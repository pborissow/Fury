import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'fs/promises';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { persistSessionContextWindow } from './transcriptArchiver';
import { eventBus } from './eventBus';
import { findSessionJsonlDir } from './sessionPaths';
// Type-only (erased at compile time) — no runtime coupling to the CLI manager.
// Reusing its shapes keeps /api/stream-buffer and ChatTab identical for both
// backends.
import type { StreamBuffer, StreamBufferEvent } from './sessionManager';

/**
 * PROTOTYPE — persistent-session manager built on @anthropic-ai/claude-agent-sdk.
 *
 * Contrast with lib/sessionManager.ts (the shipping implementation), which
 * spawns a FRESH `claude --print` process every turn, feeds one prompt over
 * stdin, closes stdin, and lets the process exit. That design forces a cold
 * start (re-read + re-parse the whole JSONL) on every turn and kills any
 * subprocess Claude launched (e.g. a Bash background server) at end of turn.
 *
 * Here we open ONE long-lived `query()` per session with a streaming input
 * prompt. The underlying CLI process stays alive across turns, so:
 *   1. No cold start → far lower time-to-first-token on turns 2..N.
 *   2. Subprocesses Claude launches survive between turns.
 *   3. Rewind is native (`resume` + `resumeSessionAt`) instead of hand-editing
 *      the transcript.
 *
 * It emits the SAME eventBus events as the shipping manager, so the existing
 * SSE route + frontend render it unchanged.
 */

/**
 * A pushable async-iterable of user messages. This is the `prompt` we hand to
 * query(). The generator AWAITS when the queue is empty rather than returning —
 * returning would end the session and let the CLI exit. That awaiting is what
 * keeps the process alive between turns.
 */
function createInputStream() {
  const queue: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let ended = false;

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (queue.length === 0) {
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      if (ended && queue.length === 0) return;
    }
  }

  return {
    stream: generator(),
    push(msg: SDKUserMessage) {
      queue.push(msg);
      notify?.();
      notify = null;
    },
    end() {
      ended = true;
      notify?.();
      notify = null;
    },
  };
}

type InputStream = ReturnType<typeof createInputStream>;

interface SdkSession {
  sessionId: string;
  projectPath?: string;
  q: Query | null;
  input: InputStream | null;
  isProcessing: boolean;
  startedAt?: number;
  lastActivity: number;
  // Per-turn timing for the TTFT measurement.
  turnStartedAt?: number;
  ttftEmitted: boolean;
  // Live billed-token tally, deduped by assistant message id (mirrors the
  // shipping manager's session:usage accounting).
  usageByMsg: Map<string, number>;
  lastEmittedTokens: number;
  lastEmittedContext: number;
  lastEmittedWindow: number;
  // Current context occupancy: the prompt size of the most recent API call
  // (input + cache write + cache read; output isn't part of the next prompt).
  // An absolute level, not a running total — the last call wins.
  contextTokens: number;
  // The model's context window, from result.modelUsage[model].contextWindow.
  // 0 until the first result of the session. Not recoverable from the JSONL
  // (see archiveTranscript's contextWindow doc), so capturing it here is the
  // only way archived sessions ever learn their denominator.
  contextWindow: number;
  // Aborts the query() and terminates the underlying CLI subprocess. This is
  // the SDK's documented hard-stop (Options.abortController) — used by stop()
  // and killSession() so deleting a session actually kills its warm process.
  abortController?: AbortController;
  // Server-side buffer of the current turn's stream, mirroring the CLI manager.
  // Load-bearing for the UI: ChatTab keys its "strip the in-flight turn's
  // partial assistant messages" logic on this (otherwise the JSONL's partials
  // render as intermediary bubbles above the bouncing dots), and restores
  // streamed text / tool events / the elapsed timer from it when the user opens
  // or switches back to a session mid-turn.
  streamBuffer?: StreamBuffer;
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** When this Node process started. Any CLI process older than this cannot have
 *  been spawned by us, which is how reapOrphanedProcesses tells a leftover from
 *  a previous server life apart from a live, unrelated SDK app. */
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

class SdkSessionManager {
  private sessions = new Map<string, SdkSession>();
  /** Keep completed stream buffers this long so a user switching back right
   *  after a turn still sees its final state (matches the CLI manager). */
  private readonly BUFFER_TTL = 60 * 1000;

