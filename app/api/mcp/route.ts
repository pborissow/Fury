import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { mcpCache, projectKeyCandidates } from '@/lib/mcpCache';

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

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  mcpCache.start();
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('projectPath');
    const { servers, error } = await mcpCache.get(projectPath);
    return NextResponse.json({ servers, ...(error ? { error } : {}) });
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
      const incomingArgs = args ? args.split(/\s+/).filter(Boolean) : [];
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

    // Add extra arguments after the command
    if (args) {
      const extraArgs = args.split(/\s+/).filter(Boolean);
      if (extraArgs.length > 0) {
        cliArgs.push('--', ...extraArgs);
      }
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
    mcpCache.invalidate(projectPath || null, effectiveScope).catch(() => { /* background */ });
    return NextResponse.json({ success: true, output: output.trim() });
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
