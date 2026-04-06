import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { eventBus } from './eventBus';

const execFileAsync = promisify(execFile);


interface SessionPidEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
}

class LiveSessionScanner {
  private intervalHandle: NodeJS.Timeout | null = null;
  private previousIds: Set<string> = new Set();
  private running = false;
  private readonly SCAN_INTERVAL = 10_000; // 10 seconds
  // Max allowed drift between PID file startedAt and actual process creation
  // time. Catches PID reuse where a new process inherited an old PID.
  private readonly START_TIME_TOLERANCE = 30_000; // 30 seconds

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
    return this.scanViaPidFiles();
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

  /**
   * Reads ~/.claude/sessions/*.json to get deterministic pid-to-session mappings,
   * then checks whether each pid is still alive. Works on macOS, Linux, and Windows.
   */
  private async scanViaPidFiles(): Promise<string[]> {
    const sessionsDir = join(homedir(), '.claude', 'sessions');
    const liveSessionIds = new Set<string>();

    try {
      const files = await readdir(sessionsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await readFile(join(sessionsDir, file), 'utf-8');
          const entry: SessionPidEntry = JSON.parse(content);

          if (entry.pid && entry.sessionId && await this.isProcessAlive(entry.pid, entry.startedAt)) {
            liveSessionIds.add(entry.sessionId);
          }
        } catch { /* skip unreadable/malformed files */ }
      }
    } catch {
      // sessions directory doesn't exist or isn't readable
    }

    return [...liveSessionIds];
  }

  /**
   * Check if the process identified by `pid` is a live Claude session.
   * Validates process name and creation time on all platforms to prevent
   * PID-reuse false positives.
   */
  private async isProcessAlive(pid: number, startedAt?: number): Promise<boolean> {
    // Validate pid is actually a number before using it in any command
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;

    if (process.platform === 'win32') {
      return this.isProcessAliveWin32(pid, startedAt);
    }
    return this.isProcessAliveUnix(pid, startedAt);
  }

  private async isProcessAliveWin32(pid: number, startedAt?: number): Promise<boolean> {
    try {
      // Use execFile with args array to avoid shell injection
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { $_.Name + '|' + $_.CreationDate.ToString('o') }`,
        ],
        { timeout: 5000 }
      );

      const line = stdout.trim();
      if (!line) return false;

      const [name, isoDate] = line.split('|');
      if (!name || !name.toLowerCase().startsWith('claude')) return false;

      return this.validateStartTime(isoDate, startedAt);
    } catch {
      return false;
    }
  }

  private async isProcessAliveUnix(pid: number, startedAt?: number): Promise<boolean> {
    // Signal 0 checks existence without killing
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }

    // Verify it's a claude process and check creation time
    try {
      const { stdout } = await execFileAsync(
        'ps', ['-p', String(pid), '-o', 'comm=,lstart='],
        { timeout: 3000 }
      );

      const line = stdout.trim();
      if (!line) return false;

      // ps output: "claude  Mon Apr  5 08:51:37 2026" or "/path/to/claude ..."
      const comm = line.split(/\s+/)[0];
      if (!comm) return false;
      const basename = comm.split('/').pop() || '';
      if (!basename.startsWith('claude')) return false;

      // Extract lstart (everything after the command name)
      const lstartStr = line.substring(line.indexOf(comm) + comm.length).trim();
      if (lstartStr) {
        return this.validateStartTime(lstartStr, startedAt);
      }

      // No lstart available — fall through to startedAt-absent handling below
      return startedAt != null;
    } catch {
      // ps failed — process may have exited between kill(0) and ps
      return false;
    }
  }

  /** Compare process creation time against the PID file's startedAt. */
  private validateStartTime(processTimeStr: string | undefined, startedAt?: number): boolean {
    if (!processTimeStr) {
      // Can't determine process start time — only trust if startedAt is present
      // (indicates a well-formed PID file from a recent Claude version)
      return startedAt != null;
    }

    if (startedAt == null) {
      // Old PID file without startedAt — can't verify, treat as untrusted
      return false;
    }

    const processStart = new Date(processTimeStr).getTime();
    if (isNaN(processStart)) return false;
    return Math.abs(processStart - startedAt) <= this.START_TIME_TOLERANCE;
  }
}

// Singleton — stop the previous instance on HMR so the new class code takes effect.
const globalKey = '__fury_live_scanner__';
const existing = (globalThis as any)[globalKey] as LiveSessionScanner | undefined;
if (existing) existing.stop();
export const liveSessionScanner: LiveSessionScanner =
  (globalThis as any)[globalKey] = new LiveSessionScanner();