  private getOrCreate(sessionId: string): SdkSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        q: null,
        input: null,
        isProcessing: false,
        lastActivity: Date.now(),
        ttftEmitted: false,
        usageByMsg: new Map(),
        contextTokens: 0,
        contextWindow: 0,
        lastEmittedTokens: -1,
        lastEmittedContext: -1,
        lastEmittedWindow: -1,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * Send a message to a session, opening the persistent query on first use.
   * Subsequent calls reuse the live process — this is the hot path that avoids
   * the cold start.
   */
  async sendMessage(sessionId: string, prompt: string, projectPath?: string): Promise<void> {
    const s = this.getOrCreate(sessionId);
    if (projectPath) s.projectPath = projectPath;

    if (!s.q) this.startQuery(s);

    // Make the session visible to the sidebar/history and to the DB startup
    // archiver. scanAndArchiveAll (lib/db.ts) SKIPS any session that has no
    // history.jsonl entry — it needs the real project path, not the slug. The
    // interactive CLI writes history.jsonl itself, but the SDK's streaming
    // session does NOT, so we write it here (parity with sessionManager.ts,
    // which appends one entry per turn).
    this.appendHistoryEntry(s, prompt);

    // Open this turn's stream buffer BEFORE the first event can arrive.
    // `userPrompt` must be the exact prompt text: ChatTab matches it against the
    // JSONL user message to find where to cut the in-flight turn's partials.
    s.streamBuffer = {
      userPrompt: prompt,
      accumulatedText: '',
      events: [],
      isActive: true,
      startedAt: Date.now(),
    };

    // Reset the per-turn tally. eventBus's SessionUsageEvent documents
    // turnTokens as "accrued so far in the in-flight turn", but this map lives
    // on the session, which (unlike the CLI manager's per-spawn map) outlives
    // the turn — so without this it silently became session-cumulative.
    s.usageByMsg.clear();
    s.lastEmittedTokens = -1;

    s.isProcessing = true;
    s.startedAt = Date.now();
    s.turnStartedAt = Date.now();
    s.ttftEmitted = false;
    this.emitHealth(s, true);

    s.input!.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    });
  }

  /**
   * Revert the working tree to the file checkpoint at a given USER message —
   * the SDK's native replacement for Fury's "ask the LLM to undo its own
   * changes" rewind (ChatTab.tsx handleRewind → PATCH /api/session). Operates
   * on the LIVE session, so call interrupt() first to stop the in-flight turn;
   * do NOT call stop() (that tears the query down). `messageUuid` is a USER
   * message uuid from the transcript — verified via scripts/verify-rewind.ts.
   * Returns the SDK result (canRewind + filesChanged/insertions/deletions).
   *
   * Scope note: this is FILE-state rewind only. Conversation-history truncation
   * is a separate concern (resumeSessionAt takes an ASSISTANT uuid and needs a
   * session restart) — deliberately not conflated with file rewind here.
   */
  async rewind(sessionId: string, messageUuid: string, projectPath?: string): Promise<RewindFilesResult> {
    const s = this.getOrCreate(sessionId);
    if (projectPath) s.projectPath = projectPath;
    // If the query was fully torn down (e.g. server restart), resume it so the
    // persisted checkpoints are reachable; the interrupt() path keeps it live.
    if (!s.q) this.startQuery(s);
    return s.q!.rewindFiles(messageUuid);
  }

  /** Interrupt the in-flight turn without tearing down the session. */
  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.q) {
      try {
        await s.q.interrupt();
      } catch (err) {
        console.warn('[SdkSessionManager] interrupt failed:', err);
      }
    }
    if (s) {
      s.isProcessing = false;
      this.closeBuffer(s);
      this.emitHealth(s, false);
    }
  }

  /**
   * Stop the live process for a session and terminate its CLI subprocess.
   * Aborts the controller (hard stop) and ends the input stream. The session
   * stays in the map (q nulled) so it can be resumed later; use killSession()
   * to also forget it.
   */
  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // Abort first so the pending for-await in consume() unwinds knowing the
    // teardown was intentional (its catch checks signal.aborted).
    try { s.abortController?.abort(); } catch { /* best effort */ }
    s.input?.end();
    s.q = null;
    s.input = null;
    s.abortController = undefined;
    s.isProcessing = false;
    this.closeBuffer(s);
    this.emitHealth(s, false);
  }

  /**
   * Fully destroy a session: kill its CLI process(es) AND forget it. Wired into
   * DELETE /api/session so deleting a session in the UI doesn't leave an
   * orphaned SDK subprocess running. Safe for ids this manager doesn't own
   * (still sweeps any matching PID files), so the delete route can call it
   * unconditionally alongside the shipping manager's killSession.
   */
  async killSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      try { s.abortController?.abort(); } catch { /* best effort */ }
      s.input?.end();
      s.q = null;
      s.input = null;
      s.abortController = undefined;
      s.isProcessing = false;
    }
    // Hard-kill any CLI process registered to this session by PID. The
    // abortController only references the CURRENT query, but interrupt/rewind
    // churn can leave an earlier process alive and unreferenced — sweep them
    // all so delete never leaks a process.
    this.killProcessesForSession(sessionId);
    this.sessions.delete(sessionId);
    if (s) this.emitHealth(s, false);
  }

  /**
   * Tear down every session this manager owns. Call on server shutdown: the SDK
   * spawns the CLI as a child of this process, but a dying parent does NOT take
   * its children with it — they get reparented and keep running. Without this,
   * every restart (Ctrl+C, deploy, nodemon) leaks a warm process that still
   * burns tokens, still writes the session JSONL, and still shows up in the PID
   * scanner as Live while the fresh manager has no handle to stream or stop it.
   */
  /**
   * Take over the live session records from the previous instance when this
   * module hot-reloads (see the SINGLETON_VERSION block at the bottom).
   *
   * The records are carried BY REFERENCE on purpose: the previous instance's
   * still-running consume() loops keep mutating the very same objects (
   * isProcessing, streamBuffer, usage) that this instance serves to
   * /api/stream-buffer and /api/health. So an in-flight turn survives the reload
   * — dots keep bouncing, partials keep getting stripped — instead of being
   * orphaned into a zombie the UI can neither see nor stop. Defensive about the
   * previous instance's shape, since it was built from a different module
   * version whose fields may not match.
   */
  adoptSessionsFrom(previous: SdkSessionManager): void {
    const prior = (previous as unknown as { sessions?: Map<string, SdkSession> }).sessions;
    if (!(prior instanceof Map)) return;
    for (const [id, session] of prior) {
      if (!this.sessions.has(id)) this.sessions.set(id, session);
    }
  }

  async killAll(): Promise<number> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.killSession(id);
    return ids.length;
  }

  /**
   * Kill CLI processes left over from a PREVIOUS server life. Fury's SDK
   * sessions are pure in-memory state, so after a restart the manager owns
   * nothing while the old processes are still alive — a zombie the UI reports
   * as Live (PID scanner) but with no dots/stream/buffer (manager knows
   * nothing), and which the SDK gives us no way to re-attach to. Reaping makes
   * the state honest and consistent.
   *
   * Scoping (deliberately conservative — this kills processes):
   *  - `entrypoint: 'sdk-ts'` alone is NOT enough: that marks ANY app using the
   *    TS Agent SDK, including our own scripts/probe-*.ts and compare-cost.ts.
   *  - So we also require the process to have started BEFORE this server did.
   *    Anything older cannot belong to us and is therefore left over from a
   *    previous life; anything newer (a probe, another app started since) is
   *    spared.
   *  - Sessions this manager owns are always skipped, so it's safe to call at
   *    any time; at boot the map is empty, which is the intended sweep.
   *
   * Residual risk: a second Fury instance whose processes predate this one would
   * still match. Tests MUST pass `onlySessionId` rather than rely on that.
   *
   * `onlySessionId` narrows the sweep to a single session. Tests MUST pass it:
   * a probe run outside the server has an empty map, so an unscoped call would
   * treat every live SDK process on the machine — including sessions the user is
   * actively using — as an orphan and kill them.
   */
  reapOrphanedProcesses(opts?: { onlySessionId?: string }): number {
    let dir: string;
    let files: string[];
    try {
      dir = join(homedir(), '.claude', 'sessions');
      files = readdirSync(dir);
    } catch {
      return 0;
    }
    let reaped = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = join(dir, f);
      try {
        const e = JSON.parse(readFileSync(full, 'utf8'));
        if (e.entrypoint !== 'sdk-ts' || typeof e.pid !== 'number') continue;
        if (opts?.onlySessionId && e.sessionId !== opts.onlySessionId) continue;
        if (this.sessions.has(e.sessionId)) continue; // we own it — leave it alone
        // Predates this process => can't be ours => left over from a previous
        // life. Spares concurrently-running SDK apps (incl. our own probes).
        // Skipped when explicitly scoped to one session (tests).
        if (!opts?.onlySessionId && !(typeof e.startedAt === 'number' && e.startedAt < PROCESS_STARTED_AT)) continue;
        let alive = false;
        try { process.kill(e.pid, 0); alive = true; } catch { /* already dead */ }
        if (alive) {
          try { process.kill(e.pid, 'SIGKILL'); reaped++; } catch { /* raced */ }
        }
        try { rmSync(full); } catch { /* leave stale */ }
      } catch { /* unreadable/foreign pid file — skip */ }
    }
    return reaped;
  }

  /** SIGKILL every CLI process whose ~/.claude/sessions PID file names this id. */
  private killProcessesForSession(sessionId: string): void {
    let dir: string;
    let files: string[];
    try {
      dir = join(homedir(), '.claude', 'sessions');
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = join(dir, f);
      try {
        const e = JSON.parse(readFileSync(full, 'utf8'));
        if (e.sessionId === sessionId && typeof e.pid === 'number') {
          try { process.kill(e.pid, 'SIGKILL'); } catch { /* already dead */ }
          try { rmSync(full); } catch { /* leave stale file */ }
        }
      } catch { /* unreadable/foreign pid file — skip */ }
    }
  }

  /**
   * Sessions that are actively processing a prompt (submit → final `result`).
   * This is the "live" signal for the badge — NOT process existence.
   */
  getActiveSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.isProcessing && s.q) ids.push(id);
    }
    return ids;
  }

  /**
   * Every session Fury owns (tracked in the map), regardless of whether its
   * query stream object is currently live. This must NOT key on `s.q`: an
   * interrupted session transiently nulls `s.q` while its CLI process stays
   * alive, and the PID scanner would then wrongly show it "live" at rest. The
   * events route subtracts this set from the scanner, then adds back only the
   * isProcessing ones — so a Fury SDK session is live iff it's processing.
   */
  getManagedSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Whether this session has an in-flight turn right now. Consulted by
   * /api/health and /api/stream-buffer, which otherwise only see the CLI
   * sessionManager — without this they report isProcessing:false for a live SDK
   * session, and ChatTab's poll clears transcriptLoading (killing the bouncing
   * dots AND dropping every session-stream event).
   */
  isSessionProcessing(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!(s && s.isProcessing);
  }

  /**
   * The current turn's stream buffer, served by /api/stream-buffer. Without it
   * ChatTab sees `hasBuffer:false` for SDK sessions and skips the branch that
   * strips the in-flight turn's partial assistant messages — so opening a
   * working session renders intermediary bubbles above the bouncing dots. It
   * also restores streamed text / tool events / the elapsed timer on
   * switch-back. Completed buffers expire after BUFFER_TTL.
   */
  getStreamBuffer(sessionId: string): StreamBuffer | null {
    const s = this.sessions.get(sessionId);
    if (!s?.streamBuffer) return null;
    const buf = s.streamBuffer;
    if (!buf.isActive && buf.completedAt && Date.now() - buf.completedAt > this.BUFFER_TTL) {
      s.streamBuffer = undefined;
      return null;
    }
    return buf;
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Append an entry to ~/.claude/history.jsonl for THIS TURN. Mirrors
   * sessionManager.ts — without it, SDK sessions never appear in the history
   * sidebar and the DB startup scan skips them (no project path).
   *
   * Once per TURN, not once per session. history.jsonl is a prompt log, and
   * /api/history derives the sidebar's "N messages" by counting a session's
   * entries — so writing once per session collapsed every SDK session to
   * "1 message" (it only ever grew when a server restart reset the in-memory
   * map). buildHistoryMap (lib/db.ts) dedupes to the earliest entry per session
   * for display, and /api/history picks a best display of its own, so the
   * repeated entries are expected by both readers.
   */
  private appendHistoryEntry(s: SdkSession, prompt: string): void {
    try {
      const entry = JSON.stringify({
        display: prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt,
        pastedContents: {},
        timestamp: Date.now(),
        project: s.projectPath || process.cwd(),
        sessionId: s.sessionId,
      });
      const historyPath = join(homedir(), '.claude', 'history.jsonl');
      appendFile(historyPath, entry + '\n', 'utf-8').catch((err) =>
        console.error('[SdkSessionManager] Failed to append history.jsonl:', err),
      );
    } catch (err) {
      console.error('[SdkSessionManager] Failed to build history entry:', err);
    }
  }

  /** Append streamed text to the buffer, coalescing consecutive text events. */
  private bufferText(s: SdkSession, text: string): void {
    const buf = s.streamBuffer;
    if (!buf) return;
    buf.accumulatedText += text;
    const last = buf.events[buf.events.length - 1];
    if (last && last.type === 'text') {
      last.content = (last.content || '') + text;
    } else {
      buf.events.push({ type: 'text', content: text, ts: Date.now() });
    }
  }

  private bufferEvent(s: SdkSession, evt: StreamBufferEvent): void {
    s.streamBuffer?.events.push(evt);
  }

  /** Close the current buffer (turn ended / interrupted) but keep its content. */
  private closeBuffer(s: SdkSession): void {
    if (s.streamBuffer?.isActive) {
      s.streamBuffer.isActive = false;
      s.streamBuffer.completedAt = Date.now();
    }
  }

  private allowAll = async (
    _toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // This callback is where a REAL permission prompt would live, and because
    // the session is bidirectional, AskUserQuestion works here too (unlike the
    // shipping `--print` path that auto-errors it).
    //
    // IMPORTANT: with `permissionMode: 'bypassPermissions'` below, the SDK
    // auto-approves every tool BEFORE consulting this callback, so it is never
    // invoked (the runtime warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). To actually
    // gate tools through this callback, switch to `permissionMode: 'default'`
    // (or 'acceptEdits'), or register a PreToolUse hook. Kept here to document
    // the seam; the prototype runs bypass for behavior parity with today.
    return { behavior: 'allow', updatedInput: input };
  };

  private startQuery(s: SdkSession): void {
    // Reclaim any CLI process still running for this session before spawning a
    // replacement. consume() nulls s.q when the message stream ends (e.g. after
    // an interrupt) WITHOUT terminating the process, so the next sendMessage
    // would spawn a second process for the same session: both alive, both
    // writing the same JSONL, only the newest one tracked/abortable.
    // startQuery only runs when s.q is null, so anything still alive here is a
    // leak by definition.
    if (s.abortController && !s.abortController.signal.aborted) {
      try { s.abortController.abort(); } catch { /* best effort */ }
    }
    this.killProcessesForSession(s.sessionId);

    const cwd = s.projectPath || process.cwd();
    const existing = findSessionJsonlDir(s.sessionId, cwd) !== null;
    const input = createInputStream();
    s.input = input;
    const abortController = new AbortController();
    s.abortController = abortController;

    s.q = query({
      prompt: input.stream,
      options: {
        abortController,
        cwd,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        enableFileCheckpointing: true,
        // Pin Fury's client-generated UUID so the on-disk JSONL matches what
        // sessionPaths/transcriptParser expect. resume for an existing session,
        // sessionId to create one with our id.
        ...(existing ? { resume: s.sessionId } : { sessionId: s.sessionId }),
        stderr: (data: string) => {
          // Hook point for the usage-limit / provider-switch detection the
          // shipping manager runs on stderr. Left as a log for the prototype.
          if (data.trim()) console.error('[SdkSessionManager] stderr:', data.trim());
        },
        canUseTool: this.allowAll,
      },
    });

    this.consume(s);
  }

  private async consume(s: SdkSession): Promise<void> {
    try {
      for await (const msg of s.q!) {
        this.handle(s, msg);
      }
    } catch (err) {
      // An intentional teardown (stop/killSession aborts the controller)
      // surfaces here as an AbortError — don't report it as a session error.
      if (!s.abortController?.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.bufferEvent(s, { type: 'error', content: message, ts: Date.now() });
        eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, error: message });
      }
    } finally {
      s.isProcessing = false;
      s.q = null;
      s.input = null;
      this.closeBuffer(s);
      this.emitHealth(s, false);
    }
  }

  private handle(s: SdkSession, msg: SDKMessage): void {
    s.lastActivity = Date.now();
    const anyMsg = msg as any;

    switch (msg.type) {
      case 'system':
        if (anyMsg.subtype === 'init' && anyMsg.model) {
          eventBus.emitApp({ type: 'session:model', sessionId: s.sessionId, model: anyMsg.model });
        }
        break;

      case 'stream_event': {
        const ev = anyMsg.event;
        if (!ev) break;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (!s.ttftEmitted) {
            s.ttftEmitted = true;
            const ttft = Date.now() - (s.turnStartedAt ?? Date.now());
            console.log(`[SdkSessionManager] ${s.sessionId} TTFT=${ttft}ms (sdk ttft_ms=${anyMsg.ttft_ms ?? '?'})`);
          }
          this.bufferText(s, ev.delta.text);
          eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          this.bufferEvent(s, { type: 'tool_start', name: ev.content_block.name, ts: Date.now() });
          eventBus.emitApp({
            type: 'session:stream',
            sessionId: s.sessionId,
            toolUse: { name: ev.content_block.name, status: 'starting' },
          });
        } else if (ev.type === 'message_start' && ev.message?.id) {
          const u = ev.message.usage;
          s.usageByMsg.set(
            ev.message.id,
            num(u?.input_tokens) + num(u?.output_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens),
          );
          // Context occupancy is fixed at message_start (the prompt is already
          // assembled) and excludes output, which isn't in this call's prompt.
          // Each call within a turn re-reports the whole prompt, so the latest
          // message_start is the live context — assign, never accumulate.
          //
          // Subagents (sidechains) run their own conversation with a fresh, much
          // smaller context, and the SDK forwards their tool_use blocks by
          // default (forwardSubagentText only gates *text*) carrying real usage.
          // Assigning from one collapses the reading mid-turn — verified: a
          // subagent drove this from ~23.5k to 2950. Their tokens are still
          // billed, so they stay in the tally above; only the main thread's
          // occupancy may set contextTokens. Mirrors transcriptParser's
          // `!entry.isSidechain` guard.
          if (anyMsg.parent_tool_use_id == null) {
            s.contextTokens =
              num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens);
          }
          this.emitUsage(s);
        }
        break;
      }

      case 'assistant': {
        const content = anyMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              this.bufferEvent(s, { type: 'tool_complete', name: block.name, input: block.input, ts: Date.now() });
              eventBus.emitApp({
                type: 'session:stream',
                sessionId: s.sessionId,
                toolUse: { name: block.name, status: 'complete', input: block.input },
              });
            }
          }
        }
        const u = anyMsg.message?.usage;
        if (anyMsg.message?.id && u) {
          s.usageByMsg.set(
            anyMsg.message.id,
            num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
          );
          // Sidechain guard — see the message_start case above.
          if (anyMsg.parent_tool_use_id == null) {
            s.contextTokens =
              num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
          }
          this.emitUsage(s);
        }
        break;
      }

      case 'user': {
        const content = anyMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const preview =
                typeof block.content === 'string'
                  ? block.content.slice(0, 100)
                  : JSON.stringify(block.content).slice(0, 100);
              this.bufferEvent(s, { type: 'tool_result', preview, ts: Date.now() });
              eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, toolResult: { preview } });
            }
          }
        }
        break;
      }

      case 'result': {
        s.isProcessing = false;
        this.closeBuffer(s);
        // The SDK reports the context window per model it used this turn. Take
        // the largest: on a model switch mid-turn the surviving conversation is
        // bounded by the roomiest window it ran under, and picking the smallest
        // would show a fill % over 100.
        const mu = anyMsg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        if (mu) {
          let win = 0;
          for (const v of Object.values(mu)) {
            const w = num(v?.contextWindow);
            if (w > win) win = w;
          }
          if (win > 0) {
            s.contextWindow = win;
            // Persist on EVERY result, not only when the value changes: at the
            // first result the sessions row usually doesn't exist yet (the
            // archiver creates it), so that write is a no-op — and since the
            // window never changes afterwards, a change-gated retry would never
            // fire and the window would be lost for good. The helper itself
            // no-ops when the stored value already matches.
            void persistSessionContextWindow(s.sessionId, win);
          }
        }
        this.emitUsage(s);
        this.emitHealth(s, false);
        if (anyMsg.subtype === 'success') {
          console.log(
            `[SdkSessionManager] ${s.sessionId} turn done: ttft_ms=${anyMsg.ttft_ms ?? '?'} ` +
              `duration_ms=${anyMsg.duration_ms} warm_spare=${anyMsg.warm_spare_claimed ?? false} ` +
              `cost_usd=${anyMsg.total_cost_usd}`,
          );
        }
        break;
      }
    }
  }

  private emitHealth(s: SdkSession, isProcessing: boolean): void {
    eventBus.emitApp({ type: 'session:health', sessionId: s.sessionId, isProcessing, isStuck: false });
  }

  // NOTE (cost accounting): we emit TOKEN COUNTS only, matching the shipping
  // manager. The Stats tab derives USD from lib/pricing.ts at read time. The
  // SDK also hands us `total_cost_usd` on the `result` message — do NOT feed
  // that into the UI/DB: it comes from Anthropic's own pricing and will diverge
  // from pricing.ts (rounding/source), desyncing the live counter from stats.
  private emitUsage(s: SdkSession): void {
    let total = 0;
    for (const v of s.usageByMsg.values()) total += v;
    // Emit when the billed tally, the context level, OR the window moved. The
    // window lands on `result` after the tally has stopped moving, so gating
    // purely on `total` would drop the one event carrying the denominator.
    if (
      total === s.lastEmittedTokens &&
      s.contextTokens === s.lastEmittedContext &&
      s.contextWindow === s.lastEmittedWindow
    ) return;
    s.lastEmittedTokens = total;
    s.lastEmittedContext = s.contextTokens;
    s.lastEmittedWindow = s.contextWindow;
    eventBus.emitApp({
      type: 'session:usage',
      sessionId: s.sessionId,
      turnTokens: total,
      contextTokens: s.contextTokens,
      contextWindow: s.contextWindow,
    });
  }

}

