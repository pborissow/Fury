/**
 * Process-level crash guards for the custom Node entrypoint.
 *
 * WHY THIS EXISTS: a client that disconnects mid-response (browser navigates
 * away from the `/api/events` SSE stream, a fetch is aborted, a Playwright test
 * closes a page) makes Node emit `'error'` — `Error: aborted` / `ECONNRESET` —
 * on the request stream. With no listener that becomes an `uncaughtException`,
 * and `server.ts` had no handler for it, so one ordinary disconnect killed the
 * whole process: every SDK session, SSE stream and MCP connection with it.
 *
 * It was made a *certain* kill by a transitive dependency. `phonemizer`
 * (kokoro-js → @huggingface/transformers → phonemizer) registers, at module
 * load:
 *
 *   process.on("uncaughtException", (e) => { if (!(e instanceof PhonemizeError)) throw e });
 *   process.on("unhandledRejection", (e) => { throw e });
 *
 * A throw from inside an `uncaughtException` listener is fatal to Node no
 * matter what other listeners exist — so simply adding our own handler is not
 * enough while that one is armed. Hence the two exports here:
 *
 *   - `installProcessGuards()` — our own log-and-continue handlers.
 *   - `importWithoutProcessHandlers()` — loads a module and strips any
 *     `uncaughtException` / `unhandledRejection` listener it registered on the
 *     way in, so a dependency cannot install a fatal handler behind our back.
 *
 * See docs/ticket-server-crash-on-aborted-request.md.
 */
import { log } from './logger';

/** Events a dependency must not be allowed to hijack. */
const GUARDED_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;
type GuardedEvent = (typeof GUARDED_EVENTS)[number];

/** Socket-level codes that mean "the peer went away", not "we are broken". */
const BENIGN_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);

/**
 * True for errors that are a normal consequence of a client disconnecting.
 * These are noise: the request is already over and nothing is left to do.
 */
export function isBenignClientAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string' && BENIGN_CODES.has(e.code)) return true;
  if (e.name === 'AbortError') return true;
  return typeof e.message === 'string' && /\baborted\b/i.test(e.message);
}

/** Small, log-safe projection of an unknown thrown value. */
function describe(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: (err as NodeJS.ErrnoException).code,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return { value: String(err).slice(0, 500) };
}

let installed = false;

/**
 * Register the process-level handlers. Idempotent — safe to call from more
 * than one entrypoint.
 *
 * Deliberately does NOT exit. A single aborted request must not be able to
 * take down every live session; a genuine bug is loud in the log instead
 * (`server.guard`, and mirrored to the console by lib/logger).
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    if (isBenignClientAbort(err)) {
      log.debug('server.guard', 'uncaughtException: client abort (ignored)', { data: describe(err) });
      return;
    }
    log.error('server.guard', 'uncaughtException (server kept alive)', { data: describe(err) });
  });

  process.on('unhandledRejection', (reason) => {
    if (isBenignClientAbort(reason)) {
      log.debug('server.guard', 'unhandledRejection: client abort (ignored)', { data: describe(reason) });
      return;
    }
    log.error('server.guard', 'unhandledRejection (server kept alive)', { data: describe(reason) });
  });
}

/**
 * Load a module, then remove any `uncaughtException` / `unhandledRejection`
 * listener it registered while loading.
 *
 * Used for the TTS stack, whose transitive `phonemizer` dependency installs a
 * rethrowing handler at module scope (see the file header). Snapshotting before
 * and diffing after is precise: listeners the app registered earlier are left
 * alone, and only the ones that appeared during this import are dropped.
 *
 * Runs on the failure path too — a partially-evaluated module can still have
 * gotten as far as its `process.on` calls.
 */
export async function importWithoutProcessHandlers<T>(label: string, load: () => Promise<T>): Promise<T> {
  // Through the plain EventEmitter surface: process's own typed overloads only
  // accept signal names for the generic listener/removeListener forms.
  const emitter = process as NodeJS.EventEmitter;
  const before = new Map<GuardedEvent, Set<unknown>>(
    GUARDED_EVENTS.map((ev) => [ev, new Set<unknown>(emitter.listeners(ev))]),
  );
  try {
    return await load();
  } finally {
    for (const ev of GUARDED_EVENTS) {
      const known = before.get(ev)!;
      for (const listener of emitter.listeners(ev)) {
        if (known.has(listener)) continue;
        emitter.removeListener(ev, listener as (...args: unknown[]) => void);
        log.warn('server.guard', `stripped ${ev} handler installed by ${label}`);
      }
    }
  }
}
