/**
 * lib/baseWindowBackfill — the archive base-window backfill.
 *
 * This is the changeset's most side-effecting logic (mutates usage_events +
 * session metadata) and its boot path is IN_TEST-gated, so it gets NO coverage
 * from the DB-integration tests. Here we drive the branching directly against a
 * stateful fake client + injected deps — no boot, no gate — covering every
 * outcome: fill (base + variant), stamp-already-known, stamp-nothing-to-fill,
 * park, park→retry→fill, and re-park.
 */
import { describe, it, expect } from 'vitest';
import { decideBaseWindow, backfillBaseWindows } from '../../lib/baseWindowBackfill';

// ---------------------------------------------------------------------------
// Pure decision matrix.
// ---------------------------------------------------------------------------
describe('decideBaseWindow', () => {
  it('stamps a session that already has a window (leaves it alone)', () => {
    expect(decideBaseWindow({ known: 200_000, model: 'm', maxPrompt: 5, base: 200_000 }))
      .toEqual({ action: 'stamp' });
  });
  it('fills to base when the peak fit within it', () => {
    expect(decideBaseWindow({ known: 0, model: 'm', maxPrompt: 40_000, base: 200_000 }))
      .toEqual({ action: 'fill', window: 200_000 });
  });
  it('fills to the ceiling when the peak exceeded base (ran a larger variant)', () => {
    expect(decideBaseWindow({ known: 0, model: 'm', maxPrompt: 300_000, base: 200_000 }))
      .toEqual({ action: 'fill', window: 1_000_000 });
  });
  it('parks a resolvable model whose window is not confirmed yet', () => {
    expect(decideBaseWindow({ known: 0, model: 'm', maxPrompt: 40_000, base: null }))
      .toEqual({ action: 'park', model: 'm', maxPrompt: 40_000 });
  });
  it('stamps when there is no model at all (unparseable / no main-thread call)', () => {
    expect(decideBaseWindow({ known: 0, model: null, maxPrompt: 0, base: null }))
      .toEqual({ action: 'stamp' });
  });
});

// ---------------------------------------------------------------------------
// The loop, against a stateful fake client.
// ---------------------------------------------------------------------------

