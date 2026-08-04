/**
 * Transcript archival layer — persists parsed transcripts to SQLite
 * and retrieves them when the original JSONL files are gone.
 */

import { createHash } from 'crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getDb } from './db';
import { eventBus } from './eventBus';
import { parseTranscriptJsonl, type TranscriptMessage, type UsageEvent } from './transcriptParser';
import { parseSubagentUsageEvents, subagentsDirFor } from './subagentUsage';
import { projectPathToSlug } from './utils';

export interface SessionMetadata {
  label?: string;
  [key: string]: unknown;
}

/**
 * Per-session serialization for `sessions.metadata` read-modify-writes (P3).
 *
 * Every metadata write here is an unguarded SELECT metadata → JSON.parse → set
 * one key → UPDATE the whole blob. Two of them fire back-to-back and unawaited on
 * a single `result` (persistSessionModel + persistSessionContextWindow), and the
 * archive / subagent-refresh paths can overlap with them too. Without a lock both
 * SELECTs can read the same pre-update blob and the second UPDATE clobbers the key
 * the first one wrote — dropping a user's model override or the context window.
 *
 * Same shape as lib/mcpApprove.ts's withLock: a per-key promise chain so all
 * metadata RMWs for one sessionId run strictly sequentially. Different sessions
 * never contend. The tail is swallowed so one failure can't reject the next op.
 */
const metaChains = new Map<string, Promise<unknown>>();
function withSessionMetaLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaChains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous op's outcome
  // Prune the map entry once this op is the tail, so it can't grow unbounded
  // across the process life (one entry per distinct session otherwise).
  const tail = run.then(() => {}, () => {});
  metaChains.set(sessionId, tail);
  void tail.then(() => {
    if (metaChains.get(sessionId) === tail) metaChains.delete(sessionId);
  });
  return run;
}

/**
 * Session lifecycle status. 'archived' is a soft delete — the row and all its
 * child data survive intact; only the sidebar hides it. See setSessionStatus.
 */
export type SessionStatus = 'active' | 'archived';

export interface SessionRecord {
  session_id: string;
  project: string;
  display: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  metadata?: SessionMetadata;
  status?: SessionStatus;
}

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a session is already archived with the same JSONL content.
 */
