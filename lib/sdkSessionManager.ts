import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type RewindFilesResult, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'fs/promises';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  persistSessionContextWindow,
  persistSessionModel,
  loadSessionModel,
  loadSessionMeta,
  modelFromMeta,
  contextTokensFromMeta,
} from './transcriptArchiver';
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
  // The user's chosen model for this session, or undefined for the CLI default.
  // Load-bearing in TWO places, because the query object comes and goes:
  //   1. Pushed live via Query.setModel() when a query is open (no restart).
  //   2. Replayed into options.model by startQuery() — covers both a session
  //      picked before its first send (q is still null) and a re-open after
  //      interrupt/stop, which would otherwise silently revert to the default.
  model?: string;
  // Whether `model` has been reconciled with the persisted override. Guards two
  // things: a redundant DB read per session, and hydration racing a user action
  // (a deliberate "clear to Default" leaves model undefined, which is exactly
  // what an un-guarded hydrate would helpfully overwrite with the stale value).
  modelHydrated?: boolean;
  // Dedup for session:model emission (mirrors emitModelIfNew in the CLI
  // manager). The SDK reports the model on system.init AND on every assistant
  // message; without this we'd re-emit the same value on every turn.
  lastEmittedModel: string | null;
  // Server-side buffer of the current turn's stream, mirroring the CLI manager.
  // Load-bearing for the UI: ChatTab keys its "strip the in-flight turn's
  // partial assistant messages" logic on this (otherwise the JSONL's partials
  // render as intermediary bubbles above the bouncing dots), and restores
  // streamed text / tool events / the elapsed timer from it when the user opens
  // or switches back to a session mid-turn.
  streamBuffer?: StreamBuffer;
  /**
   * A question the model is currently parked on, awaiting the user.
   *
   * Held on the SESSION, not the manager, and that is load-bearing:
   * adoptSessionsFrom() carries session records BY REFERENCE across an HMR
   * reload, so the resolver survives for free. Parked on the manager instead,
   * a reload would strand it — the dialog would hang forever with no way to
   * resolve the turn, and the warm process would sit blocked in canUseTool.
   *
   * `resolve` settles the held canUseTool promise. It MUST be called exactly
   * once on every path (answer, skip, abort, teardown) or the tool stays
   * blocked indefinitely: permission prompts have no park deadline
   * (sdk.d.ts:204). See docs/ask-user-question-sdk.md TRAP #1 / #2.
   */
  pendingAsk?: {
    toolUseID: string;
    questions: unknown[];
    input: Record<string, unknown>;
    resolve: (r: PermissionResult) => void;
  };
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** When this Node process started. Any CLI process older than this cannot have
 *  been spawned by us, which is how reapOrphanedProcesses tells a leftover from
 *  a previous server life apart from a live, unrelated SDK app. */
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

class SdkSessionManager {
  private sessions = new Map<string, SdkSession>();
  /** Last catalog any session reported, for sessions with no live query to ask.
   *  See listModels() for why this is served with live:false. */
  private lastKnownModels: ModelInfo[] | null = null;
  /** Single-flight guard for warmModels()'s throwaway query so concurrent
   *  new-session wizard opens spawn at most one CLI. See warmModels(). */
  private warmPromise: Promise<ModelInfo[]> | null = null;
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
        lastEmittedModel: null,
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

    // A parked question blocks the turn mid-tool. Pushing a prompt into the
    // input stream now would NOT answer it (the tool result is the only thing
    // that unblocks the model) — it would queue behind the parked tool call and
    // surface later, out of context, while the dialog still waits. Reject with a
    // clear message instead: answer or dismiss first.
    if (s.pendingAsk) {
      throw new Error('Claude is waiting for an answer to its question. Answer or dismiss it first.');
    }

    // MUST precede startQuery: it replays s.model into options.model, so a
    // session resumed after a restart would otherwise open its query on the
    // default model and only correct itself on some later turn.
    await this.ensureModelHydrated(s);

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

