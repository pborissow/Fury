/**
 * Structured, correlated logging for Fury.
 *
 * WHY THIS EXISTS: the SDK pivot produced failures that were real on the server
 * but invisible in the UI — most sharply, an auth failure that the SDK returns as
 * a synthetic assistant message. The turn ends, the dots vanish, and the user
 * sees silence ("are you still there?"). Nothing was logged anywhere, so there
 * was no way to line up "the UI cleared the dots at 21:15:49" against "the server
 * still had isProcessing:true for that session". This logger is the shared spine
 * that closes that loop.
 *
 * Both halves of the app write into ONE stream:
 *   - server code calls `log.info(...)` etc. directly (source: 'server')
 *   - the browser batches events to POST /api/telemetry, which replays them here
 *     via `ingestUiEntry` (source: 'ui')
 * Because every entry carries `ts`, `sessionId`, and `corrId`, the daily JSONL
 * file interleaves UI and server events for the same session in timestamp order —
 * exactly the view the inflight-partials investigation had to reconstruct by hand.
 *
 * Node runtime only (uses fs/os). Do NOT import from client components — the
 * browser goes through lib/clientTelemetry.ts instead.
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { furyLogsDir } from './furyHome';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'server' | 'ui';

export interface LogEntry {
  /** epoch ms — the join key across UI and server. */
  ts: number;
  level: LogLevel;
  source: LogSource;
  /** dotted namespace, e.g. 'sdk.turn', 'chat.healthPoll'. */
  scope: string;
  msg: string;
  /** The session this line is about, when applicable. */
  sessionId?: string;
  /** Correlation id: a per-turn id on the server, a per-tab id in the UI. Lets a
   *  single conversation's UI and server lines be grepped together. */
  corrId?: string;
  /** Arbitrary structured fields. Kept small — this is a log, not a transcript. */
  data?: Record<string, unknown>;
}

/** A UI-sourced entry as it arrives over the wire (untrusted shape). */
export interface RawUiEntry {
  ts?: number;
  level?: string;
  scope?: string;
  msg?: string;
  sessionId?: string;
  corrId?: string;
  data?: Record<string, unknown>;
}

// Resolved lazily (NOT at import time): this module loads before the startup
// migration in server.ts runs, and lib/furyHome's read-fallback could capture
// the legacy ~/.claude/fury-logs path that the migration is about to move.
const logDir = () => furyLogsDir();
// Under the test runner, keep the console mirror but don't append to the durable
// daily file — unit tests import sdkSessionManager (which logs) and shouldn't
// pollute the user's real ~/.fury/logs.
const IN_TEST = !!process.env.VITEST || process.env.NODE_ENV === 'test';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL =
  LEVEL_ORDER[(process.env.FURY_LOG_LEVEL as LogLevel)] ?? LEVEL_ORDER.debug;

// mkdir is idempotent and cheap, but cache the promise so we don't issue one per
// line. Module-scope is fine: on HMR the module re-evals and re-mkdirs once,
// which is harmless (recursive:true no-ops when the dir exists).
let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(logDir(), { recursive: true })
      .then(() => undefined)
      .catch(() => undefined);
  }
  return dirReady;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Daily rolling file — one JSONL per calendar day (local time). */
function fileForTs(ts: number): string {
  const d = new Date(ts);
  return join(logDir(), `fury-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
}

function consoleLine(e: LogEntry): string {
  const d = new Date(e.ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sid = e.sessionId ? ` ${e.sessionId.slice(0, 8)}` : '';
  const hasData = e.data && Object.keys(e.data).length > 0;
  const data = hasData ? ` ${JSON.stringify(e.data)}` : '';
  return `[${time}] ${e.level.toUpperCase().padEnd(5)} ${e.source}/${e.scope}${sid} ${e.msg}${data}`;
}

/**
 * The one sink. Never throws and never rejects into the caller — logging must not
 * be able to break a request or a turn. File writes are fire-and-forget.
 */
function write(e: LogEntry): void {
  if ((LEVEL_ORDER[e.level] ?? 0) < MIN_LEVEL) return;

  const line = consoleLine(e);
  if (e.level === 'error' || e.level === 'warn') console.error(line);
  else console.log(line);

  if (IN_TEST) return;

  void ensureDir().then(() =>
    appendFile(fileForTs(e.ts), JSON.stringify(e) + '\n', 'utf-8').catch(() => {
      // Best-effort: a failed log write must not surface anywhere.
    }),
  );
}

export interface LogOpts {
  sessionId?: string;
  corrId?: string;
  data?: Record<string, unknown>;
}

function serverLog(level: LogLevel, scope: string, msg: string, opts?: LogOpts): void {
  write({
    ts: Date.now(),
    level,
    source: 'server',
    scope,
    msg,
    sessionId: opts?.sessionId,
    corrId: opts?.corrId,
    data: opts?.data,
  });
}

/** Server-side logging surface. `log.info('sdk.turn', 'start', { sessionId })`. */
export const log = {
  debug: (scope: string, msg: string, opts?: LogOpts) => serverLog('debug', scope, msg, opts),
  info: (scope: string, msg: string, opts?: LogOpts) => serverLog('info', scope, msg, opts),
  warn: (scope: string, msg: string, opts?: LogOpts) => serverLog('warn', scope, msg, opts),
  error: (scope: string, msg: string, opts?: LogOpts) => serverLog('error', scope, msg, opts),
};

const VALID_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Ingest one UI-sourced entry from POST /api/telemetry. Defensive: the shape is
 * client-controlled, so every field is validated/clamped before it lands in the
 * shared log. `data` is passed through as-is (already JSON from the request body)
 * but capped so a runaway client can't bloat the file.
 */
export function ingestUiEntry(raw: RawUiEntry): void {
  if (!raw || typeof raw !== 'object') return;
  const level = (typeof raw.level === 'string' && VALID_LEVELS.has(raw.level) ? raw.level : 'info') as LogLevel;
  const scope = typeof raw.scope === 'string' ? raw.scope.slice(0, 80) : 'ui';
  const msg = typeof raw.msg === 'string' ? raw.msg.slice(0, 2000) : '';
  if (!msg) return;
  // Trust the client's timestamp only if it's a sane recent value; otherwise the
  // server clock wins. Skew would scramble the interleaving this whole file is
  // for, so bound it to ±5 min of now.
  const now = Date.now();
  const ts = typeof raw.ts === 'number' && Math.abs(now - raw.ts) < 5 * 60_000 ? raw.ts : now;

  let data = raw.data && typeof raw.data === 'object' ? raw.data : undefined;
  if (data) {
    const serialized = JSON.stringify(data);
    if (serialized.length > 4000) data = { _truncated: true, preview: serialized.slice(0, 4000) };
  }

  write({
    ts,
    level,
    source: 'ui',
    scope,
    msg,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 64) : undefined,
    corrId: typeof raw.corrId === 'string' ? raw.corrId.slice(0, 64) : undefined,
    data,
  });
}

/** Where the logs are, for surfacing in diagnostics/UI if ever needed. */
export function logDirectory(): string {
  return logDir();
}