export async function isCurrentlyArchived(
  sessionId: string,
  jsonlHash: string
): Promise<boolean> {
  const db = await getDb();
  const row = await db.execute({
    sql: 'SELECT jsonl_hash FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
  return row.rows.length > 0 && row.rows[0].jsonl_hash === jsonlHash;
}

/**
 * Archive a transcript to SQLite. Skips if the content hash hasn't changed.
 *
 * UPSERTs the session, then deletes + re-inserts all messages and raw lines, handling
 * both new sessions and updates (a session that grew or was rewound).
 *
 * NOT a single transaction across the whole write (F9): the preamble + first 500 rows
 * commit in one db.batch, and each additional 500-row chunk commits separately, so a
 * concurrent reader between chunks (loadTranscript / restoreJsonlFromArchive) can see a
 * truncated prefix. It self-heals — the content hash is stamped only on the FINAL chunk,
 * so isCurrentlyArchived stays false and the next archive re-writes — but the window is
 * real for sessions over 500 rows.
 */
export async function archiveTranscript(
  sessionId: string,
  project: string,
  display: string,
  jsonlContent: string,
  messages: TranscriptMessage[],
  rawLines?: string[],
  skipHashCheck?: boolean,
  opts?: {
    numCompactions?: number;
    totalOutputTokens?: number;
    usageEvents?: UsageEvent[];
    /** Current context occupancy in tokens (parseTranscriptJsonl().contextTokens). */
    contextTokens?: number;
    /** The model's context window. NOT derivable from the JSONL — the transcript
     *  records "claude-opus-4-8" whether or not the [1m] beta was active, and
     *  carries no window field. Supplied by the session manager from the SDK's
     *  `result.modelUsage[model].contextWindow`. When omitted we fall back to
     *  whatever a previous run already stored, so re-archiving never loses it. */
    contextWindow?: number;
  }
): Promise<void> {
  const hash = computeHash(jsonlContent);

  if (!skipHashCheck && await isCurrentlyArchived(sessionId, hash)) return;

  const db = await getDb();
  const now = Date.now();

  // Determine created_at: keep existing if present, otherwise use earliest message timestamp
  const existing = await db.execute({
    sql: 'SELECT created_at FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
  const createdAt = existing.rows.length > 0
    ? (existing.rows[0].created_at as number)
    : (messages.length > 0
      ? new Date(messages[0].timestamp).getTime() || now
      : now);

  // Shrink guard: refuse to overwrite the archive when the incoming JSONL has
  // fewer messages than what's archived AND the shrink looks catastrophic
  // rather than a user-initiated rewind. Two destructive patterns:
  //   - Empty incoming (0 messages) over a non-empty archive: Claude CLI
  //     cleaned up the JSONL and a subsequent resume recreated an empty file.
  //   - Smaller incoming whose first message is NEWER than what's archived:
  //     the original head was lost (not a prefix).
  // A real rewind preserves the first message, so the surviving messages are a
  // prefix of the archive and the first timestamp matches — that is allowed.
  const archivedSnapshot = await db.execute({
    sql: 'SELECT COUNT(*) AS cnt, MIN(timestamp) AS first_ts FROM messages WHERE session_id = ?',
    args: [sessionId],
  });
  const archivedCount = (archivedSnapshot.rows[0]?.cnt as number | undefined) ?? 0;
  const archivedFirstTs = archivedSnapshot.rows[0]?.first_ts as string | undefined;
  if (
    archivedCount > 0 &&
    messages.length < archivedCount &&
    (
      messages.length === 0 ||
      (archivedFirstTs && messages[0].timestamp > archivedFirstTs)
    )
  ) {
    console.warn(
      `[archiveTranscript] REFUSING destructive overwrite for session ${sessionId}: ` +
      `incoming ${messages.length} msgs` +
      (messages.length > 0 ? ` starting ${messages[0].timestamp}` : ' (empty)') + `, ` +
      `archived ${archivedCount} msgs starting ${archivedFirstTs}. ` +
      `Looks like catastrophic shrink (JSONL recreated). Keeping archive intact.`
    );
    return;
  }

  // Ingest subagent (sidechain) usage from the sidecar transcripts and fold it into
  // the usage set. Centralized here so EVERY archive path (reactive watch, boot
  // scan, re-archive) captures it: the SDK writes subagent turns to
  // <sid>/subagents/agent-*.jsonl, absent from the main JSONL, so without this Stats
  // undercounts a delegated session by up to ~10x
  // (docs/ticket-stats-undercount-subagent-tokens.md). Only when the caller passed a
  // main-thread set (usage-bearing archive) — a usage-less call stays usage-less so
  // it can't wipe/rewrite analytics.
  const usageEvents = opts?.usageEvents
    ? [...opts.usageEvents, ...(await parseSubagentUsageEvents(subagentsDirFor(sessionId, project)))]
    : undefined;

  // Resolve the context window before writing usage_events. The window can't be
  // recovered from the transcript, so a caller that doesn't know it (e.g. the
  // file-watch archive path, which runs without a live session) must inherit the
  // value a previous run persisted rather than stamping 0 over it.
  let contextWindow = opts?.contextWindow ?? 0;
  if (!contextWindow) {
    const prior = await db.execute({
      sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
      args: [sessionId],
    });
    if (prior.rows[0]?.metadata) {
      try {
        const w = JSON.parse(prior.rows[0].metadata as string).contextWindow;
        if (typeof w === 'number' && isFinite(w) && w > 0) contextWindow = w;
      } catch {}
    }
  }

  // Build statements: UPSERT session (with NULL hash), clear old data, then insert new data.
  // The hash is set to NULL initially so that if a later batch fails, the incomplete
  // archive will be retried on the next call (NULL hash never matches).
  //
  // NOTE: `status` is deliberately absent from both the INSERT column list and
  // the DO UPDATE set-list, and must stay that way. On INSERT it takes the
  // 'active' column default; on CONFLICT it is left untouched, so re-archiving
  // an archived session (reactive listener, startup scan, transcript GET) can't
  // resurrect it into the sidebar. `status` is owned exclusively by the
  // delete/restore actions. See docs/delete-to-archive.md (trap #2).
  const preamble = [
    {
      sql: `INSERT INTO sessions (session_id, project, display, message_count, created_at, updated_at, jsonl_hash)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
              project = excluded.project,
              display = excluded.display,
              message_count = excluded.message_count,
              updated_at = excluded.updated_at,
              jsonl_hash = NULL`,
      args: [sessionId, project, display.substring(0, 200), messages.length, createdAt, now],
    },
    { sql: 'DELETE FROM messages WHERE session_id = ?', args: [sessionId] },
    { sql: 'DELETE FROM raw_jsonl WHERE session_id = ?', args: [sessionId] },
  ];
  // Only wipe usage_events when the caller is providing a fresh set — callers
  // that omit usageEvents (if any) must not silently clear the analytics data.
  if (usageEvents) {
    preamble.push({ sql: 'DELETE FROM usage_events WHERE session_id = ?', args: [sessionId] });
  }

  const inserts: { sql: string; args: any[] }[] = [];
  for (let i = 0; i < messages.length; i++) {
    inserts.push({
      sql: 'INSERT INTO messages (session_id, role, content, timestamp, turn_index) VALUES (?, ?, ?, ?, ?)',
      args: [sessionId, messages[i].role, messages[i].content, messages[i].timestamp, i],
    });
  }
  const lines = rawLines ?? jsonlContent.split('\n').filter(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    inserts.push({
      sql: 'INSERT INTO raw_jsonl (session_id, line_number, content) VALUES (?, ?, ?)',
      args: [sessionId, i, lines[i]],
    });
  }
  if (usageEvents) {
    for (const u of usageEvents) {
      inserts.push({
        // INSERT OR REPLACE, not a plain INSERT (P8): the DELETE usage_events above
        // rides in the first batch, but usage rows spill into later, separately-
        // committed chunks. A concurrent re-archive of the same session (e.g.
        // backfillSubagentUsage nulling the hash while scanAndArchiveAll runs) can
        // interleave and hit the (session_id, message_id) UNIQUE PK — a plain INSERT
        // would throw and abort the archive, leaving jsonl_hash NULL. OR REPLACE
        // makes the re-insert idempotent (mirrors refreshSubagentUsage).
        sql: `INSERT OR REPLACE INTO usage_events (session_id, message_id, model, ts, input, output, cache_write, cache_write_5m, cache_write_1h, cache_read, context_window, is_sidechain, agent_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        // Sidechain rows carry the parent's window as 0: a subagent runs its own
        // context under a possibly different model, so the parent's window must not
        // be attributed to it (Stats already excludes is_sidechain from window).
        args: [sessionId, u.messageId, u.model, u.timestamp, u.input, u.output, u.cacheWrite, u.cacheWrite5m, u.cacheWrite1h, u.cacheRead, u.isSidechain ? 0 : contextWindow, u.isSidechain ? 1 : 0, u.agentId ?? null],
      });
    }
  }

  // Chunk inserts to avoid hitting batch size limits on very large sessions
  const CHUNK_SIZE = 500;
  const firstChunk = inserts.slice(0, CHUNK_SIZE);
  await db.batch([...preamble, ...firstChunk], 'write');

  for (let offset = CHUNK_SIZE; offset < inserts.length; offset += CHUNK_SIZE) {
    await db.batch(inserts.slice(offset, offset + CHUNK_SIZE), 'write');
  }

  // All batches succeeded — stamp the real hash and merge metadata atomically
  const nc = opts?.numCompactions ?? 0;
  const tot = opts?.totalOutputTokens;
  const wroteUsage = Array.isArray(usageEvents);
  const ctxTok = opts?.contextTokens;
  const hasMeta =
    nc > 0 || typeof tot === 'number' || wroteUsage || typeof ctxTok === 'number' || contextWindow > 0;
  if (hasMeta) {
    // Serialize the metadata RMW against the live persisters (P3): a concurrent
    // persistSessionModel/ContextWindow must not read a pre-merge blob and clobber
    // the derived keys written here (or have its own key clobbered by this write).
    await withSessionMetaLock(sessionId, async () => {
    // Read existing metadata, merge in derived fields, write back with hash
    const metaRow = await db.execute({
      sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
      args: [sessionId],
    });
    let meta: Record<string, unknown> = {};
    if (metaRow.rows[0]?.metadata) {
      try { meta = JSON.parse(metaRow.rows[0].metadata as string); } catch {}
    }
    if (nc > 0) {
      meta.numCompactions = nc;
      delete meta.hasCompaction; // clean up old key if present
    }
    if (typeof tot === 'number') meta.totalOutputTokens = tot;
    // Marks usage_events as populated (so the backfill skips it) and stores the
    // cost-driving total billed token count — input + output + cache write +
    // cache read — so the session list renders the same number the Stats tab
    // aggregates, without re-summing. See lib/db.ts.
    if (wroteUsage) {
      meta.hasUsageEvents = true;
      // Includes subagent tokens (folded into usageEvents above), so the session
      // list's total matches the Stats aggregate for delegated sessions too.
      meta.totalTokens = usageEvents!.reduce(
        (s, u) => s + u.input + u.output + u.cacheWrite + u.cacheRead, 0);
    }
    // Current context occupancy + the window it's measured against. The session
    // list renders these directly (size, fill %, breakpoint icons) without
    // touching usage_events. contextWindow stays absent when unknown — the UI
    // then shows the size but no fill, rather than guessing a denominator.
    if (typeof ctxTok === 'number') meta.contextTokens = ctxTok;
    if (contextWindow > 0) meta.contextWindow = contextWindow;
    await db.execute({
      sql: 'UPDATE sessions SET jsonl_hash = ?, metadata = ? WHERE session_id = ?',
      args: [hash, JSON.stringify(meta), sessionId],
    });
    });
  } else {
    await db.execute({
      sql: 'UPDATE sessions SET jsonl_hash = ? WHERE session_id = ?',
      args: [hash, sessionId],
    });
  }
}

/**
 * Refresh ONLY a session's subagent (sidechain) usage_events from the current
 * sidecar transcripts — WITHOUT re-reading the (possibly huge) main JSONL or
 * rewriting messages/raw_jsonl.
 *
 * Captures trailing subagent tokens that finished AFTER the session's last
 * main-thread turn — a session killed mid-background, or a detached Monitor that
 * outlives the last turn — which no main-JSONL change would archive, since the
 * reactive watcher and the archive hash both key on the main JSONL alone
 * (docs/ticket-stats-undercount-subagent-tokens.md; the live-badge ticket's Note 1).
 * The common completion path self-heals: a subagent's <task-notification> starts a
 * new main turn, whose main-JSONL write triggers a full re-archive.
 *
 * Idempotent: deletes the session's is_sidechain rows and reinserts the current set
 * (namespaced ids keep them collision-safe). No-op when the session isn't archived
 * yet. Keeps metadata.totalTokens in sync so the sidebar total matches Stats.
 */
export async function refreshSubagentUsage(sessionId: string, project: string): Promise<void> {
  const db = await getDb();
  // Only touch sessions we've archived — usage_events FKs to sessions.
  const sess = await db.execute({ sql: 'SELECT metadata FROM sessions WHERE session_id = ?', args: [sessionId] });
  if (!sess.rows.length) return;

  const events = await parseSubagentUsageEvents(subagentsDirFor(sessionId, project));

  const ops: { sql: string; args: any[] }[] = [
    { sql: 'DELETE FROM usage_events WHERE session_id = ? AND is_sidechain = 1', args: [sessionId] },
  ];
  for (const u of events) {
    ops.push({
      // context_window 0: a subagent runs its own context under a possibly
      // different model, so the parent's window must not be attributed to it.
      sql: `INSERT OR REPLACE INTO usage_events (session_id, message_id, model, ts, input, output, cache_write, cache_write_5m, cache_write_1h, cache_read, context_window, is_sidechain, agent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      args: [sessionId, u.messageId, u.model, u.timestamp, u.input, u.output, u.cacheWrite, u.cacheWrite5m, u.cacheWrite1h, u.cacheRead, u.agentId ?? null],
    });
  }

  const CHUNK = 500; // stay within batch limits on very large sessions
  for (let i = 0; i < ops.length; i += CHUNK) {
    await db.batch(ops.slice(i, i + CHUNK), 'write');
  }

  // Recompute metadata.totalTokens over ALL rows (main + sidechain) so the session
  // list total matches the Stats aggregate for delegated sessions. Serialize the
  // RMW and RE-READ metadata inside the lock (P3): the `sess` read above happened
  // before the batch writes, so a concurrent persister could have updated the blob
  // since — reusing that stale copy would drop its key.
  await withSessionMetaLock(sessionId, async () => {
    const totRow = await db.execute({
      sql: 'SELECT COALESCE(SUM(input + output + cache_write + cache_read), 0) AS t FROM usage_events WHERE session_id = ?',
      args: [sessionId],
    });
    const fresh = await db.execute({ sql: 'SELECT metadata FROM sessions WHERE session_id = ?', args: [sessionId] });
    if (!fresh.rows.length) return; // session vanished mid-refresh
    let meta: Record<string, unknown> = {};
    try { if (fresh.rows[0].metadata) meta = JSON.parse(fresh.rows[0].metadata as string); } catch { /* keep {} */ }
    meta.totalTokens = Number(totRow.rows[0]?.t) || 0;
    meta.hasUsageEvents = true;
    await db.execute({
      sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
      args: [JSON.stringify(meta), sessionId],
    });
  });
}

/**
 * Persist a session's model override (the catalog id the user picked, e.g.
 * 'haiku' or 'opus[1m]'; undefined = follow the CLI default).
 *
 * The override otherwise lives only in sdkSessionManager's in-memory map, so a
 * server restart drops it and the session silently reverts to the default on its
 * next turn — the exact drift the override exists to prevent. It's stored beside
 * contextWindow because it has the same property: chosen at runtime and
 * unrecoverable from the transcript, which logs the model that SERVED each turn,
 * never the one that was selected (they differ under a fallbackModel demotion).
 *
 * Best-effort: a failure costs the override across a restart, never a turn.
 * Safe to call on every result — it no-ops when the stored value is unchanged.
 */
export async function persistSessionModel(
  sessionId: string,
  model: string | undefined
): Promise<void> {
  try {
    await withSessionMetaLock(sessionId, async () => {
      const db = await getDb();
      const row = await db.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sessionId],
      });
      // Same as persistSessionContextWindow: the row may not exist yet on the
      // first turn (the archiver creates it), so callers re-persist on later
      // results rather than gating on change alone.
      if (row.rows.length === 0) return;
      let meta: Record<string, unknown> = {};
      if (row.rows[0]?.metadata) {
        try { meta = JSON.parse(row.rows[0].metadata as string); } catch {}
      }
      const stored = typeof meta.model === 'string' ? meta.model : undefined;
      if (stored === model) return;
      // Delete rather than store null: "no override" and "key absent" mean the
      // same thing, and loadSessionModel only trusts a string.
      if (model === undefined) delete meta.model;
      else meta.model = model;
      await db.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sessionId],
      });
    });
  } catch (err) {
    console.warn(`[persistSessionModel] failed for ${sessionId}:`, err);
  }
}

