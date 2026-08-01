/**
 * Live regression drives for docs/ticket-local-mcp-this-project-fails-first-use.md.
 *
 * Two costly, token-spending drives against the real SDK backend:
 *
 *  A) "codemogger connects + gets used" — register the code-search server for a
 *     scratch project (via the real POST /api/mcp, which creates the --db parent
 *     [B1] and auto-approves [B2]), index a tiny fixture, then drive a turn asking
 *     about a distinctive symbol. Assert the transcript contains a
 *     `mcp__codemogger__codemogger_search` tool_use, the answer is grounded in the
 *     hit, and NO `sdk.mcp` failure was logged (the server connected).
 *
 *  B) "failures are surfaced" (B4) — register codemogger with a `--db` that points
 *     at a directory (codemogger crashes opening it, exit 1 — verified), so the
 *     server is `failed` at system:init. Drive a trivial turn and assert an
 *     `sdk.mcp` warning appears in ~/.claude/fury-logs/ naming the failed server.
 *
 * COST/TIME: each runs a real short Claude turn under <repo>/../fury-e2e-mcp-*
 * (wiped each run). Budget ~2 min each. Lives in tests/live-sessions (the costly
 * drive suite), not the default unit run — see tests/README.md.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn,
  cleanupSession, jsonlPath,
} from './drive-helpers';

const execFileAsync = promisify(execFile);

// Resolve codemogger's CLI entry and run it via `node` directly. On Windows the
// PATH shim is `codemogger.cmd`, which execFile (no shell) can't spawn by bare
// name — `node dist/cli.mjs` is portable and deterministic. (The MCP server the
// Claude CLI launches uses its own resolution; this is only the test's indexing.)
const CODEMOGGER_CLI = join(__dirname, '..', '..', 'node_modules', 'codemogger', 'dist', 'cli.mjs');
function codemogger(args: string[]) {
  return execFileAsync(process.execPath, [CODEMOGGER_CLI, ...args], { timeout: 60000 });
}

const PROJECT_OK = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-ok');
const PROJECT_FAIL = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-fail');
const SERVER_NAME = 'codemogger';

async function registerCodemogger(project: string, args: string[]): Promise<Response> {
  return fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: SERVER_NAME, transport: 'stdio', commandOrUrl: 'codemogger',
      args, scope: 'project', projectPath: project,
    }),
  });
}

async function removeServer(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/mcp`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: SERVER_NAME, projectPath: project }),
    });
  } catch { /* best effort */ }
  // Purge the scratch project key from ~/.claude.json so the auto-approve residue
  // doesn't accumulate across runs.
  try {
    const { homedir } = await import('os');
    const cj = join(homedir(), '.claude.json');
    if (existsSync(cj)) {
      const cfg = JSON.parse(readFileSync(cj, 'utf8'));
      const key = project.replace(/\\/g, '/');
      if (cfg.projects?.[key]) { delete cfg.projects[key]; writeFileSync(cj, JSON.stringify(cfg, null, 2)); }
    }
  } catch { /* best effort */ }
}

/** Every assistant tool_use name found in the session JSONL. */
function toolUsesIn(sessionId: string, project: string): string[] {
  const p = jsonlPath(sessionId, project);
  if (!p || !existsSync(p)) return [];
  const names: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const content = e?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'tool_use' && typeof b.name === 'string') names.push(b.name);
      }
    } catch { /* partial */ }
  }
  return names;
}

/** Concatenated assistant text from the session JSONL. */
function assistantTextIn(sessionId: string, project: string): string {
  const p = jsonlPath(sessionId, project);
  if (!p || !existsSync(p)) return '';
  let out = '';
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'assistant') continue;
      const content = e?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
      }
    } catch { /* partial */ }
  }
  return out;
}

async function waitForTurnDone(sessionId: string, deadlineMs: number): Promise<any[]> {
  const deadline = Date.now() + deadlineMs;
  let logs: any[] = [];
  while (Date.now() < deadline) {
    await sleep(3000);
    logs = furyLogLinesFor(sessionId);
    if (logs.some((e) => e.scope === 'sdk.turn' && (e.msg === 'done' || e.msg === 'done (error)'))) break;
  }
  return logs;
}

