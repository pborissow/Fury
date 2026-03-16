import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from './utils';
import { eventBus } from './eventBus';

const execAsync = promisify(exec);

class LiveSessionScanner {
  private intervalHandle: NodeJS.Timeout | null = null;
  private previousIds: Set<string> = new Set();
  private running = false;
  private readonly SCAN_INTERVAL = 10_000; // 10 seconds

  start() {
    if (this.intervalHandle) return;
    this.scan();
    this.intervalHandle = setInterval(() => this.scan(), this.SCAN_INTERVAL);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Run a scan immediately and return the result (for REST endpoint). */
  async scanNow(): Promise<string[]> {
    return process.platform === 'win32'
      ? this.scanWindows()
      : this.scanUnix();
  }

  private async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const ids = await this.scanNow();
      const currentSet = new Set(ids);
      if (!this.setsEqual(currentSet, this.previousIds)) {
        this.previousIds = currentSet;
        eventBus.emitApp({
          type: 'live-sessions',
          liveSessionIds: ids,
        });
      }
    } catch {
      // Scan failed — retain previous state, don't emit
    } finally {
      this.running = false;
    }
  }

  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  private async scanWindows(): Promise<string[]> {
    const liveSessionIds: string[] = [];

    try {
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
        .sort((a, b) => b - a);

      if (processCreationTimes.length === 0) {
        return [];
      }

      const historyPath = join(homedir(), '.claude', 'history.jsonl');
      let projectsFromHistory: { project: string; sessionId: string }[] = [];

      try {
        const content = await readFile(historyPath, 'utf-8');
        const entries = content.trim().split('\n')
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean)
          .reverse();

        const seenProjects = new Set<string>();
        for (const entry of entries) {
          if (!entry.project || !entry.sessionId || seenProjects.has(entry.project)) continue;
          seenProjects.add(entry.project);
          projectsFromHistory.push({ project: entry.project, sessionId: entry.sessionId });
        }
      } catch {
        // history.jsonl not readable
      }

      const usedProcesses = new Set<number>();
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
                bestSession = {
                  sessionId: file.replace('.jsonl', ''),
                  mtime: fileStat.mtimeMs,
                };
              }
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }

        if (!bestSession) continue;

        let matchedProcess = -1;
        for (let i = 0; i < processCreationTimes.length; i++) {
          if (usedProcesses.has(i)) continue;
          if (processCreationTimes[i] <= bestSession.mtime) {
            matchedProcess = i;
            break;
          }
        }

        if (matchedProcess >= 0) {
          usedProcesses.add(matchedProcess);
          liveSessionIds.push(bestSession.sessionId);
        }

        if (usedProcesses.size >= processCreationTimes.length) break;
      }
    } catch {
      // Process detection or history parsing failed
    }

    return liveSessionIds;
  }

  private async scanUnix(): Promise<string[]> {
    const liveSessionIds: string[] = [];

    try {
      const { stdout: pgrepOut } = await execAsync('pgrep -af "^claude" 2>/dev/null', { timeout: 5000 });
      const pids = pgrepOut.trim().split('\n').map(line => line.trim().split(/\s/)[0]).filter(Boolean);

      if (pids.length === 0) {
        return [];
      }

      const pidList = pids.join(',');
      const { stdout: lsofOut } = await execAsync(
        `lsof -a -p ${pidList} -d cwd -Fn 2>/dev/null`,
        { timeout: 5000 }
      );

      const projectDirs: string[] = [];
      for (const line of lsofOut.split('\n')) {
        if (line.startsWith('n/')) {
          projectDirs.push(line.substring(1));
        }
      }

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

          sessions.sort((a, b) => b.mtime - a.mtime);
          for (let i = 0; i < Math.min(count, sessions.length); i++) {
            liveSessionIds.push(sessions[i].sessionId);
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch {
      // No claude processes or commands unavailable
    }

    return liveSessionIds;
  }
}

// Singleton with globalThis protection for Next.js HMR
const globalKey = '__fury_live_scanner__';
export const liveSessionScanner: LiveSessionScanner =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new LiveSessionScanner());