/**
 * Parsed sessions.metadata for a session, or null when there's no row yet /
 * it's unreadable. The single read behind the typed loaders below — callers
 * needing several fields should use this directly rather than one query each.
 */
export async function loadSessionMeta(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const db = await getDb();
    const row = await db.execute({
      sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
      args: [sessionId],
    });
    if (row.rows.length === 0 || !row.rows[0]?.metadata) return null;
    return JSON.parse(row.rows[0].metadata as string);
  } catch (err) {
    console.warn(`[loadSessionMeta] failed for ${sessionId}:`, err);
    return null;
  }
}

/** The persisted model override for a session, or null if none/unreadable. */
export async function loadSessionModel(sessionId: string): Promise<string | null> {
  return modelFromMeta(await loadSessionMeta(sessionId));
}

/** The model override held in an already-loaded metadata blob. */
export function modelFromMeta(meta: Record<string, unknown> | null): string | null {
  const m = meta?.model;
  return typeof m === 'string' && m ? m : null;
}

/**
 * The context occupancy (latest call's prompt size) held in an already-loaded
 * metadata blob — written by the archiver, and the only source once a session
 * is no longer in the manager's memory.
 */
export function contextTokensFromMeta(meta: Record<string, unknown> | null): number {
  const t = meta?.contextTokens;
  return typeof t === 'number' && t > 0 ? t : 0;
}