  /**
   * The selectable model catalog for a session.
   *
   * Query.supportedModels() resolves from the CACHED initialize response
   * (`(await this.initialization).models`) — it does not round-trip to the
   * subprocess, so calling it on every dialog open is free.
   *
   * When a session has no live query (never sent a message, or post-interrupt)
   * there's nothing to ask, so we fall back to the last catalog any session
   * reported. The catalog is a function of provider + settings cascade + cwd,
   * so a cached list from a different cwd can in principle differ — `live:false`
   * tells the UI to say so rather than present a guess as fact.
   */
  /**
   * Reconcile `s.model` with the override persisted in sessions.metadata.
   *
   * Runs once per session per process life. In-memory always wins — a value set
   * during this process is fresher than the DB, and setModel marks the session
   * hydrated so a user's choice is never clobbered by a late read.
   */
  private async ensureModelHydrated(s: SdkSession): Promise<void> {
    if (s.modelHydrated) return;
    const stored = await loadSessionModel(s.sessionId);
    if (s.modelHydrated) return; // a setModel landed while we were reading
    if (stored && s.model === undefined) s.model = stored;
    s.modelHydrated = true;
  }

  async listModels(
    sessionId: string,
  ): Promise<{ models: ModelInfo[]; live: boolean; current?: string; contextTokens: number }> {
    const s = this.sessions.get(sessionId);
    if (s) await this.ensureModelHydrated(s);
    // Read straight through to the DB when the session isn't in the map
    // (restarted server, or never sent) — going via getOrCreate would add a map
    // entry for every picker open, including on archived sessions that will
    // never run again. One read for both fields.
    //
    // BOTH must read through, not just the override. contextTokens drives the
    // confirm step's cost line and its window-overflow warning, so falling back
    // to 0 here silently degrades the dialog to generic prose — on exactly the
    // long-lived session you reopened after a restart, which is the case it
    // exists for. The archiver persists it; it just has to be read.
    const meta = s ? null : await loadSessionMeta(sessionId);
    const current = s ? s.model : modelFromMeta(meta) ?? undefined;
    // Current prompt occupancy. 0 when genuinely unknown (no turn yet); the
    // picker treats 0 as "don't claim".
    const contextTokens = s ? s.contextTokens : contextTokensFromMeta(meta);
    if (s?.q) {
      try {
        const models = await s.q.supportedModels();
        // Only answer `live` with a catalog we actually got. An empty result
        // falls through to the cache below: telling the user of a RUNNING
        // session to "send a message first" is worse than showing a stale list.
        if (models?.length) {
          this.lastKnownModels = models;
          return { models, live: true, current, contextTokens };
        }
      } catch (err) {
        console.warn('[SdkSessionManager] supportedModels failed:', err);
      }
    }
    return { models: this.lastKnownModels ?? [], live: false, current, contextTokens };
  }

  /**
   * The selectable model catalog with NO session in hand — for the new-session
   * wizard, which lets the user pick a model before a session id exists.
   *
   * Resolution order, cheapest first:
   *   1. lastKnownModels — any prior session this process already reported it
   *      (free; also the steady state once anything has run a turn).
   *   2. A live session's supportedModels() — resolves from that query's cached
   *      init response, so no subprocess round-trip (free).
   *   3. A short-lived throwaway query — the ONLY path that spawns a CLI, and
   *      only on a cold process with no session yet. Single-flighted via
   *      warmPromise so concurrent wizard opens share one spawn.
   *
   * Never throws: on any failure it degrades to lastKnownModels ?? [] and the
   * dialog shows its "no model list yet" copy rather than erroring.
   */
  async warmModels(): Promise<ModelInfo[]> {
    if (this.lastKnownModels?.length) return this.lastKnownModels;

    // Reuse any live query — supportedModels() reads its cached init, no spawn.
    for (const s of this.sessions.values()) {
      if (!s.q) continue;
      try {
        const models = await s.q.supportedModels();
        if (models?.length) {
          this.lastKnownModels = models;
          return models;
        }
      } catch { /* fall through to a throwaway query */ }
    }

    if (!this.warmPromise) {
      this.warmPromise = this.spawnWarmQuery().finally(() => { this.warmPromise = null; });
    }
    return this.warmPromise;
  }

