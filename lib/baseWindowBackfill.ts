/**
 * Base-window backfill — gives a context window to archived sessions that have
 * none, using the empirically-confirmed base windows (lib/model-windows.json).
 *
 * Extracted from initDb so the branching (the part most likely to regress) is
 * unit-testable against a fake client, independent of the IN_TEST boot gate that
 * keeps this fire-and-forget re-parse out of the parallel suite. initDb wires the
 * real client + baseWindowFor + updateSessionMetadata; tests inject fakes.
 *
 * Strictly ADDITIVE: only touches sessions whose window is still 0, only fills
 * where the model's base is confirmed, and stamps `baseWindowFilled` only when a
 * session is genuinely done (filled or nothing-to-fill) — a resolvable-but-
 * unconfirmed model is parked with a breadcrumb so a later boot retries cheaply.
 */
import { parseTranscriptJsonl } from './transcriptParser';
import { baseWindowFor, WINDOW_CEILING } from './modelWindows';

/** The per-session outcome — pure, so the decision matrix is trivially testable. */
export type BaseWindowDecision =
  | { action: 'stamp' }                                   // done: already-windowed, or nothing fillable
  | { action: 'fill'; window: number }                    // set contextWindow + fill usage_events + stamp
  | { action: 'park'; model: string; maxPrompt: number }; // model known but window not confirmed yet

/**
 * Decide what to do with one session. Order matters:
 *   known window        → stamp (leave the more-specific existing value alone)
 *   confirmed base       → fill (maxPrompt > base ⇒ it ran a larger variant)
 *   model but no base    → park (retry once a probe confirms the window)
 *   no model             → stamp (unparseable / no main-thread call — never fillable)
 */
export function decideBaseWindow(input: {
  known: number;
  model: string | null;
  maxPrompt: number;
  base: number | null;
}): BaseWindowDecision {
  const { known, model, maxPrompt, base } = input;
  if (known > 0) return { action: 'stamp' };
  if (base != null) return { action: 'fill', window: maxPrompt > base ? WINDOW_CEILING : base };
  if (model) return { action: 'park', model, maxPrompt };
  return { action: 'stamp' };
}

/** Just the bit of the libSQL client this backfill calls — lets tests pass a fake. */
export interface BackfillClient {
  execute(query: string | { sql: string; args: unknown[] }): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface BackfillDeps {
  /** Confirmed base window for a model, or null. Default: baseWindowFor. */
  baseWindow?: (model: string | null) => number | null;
  /** Merge a metadata patch under the per-session lock. Default: updateSessionMetadata. */
  updateMeta?: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
}

export interface BackfillResult { filled: number; parked: number; stamped: number; }

/**
 * Resolve a session's binding model + largest main-thread prompt, preferring a
 * prior boot's breadcrumb over re-parsing raw_jsonl (the re-parse is the cost).
 */
async function resolveModel(
  client: BackfillClient,
  sid: string,
  meta: Record<string, unknown>,
): Promise<{ model: string | null; maxPrompt: number }> {
  const pending = meta.pendingWindow as { model: string | null; maxPrompt: number } | undefined;
  if (pending) return { model: pending.model ?? null, maxPrompt: pending.maxPrompt ?? 0 };

  const rawRows = await client.execute({
    sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
    args: [sid],
  });
  if (rawRows.rows.length === 0) return { model: null, maxPrompt: 0 }; // nothing to parse, ever

  let parsed: ReturnType<typeof parseTranscriptJsonl> | null = null;
  try { parsed = parseTranscriptJsonl(rawRows.rows.map(r => r.content as string).join('\n')); } catch { /* leave null */ }

  let model: string | null = null;
  let maxPrompt = 0;
  for (const u of parsed?.usageEvents ?? []) {
    if (u.isSidechain) continue;
    const p = u.input + u.cacheWrite + u.cacheRead;
    if (p >= maxPrompt) { maxPrompt = p; model = u.model; }
  }
  return { model, maxPrompt };
}

export async function backfillBaseWindows(
  client: BackfillClient,
  deps: BackfillDeps = {},
): Promise<BackfillResult> {
  const baseWindow = deps.baseWindow ?? baseWindowFor;
  const updateMeta = deps.updateMeta
    ?? (async (sid, patch) => {
      const { updateSessionMetadata } = await import('./transcriptArchiver');
      await updateSessionMetadata(sid, patch);
    });

  // Re-select DONE-less sessions: never-processed, plus those parked with a
  // breadcrumb awaiting their model's window.
  const targets = await client.execute(`
    SELECT session_id, metadata FROM sessions
    WHERE metadata IS NULL OR metadata NOT LIKE '%baseWindowFilled%'
  `);

  const result: BackfillResult = { filled: 0, parked: 0, stamped: 0 };
  for (const row of targets.rows) {
    const sid = row.session_id as string;
    let meta: Record<string, unknown> = {};
    if (row.metadata) { try { meta = JSON.parse(row.metadata as string); } catch { /* treat as empty */ } }

    const known = typeof meta.contextWindow === 'number' ? meta.contextWindow as number : 0;
    const { model, maxPrompt } = known > 0
      ? { model: null, maxPrompt: 0 }
      : await resolveModel(client, sid, meta);

    const decision = decideBaseWindow({ known, model, maxPrompt, base: model ? baseWindow(model) : null });

    const patch: Record<string, unknown> = {};
    if (decision.action === 'fill') {
      patch.contextWindow = decision.window;
      patch.baseWindowFilled = true;
      patch.pendingWindow = null; // clear any breadcrumb — we're done
      result.filled++;
      await client.execute({
        sql: 'UPDATE usage_events SET context_window = ? WHERE session_id = ? AND context_window = 0 AND is_sidechain = 0',
        args: [decision.window, sid],
      });
    } else if (decision.action === 'park') {
      patch.pendingWindow = { model: decision.model, maxPrompt: decision.maxPrompt };
      result.parked++;
    } else {
      patch.baseWindowFilled = true;
      result.stamped++;
    }
    await updateMeta(sid, patch);
  }
  return result;
}

