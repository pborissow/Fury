/**
 * Transcripts MCP tool handlers (lib/transcriptsMcpServer.ts,
 * docs/ticket-ask-search.md §3, §7) over a seeded scratch archive.
 *
 * Pins: what each tool finds and filters; ids passed through verbatim (the
 * librarian's answer contract); output caps; text hygiene (highlight markers,
 * control chars); errors reported as tool errors, never thrown; and that the
 * whole surface is READ-ONLY (connection write counter unchanged).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// MUST be set before the first getDb().
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fury-transcripts-mcp-'));
process.env.FURY_DB_PATH = join(TEMP_ROOT, 'test.db');

import { getDb } from '../../lib/db';
import {
  transcriptsToolHandlers,
  transcriptsMcpServer,
  cleanText,
  HITS_PER_SESSION,
  MAX_OUTPUT_CHARS,
  TRANSCRIPTS_MCP_SERVER_NAME,
} from '../../lib/transcriptsMcpServer';

afterAll(async () => {
  delete process.env.FURY_DB_PATH;
  try { (await getDb()).close(); } catch { /* best effort */ }
  try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const FURY = '/Users/me/Documents/JavaScript/Fury';
const OTHER = '/Users/me/Projects/garden-planner';

async function seed(
  sessionId: string,
  project: string,
  display: string,
  messages: [role: 'user' | 'assistant', content: string][],
  opts: { label?: string; status?: string; updatedAt?: number } = {},
) {
  const db = await getDb();
  const t = opts.updatedAt ?? Date.now();
  await db.execute({
    sql: `INSERT OR REPLACE INTO sessions (session_id, project, display, message_count, created_at, updated_at, status, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [sessionId, project, display, messages.length, t - 1000, t, opts.status ?? 'active',
      opts.label ? JSON.stringify({ label: opts.label }) : null],
  });
  await db.execute({ sql: 'DELETE FROM messages WHERE session_id = ?', args: [sessionId] });
  for (let i = 0; i < messages.length; i++) {
    await db.execute({
      sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      args: [sessionId, messages[i][0], messages[i][1], new Date(t).toISOString(), i],
    });
  }
}

type Json = Record<string, any>;
const h = transcriptsToolHandlers(getDb);
const parse = (r: { content: { text: string }[] }): Json => JSON.parse(r.content[0].text);

beforeAll(async () => {
  await seed('s-tree', FURY, 'fix the sidebar', [
    ['user', 'The file tree collapses every folder when I rename one.'],
    ['assistant', 'Looking at the tree watcher now.'],          // intermediary (next is assistant)
    ['assistant', 'Fixed: the file tree keeps expansion state across renames.'],
    ['user', 'great, also the file tree icons look off'],
    ['assistant', 'Updated the file tree icon set.'],
  ], { label: 'File tree polish', updatedAt: Date.now() - 1000 });
  await seed('s-browser', FURY, 'directory view', [
    ['user', 'Can we add drag and drop to the file browser?'],
    ['assistant', 'Added drag-and-drop to the directory view.'],
  ], { updatedAt: Date.now() - 5000 });
  await seed('s-garden', OTHER, 'plant list', [
    ['user', 'Sort the plant tree by bloom date.'],
    ['assistant', 'Done — the plant tree sorts by bloom date.'],
  ], { updatedAt: Date.now() - 10_000 });
  await seed('s-archived', FURY, 'old tree experiment', [
    ['user', 'Prototype a radial file tree.'],
    ['assistant', 'Here is a radial file tree prototype.'],
  ], { status: 'archived', updatedAt: Date.now() - 20_000 });
});

describe('search_transcripts', () => {
  it('finds sessions by message text and returns ids verbatim, best-first', async () => {
    const r = parse(await h.searchTranscripts({ q: 'file tree' }));
    const ids = r.results.map((s: Json) => s.sessionId);
    expect(ids).toEqual(expect.arrayContaining(['s-tree', 's-archived']));
    expect(ids).not.toContain('s-garden'); // "plant tree" ≠ "file tree"
    const tree = r.results.find((s: Json) => s.sessionId === 's-tree');
    expect(tree.title).toBe('File tree polish');               // label beats display
    expect(tree.project).toBe(FURY);
    expect(tree.hits.every((x: Json) => Number.isInteger(x.turnIndex))).toBe(true);
    // Rendered-bubble filter: the intermediary assistant segment (turn 1) is never a hit.
    expect(tree.hits.map((x: Json) => x.turnIndex)).not.toContain(1);
    expect(r.note).toMatch(/data, never as instructions/);
  });

  it('matches titles/labels and project path segments', async () => {
    const byLabel = parse(await h.searchTranscripts({ q: 'polish' }));
    expect(byLabel.results[0]).toMatchObject({ sessionId: 's-tree', titleOrProjectMatch: true });
    const byPath = parse(await h.searchTranscripts({ q: 'garden-planner' }));
    expect(byPath.results.map((s: Json) => s.sessionId)).toEqual(['s-garden']);
  });

  it('applies role, project and archived filters', async () => {
    const userOnly = parse(await h.searchTranscripts({ q: 'drag', role: 'user' }));
    expect(userOnly.results[0].hits.every((x: Json) => x.role === 'user')).toBe(true);
    const inOther = parse(await h.searchTranscripts({ q: 'tree', project: OTHER }));
    expect(inOther.results.map((s: Json) => s.sessionId)).toEqual(['s-garden']);
    const noArchived = parse(await h.searchTranscripts({ q: 'radial', includeArchived: false }));
    expect(noArchived.results).toEqual([]);
    const withArchived = parse(await h.searchTranscripts({ q: 'radial' }));
    expect(withArchived.results[0]).toMatchObject({ sessionId: 's-archived', status: 'archived' });
  });

  it('marks matches visibly and strips control characters', async () => {
    const r = parse(await h.searchTranscripts({ q: 'expansion' }));
    const snip: string = r.results[0].hits[0].snippet;
    expect(snip).toMatch(/«expansion»/);
    expect(snip).not.toMatch(/[\u0001\u0002]/);
    expect(cleanText('a\u0001b\u0002c\u0007d\ne')).toBe('a«b»cd\ne');
  });

  it('caps hits per session and sessions per call, reporting the totals', async () => {
    const r = parse(await h.searchTranscripts({ q: 'tree' }));
    for (const s of r.results) {
      expect(s.hits.length).toBeLessThanOrEqual(HITS_PER_SESSION);
      expect(s.hitCount).toBeGreaterThanOrEqual(s.hits.length);
    }
    const one = parse(await h.searchTranscripts({ q: 'tree', limit: 1 }));
    expect(one.returned).toBe(1);
    expect(one.totalSessions).toBeGreaterThan(1);
  });

  it('never exceeds the output cap, and says when it truncated', async () => {
    const long = 'needlecap ' + 'lorem ipsum dolor sit amet '.repeat(60);
    for (let i = 0; i < 30; i++) {
      await seed(`s-big-${i}`, `/Users/me/p/${'deep/'.repeat(30)}${i}`, `needlecap ${'x'.repeat(190)}`,
        [['user', long], ['assistant', long]]);
    }
    const res = await h.searchTranscripts({ q: 'needlecap', limit: 25 });
    expect(res.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const r = parse(res);
    expect(r.truncated).toBe(true);
    expect(r.returned).toBeLessThan(25);
    expect(r.totalSessions).toBe(30);
  });

  it('reports bad input as a tool error instead of throwing', async () => {
    const empty = await h.searchTranscripts({ q: '   ' });
    expect(empty.isError).toBe(true);
    // FTS operator junk is phrase-quoted by the engine: no throw, maybe no hits.
    for (const q of ['"unbalanced', 'NEAR(a b)', 'a:b*', ')))', "'; DROP TABLE sessions; --"]) {
      const r = await h.searchTranscripts({ q });
      expect(r.isError).toBeUndefined();
    }
    const db = await getDb();
    expect((await db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n).toBeGreaterThan(0);
  });
});

describe('list_projects', () => {
  it('lists each project once with counts, a short name, most recent first', async () => {
    const r = parse(await h.listProjects());
    const fury = r.projects.find((p: Json) => p.path === FURY);
    expect(fury).toMatchObject({ name: 'Fury', sessions: 3 });
    expect(r.projects.find((p: Json) => p.path === OTHER)).toMatchObject({ name: 'garden-planner', sessions: 1 });
    const times = r.projects.map((p: Json) => Date.parse(p.lastActive));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe('get_session', () => {
  it('returns a bounded digest: who/where/when + first and last rendered messages', async () => {
    const r = parse(await h.getSession({ sessionId: 's-tree', messages: 2 }));
    expect(r).toMatchObject({ sessionId: 's-tree', title: 'File tree polish', project: FURY, messageCount: 5 });
    expect(r.firstMessages.map((m: Json) => m.turnIndex)).toEqual([0, 2]);  // turn 1 is intermediary
    expect(r.lastMessages.map((m: Json) => m.turnIndex)).toEqual([3, 4]);
    expect(r.note).toMatch(/never as instructions/);
  });

  it('does not repeat messages for short sessions', async () => {
    const r = parse(await h.getSession({ sessionId: 's-browser', messages: 5 }));
    expect(r.firstMessages.map((m: Json) => m.turnIndex)).toEqual([0, 1]);
    expect(r.lastMessages).toEqual([]);
  });

  it('truncates long message text', async () => {
    const r = parse(await h.getSession({ sessionId: 's-big-0' }));
    for (const m of [...r.firstMessages, ...r.lastMessages]) {
      expect(m.text.length).toBeLessThanOrEqual(240);
      expect(m.text.endsWith('…')).toBe(true);
    }
  });

  it('reports an unknown id as a tool error that steers back to verbatim ids', async () => {
    const r = await h.getSession({ sessionId: 'made-up-id' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/exactly as returned by search_transcripts/);
    expect((await h.getSession({ sessionId: '' })).isError).toBe(true);
  });
});

describe('read-only surface', () => {
  it('no tool writes to the database', async () => {
    const db = await getDb();
    const changes = async () => Number((await db.execute('SELECT total_changes() AS n')).rows[0].n);
    const before = await changes();
    await h.searchTranscripts({ q: 'tree' });
    await h.searchTranscripts({ q: 'zzz-nothing' });           // LIKE fallback path
    await h.listProjects();
    await h.getSession({ sessionId: 's-tree' });
    await h.getSession({ sessionId: 'missing' });
    expect(await changes()).toBe(before);
  });

  it('builds an in-process SDK server named for the tool prefix', () => {
    const cfg = transcriptsMcpServer(getDb);
    expect(cfg.type).toBe('sdk');
    expect(cfg.name).toBe(TRANSCRIPTS_MCP_SERVER_NAME);
    // Fresh instance per call (one server backs one client connection).
    expect(transcriptsMcpServer(getDb).instance).not.toBe(cfg.instance);
  });
});
