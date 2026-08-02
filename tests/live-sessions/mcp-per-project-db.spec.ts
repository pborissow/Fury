/**
 * Per-project index DB — cross-project isolation (docs/ticket-local-mcp-this-project-
 * fails-first-use.md → decision #2). The "This project" wizard used to point every
 * project at ONE shared `~/.codemogger/index.db`, and codemogger search is global
 * across all codebases in a DB — so project A's search returned project B's hits.
 * Now each project gets its own `<project>/.codemogger/index.db`, indexed only for
 * the selected directories.
 *
 * This drives the REAL `POST /api/mcp` (which writes the per-project `.mcp.json`,
 * the selected-dirs sidecar, gitignores `.codemogger/` in a git repo, and kicks off
 * the initial index) for two separate projects with distinct symbols, then asserts:
 *   - each project's DB contains ONLY its own symbol (the isolation / leak fix);
 *   - the route wrote the per-project sidecar with the selected dirs;
 *   - a NON-git project gets no `.gitignore` created.
 *
 * COST/TIME: spawns codemogger locally (index + searches); ZERO Claude tokens. Runs
 * on all platforms (the server-side initial index doesn't use fs.watch).
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { BASE_URL, sleep, reapPidFiles, resetProjectDir } from './drive-helpers';

const execFileAsync = promisify(execFile);
const CLI = join(__dirname, '..', '..', 'node_modules', 'codemogger', 'dist', 'cli.mjs');

const A = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-projA');
const B = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-projB');
const dbOf = (p: string) => join(p, '.codemogger', 'index.db');
const SYM_A = 'alpha_zonktastic_widget'; const TOK_A = 'zonktastic';
const SYM_B = 'beta_quxolotl_gadget';    const TOK_B = 'quxolotl';

async function keywordHits(db: string, query: string): Promise<number> {
  const res = await execFileAsync(process.execPath, [CLI, '--db', db, 'search', query, '--mode', 'keyword'], { timeout: 60_000 })
    .catch(() => ({ stdout: '{"results":[]}' }));
  try { return (JSON.parse(res.stdout).results || []).length; } catch { return 0; }
}

async function register(project: string): Promise<Response> {
  const db = dbOf(project).replace(/\\/g, '/');
  return fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'codemogger', transport: 'stdio', commandOrUrl: 'codemogger',
      args: ['--db', db, 'mcp'], scope: 'project', projectPath: project, indexDirs: [project],
    }),
  });
}

async function removeServer(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/mcp`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'codemogger', projectPath: project }) });
  } catch { /* best effort */ }
  try {
    const cj = join(homedir(), '.claude.json');
    if (existsSync(cj)) {
      const cfg = JSON.parse(readFileSync(cj, 'utf8'));
      const key = project.replace(/\\/g, '/');
      if (cfg.projects?.[key]) { delete cfg.projects[key]; writeFileSync(cj, JSON.stringify(cfg, null, 2)); }
    }
  } catch { /* best effort */ }
}

async function waitForHits(db: string, query: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let h = await keywordHits(db, query);
  while (Date.now() < deadline && h === 0) { await sleep(3000); h = await keywordHits(db, query); }
  return h;
}

test.describe('Per-project code-search DB — cross-project isolation', () => {
  test.afterAll(async () => {
    await removeServer(A); await removeServer(B);
    for (const p of [A, B]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  test('each project indexes into its own DB; searches do not leak across projects', async () => {
    test.setTimeout(4 * 60 * 1000);

    reapPidFiles((e) => /fury-e2e-mcp-proj[AB]/.test(String(e.cwd || '')));
    await resetProjectDir(A); await resetProjectDir(B);
    // Distinct symbols; files written BEFORE registration so the route's initial
    // index picks them up.
    writeFileSync(join(A, 'a.ts'), `export function ${SYM_A}(n: number) { return n; }\n`);
    writeFileSync(join(B, 'b.ts'), `export function ${SYM_B}(n: number) { return n; }\n`);

    expect((await register(A)).ok, 'registered A').toBe(true);
    expect((await register(B)).ok, 'registered B').toBe(true);

    // The route created per-project DBs (B1) and wrote the selected-dirs sidecar.
    expect(existsSync(join(A, '.codemogger')), 'A/.codemogger created').toBe(true);
    const sidecarA = JSON.parse(readFileSync(join(A, '.codemogger', '.fury-index-dirs.json'), 'utf8'));
    expect(sidecarA.dirs, 'sidecar records the selected dirs for A').toEqual([A]);
    // A is NOT a git repo → no .gitignore should be created for it.
    expect(existsSync(join(A, '.gitignore')), 'no .gitignore in a non-git project').toBe(false);

    // The route kicked off the initial index — wait until each DB has its OWN symbol.
    const aHasA = await waitForHits(dbOf(A), TOK_A, 90_000);
    const bHasB = await waitForHits(dbOf(B), TOK_B, 90_000);
    console.log(`[E2E] A.zonktastic=${aHasA} B.quxolotl=${bHasB}`);
    expect(aHasA, "A's DB indexed A's symbol").toBeGreaterThan(0);
    expect(bHasB, "B's DB indexed B's symbol").toBeGreaterThan(0);

    // ── The isolation guarantee: neither DB contains the OTHER project's symbol. ──
    expect(await keywordHits(dbOf(A), TOK_B), "A's DB must NOT contain B's symbol").toBe(0);
    expect(await keywordHits(dbOf(B), TOK_A), "B's DB must NOT contain A's symbol").toBe(0);
  });
});
