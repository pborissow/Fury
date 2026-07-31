import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type RewindFilesResult, type ModelInfo, type SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'fs/promises';
import { readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { promisify } from 'util';
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
  refreshSubagentUsage,
} from './transcriptArchiver';
import { eventBus } from './eventBus';
import { log } from './logger';
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
  // Whether this turn has already surfaced an error to the client (via
  // session:stream {error}). An auth failure arrives as a synthetic assistant
  // message AND then a non-success result; without this flag we'd emit the same
  // failure twice. Reset at every turn start alongside ttftEmitted.
  turnErrorEmitted?: boolean;
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
  // Every CLI pid THIS manager has spawned for this session and not yet seen
  // exit. This is the ONLY provable "we own it" signal we have: the on-disk PID
  // files are indistinguishable between Fury's own resume subprocess and an
  // external interactive terminal (both write kind:'interactive',
  // entrypoint:'sdk-ts' — see docs/ticket-resume-live-cli-session-hard-kill.md).
  // So kills on the send/handoff path are scoped to THIS set, and any live pid
  // for the session that is NOT in it is treated as an external owner (→
  // confirmed graceful takeover), never a silent SIGKILL. Populated by the
  // custom spawnClaudeCodeProcess in startQuery; pruned on the child's 'exit'.
  spawnedPids: Set<number>;
  // Task ids of the session's in-flight BACKGROUND agents/Bash (run_in_background,
  // Workflow, Monitor, or a foreground task backgrounded with Ctrl+B). Kept so the
  // session reads as LIVE (badge + dots) across the whole background window, not
  // just its own main turns — an orchestrator's main turn ends immediately while a
  // dispatched subagent keeps working, and without this the session goes dark until
  // the next task-notification starts a new turn (see
  // docs/ticket-live-badge-dark-during-background-subagent.md).
  //
  // Driven by the SDK's `system/background_tasks_changed` LEVEL signal: REPLACE the
  // whole set on each payload (never pair start/stop edges), so a missed edge can't
  // wedge a stale "live". Per-process — reset to empty whenever a new CLI is spawned
  // (startQuery) and on teardown (stop/kill).
  backgroundTasks: Set<string>;
  // Whether a background_tasks_changed LEVEL signal has arrived for the CURRENT CLI
  // process. Until it has, backgroundActive falls back to a durable scan of the
  // session's subagent transcripts on disk — so a subagent already in flight when
  // the code (re)loads still reads as live, instead of going dark because the new
  // manager instance's in-memory set is empty (the reload gap). Once the level
  // fires it's authoritative (it re-emits the FULL set, including pre-load tasks),
  // so the disk fallback is disabled to avoid a stale-window over-report. Reset with
  // backgroundTasks on a new process (startQuery).
  sawBackgroundLevelSignal?: boolean;
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

const execFileP = promisify(execFile);

// Don't run the background-reconcile timer under vitest (it imports this module):
// an unref'd interval would still keep re-scanning the real ~/.claude during tests.
const IN_TEST = !!process.env.VITEST || process.env.NODE_ENV === 'test';

/** A subagent transcript written within this window is treated as "still running".
 *  Past it we fail toward NOT-live, so a crashed/stalled subagent can't pin a
 *  session green forever (docs ticket "Additional fix required"). */
const SUBAGENT_RUNNING_WINDOW_MS = 120_000;

/** Liveness probe: signal 0 throws iff the pid is gone (or not ours to signal). */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Given a candidate process's parent pid, is it a PROVABLE orphaned leftover —
 * i.e. safe for reapOrphanedProcesses to SIGKILL?
 *
 * ONLY two states prove orphan-hood: the parent is init (Linux re-parents orphans
 * to pid 1) or the parent is dead (Windows leaves a stale ParentProcessId once the
 * spawning server exits). EVERYTHING ELSE is spared:
 *   - `ppid === null` — the OS lookup failed. parentPidOf's contract is explicit:
 *     never kill on a failed lookup. Falling through to SIGKILL here is exactly
 *     how a transient PowerShell failure at boot could take out a user's terminal.
 *   - a live, non-init parent — the process is attached to a real shell/terminal
 *     the user is in (an external session), not our leftover.
 *   - `ppid === selfPid` — a child of THIS server (current life, not a leftover).
 *
 * Pure and injectable (`alive`) so the reap decision is unit-testable without the
 * unscoped sweep, which can't run in a test (it would target real machine sessions).
 */
export function isProvableOrphan(
  ppid: number | null,
  selfPid: number,
  alive: (pid: number) => boolean,
): boolean {
  if (ppid === null || ppid === selfPid) return false;
  return ppid === 1 || !alive(ppid);
}

/**
 * The parent pid of an arbitrary process, or null if it can't be determined.
 *
 * Node exposes process.ppid for ITSELF only, so ownership attribution
 * (docs/ticket-resume-live-cli-session-hard-kill.md) has to go to the OS. This is
 * the ancestry signal the ticket's process-model findings settled on: a
 * Fury-spawned CLI is a direct child of this server process, so
 * `parentPidOf(pid) === process.pid` proves ownership when no spawn record exists
 * (e.g. a PID file we never got to record). PID files' kind/entrypoint/startedAt
 * are all proven NON-discriminating — an external terminal is byte-for-byte the
 * same shape — so this is the only field-independent test.
 *
 * Best-effort and defensive: any failure returns null, and callers MUST treat
 * null as "cannot prove ownership" → leave the process alive (never kill on a
 * failed lookup). One short-lived OS query per uncached candidate; the hot path
 * (pid already in spawnedPids) never reaches here.
 */
async function parentPidOf(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      // Win32_Process.ParentProcessId — exactly what diagnosed this ticket.
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ]);
      const ppid = parseInt(stdout.trim(), 10);
      return Number.isFinite(ppid) ? ppid : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('ps', ['-o', 'ppid=', '-p', String(pid)]);
      const ppid = parseInt(stdout.trim(), 10);
      return Number.isFinite(ppid) ? ppid : null;
    }
    // Linux: field 4 of /proc/<pid>/stat, but comm (field 2) can contain spaces
    // and parens, so index from the LAST ')' rather than splitting from the start.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = parseInt(rest[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