/**
 * Persist a session's context window onto its metadata.
 *
 * The window is only ever reported by the running CLI/SDK (on the `result`
 * envelope's modelUsage) and is unrecoverable from the transcript afterwards —
 * the JSONL logs "claude-opus-4-8" whether or not the [1m] beta was active and
 * carries no window field. Capturing it here is what lets an archived session
 * render a fill %; without it the list shows context size only.
 *
 * Best-effort: a failure costs a fill bar, never a turn. Safe to call on every
 * result — it no-ops when the value is unchanged.
 */
export async function persistSessionContextWindow(
  sessionId: string,
  contextWindow: number
): Promise<void> {
  if (!(contextWindow > 0)) return;
  try {
    await withSessionMetaLock(sessionId, async () => {
      const db = await getDb();
      const row = await db.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sessionId],
      });
      // The row may not exist yet on a session's first turn; the archiver creates
      // it and the next result persists the window.
      if (row.rows.length === 0) return;
      let meta: Record<string, unknown> = {};
      if (row.rows[0]?.metadata) {
        try { meta = JSON.parse(row.rows[0].metadata as string); } catch {}
      }
      if (meta.contextWindow === contextWindow) return;
      meta.contextWindow = contextWindow;
      await db.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sessionId],
      });
    });
  } catch (err) {
    console.warn(`[persistSessionContextWindow] failed for ${sessionId}:`, err);
  }
}

