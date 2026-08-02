/**
 * In-process codemogger engine (docs/ticket-local-mcp-this-project-fails-first-use.md
 * → decision #2, macOS DB contention → Option A). Proves the single-process engine
 * works: index a dir, search it, incrementally reindex on change, and run a search
 * CONCURRENTLY with a reindex without error (the per-project mutex serializes the DB).
 *
 * COST/TIME: loads the real embedder + Turso in THIS process (the whole point — one
 * process). ~10s, ZERO Claude tokens. Cross-platform (no fs.watch).
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { reindexProject, searchProject, dropProject } from '../../lib/codemoggerServer';

test('single-process engine: index + search + concurrent reindex are serialized', async () => {
  test.setTimeout(3 * 60 * 1000);

  const project = mkdtempSync(join(tmpdir(), 'fury-inproc-'));
  const db = join(project, '.codemogger', 'index.db');
  try {
    writeFileSync(join(project, 'a.ts'), 'export function inprocAlphaSymbol(n: number) { return n; }\n');

    // Initial in-process index, then search — same connection, no separate process.
    await reindexProject(project, db, [project]);
    const hitsAlpha = await searchProject(project, db, 'inprocAlphaSymbol', { mode: 'keyword' });
    expect(hitsAlpha.some(r => r.name === 'inprocAlphaSymbol'), 'search finds the indexed symbol').toBe(true);

    // Incremental change → reindex picks up the new symbol; old one still gone if removed.
    writeFileSync(join(project, 'b.ts'), 'export function inprocBetaSymbol(n: number) { return n * 2; }\n');

    // Fire a search CONCURRENTLY with the reindex — the mutex must serialize them so
    // neither errors on the shared DB (the crux of Option A: no two DB ops at once).
    const [, betaHits] = await Promise.all([
      reindexProject(project, db, [project]),
      searchProject(project, db, 'inprocAlphaSymbol', { mode: 'keyword' }),
    ]);
    expect(Array.isArray(betaHits)).toBe(true); // concurrent search returned without throwing

    const afterBeta = await searchProject(project, db, 'inprocBetaSymbol', { mode: 'keyword' });
    expect(afterBeta.some(r => r.name === 'inprocBetaSymbol'), 'incremental reindex added the new symbol').toBe(true);
  } finally {
    await dropProject(project); // closes the DB connection before cleanup
    try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