  /**
   * Spin up a disposable query solely to read supportedModels(), then tear it
   * down. Only reached on a cold process with no live session (warmModels step
   * 3). The query is never fed a prompt and never tracked as a Fury session, so
   * it writes no history.jsonl entry and can't surface in the sidebar; the
   * abort + PID sweep in `finally` terminates the CLI it spawned.
   */
  private async spawnWarmQuery(): Promise<ModelInfo[]> {
    // A throwaway id so the PID sweep can target this spawn's process. Not a
    // Fury session: no history entry is written, so the archiver ignores it.
    const warmId = randomUUID();
    const input = createInputStream();
    const abortController = new AbortController();
    let q: Query | null = null;
    try {
      q = query({
        prompt: input.stream,
        options: {
          abortController,
          cwd: process.cwd(),
          permissionMode: 'bypassPermissions',
          sessionId: warmId,
        },
      });
      // Drain in the background so the query connects and initializes; we never
      // push a prompt, so it settles at init and produces no turn.
      const drained = q;
      void (async () => {
        try { for await (const _msg of drained) { /* ignore */ } } catch { /* aborted */ }
      })();
      // supportedModels() awaits the cached init response. Bound it so a stuck
      // connect can't hang the wizard forever.
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<ModelInfo[]>((_, reject) =>
          setTimeout(() => reject(new Error('warmModels timed out')), 10_000)),
      ]);
      if (models?.length) this.lastKnownModels = models;
      return models ?? [];
    } catch (err) {
      console.warn('[SdkSessionManager] warmModels failed:', err);
      return this.lastKnownModels ?? [];
    } finally {
      try { input.end(); } catch { /* best effort */ }
      try { abortController.abort(); } catch { /* best effort */ }
      this.killProcessesForSession(warmId);
    }
  }

  /**
   * Change the model for a session. `undefined` restores the CLI default.
   *
   * Records the choice on the session FIRST so it survives a later restart,
   * then pushes it to the live query if there is one. With no live query the
   * record alone is enough — startQuery() replays it into options.model.
   *
   * setModel() is only available in streaming input mode; we always pass an
   * AsyncGenerator as `prompt` (see createInputStream), so the control channel
   * to the subprocess is open for the life of the query.
   */
  async setModel(sessionId: string, model?: string): Promise<{ applied: 'live' | 'pending' }> {
    const s = this.getOrCreate(sessionId);
    const prev = s.model;
    s.model = model;
    // A deliberate choice outranks whatever is on disk — mark hydrated so an
    // in-flight ensureModelHydrated can't overwrite it (notably when clearing to
    // Default, which leaves model undefined and would otherwise look unhydrated).
    s.modelHydrated = true;
    // Persist even on the pending path: the choice must survive a restart before
    // the session's first turn. No-ops if the sessions row doesn't exist yet —
    // the result handler re-persists once it does.
    void persistSessionModel(sessionId, model);

    if (!s.q) return { applied: 'pending' };

    // Since SDK 0.3.200 an unrecognized model is rejected before latching, so a
    // throw here means the id is bad or unavailable under the current policy —
    // and the live query is still on whatever it was.
    //
    // Restore the PREVIOUS override, not undefined: a failed switch must not
    // mutate state at all. Clearing it would make a session pinned to (say)
    // Haiku report `current: undefined` while Haiku is still serving — the
    // picker would badge Default, and the next stop→send would silently revert
    // the session to the CLI default, which is the exact drift s.model exists
    // to prevent.
    try {
      await s.q.setModel(model);
    } catch (err) {
      s.model = prev;
      void persistSessionModel(sessionId, prev); // keep disk in step with the rollback
      throw err;
    }

    // The SDK only reports the model on system.init, so a live switch produces
    // no message of its own — emit so the status bar reflects it immediately
    // instead of at the next init.
    //
    // Emit the WIRE id, not the picked value: the catalog is full of aliases
    // ('sonnet', 'opus[1m]', 'default') and the label formatter expects a real
    // model id — it renders a bare "Claude" for anything else.
    //
    // Resolving needs the catalog, so fetch it if nothing has yet. Don't rely
    // on listModels having run: that's true for the dialog (it fetches on open)
    // but makes the emit silently wrong for any other caller. supportedModels()
    // resolves from the cached init response, so this costs nothing.
    if (model) {
      let catalog = this.lastKnownModels;
      if (!catalog) {
        try {
          catalog = await s.q.supportedModels();
          if (catalog?.length) this.lastKnownModels = catalog;
        } catch { /* fall back to the raw id below */ }
      }
      const resolved = catalog?.find(m => m.value === model)?.resolvedModel;
      this.emitModelIfNew(s, resolved || model);
    }
    // Deliberately no emit when clearing to the default: we can't know what the
    // CLI will pick, and guessing would put a wrong model in the status bar.
    // The next assistant turn reports the truth.
    return { applied: 'live' };
  }

  /**
   * The context window bounding the MAIN thread's next turn, from a result's
   * `modelUsage`.
   *
   * `modelUsage` is CUMULATIVE across the session, not per-turn — verified: a
   * session that switches to Haiku reports BOTH
   *   { 'claude-opus-4-8[1m]': 1_000_000, 'claude-haiku-4-5-20251001': 200_000 }
   * on every subsequent result. So taking the max (what this used to do) pins
   * the window to the roomiest model the session EVER ran: a session moved to
   * Haiku keeps reporting 1M forever, its fill % understates by 5x, and the
   * >=70% "context filling up" warning never fires — on the one model where
   * running out actually bites. That was invisible before the model picker,
   * because the main model never changed.
   *
   * So prefer the main model's OWN entry. Fall back to the max only when it
   * can't be identified, which preserves the original rationale: a subagent on
   * a small-window model must not drag the main window down and push fill
   * above 100%.
   */
  private windowForMainModel(s: SdkSession, mu: Record<string, { contextWindow?: number }>): number {
    // modelUsage keys carry the context-variant suffix ('claude-opus-4-8[1m]')
    // but assistant messages report the bare id ('claude-opus-4-8'), so compare
    // stripped. Haiku matches exactly either way.
    const strip = (v: string) => v.replace(/\[[^\]]*\]/g, '');
    const main = s.lastEmittedModel;
    if (main) {
      for (const [id, v] of Object.entries(mu)) {
        if (strip(id) === strip(main)) {
          const w = num(v?.contextWindow);
          if (w > 0) return w;
        }
      }
    }
    let win = 0;
    for (const v of Object.values(mu)) {
      const w = num(v?.contextWindow);
      if (w > win) win = w;
    }
    return win;
  }

  /** Emit session:model, deduped — the model arrives on init AND every turn. */
  private emitModelIfNew(s: SdkSession, model: string | undefined): void {
    if (!model || model === '<synthetic>') return;
    if (model === s.lastEmittedModel) return;
    s.lastEmittedModel = model;
    eventBus.emitApp({ type: 'session:model', sessionId: s.sessionId, model });
  }

  /**
   * Settle a parked question with a deny, and tell any open dialog to close.
   *
   * Every teardown path MUST funnel through here. A dropped resolver leaves the
   * CLI blocked in canUseTool forever (no park deadline), and the session then
   * reports isProcessing:false while the process is still stuck — idle to the
   * UI, wedged in reality. Idempotent: `resolve` is the router's own `settle`,
   * which no-ops after the first call.
   */
  private settlePendingAsk(s: SdkSession, message: string): void {
    if (!s.pendingAsk) return;
    s.pendingAsk.resolve({ behavior: 'deny', message });
    s.pendingAsk = undefined;
    eventBus.emitApp({
      type: 'session:stream',
      sessionId: s.sessionId,
      askUserQuestion: { cleared: true },
    });
  }

  /** Interrupt the in-flight turn without tearing down the session. */
  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);

    // Settle BEFORE interrupting, for two reasons.
    //
    // 1. Correctness: interrupt() is the ONE teardown that neither aborts the
    //    abortController nor ends the input stream — so the router's abort
    //    listener never fires and consume()'s finally never runs (the message
    //    stream stays open for the next turn). Without this the question stays
    //    parked while isProcessing flips false: the UI says idle, the CLI is
    //    still blocked, and a later answer would RESUME the turn the user just
    //    stopped. Stop has to actually stop.
    // 2. Liveness: the CLI is blocked awaiting our control_response, so
    //    `await s.q.interrupt()` could wait on a process that isn't listening.
    //    Unblocking it first means interrupt() can be serviced.
    //
    // Both recovery buttons land here (handleTranscriptStop and
    // handleKillStuckSession), so this is the escape hatch — it cannot be the
    // one path that strands the turn.
    if (s) this.settlePendingAsk(s, 'Session interrupted.');

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
    // Belt and braces: the abort above already settles a parked question via the
    // router's signal listener. This makes the teardown correct on its own terms
    // rather than by tracing the abort wiring — and covers an abortController
    // that's already been cleared, where the listener can never fire.
    this.settlePendingAsk(s, 'Session interrupted.');
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
      // As in stop(): the abort settles a parked question through the router's
      // listener, but the teardown shouldn't depend on that to be correct.
      this.settlePendingAsk(s, 'Session interrupted.');
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

  /**
   * Tear down every session this manager owns. Call on server shutdown: the SDK
   * spawns the CLI as a child of this process, but a dying parent does NOT take
   * its children with it — they get reparented and keep running. Without this,
   * every restart (Ctrl+C, deploy, nodemon) leaks a warm process that still
   * burns tokens, still writes the session JSONL, and still shows up in the PID
   * scanner as Live while the fresh manager has no handle to stream or stop it.
   */
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

  /**
   * The permission callback. Today it does exactly two things: allow every
   * ordinary tool through untouched, and PARK on AskUserQuestion until a human
   * answers.
   *
   * On `permissionMode: 'bypassPermissions'` (below) and this callback:
   * bypass auto-approves permission-GATED tools before consulting us, and the
   * runtime warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED to that effect. That warning
   * does NOT apply to AskUserQuestion. It is not permission-gated — it is a
   * user-INPUT tool, and the permission component is the only channel that can
   * collect its answers, so it routes here regardless of mode. Verified at SDK
   * 0.3.210 under BOTH bypassPermissions and default: the callback fires, the
   * promise is awaited for as long as we hold it, and updatedInput.answers is
   * threaded back into the same turn (scripts/probe-ask-user-question.mjs).
   *
   * So we keep bypassPermissions: switching to 'default' would force a callback
   * round-trip on every Bash/Edit/Read and break behavior parity for no gain.
   * That the shadowing warning does not cover user-input tools is OBSERVED, not
   * promised by the types — hence the exact version pin in package.json and the
   * canary test that fails loudly if a future SDK changes it.
   *
   * Gating other tools behind a real UI prompt is deliberately out of scope; the
   * `allow` fallthrough is the seam where that would live.
   */
  private canUseTool(s: SdkSession) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      { signal, toolUseID, agentID }: { signal: AbortSignal; toolUseID: string; agentID?: string },
    ): Promise<PermissionResult> => {
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow', updatedInput: input };
      }

      // A subagent has no dialog to render into: Fury's UI renders questions for
      // the main chat only. Parking here would block a sidechain forever on a
      // prompt nobody can see, and — with a single-slot pendingAsk — a sidechain
      // question would silently overwrite the main turn's slot and resolve the
      // WRONG promise. Deny instead; the model handles it gracefully.
      if (agentID) {
        return {
          behavior: 'deny',
          message:
            'AskUserQuestion is not available to subagents in this environment. ' +
            'Proceed with your best judgment, or ask the user from the main thread.',
        };
      }

      // Single slot. The model cannot ask twice concurrently (its turn is
      // blocked right here), so an overwrite means an assumption broke — resolve
      // the old promise rather than leak it, and say so loudly.
      if (s.pendingAsk) {
        console.warn(
          `[SdkSessionManager] ${s.sessionId} pendingAsk overwritten ` +
            `(${s.pendingAsk.toolUseID} -> ${toolUseID}); resolving the stale one.`,
        );
        s.pendingAsk.resolve({ behavior: 'deny', message: 'Superseded by a newer question.' });
        s.pendingAsk = undefined;
      }

      const questions = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];

      return new Promise<PermissionResult>((resolve) => {
        let settled = false;
        const settle = (r: PermissionResult) => {
          if (settled) return;
          settled = true;
          if (s.pendingAsk?.toolUseID === toolUseID) s.pendingAsk = undefined;
          resolve(r);
        };

        // TRAP #2: stop() and killSession() abort the controller. Without this
        // listener the held promise NEVER settles — the callback leaks and
        // teardown hangs behind a dialog nobody is looking at.
        if (signal.aborted) {
          settle({ behavior: 'deny', message: 'Session interrupted.' });
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            settle({ behavior: 'deny', message: 'Session interrupted.' });
            eventBus.emitApp({
              type: 'session:stream',
              sessionId: s.sessionId,
              askUserQuestion: { cleared: true },
            });
          },
          { once: true },
        );

        s.pendingAsk = { toolUseID, questions, input, resolve: settle };

        // Announce to any live dialog. A client that missed this (mid-refresh)
        // re-hydrates from /api/stream-buffer instead — server-held state is the
        // ONLY source of a pending question on the SDK path (TRAP #4).
        eventBus.emitApp({
          type: 'session:stream',
          sessionId: s.sessionId,
          askUserQuestion: { toolUseID, questions },
        });
      });
    };
  }

  /**
   * Resolve a parked question. Called by POST /api/claude-sdk/answer.
   *
   * Returns false when nothing was resolved — no session, nothing parked, or a
   * toolUseID mismatch. The mismatch check is the point: a stale dialog left
   * open from a previous turn must not answer the current question.
   */
  resolveAsk(
    sessionId: string,
    toolUseID: string,
    result: { answers: Record<string, string>; annotations?: Record<string, unknown> } | { skip: true },
  ): boolean {
    const s = this.sessions.get(sessionId);
    if (!s?.pendingAsk || s.pendingAsk.toolUseID !== toolUseID) return false;

    const { input, resolve } = s.pendingAsk;
    s.pendingAsk = undefined;

    if ('skip' in result) {
      resolve({
        behavior: 'deny',
        message: 'The user dismissed the question without answering.',
      });
    } else {
      resolve({
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: result.answers,
          ...(result.annotations ? { annotations: result.annotations } : {}),
        },
      });
    }
    eventBus.emitApp({
      type: 'session:stream',
      sessionId,
      askUserQuestion: { cleared: true },
    });
    return true;
  }

  /**
   * The serializable half of a parked question (no `resolve`), for
   * /api/stream-buffer to re-hydrate a dialog after a browser refresh.
   *
   * Deliberately NOT folded into StreamBuffer: that shape is shared with the CLI
   * manager, which has no concept of a parked question. A separate accessor also
   * keeps this answerable when no buffer exists (or one has expired).
   */
  getPendingAsk(sessionId: string): { toolUseID: string; questions: unknown[] } | null {
    const p = this.sessions.get(sessionId)?.pendingAsk;
    return p ? { toolUseID: p.toolUseID, questions: p.questions } : null;
  }

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
        // Replay the session's chosen model. Omitted entirely when unset so the
        // CLI default applies — passing model: undefined is equivalent, but
        // being explicit keeps the "we never chose" case out of the options.
        ...(s.model ? { model: s.model } : {}),
        // Pin Fury's client-generated UUID so the on-disk JSONL matches what
        // sessionPaths/transcriptParser expect. resume for an existing session,
        // sessionId to create one with our id.
        ...(existing ? { resume: s.sessionId } : { sessionId: s.sessionId }),
        stderr: (data: string) => {
          // Hook point for the usage-limit / provider-switch detection the
          // shipping manager runs on stderr. Left as a log for the prototype.
          if (data.trim()) console.error('[SdkSessionManager] stderr:', data.trim());
        },
        canUseTool: this.canUseTool(s),
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
      // Settle any still-parked question. RESOLVE rather than just drop it: the
      // turn is over, so nothing will ever answer this promise, and a dropped
      // one leaves the canUseTool callback pending forever (no park deadline).
      // Normally already undefined — the answer/abort paths clear their own slot
      // — so reaching here means the stream ended under an open dialog.
      this.settlePendingAsk(s, 'The turn ended before the question was answered.');
      this.closeBuffer(s);
      this.emitHealth(s, false);
    }
  }

  private handle(s: SdkSession, msg: SDKMessage): void {
    s.lastActivity = Date.now();
    const anyMsg = msg as any;

    switch (msg.type) {
      case 'system':
        if (anyMsg.subtype === 'init') this.emitModelIfNew(s, anyMsg.model);
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
        // Report the model that actually served this turn (parity with the CLI
        // manager, which emits here too). init alone isn't enough once the model
        // can change: a setModel() switch, or a fallbackModel demotion under
        // load, would otherwise leave the status bar asserting a stale model.
        //
        // Sidechain guard (same reason as contextTokens below): a subagent's
        // assistant message carries the SUBAGENT's model, so emitting it would
        // flip the status bar to e.g. Haiku mid-turn on an Opus session — and
        // the result handler now derives the context window from this model, so
        // it would mis-size the fill bar too.
        if (anyMsg.parent_tool_use_id == null) {
          this.emitModelIfNew(s, anyMsg.message?.model);
        }
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
        // Sidechain guard — mirrors the message_start/assistant cases above. Only
        // the MAIN turn's result ends the turn. If the SDK ever surfaces a
        // top-level `result` for a subagent (parent_tool_use_id != null), acting
        // on it would flip isProcessing:false and close the buffer mid-turn — the
        // exact transient false that makes /api/health report a live session idle
        // and drops the in-flight view into un-stripped intermediary bubbles.
        if (anyMsg.parent_tool_use_id != null) break;
        s.isProcessing = false;
        this.closeBuffer(s);
        const mu = anyMsg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        if (mu) {
          const win = this.windowForMainModel(s, mu);
          if (win > 0) {
            s.contextWindow = win;
            // Persist on EVERY result, not only when the value changes: at the
            // first result the sessions row usually doesn't exist yet (the
            // archiver creates it), so that write is a no-op and a change-gated
            // retry would never fire — the window would be lost for good. The
            // helper itself no-ops when the stored value already matches.
            //
            // (This used to also reason "the window never changes afterwards".
            // It can now: pinning a session to Haiku moves it 1M -> 200k.)
            void persistSessionContextWindow(s.sessionId, win);
          }
        }
        // Same reasoning as the window above: the sessions row usually doesn't
        // exist at the first result, so the write from setModel() may have been
        // a no-op. Re-persist here until it lands (no-ops once it matches).
        // Deliberately OUTSIDE the modelUsage block — whether the row exists yet
        // has nothing to do with whether this result carried usage.
        if (s.modelHydrated) {
          void persistSessionModel(s.sessionId, s.model);
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
// 17: added warmModels()/spawnWarmQuery() (+ warmPromise) for the new-session
//     model picker's session-less catalog. A running dev server on v16 has no
//     warmModels on its live instance, so GET /api/claude-sdk/model without a
//     sessionId threw "sdkSessionManager.warmModels is not a function".
// 18: handle() 'result' case now guards on parent_tool_use_id — a subagent's
//     result no longer tears down the main turn (isProcessing/closeBuffer).
const SINGLETON_VERSION = 18;
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
// Always resolve the CURRENT instance, never capture one.
//
// `export const x = globalForSdk.__sdkSessionManager` freezes the reference at
// module-evaluation time. When the block above swaps in a replacement, every
// route module that was ALREADY evaluated keeps pointing at the old instance —
// so routes silently disagree about the same session. Observed in the wild:
// /api/stream-buffer (recompiled after a bump) reported isProcessing:true while
// /api/health (not recompiled, still holding the old instance) reported false
// for the same live session. ChatTab's 15s health poll then cleared
// transcriptLoading mid-turn — dots vanish — and refetched the transcript, whose
// in-flight partials render as intermediary bubbles.
//
// A proxy keeps the `sdkSessionManager.foo()` call sites unchanged while looking
// the instance up on every access. Methods are bound to the live instance so
// `this` isn't the proxy.
export const sdkSessionManager: SdkSessionManager = new Proxy({} as SdkSessionManager, {
  get(_target, prop) {
    const live = globalForSdk.__sdkSessionManager as unknown as Record<string | symbol, unknown>;
    const value = live[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(live) : value;
  },
  set(_target, prop, value) {
    (globalForSdk.__sdkSessionManager as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});
