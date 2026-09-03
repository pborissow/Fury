/**
 * Empirically-learned model context windows.
 *
 * The problem this solves: `CONTEXT_WINDOWS` in lib/pricing.ts stores each
 * model's MAXIMUM capability (the 1M ceiling behind the opt-in `[1m]` variant),
 * not the window the app actually serves — so it can't answer "how full is this
 * session" or "what's the base window for model X". See
 * docs/ticket-model-context-size-variant.md.
 *
 * Instead we learn windows from ground truth — the served window the SDK reports
 * on each `result` (`modelUsage[id].contextWindow`) — across three layers:
 *
 *   1. SHIPPED SEED  (lib/model-windows.json, committed) — a maintainer-captured
 *      set of served windows, so a fresh install inherits what we've learned
 *      without having to observe every model itself.
 *   2. LOCAL RUNTIME (this module's write-back) — as the app observes real
 *      served windows it enriches the JSON in place (confirmed-only, merge-not-
 *      overwrite, only-on-new-knowledge), which collaborators commit upstream.
 *   3. DERIVED       (deriveObservedWindows over usage_events) — the historical
 *      view for backfill/analytics.
 *
 * A window is only trusted when it's a REAL capture. The 1M ceiling is treated
 * as "unconfirmed" for a base until we see the model served *below* it: a value
 * that only ever equals the ceiling may just be the db.ts backfill's inference,
 * not an observation.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { Client } from '@libsql/client';
import { atomicWriteFile } from './atomicWrite';
import { normalizeModelId } from './pricing';

/** The largest variant window today. A base equal to it is unconfirmed — we've
 *  never seen the model served smaller, so we can't distinguish its real base
 *  from a run that opted into the 1M variant (or from the backfill's guess). */
export const WINDOW_CEILING = 1_000_000;

export interface WindowEntry {
  /** Smallest served window ever observed — the base/default. */
  base: number;
  /** Largest served window ever observed (the variant ceiling). Equals `base`
   *  until a distinct larger variant is seen. Optional only for hand-written
   *  seed entries; the writer always populates it. */
  ceiling?: number;
  /** Where the current `base` came from. */
  source: 'probe' | 'observed';
  /** ISO day (YYYY-MM-DD) the entry was last changed. */
  at: string;
}

interface WindowFile {
  version: number;
  note?: string;
  models: Record<string, WindowEntry>;
}

// process.cwd() is the repo root under `tsx server.ts`. Unlike the user-data
// stores (now under ~/.fury — see lib/furyHome.ts), this seed file IS part of
// the repo: the running app enriches it in place, so it must be the on-disk
// source file, not a bundled copy. The env override exists so tests can point
// at a throwaway file instead of clobbering the real seed.
const FILE = process.env.FURY_MODEL_WINDOWS_PATH ?? join(process.cwd(), 'lib', 'model-windows.json');

let cache: WindowFile | null = null;

function load(): WindowFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    cache = parsed && typeof parsed === 'object' && parsed.models
      ? parsed as WindowFile
      : { version: 1, models: {} };
  } catch {
    cache = { version: 1, models: {} };
  }
  return cache;
}

/** The seed/enriched entry for a raw model id (normalized), or null. */
export function windowFor(model: string | null | undefined): WindowEntry | null {
  if (!model) return null;
  return load().models[normalizeModelId(model)] ?? null;
}

/**
 * The best-known CONFIRMED base (default served) window for a model, or null
 * when we don't have a trustworthy one. This is the empirical replacement for
 * pricing.ts's CONTEXT_WINDOWS (which stored the 1M *ceiling*, not the base).
 * Null means "unknown" — callers must stay silent rather than guess.
 */
export function baseWindowFor(model: string | null | undefined): number | null {
  const e = windowFor(model);
  return hasConfirmedBase(e) ? e!.base : null;
}

/**
 * True when the base is trustworthy. Two ways to earn it:
 *   - `source: 'probe'` — a controlled bare-id capture is authoritative even at
 *     1M (some models genuinely default to a 1M window; the probe proves it).
 *   - seen served BELOW the ceiling — a base under 1M can't be the backfill's
 *     guess, so a runtime `observed` value confirms itself.
 * A model only ever `observed` at the 1M ceiling stays unconfirmed: that value
 * may just be db.ts's inference, not a real base.
 */
export function hasConfirmedBase(entry: WindowEntry | null): boolean {
  if (!entry || !(entry.base > 0)) return false;
  return entry.source === 'probe' || entry.base < WINDOW_CEILING;
}

/** True if ANY model has a confirmed base. Lets the backfill skip its whole
 *  archive scan when there's nothing it could fill (empty seed / pre-probe). */
