import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

interface McpServer {
  name: string;
  url: string;
  status: 'connected' | 'needs_auth' | 'error' | 'unknown';
  statusDetail: string;
  scope: 'project' | 'user' | 'unknown';
  transport: 'stdio' | 'http' | 'unknown';
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectPath = searchParams.get('projectPath');

    const execOpts: { timeout: number; encoding: 'utf-8'; env: NodeJS.ProcessEnv; cwd?: string } = {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    };

    if (projectPath) {
      execOpts.cwd = projectPath;
    }

    const { stdout, stderr } = await execFileAsync('claude', ['mcp', 'list'], execOpts);

    const output = (stdout || '') + (stderr || '');
    const servers: McpServer[] = [];

    // Parse lines like:
    //   "claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication"
    //   "my-server: stdio://npx my-mcp-server - ✓ Connected"
    // The first line is "Checking MCP server health..." — skip it
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Checking')) continue;

      // Pattern: "name: url - status"
      const match = trimmed.match(/^(.+?):\s+(\S+)(?:\s+\([^)]+\))?\s+-\s+(.+)$/);
      if (match) {
        const [, name, url, statusText] = match;
        let status: McpServer['status'] = 'unknown';
        if (/needs\s+auth/i.test(statusText)) {
          status = 'needs_auth';
        } else if (/connected|ok|running/i.test(statusText)) {
          status = 'connected';
        } else if (/error|fail/i.test(statusText)) {
          status = 'error';
        }
        servers.push({
          name: name.trim(),
          url: url.trim(),
          status,
          statusDetail: statusText.trim(),
          scope: 'unknown',
          transport: 'unknown',
        });
      }
    }

    // Fetch scope and transport per server in parallel via `claude mcp get`
    await Promise.all(servers.map(async (server) => {
      // Claude.ai integrations (e.g. "claude.ai Gmail") — can't query via `claude mcp get`
      if (server.name.startsWith('claude.ai ')) {
        server.scope = 'user';
        server.transport = 'http';
        return;
      }
      try {
        const { stdout: out, stderr: err } = await execFileAsync(
          'claude', ['mcp', 'get', server.name],
          { timeout: 10000, encoding: 'utf-8', env: { ...process.env, CLAUDECODE: undefined } },
        );
        const detail = (out || '') + (err || '');
        if (/project/i.test(detail.match(/Scope:\s*(.+)/)?.[1] || '')) {
          server.scope = 'project';
        } else if (/user/i.test(detail.match(/Scope:\s*(.+)/)?.[1] || '')) {
          server.scope = 'user';
        }
        const typeMatch = detail.match(/Type:\s*(\S+)/);
        if (typeMatch) {
          const t = typeMatch[1].toLowerCase();
          server.transport = t === 'http' ? 'http' : t === 'stdio' ? 'stdio' : 'unknown';
        }
      } catch {
        // Non-critical — leave as 'unknown'
      }
    }));

    return NextResponse.json({ servers });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCP API] Error listing MCP servers:', message);
    return NextResponse.json(
      { servers: [], error: message },
      { status: 200 }, // still 200 so the UI can show "no servers" gracefully
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

    const { stdout, stderr } = await execFileAsync('claude', ['mcp', 'remove', name], execOpts);

    const output = (stdout || '') + (stderr || '');
    return NextResponse.json({ success: true, output: output.trim() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCP API] Error removing MCP server:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
