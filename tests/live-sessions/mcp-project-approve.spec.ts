/**
 * Acceptance drive for docs/ticket-mcp-auto-approve-stale-trust-store.md:
 * add-and-use a project-scoped MCP server with ZERO manual CLI interaction.
 *
 * On a fresh, never-trusted scratch project:
 *   1. register a stdio server via the REAL `POST /api/mcp` (the Fury add flow),
 *   2. assert the approval landed in the CLI's canonical store,
 *      `<project>/.claude/settings.local.json` (W1) — and that a pre-existing
 *      explicit DISABLE (the one state that actually blocks loading under
 *      Fury's bypassPermissions sessions — P0 case g) was cleared,
 *   3. drive one SDK turn that calls the server's tool and assert the
 *      transcript proves it was loaded AND usable (`mcp__fixture__fixture_ping`
 *      tool_use + the fixture's distinctive token in the answer). The
 *      init/mcp_servers list isn't persisted to the JSONL, so a successful
 *      tool_use is the on-disk proof of "approved and attempted+connected".
 *   4. regression-guard ~/.claude.json: still parseable after the add (the CLI
 *      migration + Fury's writes share that file's racy zone).
 *
 * COST/TIME: one short Claude turn + a spawned fixture MCP server. Budget ~2 min.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  BASE_URL, sleep, reapPidFiles, resetProjectDir, driveTurn, cleanupSession,
  jsonlPath, furyLogLinesFor,
} from './drive-helpers';
import { localSettingsPath } from '../../lib/mcpApprove';

const PROJECT = join(__dirname, '..', '..', '..', 'fury-e2e-mcp-approve');
const FIXTURE = join(__dirname, '..', 'fixtures', 'mcp-fixture-server.mjs');
const SERVER = 'fixture';
const FIXTURE_TOKEN = 'fixture-pong-zappaflux';

function claudeJsonPath(): string { return join(homedir(), '.claude.json'); }

/** Remove the scratch project's entry from ~/.claude.json → a NEVER-TRUSTED project. */
function purgeProjectEntry(): void {
  try {
    const cfg = JSON.parse(readFileSync(claudeJsonPath(), 'utf8'));
    const key = PROJECT.replace(/\\/g, '/');
    if (cfg.projects?.[key]) { delete cfg.projects[key]; writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2)); }
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

test.describe('project MCP approval lands in settings.local.json and the server is usable', () => {
  let sessionId: string | null = null;

  test.afterAll(async () => {
    await cleanupSession(sessionId, PROJECT);
    purgeProjectEntry();
    try { rmSync(PROJECT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('add via POST /api/mcp → approval in local settings → one turn uses the tool', async () => {
    test.setTimeout(4 * 60 * 1000);
    sessionId = randomUUID();
    reapPidFiles((e) => String(e.cwd || '').replace(/\\/g, '/').includes('/fury-e2e-mcp-approve'));
    await resetProjectDir(PROJECT);
    purgeProjectEntry(); // fresh AND never trusted — the acceptance precondition

    // Seed an explicit DISABLE for the server: the one state that genuinely
    // blocks loading (P0 case g). The add flow must clear it from the
    // EFFECTIVE store, not the legacy one.
    mkdirSync(join(PROJECT, '.claude'), { recursive: true });
    writeFileSync(localSettingsPath(PROJECT), JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] }, // unrelated shared content — must survive
      disabledMcpjsonServers: [SERVER],
    }, null, 2));

    // 1. Register through the REAL add flow.
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: SERVER, transport: 'stdio', commandOrUrl: 'node', args: [FIXTURE],
        scope: 'project', projectPath: PROJECT,
      }),
    });
    const body = await res.json();
    expect(res.ok, `POST /api/mcp succeeded: ${JSON.stringify(body)}`).toBe(true);
    expect(body.warning, 'no approval warning — the write persisted').toBeUndefined();
    expect(existsSync(join(PROJECT, '.mcp.json')), '.mcp.json registered').toBe(true);

    // 2. Approval landed in the CLI's canonical store; the disable is gone;
    //    unrelated keys survived (the file is shared).
    const settings = JSON.parse(readFileSync(localSettingsPath(PROJECT), 'utf8'));
    expect(settings.enabledMcpjsonServers, 'enable in settings.local.json').toContain(SERVER);
    expect(settings.disabledMcpjsonServers ?? [], 'explicit disable cleared').not.toContain(SERVER);
    expect(settings.permissions, 'unrelated permissions content preserved').toEqual({ allow: ['Bash(ls:*)'] });

    // 4a. ~/.claude.json regression guard: parseable after the add.
    expect(() => JSON.parse(readFileSync(claudeJsonPath(), 'utf8')),
      '~/.claude.json still parseable after the add').not.toThrow();

    // 3. One SDK turn, zero manual CLI interaction: the model can call the tool.
    await driveTurn(sessionId, PROJECT,
      'Call the fixture_ping MCP tool (use ToolSearch to find it if it is not directly ' +
      'available) and reply with its exact output text.');
    await waitTurnDone(sessionId, 150_000);

    const tools = toolUsesIn(sessionId);
    const text = assistantTextIn(sessionId);
    console.log('[approve] tools:', JSON.stringify(tools));
    console.log('[approve] answer:', text.slice(0, 300));
    expect(tools, 'the project server loaded and its tool was callable with no manual approval')
      .toContain('mcp__fixture__fixture_ping');
    expect(text.includes(FIXTURE_TOKEN), 'the fixture server actually responded').toBe(true);

    // 4b. ~/.claude.json still parseable after the session too.
    expect(() => JSON.parse(readFileSync(claudeJsonPath(), 'utf8')),
      '~/.claude.json still parseable after the session').not.toThrow();
  });
});