test.describe('MCP code-search (codemogger) — live', () => {
  let okId: string | null = null;
  let failId: string | null = null;

  test.afterAll(async () => {
    await cleanupSession(okId, PROJECT_OK);
    await cleanupSession(failId, PROJECT_FAIL);
    await removeServer(PROJECT_OK);
    await removeServer(PROJECT_FAIL);
  });

  test('A: codemogger connects and the model uses codemogger_search', async () => {
    test.setTimeout(4 * 60 * 1000);
    const sessionId = randomUUID();
    okId = sessionId;

    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-ok'));
    await resetProjectDir(PROJECT_OK);

    // A distinctive symbol, unlikely to exist in the model's priors — so a correct,
    // grounded answer can ONLY come from the codemogger hit, not memorization.
    writeFileSync(join(PROJECT_OK, 'widget.ts'),
      'export function zorptangleReticulator(splines: number): number {\n' +
      '  // Reticulates splines for the frobnicator subsystem.\n' +
      '  return splines * 42;\n}\n');

    const dbPath = join(PROJECT_OK, '.codemogger', 'index.db');
    // Register via the REAL route: creates the --db parent (B1) + auto-approves (B2).
    const reg = await registerCodemogger(PROJECT_OK, ['--db', dbPath, 'mcp']);
    expect(reg.ok, 'POST /api/mcp registered codemogger').toBe(true);
    expect(existsSync(join(PROJECT_OK, '.codemogger')), 'B1: --db parent dir created').toBe(true);
    expect(existsSync(join(PROJECT_OK, '.mcp.json')), '.mcp.json written in project').toBe(true);

    // Populate the DB the MCP server will read (dir now exists thanks to B1).
    await codemogger(['--db', dbPath, 'index', PROJECT_OK]);

    const prompt =
      'Use the codemogger_search MCP tool (keyword mode, includeSnippet=true) to find the ' +
      'function named zorptangleReticulator in this project. Then tell me, in one sentence, ' +
      'what value it returns for the input and which file it is defined in.';
    const res = await driveTurn(sessionId, PROJECT_OK, prompt);
    expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

    const logs = await waitForTurnDone(sessionId, 150_000);
    expect(logs.some((e) => e.scope === 'sdk.turn' && e.msg.startsWith('done')), 'the turn completed').toBe(true);

    const tools = toolUsesIn(sessionId, PROJECT_OK);
    console.log('[E2E-A] tool_uses:', tools);
    expect(tools, 'the model called the codemogger search tool')
      .toContain('mcp__codemogger__codemogger_search');

    const answer = assistantTextIn(sessionId, PROJECT_OK);
    console.log('[E2E-A] answer:\n' + answer.slice(0, 600));
    // Grounded in the hit: names the symbol/file and the returned value (42×splines).
    expect(answer).toMatch(/zorptangleReticulator|widget\.ts/);
    expect(answer).toMatch(/42/);

    // codemogger connected → it must NOT appear in any sdk.mcp failure warning.
    // (We can't assert ZERO warnings: unrelated user-scoped servers — e.g. a
    // pending claude.ai integration — legitimately warn, and B4 correctly reports
    // every non-connected server. Scope the assertion to codemogger.)
    const warnedCodemogger = logs
      .filter((e) => e.scope === 'sdk.mcp')
      .flatMap((e) => (e?.data?.servers ?? []) as { name: string; status: string }[])
      .find((s) => s.name === SERVER_NAME);
    expect(warnedCodemogger, 'codemogger connected (absent from sdk.mcp failure warnings)').toBeFalsy();
  });

  test('B: a failed codemogger surfaces an sdk.mcp warning (B4)', async () => {
    test.setTimeout(3 * 60 * 1000);
    const sessionId = randomUUID();
    failId = sessionId;

    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-fail'));
    await resetProjectDir(PROJECT_FAIL);

    // Point --db at a DIRECTORY (the project dir): codemogger crashes opening it
    // (exit 1, verified), so the server is `failed` at system:init. ensureDbParentDir
    // just mkdirs the already-existing parent — harmless.
    const reg = await registerCodemogger(PROJECT_FAIL, ['--db', PROJECT_FAIL, 'mcp']);
    expect(reg.ok, 'POST /api/mcp registered the (doomed) codemogger').toBe(true);

    const res = await driveTurn(sessionId, PROJECT_FAIL, 'Reply with exactly the word: ready.');
    expect(res.ok, '/api/claude-sdk accepts the turn').toBe(true);

    const logs = await waitForTurnDone(sessionId, 120_000);

    const mcpWarns = logs.filter((e) => e.scope === 'sdk.mcp');
    console.log('[E2E-B] sdk.mcp warns:', JSON.stringify(mcpWarns.map((e) => e.data), null, 2));
    expect(mcpWarns.length, 'B4: a failed MCP server logs an sdk.mcp warning').toBeGreaterThanOrEqual(1);

    // The warning names codemogger with a non-connected status.
    const servers = mcpWarns.flatMap((e) => (e?.data?.servers ?? []) as { name: string; status: string }[]);
    const codemogger = servers.find((s) => s.name === SERVER_NAME);
    expect(codemogger, 'the warning names codemogger').toBeTruthy();
    expect(codemogger!.status, 'status is not "connected"').not.toBe('connected');

    // Durable restore path (B4 review): /api/stream-buffer exposes the failed set
    // so the client restores the banner on open — even after the turn ended. This
    // is what makes the banner survive turn resets / navigation.
    const buf = await fetch(`${BASE_URL}/api/stream-buffer?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json());
    console.log('[E2E-B] stream-buffer.mcpFailed:', JSON.stringify(buf.mcpFailed));
    const restored = (buf.mcpFailed ?? []) as { name: string; status: string }[];
    expect(restored.some((s) => s.name === SERVER_NAME && s.status === 'failed'),
      'stream-buffer returns codemogger as failed for restore').toBe(true);
  });
});
