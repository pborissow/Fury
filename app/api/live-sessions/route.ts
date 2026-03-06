import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from '@/lib/utils';

const execAsync = promisify(exec);

export const runtime = 'nodejs';

/**
 * Returns the session IDs of currently live Claude sessions.
 *
 * Windows approach:
 * 1. Get command lines and creation times of running claude.exe processes
 * 2. Extract session IDs directly from --resume / --session-id flags
 * 3. For interactive sessions (no explicit session ID), fall back to a
 *    time-based heuristic matching process creation time to JSONL mtime
 *
 * Unix approach: pgrep + lsof to directly map PIDs to CWDs.
 */
export async function GET() {
  try {
    if (process.platform === 'win32') {
      return await getWindowsLiveSessions();
    } else {
      return await getUnixLiveSessions();
    }
  } catch {
    return NextResponse.json({ liveSessionIds: [] });
  }
}

async function getWindowsLiveSessions() {
  try {
    // Get command lines and creation times of all running claude.exe processes.
    // Parsing --resume / --session-id from the command line is far more
    // reliable than the old time-based heuristic which could mis-attribute
    // a running process to the wrong project/session.
    const psCommand = [
      'powershell -NoProfile -Command',
      '"Get-CimInstance Win32_Process | Where-Object {',
      "$_.Name -eq \'claude.exe\'",
      '} | Select-Object @{N=\'ct\';E={$_.CreationDate.ToString(\'o\')}},CommandLine',
      '| ConvertTo-Json -Compress"',
    ].join(' ');

    const { stdout } = await execAsync(psCommand, { timeout: 5000 });
    if (!stdout.trim()) {
      return NextResponse.json({ liveSessionIds: [] });
    }

    // PowerShell outputs a single object (not array) when there's only one result
    const parsed = JSON.parse(stdout);
    const procs: { ct: string; CommandLine: string }[] = Array.isArray(parsed) ? parsed : [parsed];

    if (procs.length === 0) {
      return NextResponse.json({ liveSessionIds: [] });
    }

    const liveSessionIds: string[] = [];
    const unmatchedCreationTimes: number[] = [];

    for (const proc of procs) {
      const cmdLine = proc.CommandLine || '';

      // Extract session ID from --resume or --session-id flags
      const resumeMatch = cmdLine.match(/--resume\s+([a-f0-9-]+)/);
      const sessionIdMatch = cmdLine.match(/--session-id\s+([a-f0-9-]+)/);
      const sessionId = resumeMatch?.[1] || sessionIdMatch?.[1];

      if (sessionId) {
        liveSessionIds.push(sessionId);
      } else {
        // Interactive session without explicit ID — collect for heuristic fallback
        const t = new Date(proc.ct).getTime();
        if (!isNaN(t)) unmatchedCreationTimes.push(t);
      }
    }

    // Fallback: for interactive sessions (no --resume/--session-id), use the
    // old time-based heuristic matching process creation time to JSONL mtime.
    if (unmatchedCreationTimes.length > 0) {
      unmatchedCreationTimes.sort((a, b) => b - a);
      const usedProcesses = new Set<number>();

      const historyPath = join(homedir(), '.claude', 'history.jsonl');
      let projectsFromHistory: { project: string }[] = [];

      try {
        const content = await readFile(historyPath, 'utf-8');
        const entries = content.trim().split('\n')
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .reverse();

        const seenProjects = new Set<string>();
        for (const entry of entries) {
          if (!entry.project || seenProjects.has(entry.project)) continue;
          seenProjects.add(entry.project);
          projectsFromHistory.push({ project: entry.project });
        }
      } catch { /* history.jsonl not readable */ }

      const projectsDir = join(homedir(), '.claude', 'projects');

      for (const { project } of projectsFromHistory) {
        const slug = projectPathToSlug(project);
        const slugDir = join(projectsDir, slug);

        let bestSession: { sessionId: string; mtime: number } | null = null;
        try {
          const files = await readdir(slugDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            try {
              const fileStat = await stat(join(slugDir, file));
              if (!bestSession || fileStat.mtimeMs > bestSession.mtime) {
                bestSession = { sessionId: file.replace('.jsonl', ''), mtime: fileStat.mtimeMs };
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }

        if (!bestSession) continue;

        // Skip sessions already identified by command-line parsing
        if (liveSessionIds.includes(bestSession.sessionId)) continue;

        let matchedProcess = -1;
        for (let i = 0; i < unmatchedCreationTimes.length; i++) {
          if (usedProcesses.has(i)) continue;
          if (unmatchedCreationTimes[i] <= bestSession.mtime) {
            matchedProcess = i;
            break;
          }
        }

        if (matchedProcess >= 0) {
          usedProcesses.add(matchedProcess);
          liveSessionIds.push(bestSession.sessionId);
        }

        if (usedProcesses.size >= unmatchedCreationTimes.length) break;
      }
    }

    return NextResponse.json({ liveSessionIds });
  } catch {
    return NextResponse.json({ liveSessionIds: [] });
  }
}

async function getUnixLiveSessions() {
  const liveSessionIds: string[] = [];

  try {
    // Step 1: Find PIDs of running claude CLI processes
    const { stdout: pgrepOut } = await execAsync('pgrep -af "^claude" 2>/dev/null', { timeout: 5000 });
    const pids = pgrepOut.trim().split('\n').map(line => line.trim().split(/\s/)[0]).filter(Boolean);

    if (pids.length === 0) {
      return NextResponse.json({ liveSessionIds: [] });
    }

    // Step 2: Get working directory for each PID via lsof
    const pidList = pids.join(',');
    const { stdout: lsofOut } = await execAsync(
      `lsof -a -p ${pidList} -d cwd -Fn 2>/dev/null`,
      { timeout: 5000 }
    );

    // Collect project directories from lsof
    const projectDirs: string[] = [];
    for (const line of lsofOut.split('\n')) {
      if (line.startsWith('n/')) {
        projectDirs.push(line.substring(1));
      }
    }

    // Step 3: Count processes per project directory, then find the N most
    // recently modified JSONLs per project (where N = process count).
    const projectsDir = join(homedir(), '.claude', 'projects');
    const processCounts: Record<string, number> = {};
    for (const dir of projectDirs) {
      processCounts[dir] = (processCounts[dir] || 0) + 1;
    }

    for (const [dir, count] of Object.entries(processCounts)) {
      const slug = projectPathToSlug(dir);
      const slugDir = join(projectsDir, slug);

      try {
        const files = await readdir(slugDir);
        const sessions: { sessionId: string; mtime: number }[] = [];

        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          try {
            const fileStat = await stat(join(slugDir, file));
            sessions.push({
              sessionId: file.replace('.jsonl', ''),
              mtime: fileStat.mtimeMs,
            });
          } catch { /* skip */ }
        }

        // Take the N most recently modified sessions
        sessions.sort((a, b) => b.mtime - a.mtime);
        for (let i = 0; i < Math.min(count, sessions.length); i++) {
          liveSessionIds.push(sessions[i].sessionId);
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch {
    // No claude processes or commands unavailable
  }

  return NextResponse.json({ liveSessionIds });
}