class SdkSessionManager {
  private sessions = new Map<string, SdkSession>();
  /** pid -> sessionId for every warm CLI THIS manager spawned and hasn't seen exit.
   *  Manager-level ON PURPOSE (not derived from the `sessions` map): it must survive
   *  a session record being dropped from the map while its warm process is still
   *  alive, so the Live badge can still recognize "this scanner process is Fury's
   *  warm-but-idle one" and suppress it. Without this, a desync between the map and
   *  the PID scanner pins an idle session green off the scanner alone (the
   *  stale-LIVE-while-idle bug). Populated in spawnClaudeCodeProcess, pruned on the
   *  child's 'exit', and carried across HMR by adoptSessionsFrom. */
  private spawnedProcs = new Map<number, string>();
  /** Short-TTL cache for the durable subagent-transcript scan (hasRecentSubagentActivity),
   *  so the frequent live-set recompute doesn't stat the subagents dir on every call. */
  private subagentActivityCache = new Map<string, { at: number; active: boolean }>();
  /** Last backgroundActive value emitted per session, so the reconcile tick only
   *  fires a session:health event on an actual transition (not every tick). */
  private lastBgActive = new Map<string, boolean>();
  /** The background-reconcile heartbeat (see startReconcile). */
  private reconcileTimer: NodeJS.Timeout | null = null;
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
        spawnedPids: new Set<number>(),
        backgroundTasks: new Set<string>(),
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
  async sendMessage(
    sessionId: string,
    prompt: string,
    projectPath?: string,
    opts?: { confirmTakeover?: boolean },
  ): Promise<void> {
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

    // When the session is live in an external terminal, POST /api/claude detects
    // it and answers the send with a 409 the UI turns into a takeover dialog.
    // The confirmed re-send arrives here with confirmTakeover: end that external
    // process cleanly BEFORE opening our resume query — two live processes
    // writing one JSONL would break single-writer. Only reached post-confirmation.
    if (opts?.confirmTakeover) {
      await this.takeoverExternalOwner(s);
    }

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
    s.turnErrorEmitted = false;
    log.info('sdk.turn', 'start', {
      sessionId: s.sessionId,
      corrId: s.sessionId,
      data: { model: s.model ?? 'default', promptChars: prompt.length, cwd: s.projectPath },
    });
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
    // The process is being torn down, so any background work it hosted is gone —
    // drop the set so it can't keep the session reading "live".
    s.backgroundTasks.clear();
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
      s.backgroundTasks.clear();
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
    // Carry the manager-level warm-pid record across the HMR swap too. It's the
    // stale-LIVE safety net and must not reset to empty (which would re-expose a
    // warm-but-idle process to the scanner until its next turn).
    const priorProcs = (previous as unknown as { spawnedProcs?: Map<number, string> }).spawnedProcs;
    if (priorProcs instanceof Map) {
      for (const [pid, sid] of priorProcs) this.spawnedProcs.set(pid, sid);
    }
    const prior = (previous as unknown as { sessions?: Map<string, SdkSession> }).sessions;
    if (!(prior instanceof Map)) return;
    for (const [id, session] of prior) {
      // A session built by an older module version predates spawnedPids; backfill
      // so the ownership-scoped kill path never dereferences an undefined set.
      if (!(session.spawnedPids instanceof Set)) session.spawnedPids = new Set<number>();
      if (!(session.backgroundTasks instanceof Set)) session.backgroundTasks = new Set<string>();
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
   *
   * ANCESTRY SAFEGUARD (unscoped boot sweep only): `startedAt < PROCESS_STARTED_AT`
   * is a fragile proxy for ownership — an external terminal the user launched
   * before this server ALSO predates it (docs/ticket-resume-live-cli-session-hard-kill.md,
   * criterion 5 bonus). So before reaping, we spare any candidate still attached
   * to a live, non-init parent: that's a session hanging off a real shell/terminal,
   * not a leftover of ours. A genuine previous-life orphan has a dead parent
   * (Windows: stale ParentProcessId) or has re-parented to init (Linux pid 1) — so
   * it still gets reaped. Async because parentPidOf goes to the OS.
   */
  async reapOrphanedProcesses(opts?: { onlySessionId?: string }): Promise<number> {
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
        if (!opts?.onlySessionId) {
          if (!(typeof e.startedAt === 'number' && e.startedAt < PROCESS_STARTED_AT)) continue;
          // Reap ONLY a provable orphan (parent is init, or dead). A null lookup,
          // a live non-init parent (external terminal on a shell), or a child of
          // this server are all SPARED — never SIGKILL what we can't prove is our
          // leftover. This is the "prefer under-reaping" default the ticket calls
          // for; a failed ancestry lookup must NOT fall through to a kill.
          const ppid = await parentPidOf(e.pid);
          if (!isProvableOrphan(ppid, process.pid, pidAlive)) {
            log.info('sdk.handoff', 'reap: sparing unattributable/attached process', {
              sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
              data: { pid: e.pid, ppid },
            });
            continue;
          }
        }
        if (pidAlive(e.pid)) {
          try { process.kill(e.pid, 'SIGKILL'); reaped++; } catch { /* raced */ }
        }
        try { rmSync(full); } catch { /* leave stale */ }
      } catch { /* unreadable/foreign pid file — skip */ }
    }
    return reaped;
  }

