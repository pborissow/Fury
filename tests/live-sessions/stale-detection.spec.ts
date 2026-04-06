import { test, expect } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const START_TIME_TOLERANCE = 30_000; // must match liveSessionScanner

interface SessionPidEntry {
  pid: number;
  sessionId: string;
  startedAt: number;
}

/** Validate a PID against the running process table independently of the scanner. */
async function validatePid(entry: SessionPidEntry): Promise<'valid' | 'dead' | 'not_claude' | 'time_mismatch' | 'no_startedAt'> {
  if (typeof entry.pid !== 'number' || entry.pid <= 0) return 'dead';

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command',
         `Get-CimInstance Win32_Process -Filter 'ProcessId = ${entry.pid}' | ForEach-Object { $_.Name + '|' + $_.CreationDate.ToString('o') }`],
        { timeout: 5000 }
      );
      const line = stdout.trim();
      if (!line) return 'dead';

      const [name, isoDate] = line.split('|');
      if (!name?.toLowerCase().startsWith('claude')) return 'not_claude';

      if (entry.startedAt == null) return 'no_startedAt';
      if (!isoDate) return 'valid'; // can't check time, but name matches

      const processStart = new Date(isoDate).getTime();
      if (Math.abs(processStart - entry.startedAt) > START_TIME_TOLERANCE) return 'time_mismatch';
      return 'valid';
    } catch {
      return 'dead';
    }
  }

  // macOS / Linux
  try {
    process.kill(entry.pid, 0);
  } catch {
    return 'dead';
  }

  try {
    const { stdout } = await execFileAsync(
      'ps', ['-p', String(entry.pid), '-o', 'comm=,lstart='],
      { timeout: 3000 }
    );
    const line = stdout.trim();
    if (!line) return 'dead';

    const comm = line.split(/\s+/)[0]?.split('/').pop() || '';
    if (!comm.startsWith('claude')) return 'not_claude';

    if (entry.startedAt == null) return 'no_startedAt';

    const lstartStr = line.substring(line.indexOf(comm) + comm.length).trim();
    if (lstartStr) {
      const processStart = new Date(lstartStr).getTime();
      if (!isNaN(processStart) && Math.abs(processStart - entry.startedAt) > START_TIME_TOLERANCE) {
        return 'time_mismatch';
      }
    }
    return 'valid';
  } catch {
    return 'dead';
  }
}

async function loadPidEntries(): Promise<SessionPidEntry[]> {
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  const entries: SessionPidEntry[] = [];
  const files = await readdir(sessionsDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await readFile(join(sessionsDir, file), 'utf-8');
      entries.push(JSON.parse(content));
    } catch { /* skip */ }
  }
  return entries;
}

test.describe('Live session detection', () => {

  test('API excludes sessions with dead, non-claude, or time-mismatched PIDs', async ({ request }) => {
    const entries = await loadPidEntries();
    const results = await Promise.all(entries.map(async e => ({ entry: e, status: await validatePid(e) })));
    const invalidIds = results
      .filter(r => r.status !== 'valid')
      .map(r => r.entry.sessionId);

    test.skip(invalidIds.length === 0, 'All PID files map to valid claude processes');

    const res = await request.get('/api/live-sessions');
    expect(res.ok()).toBe(true);
    const { liveSessionIds } = await res.json();

    for (const id of invalidIds) {
      expect(liveSessionIds, `session ${id} has invalid PID — should not be live`).not.toContain(id);
    }
  });

  test('API includes sessions with valid claude.exe processes', async ({ request }) => {
    const entries = await loadPidEntries();
    const results = await Promise.all(entries.map(async e => ({ entry: e, status: await validatePid(e) })));
    const validIds = results
      .filter(r => r.status === 'valid')
      .map(r => r.entry.sessionId);

    test.skip(validIds.length === 0, 'No valid session PIDs to test');

    const res = await request.get('/api/live-sessions');
    expect(res.ok()).toBe(true);
    const { liveSessionIds } = await res.json();

    for (const id of validIds) {
      expect(liveSessionIds, `session ${id} has valid claude process — should be live`).toContain(id);
    }
  });

  test('UI live badges match API live count', async ({ page }) => {
    await page.goto('/');

    const sessionItems = page.locator('.overflow-y-auto .rounded.border');
    await sessionItems.first().waitFor({ timeout: 10_000 });

    const res = await page.request.get('/api/live-sessions');
    const { liveSessionIds } = await res.json();

    if (liveSessionIds.length === 0) {
      const liveBadge = page.locator('.overflow-y-auto .rounded.border span', { hasText: 'Live' });
      expect(await liveBadge.count()).toBe(0);
      return;
    }

    const liveBadge = page.locator('.overflow-y-auto .rounded.border span', { hasText: 'Live' });
    await expect(liveBadge.first()).toBeVisible({ timeout: 10_000 });
    expect(await liveBadge.count()).toBe(liveSessionIds.length);
  });
});
