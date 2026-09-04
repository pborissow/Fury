/**
 * Live regression drives for docs/ticket-codesearch-inprocess-mcp-macos-contention.md.
 *
 *  A) "in-process codemogger is used" (token-spending) — enable code search for a
 *     scratch project (real POST /api/code-search: writes the config, gitignores, and
 *     kicks off the IN-PROCESS index), wait for the index, then drive a turn asking
 *     about a distinctive symbol. Assert the transcript contains a
 *     `mcp__codemogger__codemogger_search` tool_use served IN-PROCESS, the answer is
 *     grounded in the hit, and NO separate codemogger process/`.mcp.json` entry exists.
 *
 *  B) "legacy stdio auto-migrates" (ZERO tokens) — a project with an old stdio
 *     codemogger `.mcp.json` entry, hit via GET /api/mcp, must be migrated: the stdio
 *     entry stripped (acceptance #5, no competing process) and code search surfaced as
 *     the in-process synthetic entry.
 *
 * COST/TIME: A runs one short Claude turn under <repo>/../fury-e2e-mcp-ok (wiped each
 * run); budget ~2 min. B is disk + one API call. Lives in tests/live-sessions.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, furyLogLinesFor, resetProjectDir, driveTurn,
  cleanupSession, jsonlPath,
} from './drive-helpers';
import { CODESEARCH_MCP_SERVER_NAME, CODESEARCH_DISPLAY_NAME } from '../../lib/mcpRuntimeStatus';

const PROJECT_OK = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-ok');
const PROJECT_MIGRATE = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-migrate');

async function enableCodeSearch(project: string, dirs: string[]): Promise<Response> {
  return fetch(`${BASE_URL}/api/code-search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, dirs }),
  });
}

async function disableCodeSearch(project: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/code-search`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project }),
    });
  } catch { /* best effort */ }
}

/** Search a project's index THROUGH the dev server (the single DB owner). */
async function serverHits(project: string, query: string): Promise<number> {
  const url = `${BASE_URL}/api/code-search?projectPath=${encodeURIComponent(project)}&q=${encodeURIComponent(query)}&mode=keyword`;
  const res = await fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
  return Array.isArray(res.results) ? res.results.length : 0;
}

async function waitForHits(project: string, query: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let h = await serverHits(project, query);
  while (Date.now() < deadline && h === 0) { await sleep(3000); h = await serverHits(project, query); }
  return h;
}

