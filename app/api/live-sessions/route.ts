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
 * 1. Get creation times of running claude.exe processes
 * 2. Get unique projects from history.jsonl (most recent first)
 * 3. For each project, find the most recently modified .jsonl session file
 * 4. A session is live if its JSONL was modified AFTER a process was created
 *    (i.e., there's a running process that could have written to it)
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
  const liveSessionIds: string[] = [];

  try {
    // Step 1: Get creation times of running Claude processes
    const psCommand = [
      'powershell -NoProfile -Command',
      '"Get-CimInstance Win32_Process | Where-Object {',
      "$_.Name -eq \'claude.exe\'",
      '} | ForEach-Object {',
      "$_.CreationDate.ToString(\'o\')",
      '}"',
    ].join(' ');

    const { stdout } = await execAsync(psCommand, { timeout: 5000 });
    const processCreationTimes = stdout.trim().split('\n')
      .map(line => new Date(line.trim()).getTime())
      .filter(t => !isNaN(t))
      .sort((a, b) => b - a); // newest first

    if (processCreationTimes.length === 0) {
      return NextResponse.json({ liveSessionIds: [] });
    }

    // Step 2: Get unique projects from history (most recent first)
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    let projectsFromHistory: { project: string; sessionId: string }[] = [];

    try {
      const content = await readFile(historyPath, 'utf-8');
      const entries = content.trim().split('\n')
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .reverse(); // most recent first

      const seenProjects = new Set<string>();
      for (const entry of entries) {
        if (!entry.project || !entry.sessionId || seenProjects.has(entry.project)) continue;
        seenProjects.add(entry.project);
        projectsFromHistory.push({ project: entry.project, sessionId: entry.sessionId });
      }
    } catch {
      // history.jsonl not readable
    }

    // Step 3: For each project, find the most recently modified JSONL and check
    // if a running process could have produced it (process created ≤ JSONL mtime)
    const usedProcesses = new Set<number>(); // indices into processCreationTimes

    const projectsDir = join(homedir(), '.claude', 'projects');

    for (const { project } of projectsFromHistory) {
      // Convert project path to slug
      const slug = projectPathToSlug(project);
      const slugDir = join(projectsDir, slug);

      // Find the most recently modified JSONL in this project
      let bestSession: { sessionId: string; mtime: number } | null = null;
      try {
        const files = await readdir(slugDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          try {
            const fileStat = await stat(join(slugDir, file));
            if (!bestSession || fileStat.mtimeMs > bestSession.mtime) {
              bestSession = {
                sessionId: file.replace('.jsonl', ''),
                mtime: fileStat.mtimeMs,
              };
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }

      if (!bestSession) continue;

      // Check if any unused process was created before this JSONL was last modified
      let matchedProcess = -1;
      for (let i = 0; i < processCreationTimes.length; i++) {
        if (usedProcesses.has(i)) continue;
        if (processCreationTimes[i] <= bestSession.mtime) {
          matchedProcess = i;
          break; // Take the first (newest) eligible unused process
        }
      }

      if (matchedProcess >= 0) {
        usedProcesses.add(matchedProcess);
        liveSessionIds.push(bestSession.sessionId);
      }

      // Stop if all processes are matched
      if (usedProcesses.size >= processCreationTimes.length) break;
    }
  } catch {
    // Process detection or history parsing failed
  }

  return NextResponse.json({ liveSessionIds });
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