/**
 * Load a transcript from the archive. Returns null if not found.
 */
export async function loadTranscript(
  sessionId: string
): Promise<{ messages: TranscriptMessage[]; rawLines: string[] } | null> {
  const db = await getDb();

  const msgResult = await db.execute({
    sql: 'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY turn_index',
    args: [sessionId],
  });

  if (msgResult.rows.length === 0) return null;

  const messages: TranscriptMessage[] = msgResult.rows.map(row => ({
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    timestamp: row.timestamp as string,
  }));

  const rawResult = await db.execute({
    sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
    args: [sessionId],
  });

  const rawLines = rawResult.rows.map(row => row.content as string);

  return { messages, rawLines };
}

/**
 * Restore a session JSONL on disk from the SQLite archive. Used to make
 * "resume" actually resume after Claude CLI's 30-day cleanup deletes the
 * original JSONL. Returns the path on success, null if the archive has
 * nothing for this session or if writing failed.
 *
 * Writes the slug directory derived from `projectPath`. The caller is
 * responsible for not clobbering an already-existing JSONL — this function
 * checks and refuses to overwrite.
 */
export async function restoreJsonlFromArchive(
  sessionId: string,
  projectPath: string,
): Promise<string | null> {
  const archived = await loadTranscript(sessionId);
  if (!archived || archived.rawLines.length === 0) return null;

  const slug = projectPathToSlug(projectPath);
  const dir = join(homedir(), '.claude', 'projects', slug);
  const jsonlPath = join(dir, `${sessionId}.jsonl`);

  try {
    // Don't clobber an existing JSONL — caller should have checked, but be safe.
    await stat(jsonlPath).then(
      () => { throw new Error('JSONL already exists; refusing to overwrite'); },
      (err: any) => { if (err.code !== 'ENOENT') throw err; },
    );
    await mkdir(dir, { recursive: true });
    await writeFile(jsonlPath, archived.rawLines.join('\n') + '\n', 'utf-8');
    console.log(`[restoreJsonlFromArchive] Wrote ${archived.rawLines.length} lines to ${jsonlPath}`);
    return jsonlPath;
  } catch (err) {
    console.error('[restoreJsonlFromArchive] Failed:', err);
    return null;
  }
}

