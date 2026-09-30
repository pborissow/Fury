/**
 * The boot-scan cache (lib/scanCache.ts) is what lets scanAndArchiveAll skip an
 * unchanged transcript WITHOUT reading it — previously every boot read and
 * SHA-256'd every top-level transcript in ~/.claude/projects (214 files / 575 MB
 * on the machine this was diagnosed on) purely to rediscover that nothing had
 * changed. These tests pin the two properties the scan relies on:
 *
 *   1. It round-trips through FURY_HOME and degrades to empty (never throws) when
 *      absent or corrupt — a lost cache must cost one slow boot, not correctness.
 *   2. `isUnchanged` is strict about BOTH size and mtime, so an edit that happens
 *      to preserve one of them still falls through to the real read-and-hash.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isUnchanged,
  loadScanCache,
  saveScanCache,
  type ScanCache,
} from '../../lib/scanCache';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'fury-scan-cache-'));
process.env.FURY_HOME = TEMP_HOME;

const cachePath = join(TEMP_HOME, 'state', 'scan-cache.json');

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
  delete process.env.FURY_HOME;
});

beforeEach(() => {
  rmSync(join(TEMP_HOME, 'state'), { recursive: true, force: true });
});

describe('scan cache persistence', () => {
  it('returns an empty cache when none has been written yet', async () => {
    expect(await loadScanCache()).toEqual({});
  });

  it('round-trips entries through FURY_HOME, creating state/ as needed', async () => {
    const cache: ScanCache = {
      'slug-a/aaa.jsonl': { size: 120, mtimeMs: 1_700_000_000_000, hash: 'hash-a' },
      'slug-b/bbb.jsonl': { size: 33_000_000, mtimeMs: 1_700_000_500_000, hash: 'hash-b' },
    };
    await saveScanCache(cache);
    expect(await loadScanCache()).toEqual(cache);
  });

  it('falls back to empty on a corrupt cache instead of throwing', async () => {
    mkdirSync(join(TEMP_HOME, 'state'), { recursive: true });
    writeFileSync(cachePath, '{ this is not json', 'utf-8');
    await expect(loadScanCache()).resolves.toEqual({});
  });

  it('falls back to empty when the file holds valid JSON that is not an object', async () => {
    mkdirSync(join(TEMP_HOME, 'state'), { recursive: true });
    writeFileSync(cachePath, 'null', 'utf-8');
    await expect(loadScanCache()).resolves.toEqual({});
  });
});

describe('isUnchanged', () => {
  const entry = { size: 500, mtimeMs: 1_700_000_000_000, hash: 'h' };

  it('accepts a file whose size AND mtime both still match', () => {
    expect(isUnchanged(entry, { size: 500, mtimeMs: 1_700_000_000_000 })).toBe(true);
  });

  it('rejects a rewrite that changed the mtime but kept the size', () => {
    expect(isUnchanged(entry, { size: 500, mtimeMs: 1_700_000_900_000 })).toBe(false);
  });

  it('rejects an append that changed the size but kept the mtime', () => {
    expect(isUnchanged(entry, { size: 900, mtimeMs: 1_700_000_000_000 })).toBe(false);
  });

  it('rejects a file with no cache entry at all', () => {
    expect(isUnchanged(undefined, { size: 500, mtimeMs: 1_700_000_000_000 })).toBe(false);
  });
});
