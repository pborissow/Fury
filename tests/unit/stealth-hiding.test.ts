/**
 * The stealth-session HIDING CONTRACT, surface by surface
 * (docs/ticket-stealth-sessions.md §2). One marker — a cwd under
 * <FURY_HOME>/internal/ — and every user-facing surface must honor it:
 *
 *   - isInternalProject(): the marker test itself (boundaries, overrides, case)
 *   - archiveTranscript(): no sessions row → invisible to search, Stats session
 *     tables and the history DB-merge
 *   - history.jsonl writers: never append for an internal cwd
 *   - /api/history: drops an internal-cwd entry even if one is written
 *   - liveSessionScanner: drops PID files whose cwd is internal
 *   - computeLiveSessionIds(): hiddenIds beat every add-back
 *
 * The e2e spec (tests/e2e/stealth-sessions-hidden.spec.ts) re-checks the same
 * contract end to end against a real stealth session.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Hoisted: vi.mock('os') below runs before imports, and modules read homedir() at load.
const { TMP, HOME } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fury-stealth-hiding-'));
  const HOME = path.join(TMP, 'home');
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
  process.env.FURY_HOME = path.join(HOME, '.fury');
  process.env.FURY_DB_PATH = path.join(TMP, 'test.db');
  return { TMP, HOME };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => HOME };
});

import { furyInternalPath, furyInternalRoot, isInternalProject } from '../../lib/furyHome';
import { computeLiveSessionIds } from '../../lib/liveSessions';
import { archiveTranscript } from '../../lib/transcriptArchiver';
import { getDb } from '../../lib/db';
import { liveSessionScanner } from '../../lib/liveSessionScanner';
import { sdkSessionManager } from '../../lib/sdkSessionManager';

afterAll(async () => {
  delete process.env.FURY_HOME;
  delete process.env.FURY_DB_PATH;
  try { (await getDb()).close(); } catch { /* best effort */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
});

const INTERNAL = () => furyInternalPath('ask-search');
const tick = () => new Promise((r) => setTimeout(r, 50));

describe('isInternalProject — the marker', () => {
  it('matches the reserved root and anything beneath it', () => {
    expect(furyInternalRoot()).toBe(join(HOME, '.fury', 'internal'));
    expect(isInternalProject(furyInternalRoot())).toBe(true);
    expect(isInternalProject(INTERNAL())).toBe(true);
    expect(isInternalProject(join(INTERNAL(), 'deeper'))).toBe(true);
    expect(isInternalProject(INTERNAL() + '/')).toBe(true);
  });

  it('respects segment boundaries and rejects junk', () => {
    expect(isInternalProject(join(HOME, '.fury', 'internal-notes'))).toBe(false);
    expect(isInternalProject(join(HOME, '.fury', 'internalx', 'a'))).toBe(false);
    expect(isInternalProject(join(HOME, '.fury'))).toBe(false);
    expect(isInternalProject('/Users/me/Fury')).toBe(false);
    expect(isInternalProject(join(INTERNAL(), '..', '..', 'state'))).toBe(false);
    expect(isInternalProject(undefined)).toBe(false);
    expect(isInternalProject('')).toBe(false);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'is case-insensitive where the filesystem is', () => {
      expect(isInternalProject(INTERNAL().toUpperCase())).toBe(true);
    });

  it('follows FURY_HOME at call time', () => {
    const prev = process.env.FURY_HOME;
    process.env.FURY_HOME = join(TMP, 'other-home');
    try {
      expect(isInternalProject(join(TMP, 'other-home', 'internal', 'x'))).toBe(true);
      expect(isInternalProject(INTERNAL().replace(join(TMP, 'other-home'), prev!))).toBe(false);
    } finally {
      process.env.FURY_HOME = prev;
    }
  });

  it('refuses unsafe consumer names', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'A', '-x', 'x'.repeat(64)]) {
      expect(() => furyInternalPath(bad)).toThrow(/Invalid/);
    }
  });
});