/**
 * Load archived sessions for the history list.
 *
 * Defaults to active sessions only. This filter is load-bearing: /api/history
 * merges these rows in specifically to surface sessions whose JSONL file is gone
 * but whose DB row survives — which is *exactly* the shape of an archived
 * session (row kept, file deleted). Without it every archived session would
 * reappear in the sidebar on the next history refresh and archiving would look
 * like a no-op. See docs/delete-to-archive.md (trap #1).
 *
 * Pass `includeArchived` to get every status (a future restore UI will want it).
 * Legacy pre-migration rows are covered by the column's 'active' default.
 */
export async function loadArchivedSessions(opts?: {
  limit?: number;
  offset?: number;
  project?: string;
  /** Include soft-deleted ('archived') sessions. Default: active only. */
  includeArchived?: boolean;
}): Promise<SessionRecord[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;

  let sql = 'SELECT session_id, project, display, message_count, created_at, updated_at, metadata, status FROM sessions';
  const args: any[] = [];
  const where: string[] = [];

  if (!opts?.includeArchived) {
    where.push("status = 'active'");
  }
  if (opts?.project) {
    where.push('project = ?');
    args.push(opts.project);
  }
  if (where.length > 0) {
    sql += ' WHERE ' + where.join(' AND ');
  }

  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  const result = await db.execute({ sql, args });

  return result.rows.map(row => {
    let metadata: SessionMetadata | undefined;
    if (row.metadata) {
      try { metadata = JSON.parse(row.metadata as string); } catch { /* ignore bad JSON */ }
    }
    return {
      session_id: row.session_id as string,
      project: row.project as string,
      display: row.display as string,
      message_count: row.message_count as number,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      metadata,
      status: row.status as SessionStatus,
    };
  });
}

