import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'fs/promises';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { eventBus } from './eventBus';
import { findSessionJsonlDir } from './sessionPaths';

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
  // Whether we've written this session's history.jsonl entry yet (once per
  // in-memory session is enough — buildHistoryMap dedupes to the earliest).
  historyWritten: boolean;
  // Aborts the query() and terminates the underlying CLI subprocess. This is
  // the SDK's documented hard-stop (Options.abortController) — used by stop()
  // and killSession() so deleting a session actually kills its warm process.
  abortController?: AbortController;
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

class SdkSessionManager {
  private sessions = new Map<string, SdkSession>();

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
        lastEmittedTokens: -1,
        historyWritten: false,
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
    // session does NOT, so we write it here (parity with sessionManager.ts).
    this.ensureHistoryEntry(s, prompt);

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

  // ---- internals ----------------------------------------------------------

  /**
   * Append this session's entry to ~/.claude/history.jsonl (once per session).
   * Mirrors sessionManager.ts — without it, SDK sessions never appear in the
   * history sidebar and the DB startup scan skips them (no project path).
   */
  private ensureHistoryEntry(s: SdkSession, prompt: string): void {
    if (s.historyWritten) return;
    s.historyWritten = true;
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
        eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, error: message });
      }
    } finally {
      s.isProcessing = false;
      s.q = null;
      s.input = null;
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
          eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
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
          this.emitUsage(s);
        }
        break;
      }

      case 'assistant': {
        const content = anyMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
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
              eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, toolResult: { preview } });
            }
          }
        }
        break;
      }

      case 'result': {
        s.isProcessing = false;
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
    if (total === s.lastEmittedTokens) return;
    s.lastEmittedTokens = total;
    eventBus.emitApp({ type: 'session:usage', sessionId: s.sessionId, turnTokens: total });
  }
}

// Singleton across Next.js HMR. The instance is intentionally persisted so we
// don't orphan warm CLI processes on every hot reload — BUT that means a running
// dev server keeps invoking the OLD method bodies of this class after an edit
// (HMR replaces the module, not the live instance's prototype). Bump
// SINGLETON_VERSION when this class's behavior changes so the dev server
// recreates the instance on the next import and picks up the new code. In
// production the module loads once, so this never re-runs.
const SINGLETON_VERSION = 4;
const globalForSdk = globalThis as unknown as {
  __sdkSessionManager?: SdkSessionManager;
  __sdkSessionManagerV?: number;
};
if (!globalForSdk.__sdkSessionManager || globalForSdk.__sdkSessionManagerV !== SINGLETON_VERSION) {
  globalForSdk.__sdkSessionManager = new SdkSessionManager();
  globalForSdk.__sdkSessionManagerV = SINGLETON_VERSION;
}
export const sdkSessionManager = globalForSdk.__sdkSessionManager;
