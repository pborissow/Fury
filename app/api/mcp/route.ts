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
}

export async function GET() {
  try {
    const { stdout, stderr } = await execFileAsync('claude', ['mcp', 'list'], {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    });

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
      const match = trimmed.match(/^(.+?):\s+(\S+)\s+-\s+(.+)$/);
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
        });
      }
    }

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
    const { name, transport, commandOrUrl, args, envVars, scope } = body;

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

    const { stdout, stderr } = await execFileAsync('claude', cliArgs, {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    });

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
