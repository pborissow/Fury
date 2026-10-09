/**
 * POST /api/search/ask (app/api/search/ask/route.ts): the NDJSON event
 * protocol and its failure paths (docs/ticket-ask-search.md §5-§6).
 *
 * askSearch() is mocked (no model calls); keywordFallback runs for real against
 * a seeded scratch archive, so the fallback assertions exercise the engine.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fury-ask-route-'));
process.env.FURY_DB_PATH = join(TEMP_ROOT, 'test.db');

const askSearchMock = vi.fn();
vi.mock('../../lib/askSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/askSearch')>();
  return { ...actual, askSearch: (...a: unknown[]) => askSearchMock(...a) };
});

import { getDb } from '../../lib/db';
import { StealthAskError } from '../../lib/stealthSessions';
import { POST } from '../../app/api/search/ask/route';
import { NextRequest } from 'next/server';

afterAll(async () => {
  delete process.env.FURY_DB_PATH;
  try { (await getDb()).close(); } catch { /* best effort */ }
  try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

const FURY = '/Users/me/Documents/JavaScript/Fury';

beforeAll(async () => {
  const db = await getDb();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at) VALUES ('s-tree', ?, 'tree work', 2, ?, ?)`,
    args: [FURY, now, now],
  });
  await db.execute({
    sql: `INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES ('s-tree', 'user', 'the file tree collapses on rename', ?, 0)`,
    args: [new Date(now).toISOString()],
  });
});

// Braces matter: mockReset() returns the mock, and a function returned from
// beforeEach is run by vitest as a cleanup hook (i.e. it would CALL the mock).
beforeEach(() => { askSearchMock.mockReset(); });

function post(body: unknown, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/search/ask', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal,
  });
}

async function events(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const QUESTION = 'can you help me find the sessions where we worked on the file tree in fury?';

describe('POST /api/search/ask', () => {
  it('rejects empty and over-long questions', async () => {
    expect((await POST(post({ question: '  ' }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ question: 'x'.repeat(501) }))).status).toBe(400);
    expect(askSearchMock).not.toHaveBeenCalled();
  });

  it('streams trimmed progress events, then the answer', async () => {
    askSearchMock.mockImplementation(async (_q: string, opts: { onToolEvent: (e: unknown) => void }) => {
      opts.onToolEvent({ type: 'tool_use', id: '1', name: 'mcp__transcripts__list_projects', input: {} });
      opts.onToolEvent({ type: 'tool_use', id: '2', name: 'mcp__transcripts__search_transcripts', input: { q: 'file tree', project: FURY, limit: 10 } });
      opts.onToolEvent({ type: 'tool_result', toolUseId: '2', isError: false }); // not forwarded
      return { summary: 'Found 1.', results: [{ sessionId: 's-tree' }], dropped: 0, costUsd: 0.001, durationMs: 1200 };
    });
    const res = await POST(post({ question: QUESTION }));
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    expect(await events(res)).toEqual([
      { type: 'progress', tool: 'list_projects', input: {} },
      { type: 'progress', tool: 'search_transcripts', input: { q: 'file tree', project: FURY } },
      { type: 'answer', summary: 'Found 1.', results: [{ sessionId: 's-tree' }], dropped: 0, costUsd: 0.001, durationMs: 1200 },
    ]);
    expect(askSearchMock.mock.calls[0][0]).toBe(QUESTION);
  });

  it('falls back to keyword search on the question residue when the agent fails', async () => {
    askSearchMock.mockRejectedValue(new StealthAskError('timeout', 'Ask exceeded 30000 ms'));
    const ev = await events(await POST(post({ question: QUESTION })));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'fallback', reason: 'timeout', query: 'file tree', project: FURY });
    expect(ev[0].results.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s-tree']);
  });

  it('retries the fallback with fewer terms when the full residue finds nothing', async () => {
    askSearchMock.mockRejectedValue(new Error('spawn failed'));
    const ev = await events(await POST(post({ question: 'where did we fix the collapses on rename in the zebra module?' })));
    expect(ev[0]).toMatchObject({ type: 'fallback', reason: 'error' });
    expect(ev[0].results.length).toBeGreaterThan(0);
    expect(ev[0].query.split(' ').length).toBeLessThan(5);
  });

  it('shows the agent\'s prose when it answered outside the schema', async () => {
    askSearchMock.mockRejectedValue(new StealthAskError('result_error', 'no structured output', {
      subtype: 'missing_structured_output', partialText: '**summary:** the tree sessions are…',
    }));
    expect(await events(await POST(post({ question: QUESTION })))).toEqual([
      { type: 'prose', text: '**summary:** the tree sessions are…' },
    ]);
  });

  it('a client abort interrupts the agent and ends the stream without a final event', async () => {
    const ac = new AbortController();
    let agentSignal: AbortSignal | undefined;
    askSearchMock.mockImplementation((_q: string, opts: { signal: AbortSignal; onToolEvent: (e: unknown) => void }) => {
      agentSignal = opts.signal;
      opts.onToolEvent({ type: 'tool_use', id: '1', name: 'mcp__transcripts__list_projects', input: {} });
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () =>
        reject(new StealthAskError('aborted', 'Ask aborted'))));
    });
    const res = await POST(post({ question: QUESTION }, ac.signal));
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first)).toMatchObject({ type: 'progress' });
    ac.abort();
    expect(agentSignal?.aborted).toBe(true);
    const rest = await reader.read();
    expect(rest.done).toBe(true);   // no fallback, no error: the user cancelled
  });
});
