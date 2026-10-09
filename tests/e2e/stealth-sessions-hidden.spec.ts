/**
 * E2E HIDING REGRESSION — the contract every stealth-session consumer inherits
 * (docs/ticket-stealth-sessions.md §2, §5, §7).
 *
 * Drives ONE real stealth turn through the running dev server's registry (the
 * inert `diag-probe` consumer behind POST /api/diagnostics/stealth: Haiku, no
 * tools), then asserts the session appears on NONE of the user-facing surfaces:
 *
 *   - live pills        GET /api/live-sessions      (while its process is warm)
 *   - sidebar history   GET /api/history + the rendered page
 *   - search corpus     GET /api/search?q=<nonce>
 *   - Stats sessions    GET /api/stats               (its id never appears)
 *   - disk              no transcript JSONL, no history.jsonl entry
 *
 * …and that its SPEND IS visible in Stats as a background-agent line item titled
 * with the consumer's human-readable label ("Diagnostics probe") under the
 * "Background agents" project (§5 — invisible sessions, visible costs).
 *
 * Because the contract lives in shared infrastructure, a future consumer
 * (ask-search, auto-labeling, digests) gets these guarantees by construction; if
 * this spec fails, every consumer is leaking.
 *
 * COST/TIME: one trivial Haiku turn (< $0.01), ~10-20 s. Needs an authenticated
 * Claude CLI, like the other live drives.
 *
 * SERVER REQUIREMENT: POST /api/diagnostics/stealth only works on a DEV server
 * (`npm run dev`, NODE_ENV !== 'production') — which is what Playwright's
 * webServer starts. Do NOT set FURY_STEALTH_PROBE=1 on a production server to
 * make this spec pass: that flag opens a token-spending endpoint to anyone who
 * can reach the API. If the spec gets a 403, run it against a dev server.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns truthy or the deadline passes; returns the last value. */
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) { await sleep(500); v = await fn(); }
  return v;
}

test.describe('stealth sessions are invisible (hiding contract)', () => {
  test.setTimeout(120_000);

  test('a live stealth turn leaks to no user surface, and its spend is labeled in Stats', async ({ page }) => {
    const nonce = `stealthnonce${Date.now().toString(36)}`;
    const tz = 'UTC';

    // --- drive one real stealth turn -------------------------------------------
    const res = await page.request.post('/api/diagnostics/stealth', {
      // The nonce rides in the PROMPT (what a sidebar/search leak would expose);
      // the reply's content is irrelevant to the contract.
      data: { prompt: `Health check ${nonce}: please reply with a one-word greeting.` },
      timeout: 90_000,
    });
    expect(res.status(), await res.text()).toBe(200);
    const probe = await res.json();
    const sid: string = probe.sessionId;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(probe.text.trim().length).toBeGreaterThan(0);
    expect(probe.costUsd).toBeGreaterThan(0);

    // The registry knows it (diagnostics is the one deliberate window)…
    const diag = await (await page.request.get('/api/diagnostics/stealth')).json();
    expect(diag.sessions.find((s: { name: string }) => s.name === 'diag-probe')).toMatchObject({ alive: true, sessionId: sid });

    // …and its process really is on disk with the internal cwd — so the live-set
    // filter below is filtering something real, not passing vacuously.
    const sessionsDir = join(homedir(), '.claude', 'sessions');
    const pidEntry = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')); } catch { return null; } })
      .find((e) => e?.sessionId === sid);
    expect(pidEntry, 'stealth CLI should have a PID file while warm').toBeTruthy();
    expect(String(pidEntry.cwd)).toMatch(/[\\/]\.fury[\\/]internal[\\/]diag-probe$|[\\/]internal[\\/]diag-probe$/);

    // --- live pills ----------------------------------------------------------------
    // NOTE (macOS, docs/ticket-live-scanner-macos-ps-truncation.md): the PID
    // scanner currently rejects every SDK-bundled CLI before the stealth filter
    // is reached. It runs `ps -o comm=,lstart=`, and macOS truncates a non-final
    // column to 16 chars, so the binary's long path fails the "starts with
    // claude" check. Until that's fixed, this assertion can't fail on a Mac; the
    // authoritative pins for BOTH live-set filters (cwd in the scanner, hiddenIds
    // in computeLiveSessionIds) are tests/unit/stealth-hiding.test.ts.
    const live = await (await page.request.get('/api/live-sessions')).json();
    expect(live.liveSessionIds).not.toContain(sid);

    // --- sidebar history (API + rendered page) -------------------------------------
    const history = await (await page.request.get('/api/history?limit=1000')).text();
    expect(history).not.toContain(sid);
    expect(history).not.toContain(nonce);

    // (Not 'networkidle': the app holds the /api/events SSE stream open.) Wait for
    // the sidebar's own history fetch, then let it render.
    const sidebarLoaded = page.waitForResponse((r) => r.url().includes('/api/history') && r.ok(), { timeout: 30_000 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await sidebarLoaded;
    await sleep(1_000);
    await expect(page.locator('body')).not.toContainText(nonce);

    // --- search corpus ---------------------------------------------------------------
    const search = await (await page.request.get(`/api/search?q=${encodeURIComponent(nonce)}`)).json();
    expect(search.totalHits).toBe(0);
    expect(search.results).toEqual([]);
    expect(JSON.stringify(search)).not.toContain(sid);
    const corpus = await (await page.request.get('/api/search')).text();
    expect(corpus).not.toMatch(/[\\/]internal[\\/]diag-probe/);

    // --- disk ------------------------------------------------------------------------
    const projectsDir = join(homedir(), '.claude', 'projects');
    const transcript = existsSync(projectsDir)
      ? readdirSync(projectsDir).some((d) => existsSync(join(projectsDir, d, `${sid}.jsonl`)))
      : false;
    expect(transcript, 'persistSession:false → no transcript').toBe(false);
    const historyJsonl = join(homedir(), '.claude', 'history.jsonl');
    if (existsSync(historyJsonl)) expect(readFileSync(historyJsonl, 'utf8')).not.toContain(sid);

    // --- Stats: id invisible, spend visible under the reserved label ------------------
    type Row = { sessionId: string; display: string; cost: number; tokens: number; internal?: boolean; project: string; projectName: string };
    const stats = await poll(
      async () => (await (await page.request.get(`/api/stats?tz=${tz}`)).json()) as { sessions: Row[] },
      (s) => s.sessions.some((r) => r.display === 'Diagnostics probe' && r.tokens > 0),
    );
    expect(JSON.stringify(stats)).not.toContain(sid);
    const today = new Date().toISOString().slice(0, 10);
    const line = stats.sessions.find((r) => r.sessionId === `fury-internal:diag-probe:${today}`);
    expect(line, 'per-consumer background-agent Stats line item').toBeTruthy();
    expect(line).toMatchObject({ internal: true, project: '', projectName: 'Background agents', display: 'Diagnostics probe' });
    expect(line!.tokens).toBeGreaterThan(0);
    expect(line!.cost).toBeGreaterThan(0);
  });
});