/**
 * The session_ids of every soft-deleted session.
 *
 * The sidebar's authority on what's hidden. /api/history builds its primary list
 * from history.jsonl, which carries no status, so the DB flag has to be applied
 * to that list explicitly — otherwise hiding an archived session depends
 * entirely on the delete route's best-effort history-strip having succeeded, and
 * an archived session whose history entry survives (failed strip; or an external
 * `claude --resume <id>` appending a fresh line) renders in the sidebar forever.
 *
 * Deliberately NOT loadArchivedSessions({ includeArchived: true }) partitioned
 * in JS: that applies its LIMIT in SQL, so archived rows would eat the budget
 * and silently drop active sessions off the end of the sidebar. This is an
 * unbounded single-column read covered by idx_sessions_status.
 */
export async function loadArchivedSessionIds(): Promise<Set<string>> {
  const db = await getDb();
  const result = await db.execute(
    "SELECT session_id FROM sessions WHERE status = 'archived'"
  );
  return new Set(result.rows.map(row => row.session_id as string));
}

/**
 * Update the metadata JSON for a session (merges with existing metadata).
 */
export async function updateSessionMetadata(sessionId: string, patch: Partial<SessionMetadata>): Promise<void> {
  // Serialize against the other metadata writers (P3) so a concurrent
  // persist/archive can't clobber the key this patch sets, or vice versa.
  await withSessionMetaLock(sessionId, async () => {
    const db = await getDb();
    // Read existing metadata, merge, and write back
    const existing = await db.execute({
      sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
      args: [sessionId],
    });
    let current: SessionMetadata = {};
    if (existing.rows.length > 0 && existing.rows[0].metadata) {
      try { current = JSON.parse(existing.rows[0].metadata as string); } catch { /* ignore */ }
    }
    const merged = { ...current, ...patch };
    // Remove keys set to null/undefined
    for (const key of Object.keys(merged)) {
      if (merged[key] == null) delete merged[key];
    }
    const json = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
    await db.execute({
      sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
      args: [json, sessionId],
    });
  });
}

/**
 * Set a session's lifecycle status. 'archived' soft-deletes it: the row and all
 * its usage_events / raw_jsonl / messages are preserved (Stats keeps counting
 * it; a future restore can bring it back), but the sidebar hides it.
 *
 * No-ops if the session has no DB row (e.g. a brand-new session deleted before
 * its first archive) — there's no accounting to preserve, so no tombstone is
 * written. Idempotent: re-archiving an archived session is an UPDATE to the
 * same value.
 */
export async function setSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE sessions SET status = ? WHERE session_id = ?',
    args: [status, sessionId],
  });
}

/** True if a durable `sessions` row exists (gates the delete route's JSONL unlink). */
async function sessionRowExists(sessionId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({
    sql: 'SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1',
    args: [sessionId],
  });
  return r.rows.length > 0;
}

/**
 * Persist a session to SQLite BEFORE the delete route destroys its JSONL, then flip
 * it to 'archived'. Returns whether a durable row now exists.
 *
 * The delete route MUST NOT unlink the JSONL unless this returns true — otherwise a
 * session with no prior DB row (deleted inside the fire-and-forget startup-archive
 * window, db.ts, or a history entry that never archived) loses its ONLY copy, and its
 * usage vanishes from Stats even though the confirm dialog promised otherwise (F1).
 *
 * Because a row now exists with status 'archived' when we return true, a reactive
 * re-archive racing the delete can only UPDATE (the ON CONFLICT upsert never writes
 * `status`), so it can't resurrect the session as 'active' (F1b). The status flip runs
 * under the per-session meta lock so it serializes with those reactive archives.
 * archiveSessionFromDisk is called OUTSIDE the lock because it acquires the lock
 * itself (via archiveTranscript) — nesting would deadlock.
 */
export async function archiveForDelete(sessionId: string, project: string | null): Promise<boolean> {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  if (project) {
    try {
      await archiveSessionFromDisk(sanitized, project);
    } catch (err) {
      console.error('[archiveForDelete] archive failed; JSONL will be preserved:', err);
    }
  }
  return withSessionMetaLock(sanitized, async () => {
    const exists = await sessionRowExists(sanitized);
    if (exists) {
      const db = await getDb();
      await db.execute({
        sql: 'UPDATE sessions SET status = ? WHERE session_id = ?',
        args: ['archived', sanitized],
      });
    }
    return exists;
  });
}

/**
 * Hard-delete a session and — via ON DELETE CASCADE — its messages, raw_jsonl
 * and usage_events.
 *
 * NOT used by the delete route any more: deleting a session archives it instead
 * (see setSessionStatus), because dropping usage_events retroactively rewrites
 * the Stats tab's history. Kept as the seam for a future explicit hard-purge.
 */
export async function deleteArchivedSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'DELETE FROM sessions WHERE session_id = ?',
    args: [sessionId],
  });
}