/** One assistant-message JSONL line for a main-thread call on `model`. */
const jsonl = (model: string, input: number) => JSON.stringify({
  isSidechain: false, type: 'assistant', timestamp: '2026-08-08T00:00:00.000Z',
  message: { id: 'm1', model, usage: { input_tokens: input, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

interface Seed { metadata: Record<string, unknown> | null; raw?: string[] }

/**
 * A fake libSQL client backed by in-memory maps. Its metadata store is mutated
 * by the injected updateMeta (mimicking updateSessionMetadata's merge + null
 * delete), so re-running the backfill sees prior writes — which is what makes
 * the park→retry cycle testable.
 */
function harness(seed: Record<string, Seed>, baseWindows: Record<string, number>) {
  const meta = new Map<string, string | null>();
  const raw = new Map<string, string[]>();
  for (const [sid, s] of Object.entries(seed)) {
    meta.set(sid, s.metadata ? JSON.stringify(s.metadata) : null);
    raw.set(sid, s.raw ?? []);
  }
  const usageFills: { sid: string; window: number }[] = [];

  const client = {
    async execute(q: string | { sql: string; args: unknown[] }) {
      if (typeof q === 'string' && q.includes('FROM sessions')) {
        // Mirror the WHERE: exclude rows whose metadata contains baseWindowFilled.
        const rows = [...meta.entries()]
          .filter(([, m]) => !m || !m.includes('baseWindowFilled'))
          .map(([session_id, metadata]) => ({ session_id, metadata }));
        return { rows };
      }
      if (typeof q === 'object' && q.sql.includes('FROM raw_jsonl')) {
        const sid = q.args[0] as string;
        return { rows: (raw.get(sid) ?? []).map(content => ({ content })) };
      }
      if (typeof q === 'object' && q.sql.includes('UPDATE usage_events')) {
        usageFills.push({ window: q.args[0] as number, sid: q.args[1] as string });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  // Mimics updateSessionMetadata: merge patch, drop null/undefined keys.
  const updateMeta = async (sid: string, patch: Record<string, unknown>) => {
    let cur: Record<string, unknown> = {};
    const m = meta.get(sid);
    if (m) { try { cur = JSON.parse(m); } catch { /* empty */ } }
    const merged = { ...cur, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
    meta.set(sid, Object.keys(merged).length ? JSON.stringify(merged) : null);
  };

  const baseWindow = (model: string | null) => (model && model in baseWindows ? baseWindows[model] : null);
  const run = () => backfillBaseWindows(client, { baseWindow, updateMeta });
  const metaOf = (sid: string) => { const m = meta.get(sid); return m ? JSON.parse(m) : {}; };
  return { run, metaOf, usageFills };
}

describe('backfillBaseWindows (loop, fake client)', () => {
  it('fills, stamps, and parks in one pass — and only fills usage_events for fills', async () => {
    const h = harness(
      {
        fillMe:      { metadata: {}, raw: [jsonl('claude-opus-4-6', 40_000)] },   // base 200k, fit → fill 200k
        variantMe:   { metadata: {}, raw: [jsonl('claude-opus-4-6', 300_000)] },  // exceeded → fill 1M
        alreadyDone: { metadata: { contextWindow: 500_000 }, raw: [jsonl('claude-opus-4-6', 10)] }, // known → stamp
        noData:      { metadata: {}, raw: [] },                                    // no raw → stamp
        parkMe:      { metadata: {}, raw: [jsonl('claude-unprobed-9', 40_000)] },  // base unknown → park
      },
      { 'claude-opus-4-6': 200_000 },
    );

    const r = await h.run();
    expect(r).toEqual({ filled: 2, parked: 1, stamped: 2 });

    expect(h.metaOf('fillMe')).toMatchObject({ contextWindow: 200_000, baseWindowFilled: true });
    expect(h.metaOf('variantMe')).toMatchObject({ contextWindow: 1_000_000, baseWindowFilled: true });
    expect(h.metaOf('alreadyDone')).toMatchObject({ contextWindow: 500_000, baseWindowFilled: true });
    expect(h.metaOf('noData')).toMatchObject({ baseWindowFilled: true });

    const parked = h.metaOf('parkMe');
    expect(parked.baseWindowFilled).toBeUndefined();                       // NOT opted out
    expect(parked.pendingWindow).toEqual({ model: 'claude-unprobed-9', maxPrompt: 40_000 });

    // usage_events written only for the two fills, with the right windows.
    expect(h.usageFills.sort((a, b) => a.window - b.window)).toEqual([
      { sid: 'fillMe', window: 200_000 },
      { sid: 'variantMe', window: 1_000_000 },
    ]);
  });

  it('park → retry fills from the breadcrumb once the window is learned (no re-parse)', async () => {
    // First boot: model unprobed → park.
    const h = harness(
      { s: { metadata: {}, raw: [jsonl('claude-late-9', 150_000)] } },
      {}, // nothing confirmed yet
    );
    let r = await h.run();
    expect(r).toEqual({ filled: 0, parked: 1, stamped: 0 });
    expect(h.metaOf('s').pendingWindow).toEqual({ model: 'claude-late-9', maxPrompt: 150_000 });

    // Second boot: a probe has confirmed the window. Drop the raw so we PROVE the
    // fill came from the breadcrumb, not a re-parse.
    const h2 = harness(
      { s: { metadata: h.metaOf('s'), raw: [] } }, // carry the parked metadata forward, no raw
      { 'claude-late-9': 200_000 },
    );
    r = await h2.run();
    expect(r).toEqual({ filled: 1, parked: 0, stamped: 0 });
    const done = h2.metaOf('s');
    expect(done).toMatchObject({ contextWindow: 200_000, baseWindowFilled: true });
    expect(done.pendingWindow).toBeUndefined();                            // breadcrumb cleared
    expect(h2.usageFills).toEqual([{ sid: 's', window: 200_000 }]);
  });

  it('re-parks when the window is still unknown on a later boot', async () => {
    const h = harness(
      { s: { metadata: { pendingWindow: { model: 'claude-late-9', maxPrompt: 150_000 } } } },
      {}, // still nothing confirmed
    );
    const r = await h.run();
    expect(r).toEqual({ filled: 0, parked: 1, stamped: 0 });
    expect(h.metaOf('s')).toMatchObject({ pendingWindow: { model: 'claude-late-9', maxPrompt: 150_000 } });
    expect(h.metaOf('s').baseWindowFilled).toBeUndefined();                // still re-selectable
  });
});