describe('archiver: stealth sessions never get a sessions row', () => {
  const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: new Date().toISOString() });

  it('refuses an internal project but archives a normal one (control)', async () => {
    await archiveTranscript('stealth-1', INTERNAL(), 'hidden', jsonl, [], [jsonl], true);
    await archiveTranscript('normal-1', '/Users/me/project', 'visible', jsonl, [], [jsonl], true);
    const db = await getDb();
    const ids = (await db.execute('SELECT session_id FROM sessions')).rows.map((r) => r.session_id);
    expect(ids).toContain('normal-1');
    expect(ids).not.toContain('stealth-1');
    const msgs = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', args: ['stealth-1'] });
    expect(Number(msgs.rows[0].n)).toBe(0);
  });

  it('creates the internal_usage table for Stats roll-ups (§5)', async () => {
    const db = await getDb();
    await db.execute({
      sql: `INSERT INTO internal_usage (consumer, label, session_id, message_id, model, ts, input, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['ask-search', 'Search agent', 'stealth-1', 'm1', 'claude-haiku-4-5', new Date().toISOString(), 10, 5],
    });
    const r = await db.execute('SELECT consumer, label, output FROM internal_usage');
    expect(r.rows.map((x) => [x.consumer, x.label, Number(x.output)])).toEqual([['ask-search', 'Search agent', 5]]);
  });
});

describe('history.jsonl', () => {
  const historyPath = join(HOME, '.claude', 'history.jsonl');

  it('the SDK manager never appends an entry for an internal cwd', async () => {
    const mgr = sdkSessionManager as unknown as { appendHistoryEntry(s: object, p: string): void };
    mgr.appendHistoryEntry({ sessionId: 'stealth-2', projectPath: INTERNAL() }, 'secret prompt');
    mgr.appendHistoryEntry({ sessionId: 'normal-2', projectPath: '/Users/me/project' }, 'visible prompt');
    await tick();
    const text = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
    expect(text).toContain('normal-2');
    expect(text).not.toContain('stealth-2');
    expect(text).not.toContain('secret prompt');
  });

  it('/api/history drops an internal-cwd entry even if one is written', async () => {
    const now = Date.now();
    writeFileSync(historyPath, [
      { display: 'leaked', timestamp: now, project: INTERNAL(), sessionId: 'stealth-3' },
      { display: 'shown', timestamp: now - 1, project: '/Users/me/project', sessionId: 'normal-3' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const { GET } = await import('../../app/api/history/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost/api/history?limit=50'));
    const body = JSON.stringify(await res.json());
    expect(body).toContain('normal-3');
    expect(body).not.toContain('stealth-3');
  });
});

describe('history DB-merge', () => {
  it('drops an archived row with an internal project (archiver regression / legacy row)', async () => {
    const db = await getDb();
    const now = Date.now();
    // Bypass the archiver on purpose: this is the second layer.
    await db.execute({
      sql: `INSERT OR REPLACE INTO sessions (session_id, project, display, message_count, created_at, updated_at)
            VALUES (?, ?, ?, 2, ?, ?)`,
      args: ['stealth-db-1', INTERNAL(), 'leaked via db', now, now],
    });
    const { GET } = await import('../../app/api/history/route');
    const { NextRequest } = await import('next/server');
    const body = JSON.stringify(await (await GET(new NextRequest('http://localhost/api/history?limit=500'))).json());
    expect(body).not.toContain('stealth-db-1');
    expect(body).toContain('normal-1'); // the archived control row still merges in
  });
});

describe('Stats roll-up', () => {
  it('labels background-agent spend and never plots a row without a ts at the epoch', async () => {
    const db = await getDb();
    const ins = `INSERT OR REPLACE INTO internal_usage (consumer, label, session_id, message_id, model, ts, input, output)
                 VALUES (?, ?, ?, ?, 'claude-haiku-4-5', ?, 100, 50)`;
    await db.execute({ sql: ins, args: ['ask-search', null, 'st-a', 'old', '2026-10-01T12:00:00.000Z'] });
    await db.execute({ sql: ins, args: ['ask-search', 'Search agent', 'st-a', 'new', '2026-10-02T12:00:00.000Z'] });
    await db.execute({ sql: ins, args: ['ask-search', 'Search agent', 'st-a', 'nots', ''] });
    await db.execute({ sql: ins, args: ['ask-search', 'Search agent', 'st-a', 'nullts', null] });
    const { GET } = await import('../../app/api/stats/route');
    const stats = await (await GET(new Request('http://localhost/api/stats?tz=America/Los_Angeles'))).json();
    const days: string[] = stats.daily.map((d: { day: string }) => d.day);
    expect(days.some((d) => d < '2000')).toBe(false);
    const rows = stats.sessions.filter((r: { internal?: boolean }) => r.internal);
    // Latest label applies to every day, including the one that predates it.
    expect(rows.map((r: { display: string; day: string }) => [r.day, r.display]).sort()).toEqual(
      expect.arrayContaining([['2026-10-01', 'Search agent'], ['2026-10-02', 'Search agent']]),
    );
    expect(rows.every((r: { projectName: string; project: string }) => r.projectName === 'Background agents' && r.project === '')).toBe(true);
    expect(JSON.stringify(stats)).not.toContain('st-a');
  });
});

describe('live set', () => {
  it('the PID scanner drops entries whose cwd is internal', async () => {
    const dir = join(HOME, '.claude', 'sessions');
    writeFileSync(join(dir, '111.json'), JSON.stringify({ pid: 111, sessionId: 'stealth-4', cwd: INTERNAL(), startedAt: 1 }));
    writeFileSync(join(dir, '222.json'), JSON.stringify({ pid: 222, sessionId: 'normal-4', cwd: '/Users/me/project', startedAt: 1 }));
    const scanner = liveSessionScanner as unknown as { isProcessAlive: (pid: number) => Promise<boolean> };
    const orig = scanner.isProcessAlive;
    scanner.isProcessAlive = async () => true;
    try {
      const ids = await liveSessionScanner.scanNow();
      expect(ids).toContain('normal-4');
      expect(ids).not.toContain('stealth-4');
    } finally {
      scanner.isProcessAlive = orig;
    }
  });

  it('computeLiveSessionIds: hiddenIds beat every add-back path', () => {
    const id = 'stealth-5';
    expect(computeLiveSessionIds({
      scannerIds: [id, 'other'],
      shippingActiveIds: [id],
      sdkManagedIds: [],
      sdkActiveIds: [id],
      backgroundActiveIds: [id],
      hiddenIds: [id],
    })).toEqual(['other']);
  });
});
