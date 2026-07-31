/**
 * Integration test for refreshSubagentUsage (docs/ticket-stats-undercount-subagent-tokens.md,
 * review Note 1): the targeted trailing-subagent refresh that captures sidecar tokens
 * finishing AFTER a session's last main-thread turn — which no main-JSONL re-archive
 * would catch.
 *
 * Runs against a SCRATCH DB (FURY_DB_PATH) so it never touches the developer's real
 * ~/.claude/fury.db; the startup scan + backfill are IN_TEST-skipped. Sidecars are
 * written under the real ~/.claude/projects/<slug> (that path is baked into
 * subagentsDirFor) and cleaned up.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// MUST be set before the first getDb() call (which happens inside the tests).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'fury-db-'));
process.env.FURY_DB_PATH = join(TMP_DIR, 'test.db');

import { getDb } from '../../lib/db';
import { refreshSubagentUsage } from '../../lib/transcriptArchiver';
import { projectPathToSlug } from '../../lib/utils';

const asst = (id: string, model: string, usage: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: '2026-07-30T00:00:00Z', message: { id, model, content: [{ type: 'text', text: 'x' }], usage } }) + '\n';

const slugDirs: string[] = [];
afterAll(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const d of slugDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('refreshSubagentUsage', () => {
  it('inserts sidechain rows for trailing subagents and keeps totalTokens in sync', async () => {
    const db = await getDb();
    const sessionId = randomUUID();
    const project = join(homedir(), '.claude', `fury-refresh-tmp-${sessionId}`);

    // An archived session with one main-thread usage row.
    await db.execute({ sql: 'INSERT INTO sessions (session_id, project, display, created_at, updated_at) VALUES (?,?,?,?,?)', args: [sessionId, project, 'test', Date.now(), Date.now()] });
    await db.execute({
      sql: 'INSERT INTO usage_events (session_id, message_id, model, ts, input, output, cache_write, cache_read, is_sidechain) VALUES (?,?,?,?,?,?,?,?,0)',
      args: [sessionId, 'main1', 'claude-opus-4-8', '', 100, 50, 0, 1000],
    });

    // A subagent sidecar on disk (finished after the last main turn).
    const slugDir = join(homedir(), '.claude', 'projects', projectPathToSlug(project));
    slugDirs.push(slugDir);
    const subDir = join(slugDir, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-sub1.jsonl'), asst('a', 'claude-sonnet-4-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500 }));

    await refreshSubagentUsage(sessionId, project);

    const sc = await db.execute({ sql: 'SELECT message_id, agent_id, cache_read, context_window FROM usage_events WHERE session_id=? AND is_sidechain=1', args: [sessionId] });
    expect(sc.rows).toHaveLength(1);
    expect(sc.rows[0].message_id).toBe('sub1:a'); // namespaced
    expect(sc.rows[0].agent_id).toBe('sub1');
    expect(Number(sc.rows[0].cache_read)).toBe(500);
    expect(Number(sc.rows[0].context_window)).toBe(0); // excluded from window

    // Main row untouched.
    const main = await db.execute({ sql: 'SELECT COUNT(*) c FROM usage_events WHERE session_id=? AND is_sidechain=0', args: [sessionId] });
    expect(Number(main.rows[0].c)).toBe(1);

    // totalTokens = main (100+50+0+1000=1150) + subagent (10+20+0+500=530).
    const meta = await db.execute({ sql: 'SELECT metadata FROM sessions WHERE session_id=?', args: [sessionId] });
    expect(JSON.parse(meta.rows[0].metadata as string).totalTokens).toBe(1680);

    // Idempotent: re-running keeps exactly one sidechain row (namespacing dedups).
    await refreshSubagentUsage(sessionId, project);
    const again = await db.execute({ sql: 'SELECT COUNT(*) c FROM usage_events WHERE session_id=? AND is_sidechain=1', args: [sessionId] });
    expect(Number(again.rows[0].c)).toBe(1);
  });

  it('no-ops for a session that is not archived', async () => {
    await expect(refreshSubagentUsage(randomUUID(), '/nonexistent')).resolves.toBeUndefined();
  });
});
