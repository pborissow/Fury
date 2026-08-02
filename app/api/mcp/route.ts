import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { mcpCache, projectKeyCandidates, type McpServer } from '@/lib/mcpCache';
import { approveProjectServer } from '@/lib/mcpApprove';
import { normalizeArgs, ensureDbParentDir } from '@/lib/mcpArgs';
import { migrateStdioCodemogger, readCodeSearchConfig } from '@/lib/codeSearchConfig';

const execFileAsync = promisify(execFile);

function parseEnvLines(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

function stableEnvKey(env: Record<string, string> | undefined): string {
  const keys = Object.keys(env || {}).sort();
  return JSON.stringify(keys.map(k => [k, env![k]]));
}

// B2 lives in lib/mcpApprove.ts (atomic re-read + rename + verify-retry) so it
// can be unit-tested against a temp config file under a competing writer.
function autoApproveProjectServer(projectPath: string, serverName: string): Promise<boolean> {
  return approveProjectServer(join(homedir(), '.claude.json'), projectPath, serverName);
}

export const dynamic = 'force-dynamic';

/** Type of the synthetic in-process code-search entry surfaced in the server list. */
type CodeSearchServer = McpServer & { codeSearch: true; dirs: string[] };

/**
 * Prepend a synthetic "code search" entry when the project has in-process code
 * search enabled. It's NOT a real MCP server (no stdio/http process) — the panel
 * renders it as a distinct row and disables it via /api/code-search.
 */
function withCodeSearchEntry(projectPath: string | null, servers: McpServer[]): (McpServer | CodeSearchServer)[] {
  if (!projectPath) return servers;
  const cfg = readCodeSearchConfig(projectPath);
  if (!cfg) return servers;
  const dirs = cfg.dirs.length ? cfg.dirs : [projectPath];
  const entry: CodeSearchServer = {
    name: 'codemogger',
    url: `in-process code search · ${dirs.length} dir${dirs.length === 1 ? '' : 's'}`,
    status: 'connected',
    statusDetail: 'In-process (Fury) — no separate process',
    scope: 'project',
    transport: 'stdio',
    codeSearch: true,
    dirs,
  };
  return [entry, ...servers];
}

export async function GET(request: NextRequest) {
  mcpCache.start();
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('projectPath');
    // Auto-migrate a legacy stdio codemogger .mcp.json entry to the in-process model
    // (docs/ticket-codesearch-inprocess-mcp-macos-contention.md). Best-effort; if it
    // changed anything, drop the stale MCP-list cache so the removed entry disappears.
    if (projectPath && migrateStdioCodemogger(projectPath)) {
      mcpCache.invalidate(projectPath, 'project').catch(() => { /* background */ });
    }
    const { servers, error } = await mcpCache.get(projectPath);
    return NextResponse.json({ servers: withCodeSearchEntry(projectPath, servers), ...(error ? { error } : {}) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCP API] Error listing MCP servers:', message);
    return NextResponse.json(
      { servers: [], error: message },
      { status: 200 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, transport, commandOrUrl, args, envVars, scope, projectPath } = body;

    if (!name || !commandOrUrl) {
      return NextResponse.json(
        { error: 'Name and command/URL are required' },
        { status: 400 },
      );
    }

    // Reject duplicates by matching on transport + specs (not name).
    // Two servers with different names but the same URL or command+args
    // are the real duplicates users encounter.
    {
      type ExistingServer = {
        name: string;
        type?: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      };
      const existing = new Map<string, ExistingServer>();
      const pushEntry = (n: string, v: unknown) => {
        if (existing.has(n)) return;
        existing.set(n, { name: n, ...(v as Record<string, unknown>) } as ExistingServer);
      };

      // Collect from user config
      try {
        const raw = await readFile(join(homedir(), '.claude.json'), 'utf-8');
        const cfg = JSON.parse(raw);
        for (const [n, v] of Object.entries(cfg?.mcpServers || {})) pushEntry(n, v);
        // Also check project-specific servers stored in user config.
        // Try all separator variants since .claude.json keys may use '/' or '\\'.
        if (projectPath) {
          for (const candidate of projectKeyCandidates(projectPath)) {
            const projCfg = cfg?.projects?.[candidate]?.mcpServers || {};
            for (const [n, v] of Object.entries(projCfg)) pushEntry(n, v);
          }
        }
      } catch { /* missing/unreadable */ }

      // Collect from project .mcp.json
      if (projectPath) {
        try {
          const raw = await readFile(join(projectPath, '.mcp.json'), 'utf-8');
          const cfg = JSON.parse(raw);
          for (const [n, v] of Object.entries(cfg?.mcpServers || {})) pushEntry(n, v);
        } catch { /* missing/unreadable */ }
      }

      // Normalize the incoming args + env for comparison
      const incomingArgs = normalizeArgs(args);
      const incomingEnvKey = stableEnvKey(parseEnvLines(envVars));
      const transportKind: 'http' | 'stdio' = (transport || 'stdio') === 'http' ? 'http' : 'stdio';

      const dup = Array.from(existing.values()).find(s => {
        if (transportKind === 'http') {
          const isHttp = s.type === 'http' || (!s.type && typeof s.url === 'string');
          return isHttp && s.url === commandOrUrl;
        }
        // stdio: hand-authored .mcp.json entries often omit `type` entirely,
        // so treat any entry with a `command` string and no other type as stdio.
        const isStdio = s.type === 'stdio' || (!s.type && typeof s.command === 'string');
        return isStdio
          && s.command === commandOrUrl
          && JSON.stringify(s.args || []) === JSON.stringify(incomingArgs)
          && stableEnvKey(s.env) === incomingEnvKey;
      });

      if (dup) {
        return NextResponse.json(
          { error: `An MCP server with these specs already exists ("${dup.name}")` },
          { status: 409 },
        );
      }
    }

    const cliArgs = ['mcp', 'add', '--transport', transport || 'stdio', '--scope', scope || 'user'];

    // Add env vars: -e KEY=value
    if (envVars) {
      const lines = envVars.split('\n').map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
        cliArgs.push('-e', line);
      }
    }

    cliArgs.push(name, commandOrUrl);

    // Add extra arguments after the command. Array in ⇒ array preserved, so a
    // `--db <path with spaces>` stays a single argv entry (B3).
    const extraArgs = normalizeArgs(args);
    if (extraArgs.length > 0) {
      cliArgs.push('--', ...extraArgs);
    }

    // B1: create the `--db` parent dir BEFORE the server can be launched, so
    // codemogger doesn't crash on first open. No-op for servers without `--db`.
    if ((transport || 'stdio') !== 'http') {
      await ensureDbParentDir(extraArgs);
    }

    const execOpts: { timeout: number; encoding: 'utf-8'; env: NodeJS.ProcessEnv; cwd?: string } = {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    };

    // For project scope, run in the target project directory so .mcp.json is created there
    if (scope === 'project' && projectPath) {
      execOpts.cwd = projectPath;
    }

    const { stdout, stderr } = await execFileAsync('claude', cliArgs, execOpts);

    const output = (stdout || '') + (stderr || '');
    const effectiveScope: 'user' | 'project' = scope === 'project' ? 'project' : 'user';
    let warning: string | undefined;
    if (effectiveScope === 'project' && projectPath) {
      // The server IS registered (.mcp.json written) even if the trust write
      // loses a race; surface a soft warning rather than failing the whole add,
      // so the user knows the server may not load until manually approved.
      const approved = await autoApproveProjectServer(projectPath, name);
      if (!approved) {
        warning = `Registered "${name}", but could not persist its trust approval in ~/.claude.json ` +
          `(a concurrent writer kept clobbering it). It may not load until you enable it manually.`;
      }
    }
    // NOTE: "This project" code search is no longer registered here — it's enabled
    // in-process via POST /api/code-search (no stdio MCP server is added), so there's
    // no codesearch branch in this generic MCP-add path anymore.
    mcpCache.invalidate(projectPath || null, effectiveScope).catch(() => { /* background */ });
    return NextResponse.json({ success: true, output: output.trim(), ...(warning ? { warning } : {}) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCP API] Error adding MCP server:', message);
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, projectPath } = body;

    if (!name) {
      return NextResponse.json({ error: 'Server name is required' }, { status: 400 });
    }

    const execOpts: { timeout: number; encoding: 'utf-8'; env: NodeJS.ProcessEnv; cwd?: string } = {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    };

    // Run in project directory so claude can find project-scoped .mcp.json
    if (projectPath) {
      execOpts.cwd = projectPath;
    }

    // Capture scope before the mutation so we can invalidate correctly.
    // Unknown (uncached) → treat as user-scope so all projects get refreshed.
    const scope = mcpCache.peekScope(projectPath || null, name) ?? 'user';

    const { stdout, stderr } = await execFileAsync('claude', ['mcp', 'remove', name], execOpts);

    const output = (stdout || '') + (stderr || '');
    mcpCache.invalidate(projectPath || null, scope).catch(() => { /* background */ });
    return NextResponse.json({ success: true, output: output.trim() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCP API] Error removing MCP server:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
