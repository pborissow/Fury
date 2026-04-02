import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { eventBus } from './eventBus';

const execAsync = promisify(exec);

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

          if (entry.pid && entry.sessionId && await this.isProcessAlive(entry.pid)) {
            liveSessionIds.add(entry.sessionId);
          }
        } catch { /* skip unreadable/malformed files */ }
      }
    } catch {
      // sessions directory doesn't exist or isn't readable
    }

    return [...liveSessionIds];
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          `tasklist /FI "PID eq ${pid}" /NH`,
          { timeout: 3000 }
        );
        return stdout.includes(String(pid));
      } catch {
        return false;
      }
    }

    // macOS / Linux: signal 0 checks existence without killing
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton with globalThis protection for Next.js HMR
const globalKey = '__fury_live_scanner__';
export const liveSessionScanner: LiveSessionScanner =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new LiveSessionScanner());