/**
 * Invalidate a session's archive hash so the next read triggers re-archival.
 * Used after rewind operations.
 */
export async function invalidateArchive(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE sessions SET jsonl_hash = NULL WHERE session_id = ?',
    args: [sessionId],
  });
}

// ---- Reactive archive listener ----

const LISTENER_KEY = '__fury_archive_listener__';

/**
 * Archive a single session by reading its JSONL file.
 * Used by the reactive listener — silently skips if the file
 * doesn't exist or the content hasn't changed.
 */
export async function archiveSessionFromDisk(
  sessionId: string,
  project: string,
  display?: string
): Promise<void> {
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  const slug = projectPathToSlug(project);
  const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sanitizedId}.jsonl`);

  let content: string;
  try {
    content = await readFile(jsonlPath, 'utf-8');
  } catch {
    return; // File doesn't exist (yet) — nothing to archive
  }

  if (!content.trim()) return;

  const hash = computeHash(content);
  if (await isCurrentlyArchived(sessionId, hash)) return;

  const { messages, rawLines, numCompactions, totalOutputTokens, usageEvents, contextTokens } = parseTranscriptJsonl(content);
  if (messages.length === 0) return;

  const label = display || messages.find(m => m.role === 'user')?.content?.substring(0, 200) || sessionId;
  await archiveTranscript(sessionId, project, label, content, messages, rawLines, true, { numCompactions, totalOutputTokens, usageEvents, contextTokens });
}

/**
 * Read the tail of a file (last `bytes` bytes). Returns the partial
 * content as a UTF-8 string. Falls back to full read for small files.
 */
async function readTail(filePath: string, bytes = 8192): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const fileStat = await fh.stat();
    if (fileStat.size <= bytes) {
      const buf = Buffer.alloc(fileStat.size);
      await fh.read(buf, 0, fileStat.size, 0);
      return buf.toString('utf-8');
    }
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, fileStat.size - bytes);
    return buf.toString('utf-8');
  } finally {
    await fh.close();
  }
}

/**
 * When history.jsonl changes, find recently-active sessions and archive them.
 * Reads only the tail (~8KB) of history.jsonl to identify which sessions were updated.
 */
async function onHistoryUpdated(): Promise<void> {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const tail = await readTail(historyPath);

    // The first line may be partial (cut mid-JSON) — skip it
    const lines = tail.split('\n');
    const safeLines = lines.slice(1).filter(l => l.trim());

    // Only process the most recent entries (last 20) to keep it fast
    const recentLines = safeLines.slice(-20);
    const seen = new Set<string>();

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.sessionId || !entry.project || seen.has(entry.sessionId)) continue;
        seen.add(entry.sessionId);

        await archiveSessionFromDisk(entry.sessionId, entry.project, entry.display);
      } catch { /* skip unparseable */ }
    }
  } catch {
    // history.jsonl unreadable — skip
  }
}

/**
 * When a watched transcript JSONL changes, archive that specific session.
 */
async function onTranscriptUpdated(sessionId: string, project: string): Promise<void> {
  try {
    await archiveSessionFromDisk(sessionId, project);
  } catch (err) {
    console.error(`[ArchiveListener] Failed to archive ${sessionId}:`, err);
  }
}

/**
 * Start listening for eventBus events and reactively archive transcripts.
 * Idempotent — safe to call multiple times.
 *
 * Call this from the SSE events route alongside liveSessionScanner.start()
 * and fileWatchers.startHistoryWatcher().
 */
/**
 * Run an async function with a single retry after a delay.
 */
async function withRetry(fn: () => Promise<void>, label: string, delayMs = 2000): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[ArchiveListener] ${label} failed, retrying in ${delayMs}ms:`, err);
    await new Promise(r => setTimeout(r, delayMs));
    try {
      await fn();
    } catch (retryErr) {
      console.error(`[ArchiveListener] ${label} retry failed:`, retryErr);
    }
  }
}

export function startArchiveListener(): void {
  const g = globalThis as any;
  if (g[LISTENER_KEY]) return;
  g[LISTENER_KEY] = true;

  eventBus.onApp(payload => {
    switch (payload.type) {
      case 'history-updated':
        withRetry(onHistoryUpdated, 'history-updated');
        break;

      case 'transcript:updated':
        withRetry(
          () => onTranscriptUpdated(payload.sessionId, payload.project),
          `transcript:updated(${payload.sessionId})`
        );
        break;
    }
  });
}
