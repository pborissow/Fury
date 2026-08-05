/**
 * Per-project index DB — cross-project isolation, IN-PROCESS
 * (docs/ticket-codesearch-inprocess-mcp-macos-contention.md, carrying over the
 * per-project-DB guarantee from the prior ticket). codemogger search is global across
 * all codebases in a DB, so each project must get its OWN
 * `<project>/.codemogger/index.db`, indexed only for its selected directories —
 * otherwise project A's search returns project B's hits.
 *
 * This drives the REAL `POST /api/code-search` (writes the fury-codesearch.json
 * config, gitignores `.codemogger/` in a git repo, and kicks off the initial
 * in-process index) for two separate projects with distinct symbols, then asserts —
 * by searching THROUGH the server (the one process that owns each DB), never a second
 * codemogger process:
 *   - each project's index contains ONLY its own symbol (the isolation guarantee);
 *   - the route wrote the per-project config with the selected dirs;
 *   - a NON-git project gets no `.gitignore` created.
 *
 * COST/TIME: in-process index + searches in the DEV SERVER; ZERO Claude tokens. Runs
 * on all platforms (the initial index doesn't use fs.watch).
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { BASE_URL, sleep, reapPidFiles, resetProjectDir } from './drive-helpers';

const A = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-projA');
const B = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-projB');
const SYM_A = 'alpha_zonktastic_widget'; const TOK_A = 'zonktastic';
const SYM_B = 'beta_quxolotl_gadget';    const TOK_B = 'quxolotl';

/** Search a project's index THROUGH the dev server (the single DB owner). */
async function serverHits(project: string, query: string): Promise<number> {
  const url = `${BASE_URL}/api/code-search?projectPath=${encodeURIComponent(project)}&q=${encodeURIComponent(query)}&mode=keyword`;
  const res = await fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
  return Array.isArray(res.results) ? res.results.length : 0;
}

async function enable(project: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/code-search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, dirs: [project] }),
  });
}

async function disable(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/code-search`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project }),
    });
  } catch { /* best effort */ }
}

async function waitForHits(project: string, query: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let h = await serverHits(project, query);
  while (Date.now() < deadline && h === 0) { await sleep(3000); h = await serverHits(project, query); }
  return h;
}

test.describe('Per-project code-search DB — cross-project isolation (in-process)', () => {
  test.afterAll(async () => {
    await disable(A); await disable(B);
    for (const p of [A, B]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test('each project indexes into its own DB; searches do not leak across projects', async () => {
    test.setTimeout(4 * 60 * 1000);

    reapPidFiles((e) => /fury-e2e-mcp-proj[AB]/.test(String(e.cwd || '')));
    await resetProjectDir(A); await resetProjectDir(B);
    // Distinct symbols; files written BEFORE enabling so the route's initial index
    // picks them up.
    writeFileSync(join(A, 'a.ts'), `export function ${SYM_A}(n: number) { return n; }\n`);
    writeFileSync(join(B, 'b.ts'), `export function ${SYM_B}(n: number) { return n; }\n`);

    expect((await enable(A)).ok, 'enabled A').toBe(true);
    expect((await enable(B)).ok, 'enabled B').toBe(true);

    // The route wrote the per-project config with the selected dirs.
    expect(existsSync(join(A, '.codemogger')), 'A/.codemogger created').toBe(true);
    const cfgA = JSON.parse(readFileSync(join(A, '.codemogger', 'fury-codesearch.json'), 'utf8'));
    expect(cfgA.dirs, 'config records the selected dirs for A').toEqual([A]);
    // A is NOT a git repo → no .gitignore should be created for it.
    expect(existsSync(join(A, '.gitignore')), 'no .gitignore in a non-git project').toBe(false);

    // The route kicked off the initial index — wait until each index has its OWN symbol.
    const aHasA = await waitForHits(A, TOK_A, 90_000);
    const bHasB = await waitForHits(B, TOK_B, 90_000);
    console.log(`[E2E] A.zonktastic=${aHasA} B.quxolotl=${bHasB}`);
    expect(aHasA, "A's DB indexed A's symbol").toBeGreaterThan(0);
    expect(bHasB, "B's DB indexed B's symbol").toBeGreaterThan(0);

    // ── The isolation guarantee: neither index contains the OTHER project's symbol. ──
    expect(await serverHits(A, TOK_B), "A's DB must NOT contain B's symbol").toBe(0);
    expect(await serverHits(B, TOK_A), "B's DB must NOT contain A's symbol").toBe(0);
  });
});