// Singleton across Next.js HMR. The instance is intentionally persisted so we
// don't orphan warm CLI processes on every hot reload — BUT that means a running
// dev server keeps invoking the OLD method bodies of this class after an edit
// (HMR replaces the module, not the live instance's prototype). Bump
// SINGLETON_VERSION when this class's behavior changes so the dev server
// recreates the instance on the next import and picks up the new code. In
// production the module loads once, so this never re-runs.
//
// CRITICAL: the recreate MUST carry the live sessions across. Constructing an
// empty manager silently orphans every in-flight session — the CLI process keeps
// running and writing the JSONL, but the new manager has no record, so
// /api/stream-buffer answers hasBuffer:false / isProcessing:false. The bouncing
// dots vanish, the in-flight turn's partial assistant messages stop being
// stripped (they render as intermediary bubbles above the composer), and the
// next send spawns a SECOND process for the same session. Editing this file
// while a session is working used to reproduce exactly that, every time.
const SINGLETON_VERSION = 8;
const globalForSdk = globalThis as unknown as {
  __sdkSessionManager?: SdkSessionManager;
  __sdkSessionManagerV?: number;
};
if (!globalForSdk.__sdkSessionManager || globalForSdk.__sdkSessionManagerV !== SINGLETON_VERSION) {
  const previous = globalForSdk.__sdkSessionManager;
  const replacement = new SdkSessionManager();
  if (previous) replacement.adoptSessionsFrom(previous);
  globalForSdk.__sdkSessionManager = replacement;
  globalForSdk.__sdkSessionManagerV = SINGLETON_VERSION;
}
export const sdkSessionManager = globalForSdk.__sdkSessionManager;