  /**
   * SIGKILL every CLI process whose ~/.claude/sessions PID file names this id.
   *
   * DELIBERATELY UNSCOPED — this is the DESTROY sweep, wired only into
   * killSession (DELETE /api/session). Deleting a session is an explicit user
   * command to obliterate it, so hard-killing anything that claims the id
   * (including an external terminal) is the intended behavior there. Do NOT call
   * this from the send/handoff path: startQuery uses reclaimOwnLeaks (own pids
   * only), and an external live owner is handled via takeoverExternalOwner behind
   * a user confirmation. See docs/ticket-resume-live-cli-session-hard-kill.md.
   */
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
   * Can Fury prove it owns `pid`? Two signals, checked cheap-first:
   *
   *   1. Recorded spawn (PRIMARY). The pid is in s.spawnedPids — we captured it
   *      from spawnClaudeCodeProcess when WE launched it. Synchronous, exact, and
   *      the common case. (This is the ticket's recommended primary; the SDK's
   *      spawn hook hands us the pid directly, cleaner than the snapshot-diff the
   *      ticket sketched.)
   *   2. Ancestry (FALLBACK). parentPidOf(pid) === process.pid — a Fury-spawned
   *      CLI is a direct child of this server process. Covers a live child whose
   *      spawn record we somehow don't have. One OS query, so only consulted when
   *      (1) misses.
   *
   * Deliberately field-INDEPENDENT: kind/entrypoint/startedAt are all proven
   * non-discriminating (an external terminal writes kind:"interactive",
   * entrypoint:"sdk-ts" — identical to Fury's own spawn), so they are never
   * consulted. A null parentPidOf (lookup failed, or a re-parented child after a
   * server restart) means "cannot prove ownership" → NOT owned → left alive. See
   * docs/ticket-resume-live-cli-session-hard-kill.md.
   */
  private async isFuryOwned(sessionId: string, pid: number): Promise<boolean> {
    if (this.sessions.get(sessionId)?.spawnedPids.has(pid)) return true;
    return (await parentPidOf(pid)) === process.pid;
  }

  /**
   * Kill CLI processes THIS manager spawned for the session that are still alive
   * even though s.q is null — a leak from a prior interrupted/ended turn (see the
   * startQuery header). Scoped to s.spawnedPids (the spawn-record ownership
   * signal), so it can NEVER touch an external terminal that merely shares the
   * session id. This is the ownership discipline the ticket requires: only ever
   * hard-kill a process we provably spawned. (No ancestry fallback is needed here:
   * within a server life spawnedPids is complete, and after a restart the record
   * is lost AND the children are re-parented — so nothing is attributable, and the
   * correct default is to leave them for reapOrphanedProcesses rather than risk an
   * unowned kill.)
   */
  private reclaimOwnLeaks(s: SdkSession): void {
    for (const pid of [...s.spawnedPids]) {
      if (pidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
        log.info('sdk.handoff', 'reclaimed own leaked cli', {
          sessionId: s.sessionId, corrId: s.sessionId, data: { pid },
        });
      }
      s.spawnedPids.delete(pid);
      this.removePidFileForPid(pid);
    }
  }

  /**
   * If the session is currently owned by a live process Fury cannot prove it owns
   * — an external interactive terminal, or a zombie from a previous server life —
   * return it. Otherwise null.
   *
   * Ownership is decided by isFuryOwned (recorded spawn, then ancestry), NEVER by
   * a PID-file field: Fury's own resume subprocess and an external CLI write
   * byte-for-byte identical files. Called by POST /api/claude to decide whether a
   * send needs a takeover confirmation. Opportunistically sweeps stale dead-pid
   * files it passes (Issue B). Read-only w.r.t. live processes — it never signals
   * anything. Async because the ancestry fallback goes to the OS.
   */
  async detectExternalOwner(
    sessionId: string,
  ): Promise<{ pid: number; name?: string; cwd?: string; file: string } | null> {
    let dir: string;
    let files: string[];
    try {
      dir = join(homedir(), '.claude', 'sessions');
      files = readdirSync(dir);
    } catch {
      return null;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = join(dir, f);
      let e: { sessionId?: unknown; pid?: unknown; name?: unknown; cwd?: unknown };
      try {
        e = JSON.parse(readFileSync(full, 'utf8'));
      } catch { continue; } // unreadable/foreign pid file — skip
      if (e.sessionId !== sessionId || typeof e.pid !== 'number') continue;
      const pid = e.pid;
      if (pid === process.pid) continue;              // never ourselves
      if (!pidAlive(pid)) {
        this.removePidFile(full);                     // stale file for a dead pid — sweep it
        continue;
      }
      if (await this.isFuryOwned(sessionId, pid)) continue; // recorded ours, or a child of this server
      return {
        pid,
        name: typeof e.name === 'string' ? e.name : undefined,
        cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
        file: full,
      };
    }
    return null;
  }

  /**
   * End the external process that currently owns this session so Fury's resume
   * query can take over as the single writer. ONLY call this after the user has
   * confirmed the takeover (POST /api/claude returns a 409 the UI renders as a
   * dialog; the confirmed re-send carries confirmTakeover) — never silently.
   *
   * SIGTERM first so a POSIX CLI can flush and exit cleanly, then poll briefly and
   * escalate to SIGKILL only if it ignores the term. NOTE: on Windows Node maps
   * every signal except 0 to TerminateProcess, so there is no soft stop there —
   * but the user has already agreed to end the terminal, which is the property
   * that matters. Narrated to sdk.handoff so the whole exchange is reconstructable
   * from ~/.claude/fury-logs/ the way this ticket was diagnosed.
   */
  private async takeoverExternalOwner(s: SdkSession): Promise<void> {
    const owner = await this.detectExternalOwner(s.sessionId);
    if (!owner) return; // gone between confirmation and now — nothing to end
    log.info('sdk.handoff', 'takeover: signalling external owner', {
      sessionId: s.sessionId, corrId: s.sessionId, data: { pid: owner.pid, name: owner.name },
    });
    try { process.kill(owner.pid, 'SIGTERM'); } catch { /* already gone */ }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let alive = false;
      try { process.kill(owner.pid, 0); alive = true; } catch { /* exited */ }
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    let stillAlive = false;
    try { process.kill(owner.pid, 0); stillAlive = true; } catch { /* exited */ }
    if (stillAlive) {
      log.warn('sdk.handoff', 'takeover: owner ignored SIGTERM, escalating to SIGKILL', {
        sessionId: s.sessionId, corrId: s.sessionId, data: { pid: owner.pid },
      });
      try { process.kill(owner.pid, 'SIGKILL'); } catch { /* raced */ }
    }
    await this.removePidFileWithRetry(owner.file);
    log.info('sdk.handoff', 'takeover: external owner ended', {
      sessionId: s.sessionId, corrId: s.sessionId, data: { pid: owner.pid },
    });
  }

  /** Best-effort unlink of a PID file. Held handles / already-gone are non-fatal. */
  private removePidFile(full: string): void {
    try { rmSync(full); } catch { /* held or already gone */ }
  }

  /** Remove the ~/.claude/sessions/<pid>.json a spawned child writes for itself. */
  private removePidFileForPid(pid: number): void {
    this.removePidFile(join(homedir(), '.claude', 'sessions', `${pid}.json`));
  }

  /**
   * Unlink a PID file, retrying a few times. On Windows the OS can briefly hold
   * the handle of a just-killed process, so the immediate rmSync fails and the
   * dead file lingers (Issue B). A short backoff clears it without blocking.
   */
  private async removePidFileWithRetry(full: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try { rmSync(full); return; } catch { /* held — retry after a beat */ }
      await new Promise((r) => setTimeout(r, 100));
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
   * Sessions with in-flight BACKGROUND work (a dispatched subagent/Bash still
   * running) even though their main turn is idle. Feeds computeLiveSessionIds
   * alongside getActiveSessionIds so an orchestrator stays live across the whole
   * background window (docs/ticket-live-badge-dark-during-background-subagent.md).
   *
   * Gated on a live `s.q`: if the query/process is gone the background work can't
   * still be running, so a stale set can never pin a dead session "live" — the
   * primary safety, together with clearing the set on teardown/respawn and the
   * SDK's REPLACE-semantics level signal (a completion emits a new, smaller set).
   */
  getBackgroundActiveSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.q && this.computeBackgroundActive(s)) ids.push(id);
    }
    return ids;
  }

  /** Whether this session has in-flight background work — for /api/stream-buffer
   *  and /api/health, which drive the client's background-work dots. */
  isBackgroundActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!(s && s.q && this.computeBackgroundActive(s));
  }

  /**
   * Is the session doing background work right now? Two sources:
   *   1. The live-observed set (background_tasks_changed) — authoritative once the
   *      current CLI process has emitted its first level signal.
   *   2. FALLBACK, only until that first level: a durable scan of the session's
   *      subagent transcripts on disk. This covers a subagent already in flight when
   *      the code (re)loaded, whose dispatch we never observed — the reload gap the
   *      ticket's follow-up calls out. Gated on !sawBackgroundLevelSignal so the
   *      authoritative set takes over cleanly (no post-completion over-report).
   */
  private computeBackgroundActive(s: SdkSession): boolean {
    if (s.backgroundTasks.size > 0) return true;
    if (s.sawBackgroundLevelSignal) return false;
    return this.hasRecentSubagentActivity(s);
  }

  /**
   * Durable liveness probe: has any of the session's subagent transcripts
   * (`<projects>/<slug>/<sid>/subagents/agent-*.jsonl`) been written within
   * SUBAGENT_RUNNING_WINDOW_MS? A running subagent keeps appending, so a recent
   * mtime ⇒ still working; past the window we fail toward not-live. Cached briefly
   * so the frequent live-set recompute doesn't stat the dir every call.
   */
  private hasRecentSubagentActivity(s: SdkSession): boolean {
    const now = Date.now();
    const cached = this.subagentActivityCache.get(s.sessionId);
    if (cached && now - cached.at < 5_000) return cached.active;

    let active = false;
    try {
      const dir = this.subagentsDir(s);
      if (dir) {
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
          if (now - statSync(join(dir, f)).mtimeMs < SUBAGENT_RUNNING_WINDOW_MS) { active = true; break; }
        }
      }
    } catch { /* no dir / unreadable ⇒ not active */ }
    this.subagentActivityCache.set(s.sessionId, { at: now, active });
    return active;
  }

  /** `<transcript dir>/<sid>/subagents`, or null if the project/dir isn't known. */
  private subagentsDir(s: SdkSession): string | null {
    if (!s.projectPath) return null;
    const loc = findSessionJsonlDir(s.sessionId, s.projectPath);
    return loc ? join(loc.dir, s.sessionId, 'subagents') : null;
  }

  /**
   * Heartbeat that keeps backgroundActive correct with NO live event to hang off.
   * The PID scanner only emits when its process set CHANGES, so a warm process that
   * is already alive triggers no live-set recompute — meaning a background subagent
   * that started BEFORE a code reload would never re-light the badge on its own
   * (the ticket's follow-up gap). This tick re-evaluates each live session's
   * backgroundActive (incl. the durable disk fallback) and, on a transition while
   * the MAIN turn is idle, emits session:health — which drives both the Live badge
   * (events-route recompute) and the dots (client). unref'd so it never holds the
   * process open; not started under tests.
   */
  startReconcile(): void {
    if (this.reconcileTimer || IN_TEST) return;
    this.reconcileTimer = setInterval(() => this.reconcileBackgroundActivity(), 8_000);
    this.reconcileTimer.unref();
  }

  /** Stop the heartbeat — called on the OLD instance during an HMR swap so timers
   *  don't accumulate across reloads. */
  stopReconcile(): void {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
  }

  private reconcileBackgroundActivity(): void {
    for (const [id, s] of this.sessions) {
      if (!s.q) { this.lastBgActive.delete(id); continue; }
      const active = this.computeBackgroundActive(s);
      const prev = this.lastBgActive.get(id) ?? false;
      if (active === prev) continue;
      this.lastBgActive.set(id, active);
      // A processing main turn drives its own health AND re-archives via the file
      // watcher, so leave it alone; only act when the main turn is idle.
      if (s.isProcessing) continue;
      this.emitHealth(s, false);
      // Background work just ENDED while the main turn is idle → no main-JSONL
      // change will archive the subagents' trailing tokens. Capture them now.
      if (prev && !active) this.archiveTrailingSubagentUsage(s);
    }
  }

  /**
   * Persist the just-finished subagents' usage for a session whose main turn is
   * idle — the trailing-token case no main-JSONL re-archive would catch (killed
   * mid-background, or a detached Monitor). Targeted refresh (sidechain rows only),
   * fire-and-forget, best-effort. Skipped under tests (no real DB / disk).
   */
  private archiveTrailingSubagentUsage(s: SdkSession): void {
    if (IN_TEST || !s.projectPath) return;
    void refreshSubagentUsage(s.sessionId, s.projectPath).catch((err) =>
      log.warn('sdk.bg', 'trailing subagent-usage refresh failed', {
        sessionId: s.sessionId,
        corrId: s.sessionId,
        data: { error: err instanceof Error ? err.message : String(err) },
      }),
    );
  }

  /**
   * Session ids Fury has a LIVE warm CLI process for, computed from spawnedProcs —
   * independent of whether the session record is still in the `sessions` map.
   *
   * computeLiveSessionIds subtracts these (like sdkManagedIds) so a warm-but-idle
   * Fury process is never counted as live off the PID scanner alone, EVEN IF the
   * session was dropped from the map while its process lived. That desync is what
   * pinned an idle session green (the stale-LIVE-while-idle bug); the manager-level
   * record closes it. Cheap: a small map + a liveness syscall per warm pid, no OS
   * ancestry lookup (we recorded the pids at spawn). Opportunistically prunes dead
   * pids whose 'exit' handler never fired (e.g. externally killed).
   */
  getFuryWarmSessionIds(): string[] {
    const ids = new Set<string>();
    for (const [pid, sid] of this.spawnedProcs) {
      if (pidAlive(pid)) ids.add(sid);
      else this.spawnedProcs.delete(pid);
    }
    return [...ids];
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
    //
    // CRITICAL: reclaim only pids THIS manager spawned (s.spawnedPids), NOT every
    // process whose PID file names this session id. An external interactive
    // terminal writes an indistinguishable PID file (same kind/entrypoint), and
    // hard-killing it here is exactly the regression this path caused — it
    // executed the user's terminal session out from under them on the first Fury
    // send (docs/ticket-resume-live-cli-session-hard-kill.md). An external live
    // owner is handled deliberately upstream (sendMessage → takeoverExternalOwner,
    // gated on a user confirmation); by the time we reach startQuery, any process
    // still alive for this session that we DIDN'T spawn has already been dealt
    // with, and s.spawnedPids holds only our own leaks.
    if (s.abortController && !s.abortController.signal.aborted) {
      try { s.abortController.abort(); } catch { /* best effort */ }
    }
    this.reclaimOwnLeaks(s);
    // A new CLI process is about to spawn. background_tasks_changed is a
    // per-process level signal that emits nothing at startup, so reset the set and
    // let the fresh process repopulate it — otherwise a stale task from the prior
    // process would pin the session "live" until the next membership change.
    s.backgroundTasks.clear();
    s.sawBackgroundLevelSignal = false;

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
        // Spawn the CLI ourselves so we can record the child's pid. This is the
        // ONLY reliable "we own it" signal: Fury's resume subprocess and an
        // external terminal write PID files we can't otherwise tell apart. It
        // mirrors the SDK's default spawnLocalProcess exactly — direct spawn (no
        // shell), windowsHide, and the FORWARDED signal (which fires only after
        // the SDK's stdin-EOF + ~2 s grace window, so it's safe to pass through).
        spawnClaudeCodeProcess: (opts) => {
          const spawnOpts: SpawnOptions = {
            cwd: opts.cwd,
            // opts.env is the SDK's looser {[k]:string|undefined}; Node (with
            // Next's ProcessEnv augmentation) wants NODE_ENV present, which it is
            // at runtime since this derives from process.env.
            env: opts.env as NodeJS.ProcessEnv,
            signal: opts.signal,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          };
          const child: ChildProcess = spawn(opts.command, opts.args, spawnOpts);
          if (typeof child.pid === 'number') {
            const pid = child.pid;
            s.spawnedPids.add(pid);
            // Also record at the MANAGER level (pid -> sessionId), which survives the
            // session record being dropped from the map while its warm process lives.
            // The Live badge uses this to suppress a warm-but-idle Fury process even
            // when the managed-subtract can't (the stale-LIVE-while-idle bug).
            this.spawnedProcs.set(pid, s.sessionId);
            log.debug('sdk.handoff', 'spawned cli', { sessionId: s.sessionId, corrId: s.sessionId, data: { pid } });
            // Prune on exit and sweep the child's own PID file once it's provably
            // gone, so no dead-pid *.json lingers after a normal turn/interrupt.
            child.once('exit', () => {
              s.spawnedPids.delete(pid);
              this.spawnedProcs.delete(pid);
              this.removePidFileForPid(pid);
            });
          }
          // The SDK bypasses its own stderr wiring when a custom spawn is given,
          // so replicate the shipping stderr hook here (usage-limit / provider
          // switch detection point; a log for the prototype).
          child.stderr?.on('data', (d: Buffer) => {
            const trimmed = d.toString().trim();
            if (trimmed) log.warn('sdk.stderr', trimmed.slice(0, 500), { sessionId: s.sessionId, corrId: s.sessionId });
          });
          return {
            stdin: child.stdin!,
            stdout: child.stdout!,
            get killed() { return child.killed; },
            get exitCode() { return child.exitCode; },
            kill: (signal) => child.kill(signal),
            on: (event, listener) => { child.on(event, listener as never); },
            once: (event, listener) => { child.once(event, listener as never); },
            off: (event, listener) => { child.off(event, listener as never); },
          };
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
        log.error('sdk.turn', 'query threw', {
          sessionId: s.sessionId,
          corrId: s.sessionId,
          data: { message },
        });
        this.bufferEvent(s, { type: 'error', content: message, ts: Date.now() });
        eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, error: message });
        s.turnErrorEmitted = true;
      } else {
        log.debug('sdk.turn', 'query aborted', { sessionId: s.sessionId, corrId: s.sessionId });
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
        if (anyMsg.subtype === 'init') {
          this.emitModelIfNew(s, anyMsg.model);
        } else if (anyMsg.subtype === 'api_retry') {
          // A transient API failure the SDK is AUTO-RETRYING (rate_limit /
          // overloaded / connection timeout arrive here, NOT as a fatal assistant
          // error). Surfacing it as session:stream {error} would be wrong — the
          // turn is still going. Log it for diagnosis and leave turnErrorEmitted
          // untouched so a genuine later error can still surface exactly once.
          log.warn('sdk.retry', 'api retry', {
            sessionId: s.sessionId,
            corrId: s.sessionId,
            data: {
              code: anyMsg.error ?? null,
              status: anyMsg.error_status ?? null,
              attempt: anyMsg.attempt ?? null,
              maxRetries: anyMsg.max_retries ?? null,
              delayMs: anyMsg.retry_delay_ms ?? null,
            },
          });
        } else if (anyMsg.subtype === 'background_tasks_changed') {
          // The full set of live background tasks after a membership change
          // (start / completion / kill / a foreground task backgrounded). LEVEL
          // signal → REPLACE the whole set; never pair edges, so a dropped
          // start/stop can't wedge a stale "live". This keeps the session's Live
          // badge + dots lit across the WHOLE background window, not just its main
          // turns (docs/ticket-live-badge-dark-during-background-subagent.md).
          const tasks = Array.isArray(anyMsg.tasks) ? anyMsg.tasks : [];
          s.backgroundTasks = new Set<string>(
            tasks.map((t: { task_id?: unknown }) => t?.task_id).filter((id: unknown): id is string => typeof id === 'string'),
          );
          // The live level is now authoritative for this process; stop using the
          // durable disk fallback (it would otherwise linger for the staleness window
          // after the last task completes).
          s.sawBackgroundLevelSignal = true;
          log.info('sdk.bg', 'background tasks changed', {
            sessionId: s.sessionId,
            corrId: s.sessionId,
            data: { count: s.backgroundTasks.size },
          });
          // Re-emit health so the events route recomputes the live set and the
          // client toggles the background-work dots. Pass the real main-turn state
          // (unchanged); emitHealth attaches the current backgroundActive flag.
          this.emitHealth(s, s.isProcessing);
        } else if (typeof anyMsg.subtype === 'string' && anyMsg.subtype.startsWith('task_')) {
          // Observability for the background-task lifecycle EDGES: task_started /
          // task_notification / task_updated / task_progress. The v24 liveness fix
          // keys on the background_tasks_changed LEVEL signal above (confirmed to
          // fire for real CLI subagents — tests/live-sessions/background-subagent-
          // liveness.spec.ts); these edges are logged for diagnosis and are the
          // fallback signal if the level ever proves unreliable. Low-noise: scoped
          // to task_* so per-token `status`/`thinking_tokens` don't spam the log.
          log.debug('sdk.sys', anyMsg.subtype, {
            sessionId: s.sessionId,
            corrId: s.sessionId,
            data: {
              taskId: typeof anyMsg.task_id === 'string' ? anyMsg.task_id : undefined,
              status: typeof anyMsg.status === 'string' ? anyMsg.status : undefined,
            },
          });
        }
        break;

      case 'stream_event': {
        const ev = anyMsg.event;
        if (!ev) break;
        // Re-assert processing when a NEW main-thread turn begins streaming while
        // the session is marked idle. The SDK runs turns the user never submitted
        // — most commonly a background task (Monitor/Bash/subagent) posting a
        // <task-notification> back into the conversation, which is injected as a
        // user message and drives a full model turn with its own `result`. The
        // submit path (sendMessage) is the only place that turned dots ON, so
        // without this such a turn streams with dots off and its partials leak as
        // intermediary bubbles until it settles (docs/ticket-background-task-
        // notification-turns-render-dark.md). message_start (or the first delta)
        // is the earliest signal a turn has begun. Guard to the MAIN thread so a
        // forwarded subagent block can't flip the session's liveness.
        if (
          anyMsg.parent_tool_use_id == null &&
          (ev.type === 'message_start' || ev.type === 'content_block_delta')
        ) {
          this.reassertProcessing(s);
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (!s.ttftEmitted) {
            s.ttftEmitted = true;
            const ttft = Date.now() - (s.turnStartedAt ?? Date.now());
            log.info('sdk.turn', 'ttft', {
              sessionId: s.sessionId,
              corrId: s.sessionId,
              data: { ttftMs: ttft, sdkTtftMs: anyMsg.ttft_ms ?? null },
            });
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

        // Surface a failure the SDK reports WITHOUT throwing — most importantly an
        // expired OAuth token. Such a failure arrives as a COMPLETE assistant
        // message, not as stream_event text deltas, so none of the streaming path
        // runs: the UI would show the dots vanish and then silence (the "are you
        // still there?" bug in session 87487df4). Emit it as an error so it's
        // visible instead of swallowed. Main thread only — a subagent's failure is
        // its own business, not a main-turn failure.
        //
        // PRIMARY signal is the typed `error` field (SDKAssistantMessageError:
        // 'authentication_failed', 'billing_error', …) — stable and specific.
        // `model === '<synthetic>'` is only a legacy FALLBACK: it's broader (it
        // also tags benign injected stubs like compaction / "no response
        // requested"), so we act on it only when the typed code is absent AND the
        // synthetic message actually carries text.
        if (anyMsg.parent_tool_use_id == null && !s.turnErrorEmitted) {
          const code: SDKAssistantMessageError | undefined = anyMsg.error;
          const text = this.textFromContent(anyMsg.message?.content);
          const legacySynthetic = !code && anyMsg.message?.model === '<synthetic>' && !!text;
          // rate_limit / overloaded are TRANSIENT — the SDK retries them (they also
          // arrive as api_retry system messages) and the turn can still finish
          // successfully. Surfacing them here would leave a fatal error bubble the
          // success result never clears (that branch only logs, and turnErrorEmitted
          // is sticky). A genuinely terminal rate limit comes back as a NON-success
          // result and is caught by the result branch below.
          const transient = code === 'rate_limit' || code === 'overloaded';
          if (transient) {
            log.warn('sdk.retry', 'assistant transient error (not surfaced)', {
              sessionId: s.sessionId,
              corrId: s.sessionId,
              data: { code },
            });
          } else if (code || legacySynthetic) {
            const errText = this.assistantErrorText(code, text);
            log.error('sdk.turn', 'assistant error surfaced', {
              sessionId: s.sessionId,
              corrId: s.sessionId,
              data: { code: code ?? null, synthetic: legacySynthetic, text: errText.slice(0, 500) },
            });
            this.bufferEvent(s, { type: 'error', content: errText, ts: Date.now() });
            eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, error: errText });
            s.turnErrorEmitted = true;
          }
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
        // NO sidechain guard here — and that is deliberate. SDKResultMessage
        // (SDKResultSuccess | SDKResultError) has NO parent_tool_use_id field at
        // all (only assistant/user messages carry it), so the old
        // `if (anyMsg.parent_tool_use_id != null) break;` was ALWAYS dead code:
        // the value is forever undefined and the guard never fired. It was added
        // in v18 for a hypothetical top-level subagent result that the SDK never
        // emits. Every result ends the current turn; the re-assert on the next
        // turn's stream activity (above) is what keeps a burst of background-task
        // turns live. If a real subagent-result discriminator ever appears in the
        // SDK, key on THAT — don't resurrect the parent_tool_use_id check.
        const wasProcessing = s.isProcessing;
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
        if (anyMsg.subtype === 'success') {
          log.info('sdk.turn', 'done', {
            sessionId: s.sessionId,
            corrId: s.sessionId,
            data: {
              subtype: anyMsg.subtype,
              durationMs: anyMsg.duration_ms ?? null,
              ttftMs: anyMsg.ttft_ms ?? null,
              warmSpare: anyMsg.warm_spare_claimed ?? false,
              costUsd: anyMsg.total_cost_usd ?? null,
            },
          });
        } else {
          // A non-success result ends the turn on an error the SDK did NOT throw
          // (e.g. subtype 'error_during_execution', 'error_max_turns'). Previously
          // this was swallowed entirely — isProcessing flipped false with nothing
          // shown. Log it, and if the turn hasn't already surfaced an error (the
          // assistant-error path usually has, for auth), surface a fallback so the
          // UI never just goes silent.
          //
          // The detail lives in `errors[]` (+ `terminal_reason`), NOT `result` —
          // only SDKResultSuccess has a `result` string. Reading anyMsg.result
          // here always got undefined and dropped the real cause; build from the
          // right fields instead.
          const detail =
            Array.isArray(anyMsg.errors) && anyMsg.errors.length
              ? anyMsg.errors.join('; ')
              : anyMsg.terminal_reason
                ? `terminated: ${anyMsg.terminal_reason}`
                : '';
          const errText = detail || `Turn ended with error (${anyMsg.subtype ?? 'unknown'}).`;
          log.error('sdk.turn', 'done (error)', {
            sessionId: s.sessionId,
            corrId: s.sessionId,
            data: {
              subtype: anyMsg.subtype ?? null,
              terminalReason: anyMsg.terminal_reason ?? null,
              durationMs: anyMsg.duration_ms ?? null,
              result: errText.slice(0, 500),
            },
          });
          if (!s.turnErrorEmitted) {
            this.bufferEvent(s, { type: 'error', content: errText, ts: Date.now() });
            eventBus.emitApp({ type: 'session:stream', sessionId: s.sessionId, error: errText });
            s.turnErrorEmitted = true;
          }
        }
        // AFTER any error surfacing above: the client's session-stream handler
        // drops events once transcriptLoading is false, and this flips it false.
        //
        // Emit idle ONLY when we actually transitioned from processing. A window
        // of background-task turns produces many back-to-back results; gating on
        // wasProcessing collapses those to one idle per real processing→idle
        // cycle instead of a burst of redundant idle events (each of which would
        // otherwise race the next turn's re-assert). The startedAt-anchored strip
        // means a brief result→message_start→result flap still re-strips cleanly.
        if (wasProcessing) this.emitHealth(s, false);
        break;
      }
    }
  }

  /**
   * Re-enter the processing/dots state for a turn that began streaming while the
   * session was marked idle — a turn Fury never submitted (a background task's
   * <task-notification>, an auto-continue, any SDK-initiated turn). No-op when
   * already processing, so it never disturbs a normal submitted turn (sendMessage
   * sets isProcessing before any event arrives) or fires twice within one turn.
   *
   * Mirrors sendMessage's per-turn setup: reopen a FRESH stream buffer with a new
   * startedAt (the strip anchor the client's latch-break re-strips on — reuses the
   * v22 startedAt-on-health work), reset the per-turn tally and flags, then
   * emitHealth(true). The buffer MUST be set before emitHealth so the re-emitted
   * session:health carries the new turn's anchor, not a stale/closed one.
   */
  private reassertProcessing(s: SdkSession): void {
    if (s.isProcessing) return;
    const now = Date.now();
    s.isProcessing = true;
    s.startedAt = now;
    s.turnStartedAt = now;
    s.ttftEmitted = false;
    s.turnErrorEmitted = false;
    // A background turn has no user-typed prompt; the client strips its partials
    // by the startedAt anchor, not userPrompt, so an empty prompt is correct here.
    s.streamBuffer = {
      userPrompt: '',
      accumulatedText: '',
      events: [],
      isActive: true,
      startedAt: now,
    };
    // Per-turn token tally is session-lived here, so reset it as sendMessage does
    // or turnTokens would silently become cumulative across the notification turns.
    // UI effect: the live turn-token counter visibly restarts at 0 for each
    // background turn — correct (each is its own turn), just cosmetically distinct
    // from one continuous submit→result count.
    s.usageByMsg.clear();
    s.lastEmittedTokens = -1;
    log.info('sdk.turn', 'reassert', {
      sessionId: s.sessionId,
      corrId: s.sessionId,
      data: { startedAt: now },
    });
    this.emitHealth(s, true);
  }

  /**
   * Pull human-readable text out of an SDK message `content` (or a result's
   * `result` field), which may be a string or an array of content blocks. Used to
   * surface synthetic/error messages that would otherwise be swallowed.
   */
  private textFromContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((b) => (b && typeof b === 'object' && (b as any).type === 'text' ? String((b as any).text ?? '') : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    return '';
  }

  /**
   * Human-readable text for a typed assistant error code. The friendly cases get
   * an actionable message; the rest defer to the SDK's own prose (`text`) and fall
   * back to a coded string only when there is none. `code` is undefined on the
   * legacy `<synthetic>` fallback path, where `text` is all we have.
   */
  private assistantErrorText(code: SDKAssistantMessageError | undefined, text: string): string {
    switch (code) {
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
        return 'Authentication failed — your session may have expired. Run `/login` and retry.';
      case 'billing_error':
        return 'Billing error — check your plan or credits.';
      case 'model_not_found':
        return 'The selected model is unavailable for this account.';
      case 'max_output_tokens':
        return text || 'The response reached the maximum output length.';
      // invalid_request / server_error / overloaded / rate_limit / unknown, or no
      // code at all (legacy synthetic): the SDK's own text is the most accurate
      // thing we have — pass it through, else a coded/last-resort fallback.
      default:
        return text || (code ? `The model reported an error (${code}).` : 'The model reported an error.');
    }
  }

  private emitHealth(s: SdkSession, isProcessing: boolean): void {
    // Carry the turn's start so the client's latch-break can anchor its re-strip
    // on the SAME timestamp the initial restore uses (/api/stream-buffer returns
    // this exact buffer.startedAt). Without it the latch-break anchored on 0 and
    // fell back to the trailing-assistant heuristic, which over-strips a prior
    // completed turn when a mid-turn prompt was folded into a tool_result — the
    // regression the anchor exists to prevent. Only load-bearing on the
    // isProcessing:true branch; harmless (and still correct) on idle, where the
    // buffer is closed-but-retained so startedAt is still present.
    const startedAt = s.streamBuffer?.startedAt;
    // Live iff the main turn is processing OR a background task is still running.
    // The client shows the dots on either, and the events route counts this toward
    // the Live badge — closing the dark gap between the orchestrator's turns.
    // computeBackgroundActive includes the durable disk fallback for tasks in flight
    // across a code reload.
    const backgroundActive = this.computeBackgroundActive(s);
    log.debug('sdk.health', isProcessing ? 'processing' : 'idle', {
      sessionId: s.sessionId,
      corrId: s.sessionId,
      data: { startedAt, backgroundActive },
    });
    eventBus.emitApp({ type: 'session:health', sessionId: s.sessionId, isProcessing, isStuck: false, startedAt, backgroundActive });
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
// 19: structured logging (lib/logger.ts) throughout handle()/startQuery/consume,
//     AND the swallowed-error fix — synthetic assistant messages and non-success
//     results are now surfaced to the client as session:stream {error}. Without
//     this bump the live instance keeps the old method bodies and neither the
//     logs nor the error surfacing fire.
// 20: live-CLI handoff fix (docs/ticket-resume-live-cli-session-hard-kill.md).
//     startQuery no longer SIGKILLs by session-id match. Ownership is now proven,
//     never inferred from PID-file fields (kind/entrypoint/startedAt are identical
//     for Fury's own spawn and an external terminal): PRIMARY is a recorded spawn
//     pid (custom spawnClaudeCodeProcess → s.spawnedPids), FALLBACK is process
//     ancestry (parentPidOf(pid) === process.pid). reclaimOwnLeaks kills only our
//     recorded pids; detectExternalOwner (isFuryOwned = record ∨ ancestry) gates a
//     confirmed graceful takeover (takeoverExternalOwner, via sendMessage's
//     confirmTakeover); reapOrphanedProcesses gains the same ancestry safeguard so
//     its startedAt heuristic can't reap a live external terminal. It and
//     detectExternalOwner are now async. Without this bump the live instance keeps
//     the old kill-on-match startQuery and the regression persists.
// 21: SDK error surfacing hardening (docs/ticket-sdk-error-surfacing-improvements.md).
//     assistant errors are detected via the typed `error` field
//     (SDKAssistantMessageError) mapped to human text by assistantErrorText, with
//     `<synthetic>`-with-text kept only as a legacy fallback; the transient codes
//     rate_limit/overloaded are NOT surfaced here (the SDK retries them and the turn
//     can still succeed — a fatal bubble would never clear; a terminal one returns as
//     a non-success result). result errors read detail from errors[]/terminal_reason
//     (not the nonexistent result field on an error result); system 'api_retry' is
//     logged (sdk.retry) and NOT surfaced as fatal; error logs carry {code,
//     terminal_reason, subtype}. Without this bump the live instance keeps the old
//     <synthetic>/anyMsg.result method bodies.
// 22: emitHealth now carries the turn's startedAt (from s.streamBuffer?.startedAt,
//     the same anchor /api/stream-buffer returns) on session:health events, so the
//     client's latch-break re-strip anchors on the real turn start instead of
//     falling back to the trailing-assistant heuristic that over-strips an earlier
//     completed turn (docs/ticket-inflight-partials-health-startedat.md). Without
//     this bump the live instance keeps the old emitHealth body and ships health
//     events with no startedAt.
// 23: background-task turns keep dots (docs/ticket-background-task-notification-
//     turns-render-dark.md). handle() now RE-ASSERTS processing when a main-thread
//     turn begins streaming (message_start / first content_block_delta) while the
//     session is marked idle — the SDK runs turns the user never submitted (a
//     background Monitor/Bash/subagent posting a <task-notification>), and only the
//     submit path used to turn dots on, so those turns streamed dark and leaked
//     partial bubbles. reassertProcessing reopens a fresh stream buffer with a new
//     startedAt and emits session:health {processing,startedAt}, which the client's
//     v22 latch-break re-strips on. The 'result' case now emits idle only when
//     transitioning from processing (collapsing a burst of background-turn results
//     to one idle per cycle) and its always-dead parent_tool_use_id sidechain guard
//     was removed (results carry no such field). Without this bump the live instance
//     keeps the old submit-only dots and flips idle at the first result.
// 24: background-task LIVENESS across the wait between turns
//     (docs/ticket-live-badge-dark-during-background-subagent.md). Fix #23 keeps dots
//     once a background turn STREAMS; this keeps the session live during the WAIT
//     before it starts. SdkSession.backgroundTasks tracks in-flight background agents
//     from the SDK's `system/background_tasks_changed` LEVEL signal (REPLACE each
//     payload); getBackgroundActiveSessionIds/isBackgroundActive expose it; emitHealth
//     carries `backgroundActive`. computeLiveSessionIds + both live-session routes add
//     it to the Live badge, and the client shows dots on it. Set cleared on startQuery
//     (new process) and teardown; gated on live s.q. Without this bump the live
//     instance keeps the old emitHealth/handle bodies and the gap stays dark.
// 25: 'sdk.sys' debug log for the background-task lifecycle EDGES (task_started/
//     task_notification/task_updated/task_progress). Confirmed via a real subagent
//     orchestration (tests/live-sessions/background-subagent-liveness.spec.ts) that
//     the v24 background_tasks_changed LEVEL signal DOES fire for CLI subagents; the
//     edges are logged for diagnosis / as a fallback signal. Observability only.
// 26: stale-LIVE-while-idle fix. A persistent SDK session's warm CLI process lingers
//     in the PID scanner between turns; computeLiveSessionIds removed it ONLY via map
//     membership (sdkManagedIds), so a session that dropped out of the map while its
//     process lived stayed pinned green. Added a manager-level spawnedProcs (pid ->
//     sessionId) recorded at spawn / pruned on exit / carried across HMR;
//     getFuryWarmSessionIds() derives the warm set from it, and computeLiveSessionIds
//     + both live-session routes subtract it independent of the map. Without this bump
//     the live instance keeps the old spawn body and never records spawnedProcs.
// 27: reconcile background liveness ACROSS a code reload (ticket follow-up). A
//     subagent already in flight when the module reloads left the new instance's
//     backgroundTasks empty → dark. backgroundActive now falls back (until the CLI's
//     first level signal this process) to a durable scan of the session's
//     subagents/agent-*.jsonl mtimes (computeBackgroundActive/hasRecentSubagentActivity),
//     and an unref'd reconcile heartbeat emits session:health on transitions so the
//     badge + dots re-light without a scanner change. Fails toward not-live after
//     SUBAGENT_RUNNING_WINDOW_MS. Without this bump the live instance keeps the old
//     level-only emitHealth and the reload gap stays dark.
// 28: the reconcile heartbeat now also archives TRAILING subagent usage — when
//     background work ends while the main turn is idle, it fires a targeted
//     refreshSubagentUsage so the sidecar tokens land in usage_events even though no
//     main-JSONL change (which is what the archiver keys on) will ever archive them
//     (docs/ticket-stats-undercount-subagent-tokens.md, review Note 1). Without this
//     bump the live instance keeps the old reconcile body and the trailing gap stays.
const SINGLETON_VERSION = 28;
const globalForSdk = globalThis as unknown as {
  __sdkSessionManager?: SdkSessionManager;
  __sdkSessionManagerV?: number;
};
if (!globalForSdk.__sdkSessionManager || globalForSdk.__sdkSessionManagerV !== SINGLETON_VERSION) {
  const previous = globalForSdk.__sdkSessionManager;
  // Stop the OLD instance's reconcile heartbeat so timers don't pile up across HMR.
  try { previous?.stopReconcile(); } catch { /* older instance without the method */ }
  const replacement = new SdkSessionManager();
  if (previous) replacement.adoptSessionsFrom(previous);
  replacement.startReconcile();
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