/** Every assistant tool_use name found in the session JSONL. */
function toolUsesIn(sessionId: string, project: string): string[] {
  const p = jsonlPath(sessionId, project);
  if (!p || !existsSync(p)) return [];
  const names: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const content = JSON.parse(line)?.message?.content;
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

test.describe('MCP code-search (codemogger) — in-process, live', () => {
  let okId: string | null = null;

  test.afterAll(async () => {
    await cleanupSession(okId, PROJECT_OK);
    await disableCodeSearch(PROJECT_OK);
    await disableCodeSearch(PROJECT_MIGRATE);
  });

  test('A: in-process codemogger connects and the model uses codemogger_search', async () => {
    test.setTimeout(4 * 60 * 1000);
    const sessionId = randomUUID();
    okId = sessionId;

    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-ok'));
    // Disable BEFORE deleting the dir: a crashed prior run leaves the server's
    // in-process engine holding the DB open, and deleting the files under a
    // live handle puts them in Windows delete-pending — every later open then
    // fails "permission denied" until the server restarts. Disabling first
    // closes the engine so the reset gets a genuinely fresh directory.
    await disableCodeSearch(PROJECT_OK);
    await resetProjectDir(PROJECT_OK);

    // A distinctive symbol, unlikely to exist in the model's priors — so a correct,
    // grounded answer can ONLY come from the codemogger hit, not memorization.
    writeFileSync(join(PROJECT_OK, 'widget.ts'),
      'export function zorptangleReticulator(splines: number): number {\n' +
      '  // Reticulates splines for the frobnicator subsystem.\n' +
      '  return splines * 42;\n}\n');

    // Enable code search (in-process): writes the config + kicks off the index.
    const reg = await enableCodeSearch(PROJECT_OK, [PROJECT_OK]);
    expect(reg.ok, 'POST /api/code-search enabled code search').toBe(true);
    expect(existsSync(join(PROJECT_OK, '.codemogger', 'fury-codesearch.json')), 'config written').toBe(true);
    // No stdio registration → no competing process (acceptance #5).
    expect(existsSync(join(PROJECT_OK, '.mcp.json')), 'no .mcp.json codemogger entry created').toBe(false);

    // Wait for the initial in-process index (observed through the owning process).
    // Search the FULL identifier: codemogger's keyword FTS matches whole tokens, so a
    // camelCase *partial* ("zorptangle") wouldn't hit "zorptangleReticulator".
    expect(await waitForHits(PROJECT_OK, 'zorptangleReticulator', 90_000), 'symbol indexed in-process').toBeGreaterThan(0);

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
    expect(tools, 'the model called the in-process codemogger search tool')
      .toContain('mcp__codemogger__codemogger_search');

    const answer = assistantTextIn(sessionId, PROJECT_OK);
    console.log('[E2E-A] answer:\n' + answer.slice(0, 600));
    // Grounded in the hit: names the symbol/file and the returned value (42×splines).
    expect(answer).toMatch(/zorptangleReticulator|widget\.ts/);
    expect(answer).toMatch(/42/);

    // In-process code search is NOT a listed MCP server, so it can never appear in an
    // sdk.mcp FAILURE warning — assert codemogger is absent from any such warning.
    const warnedCodemogger = logs
      .filter((e) => e.scope === 'sdk.mcp')
      .flatMap((e) => (e?.data?.servers ?? []) as { name: string; status: string }[])
      .find((s) => s.name === 'codemogger');
    expect(warnedCodemogger, 'in-process codemogger never reported as a failed MCP server').toBeFalsy();
  });

  test('B: a legacy stdio codemogger .mcp.json auto-migrates to in-process (no tokens)', async () => {
    test.setTimeout(60_000);
    await disableCodeSearch(PROJECT_MIGRATE);
    await resetProjectDir(PROJECT_MIGRATE);

    // Seed the OLD stdio registration shape a prior Fury version would have written.
    const db = join(PROJECT_MIGRATE, '.codemogger', 'index.db');
    writeFileSync(join(PROJECT_MIGRATE, '.mcp.json'), JSON.stringify({
      mcpServers: { codemogger: { command: 'codemogger', args: ['--db', db, 'mcp'] } },
    }, null, 2));

    // Hitting the MCP list endpoint triggers the auto-migration.
    const data = await fetch(`${BASE_URL}/api/mcp?projectPath=${encodeURIComponent(PROJECT_MIGRATE)}`)
      .then(r => r.json());

    // The stdio entry is stripped (no competing process — acceptance #5) and code
    // search is now the in-process config + synthetic list entry.
    expect(existsSync(join(PROJECT_MIGRATE, '.mcp.json')), 'stdio .mcp.json removed by migration').toBe(false);
    expect(existsSync(join(PROJECT_MIGRATE, '.codemogger', 'fury-codesearch.json')), 'in-process config written').toBe(true);
    const codeSearchEntry = (data.servers ?? [])
      .find((s: { codeSearch?: boolean }) => s.codeSearch) as
        { name: string; runtimeName?: string } | undefined;
    expect(codeSearchEntry, 'synthetic in-process code-search entry surfaced in the list').toBeTruthy();
    // The row carries BOTH identities: a friendly display label, and the name the
    // in-process engine reports runtime failures under. The panel resolves health
    // against the latter — asserting it here is what keeps P16 fixed.
    expect(codeSearchEntry!.name).toBe(CODESEARCH_DISPLAY_NAME);
    expect(codeSearchEntry!.runtimeName).toBe(CODESEARCH_MCP_SERVER_NAME);
  });
});
