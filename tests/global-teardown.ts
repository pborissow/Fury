/**
 * Playwright globalTeardown — post-run cleanup of the scratch project directories
 * the e2e / live-session specs create as REPO SIBLINGS (`../fury-e2e-*`).
 *
 * Each spec wipes + recreates its own dir at the START of a run (resetProjectDir /
 * an inline rmSync+mkdirSync) but never removes it afterwards, so the siblings pile
 * up as clutter next to the repo. Sweeping them here — once, after the whole run —
 * keeps that decoupled from any single spec's teardown and also reclaims orphans
 * left by a renamed/removed spec (e.g. a stale `fury-e2e-mcp-fail`), since we match
 * by the shared `fury-e2e-` prefix rather than a hard-coded list.
 *
 * SCOPE: this removes every dir the dev server ISN'T holding open — which is all of
 * them EXCEPT the code-search projects, whose `.codemogger/index.db` the (reused,
 * still-running) dev server keeps open. On Windows an open file blocks the dir
 * unlink from another process, so those can't be removed from here. They are cleaned
 * by the SERVER instead — server.ts closes the code-search engines and sweeps these
 * dirs on shutdown, with a boot-time sweep as the backstop (sweepE2eScratchDirs).
 *
 * Also note: only repo-sibling `fury-e2e-*` dirs are swept — the tmpdir fixture used
 * by delete-to-archive.spec.ts (`/tmp/fury-e2e-archive-fixture-*`) owns its cleanup.
 */
import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { reapPidFiles } from './live-sessions/drive-helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalTeardown(): Promise<void> {
  // This file lives at <repo>/tests, so its grandparent is where the specs place
  // ../fury-e2e-<name> (a sibling of the repo root).
  const parent = join(__dirname, '..', '..');

  let targets: string[];
  try {
    targets = readdirSync(parent)
      .filter((name) => name.startsWith('fury-e2e-'))
      .map((name) => join(parent, name))
      .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  } catch {
    return; // parent unreadable — nothing to do
  }
  if (!targets.length) return;

  // SIGKILL + unlink any pid file for a CLI still holding a fury-e2e-* cwd, so a
  // crashed spec's warm process can't lock the dir (or keep running) as we unlink.
  try {
    reapPidFiles((e: { cwd?: unknown }) =>
      String(e.cwd ?? '').replace(/\\/g, '/').includes('/fury-e2e-'));
  } catch { /* best effort */ }

  let removed = 0;
  for (const dir of targets) {
    // Retry the unlink: on Windows a just-killed process can hold the dir briefly.
    // A code-search dir whose index.db the dev server still holds won't come free
    // here (all 6 attempts fail) — that's expected; the server's own hook gets it.
    for (let i = 0; i < 6; i++) {
      try { rmSync(dir, { recursive: true, force: true }); removed++; break; }
      catch { await sleep(500); }
    }
  }
  if (removed) {
    console.log(`[E2E teardown] removed ${removed} fury-e2e-* scratch dir(s) under ${parent}`);
  }
}
