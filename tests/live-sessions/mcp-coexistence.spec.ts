/**
 * Coexistence drive (docs/ticket-codesearch-inprocess-mcp-macos-contention.md, review
 * follow-up #3): in-process code search is attached via `options.mcpServers` WITHOUT
 * `strictMcpConfig`, so it must MERGE with — not shadow — a project's own `.mcp.json`
 * MCP servers. This runs a session on a scratch project that has BOTH a real project
 * `.mcp.json` MCP server (the fixture in tests/fixtures/mcp-fixture-server.mjs) AND code
 * search enabled, and asserts both load.
 *
 * HARD proof of non-shadowing: the session's `system:init` `mcp_servers` list contains
 * BOTH `fixture` (connected) and `codemogger`. Also checks the model can actually reach
 * both tools, and that code search's index is live.
 *
 * COST/TIME: one short Claude turn + a spawned fixture MCP server + in-process index.
 * Budget ~2 min.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, resetProjectDir, driveTurn, cleanupSession,
  jsonlPath, furyLogLinesFor,
} from './drive-helpers';
import { approveProjectServer } from '../../lib/mcpApprove';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-coexist');
const FIXTURE = join(__dirname, '..', 'fixtures', 'mcp-fixture-server.mjs');
// snake_case so the FTS tokenizer yields a distinct sub-token to keyword-search
// (a camelCase partial won't match — same convention as the other code-search specs).
const SYMBOL = 'coexist_zqbanana_widget';
const TOK = 'zqbanana';
const FIXTURE_TOKEN = 'fixture-pong-zappaflux';

async function serverHits(project: string, q: string): Promise<number> {
  const url = `${BASE_URL}/api/code-search?projectPath=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}&mode=keyword`;
  const r = await fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
  return Array.isArray(r.results) ? r.results.length : 0;
}
async function waitForHits(project: string, q: string, ms: number): Promise<number> {
  const dl = Date.now() + ms;
  let h = await serverHits(project, q);
  while (Date.now() < dl && h === 0) { await sleep(3000); h = await serverHits(project, q); }
  return h;
}
async function enableCodeSearch(project: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/code-search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, dirs: [project] }),
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

function toolUsesIn(sessionId: string): string[] {
  const p = jsonlPath(sessionId, PROJECT);
  if (!p || !existsSync(p)) return [];
  const names: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line)?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use' && typeof b.name === 'string') names.push(b.name);
    } catch { /* partial */ }
  }
  return names;
}
function assistantTextIn(sessionId: string): string {
  const p = jsonlPath(sessionId, PROJECT);
  if (!p || !existsSync(p)) return '';
  let out = '';
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'assistant') continue;
      const c = e?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
    } catch { /* partial */ }
  }
  return out;
}
async function waitTurnDone(sessionId: string, ms: number): Promise<void> {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    await sleep(3000);
    if (furyLogLinesFor(sessionId).some(e => e.scope === 'sdk.turn' && String(e.msg).startsWith('done'))) return;
  }
}

test.describe('code search coexists with a project .mcp.json MCP server (no shadowing)', () => {
  let sessionId: string | null = null;

  test.afterAll(async () => {
    await cleanupSession(sessionId, PROJECT);
    await disableCodeSearch(PROJECT);
    // Purge the scratch project's trust residue from ~/.claude.json.
    try {
      const cj = join(homedir(), '.claude.json');
      if (existsSync(cj)) {
        const cfg = JSON.parse(readFileSync(cj, 'utf8'));
        const key = PROJECT.replace(/\\/g, '/');
        if (cfg.projects?.[key]) { delete cfg.projects[key]; writeFileSync(cj, JSON.stringify(cfg, null, 2)); }
      }
    } catch { /* best effort */ }
    try { rmSync(PROJECT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a session loads BOTH the project fixture MCP server AND in-process code search', async () => {
    test.setTimeout(4 * 60 * 1000);
    sessionId = randomUUID();
    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-coexist'));
    // Disable BEFORE the reset — a crashed prior run's live engine handle would
    // put the deleted DB into Windows delete-pending (see mcp-codesearch.spec.ts).
    await disableCodeSearch(PROJECT);
    await resetProjectDir(PROJECT);

    // A source symbol for code search + a REAL project .mcp.json MCP server (the fixture).
    writeFileSync(join(PROJECT, 'widget.ts'), `export function ${SYMBOL}(n: number) { return n; }\n`);
    writeFileSync(join(PROJECT, '.mcp.json'), JSON.stringify({
      mcpServers: { fixture: { command: 'node', args: [FIXTURE] } },
    }, null, 2));
    // Project-scope .mcp.json servers need trust; approve it (the B2 mechanism,
    // now targeting <project>/.claude/settings.local.json — the store the CLI reads).
    await approveProjectServer(PROJECT, 'fixture');

    // Enable code search — writes fury-codesearch.json and strips only *codemogger*
    // entries, so the fixture entry survives.
    expect((await enableCodeSearch(PROJECT)).ok, 'code search enabled').toBe(true);
    expect(existsSync(join(PROJECT, '.mcp.json')), 'fixture .mcp.json survives enable').toBe(true);
    expect(await waitForHits(PROJECT, TOK, 90_000), 'code search indexed the symbol').toBeGreaterThan(0);

    // Drive one turn that exercises BOTH the fixture tool and code search.
    await driveTurn(sessionId, PROJECT,
      `First call the fixture_ping tool (use ToolSearch to find it if it isn't directly available) and note its output. ` +
      `Then use codemogger_search to find the function ${SYMBOL}. ` +
      `Finally reply with the fixture tool's exact output text and the file that defines ${SYMBOL}.`);
    await waitTurnDone(sessionId, 150_000);

    // ── Proof of non-shadowing, from the persisted tool_use blocks: the model called
    // BOTH the project fixture server's tool AND the in-process code-search tool in the
    // SAME session — so code search (options.mcpServers) did NOT shadow the project's
    // own .mcp.json server. (The init/mcp_servers list isn't persisted to the JSONL, so
    // tool_use is the reliable on-disk signal.) ──
    const tools = toolUsesIn(sessionId);
    const text = assistantTextIn(sessionId);
    console.log('[coexist] tools:', JSON.stringify(tools));
    console.log('[coexist] answer:', text.slice(0, 300));
    expect(tools, 'project fixture MCP server tool was callable (not shadowed by code search)')
      .toContain('mcp__fixture__fixture_ping');
    expect(tools, 'in-process code-search tool was callable alongside the fixture server')
      .toContain('mcp__codemogger__codemogger_search');
    // The fixture actually returned its distinctive token → the real server responded.
    expect(text.includes(FIXTURE_TOKEN), 'fixture server returned its token to the model').toBe(true);
  });
});