export function hasAnyConfirmedWindow(): boolean {
  return Object.values(load().models).some(e => hasConfirmedBase(e));
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Record a REAL served window (an SDK capture or a probe result — never the
 * db.ts inference). Merges into the JSON: adds a new model, lowers `base` when a
 * smaller window is seen, raises `ceiling` when a larger one is. Writes only
 * when something actually changed (so the tree isn't perpetually dirty), sorts
 * keys for reviewable diffs, and writes atomically (two Fury processes share a
 * cwd). Best-effort: a failed write costs a data point, never a turn.
 *
 * Returns what happened, for the probe/logs.
 */
export async function recordServedWindow(
  model: string | null | undefined,
  servedWindow: number,
  source: 'probe' | 'observed' = 'observed',
): Promise<'added' | 'improved' | 'unchanged'> {
  if (!model || !(servedWindow > 0)) return 'unchanged';
  const id = normalizeModelId(model);
  const file = load();
  const prev = file.models[id];
  let outcome: 'added' | 'improved' | 'unchanged' = 'unchanged';

  if (!prev) {
    // base and ceiling coincide until a distinct larger window is seen. Always
    // set ceiling (not conditionally) so a later equal window is correctly a
    // no-op rather than treating an absent ceiling as 0 and "raising" it.
    file.models[id] = { base: servedWindow, ceiling: servedWindow, source, at: todayISO() };
    outcome = 'added';
  } else {
    const next: WindowEntry = { ...prev };
    if (servedWindow < prev.base) {
      next.base = servedWindow;
      next.source = source;
      outcome = 'improved';
    }
    if (servedWindow > (prev.ceiling ?? 0)) {
      next.ceiling = servedWindow;
      if (outcome === 'unchanged') outcome = 'improved';
    }
    if (outcome === 'unchanged') return 'unchanged';
    next.at = todayISO();
    file.models[id] = next;
  }

  // Deterministic serialization — sorted keys keep commit diffs minimal.
  const sorted: WindowFile = { version: file.version, note: file.note, models: {} };
  for (const k of Object.keys(file.models).sort()) sorted.models[k] = file.models[k];
  cache = sorted;
  try {
    await atomicWriteFile(FILE, JSON.stringify(sorted, null, 2) + '\n');
  } catch {
    /* best-effort: never let a data-file write break a turn */
  }
  return outcome;
}

export interface ObservedWindow {
  base: number;
  ceiling: number;
  /** Seen served below the ceiling ⇒ a real base observation, not the guess. */
  confirmed: boolean;
  /** Largest prompt actually assembled — a hard lower bound on some served window. */
  maxPromptSeen: number;
}

/**
 * Derive per-model served windows from historical usage_events (main thread
 * only). `base = MIN(non-zero served window)`, `confirmed = base < ceiling`.
 *
 * Contamination note — two writers put non-capture values into context_window:
 *   1. The old inference (db.ts) and the old windowForMainModel max-bug only
 *      ever wrote the 1M CEILING, which can't win a MIN as long as one real
 *      smaller capture exists — so it never fabricates a smaller base.
 *   2. The base-window backfill (db.ts) writes SUB-ceiling values (e.g. 200k),
 *      so `MIN` CAN now land on a backfilled value, and `confirmed` for it is
 *      technically self-referential rather than an independent SDK capture.
 *      This is SAFE because that backfill only writes `baseWindowFor(model)`,
 *      which is non-null solely for models already confirmed in this JSON — so a
 *      sub-ceiling value read back here can only ECHO an existing confirmation,
 *      never manufacture a new one for a genuinely-unknown model.
 *
 * Net: `confirmed` here means "we have a trustworthy base" (probe-seeded and/or
 * SDK-observed), not strictly "independently SDK-observed". The sole consumer —
 * the probe's target selection — only uses it to skip models already known, so
 * an echoed confirmation is exactly the right behaviour.
 */
export async function deriveObservedWindows(db: Client): Promise<Map<string, ObservedWindow>> {
  const r = await db.execute(`
    SELECT model,
           MIN(NULLIF(context_window, 0)) AS base,
           MAX(context_window)            AS ceiling,
           MAX(input + cache_write + cache_read) AS max_prompt
    FROM usage_events
    WHERE is_sidechain = 0 AND model IS NOT NULL
    GROUP BY model`);
  const out = new Map<string, ObservedWindow>();
  for (const row of r.rows) {
    const base = Number(row.base) || 0;
    if (!base) continue;
    const ceiling = Number(row.ceiling) || 0;
    out.set(normalizeModelId(row.model as string), {
      base,
      ceiling,
      confirmed: base < WINDOW_CEILING,
      maxPromptSeen: Number(row.max_prompt) || 0,
    });
  }
  return out;
}

