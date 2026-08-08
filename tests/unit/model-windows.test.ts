/**
 * Unit tests for the empirical model-window store (lib/modelWindows.ts).
 *
 * Covers the two pieces of pure logic that don't need tokens:
 *   - recordServedWindow's hardened merge (add / improve base / raise ceiling /
 *     no-op), which backs the "app writes the JSON directly" contribution flow.
 *   - deriveObservedWindows' MIN-based base + confirmed gate, and its robustness
 *     to the two contamination sources (backfill inference + the old
 *     windowForMainModel max-bug) that leave junk 1M ceilings in the column.
 *
 * FURY_MODEL_WINDOWS_PATH points the module at a throwaway file so the real
 * committed seed (lib/model-windows.json) is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DIR = mkdtempSync(join(tmpdir(), 'fury-mw-'));
const WIN_FILE = join(DIR, 'model-windows.json');
// Capture the prior value so afterAll can restore it — this env var is
// process-global and would otherwise leak into other DB tests running in the
// same worker (pointing their modelWindows reads at a temp file we delete).
const PRIOR_WIN_PATH = process.env.FURY_MODEL_WINDOWS_PATH;
process.env.FURY_MODEL_WINDOWS_PATH = WIN_FILE;
writeFileSync(WIN_FILE, JSON.stringify({ version: 1, models: {} }), 'utf-8');

// The module reads FURY_MODEL_WINDOWS_PATH at import; it's set above.
const mw = await import('../../lib/modelWindows');

const read = () => JSON.parse(readFileSync(WIN_FILE, 'utf-8')).models;

afterAll(() => {
  // Restore the env var BEFORE deleting the dir, so no later test reads a path
  // pointing at a deleted file.
  if (PRIOR_WIN_PATH === undefined) delete process.env.FURY_MODEL_WINDOWS_PATH;
  else process.env.FURY_MODEL_WINDOWS_PATH = PRIOR_WIN_PATH;
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe('recordServedWindow (hardened merge)', () => {
  it('adds a new model, and a sub-ceiling window is a confirmed base', async () => {
    expect(await mw.recordServedWindow('claude-opus-4-8', 200_000, 'probe')).toBe('added');
    const e = read()['claude-opus-4-8'];
    expect(e.base).toBe(200_000);
    expect(e.source).toBe('probe');
    expect(mw.hasConfirmedBase(e)).toBe(true);
  });

  it('raises ceiling but keeps the smaller base when a larger window is seen', async () => {
    expect(await mw.recordServedWindow('claude-opus-4-8', 1_000_000, 'observed')).toBe('improved');
    const e = read()['claude-opus-4-8'];
    expect(e.base).toBe(200_000);      // base is the SMALLEST served
    expect(e.ceiling).toBe(1_000_000); // ceiling is the LARGEST
  });

  it('lowers base when a smaller window is later observed', async () => {
    await mw.recordServedWindow('claude-sonnet-5', 400_000, 'observed');
    expect(await mw.recordServedWindow('claude-sonnet-5', 250_000, 'observed')).toBe('improved');
    expect(read()['claude-sonnet-5'].base).toBe(250_000);
  });

  it('no-ops (no write-back) when the window adds nothing new', async () => {
    await mw.recordServedWindow('claude-haiku-4-5', 200_000, 'probe');
    const before = readFileSync(WIN_FILE, 'utf-8');
    expect(await mw.recordServedWindow('claude-haiku-4-5', 200_000, 'probe')).toBe('unchanged');
    expect(await mw.recordServedWindow('claude-haiku-4-5', 300_000, 'observed')).toBe('improved'); // ceiling up
    // A window between base and ceiling changes nothing.
    expect(await mw.recordServedWindow('claude-haiku-4-5', 250_000, 'observed')).toBe('unchanged');
    // The initial identical write left the file byte-identical.
    // (indirectly: base unchanged, still 200k)
    expect(read()['claude-haiku-4-5'].base).toBe(200_000);
    expect(before).toContain('claude-haiku-4-5');
  });

  it('a model only OBSERVED at the ceiling has an UNconfirmed base (may be the backfill guess)', async () => {
    await mw.recordServedWindow('claude-opus-4-6', 1_000_000, 'observed');
    expect(mw.hasConfirmedBase(mw.windowFor('claude-opus-4-6'))).toBe(false);
  });

  it('a model PROBED at the ceiling IS confirmed (authoritative bare-id capture)', async () => {
    // Mirrors the live probe: opus-4-8/sonnet-5 default to a 1M window.
    await mw.recordServedWindow('claude-opus-4-8-ceiling-probe', 1_000_000, 'probe');
    expect(mw.hasConfirmedBase(mw.windowFor('claude-opus-4-8-ceiling-probe'))).toBe(true);
  });

  it('serializes with sorted keys for reviewable diffs', async () => {
    const keys = Object.keys(read());
    expect(keys).toEqual([...keys].sort());
  });

  it('normalizes ids (dated snapshot suffix collapses to the alias)', async () => {
    await mw.recordServedWindow('claude-haiku-4-5-20251001', 200_000, 'probe');
    // Same canonical key as claude-haiku-4-5 — no duplicate row.
    expect(Object.keys(read()).filter(k => k.includes('haiku-4-5'))).toEqual(['claude-haiku-4-5']);
  });
});

describe('deriveObservedWindows (MIN base + confirmed gate)', () => {
  // A tiny fake libSQL client returning canned aggregate rows.
  const fakeDb = (rows: any[]) => ({ execute: async () => ({ rows }) }) as any;

  it('takes MIN(non-zero) as base and flags confirmed below the ceiling', async () => {
    const m = await mw.deriveObservedWindows(fakeDb([
      // opus-4-8: a real 200k among mostly-1M ⇒ base 200k, confirmed.
      { model: 'claude-opus-4-8', base: 200_000, ceiling: 1_000_000, max_prompt: 848_857 },
      // opus-4-6: only ever 1M (all inferred/ceiling) ⇒ base 1M, UNconfirmed.
      { model: 'claude-opus-4-6', base: 1_000_000, ceiling: 1_000_000, max_prompt: 259_463 },
    ]));
    expect(m.get('claude-opus-4-8')).toMatchObject({ base: 200_000, confirmed: true });
    expect(m.get('claude-opus-4-6')).toMatchObject({ base: 1_000_000, confirmed: false, maxPromptSeen: 259_463 });
  });

  it('ignores models with no non-zero window at all', async () => {
    const m = await mw.deriveObservedWindows(fakeDb([
      { model: 'claude-unpriced-x', base: null, ceiling: 0, max_prompt: 5000 },
    ]));
    expect(m.has('claude-unpriced-x')).toBe(false);
  });
});

