/**
 * SQLite database singleton for transcript archival.
 *
 * Uses @libsql/client (Turso/libSQL) with a local file-based database
 * at ~/.claude/fury.db. Survives Next.js HMR via globalThis.
 *
 * On first initialization, runs a startup scan to archive all existing
 * JSONL transcripts into the database.
 */

import { createClient, type Client } from '@libsql/client';
import { homedir } from 'os';
import { join } from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { parseTranscriptJsonl } from './transcriptParser';
import { PRICING, PRICING_AS_OF } from './pricing';

const GLOBAL_KEY = '__fury_db__';
const PROMISE_KEY = '__fury_db_promise__';

function getDbPath(): string {
  const dbFile = join(homedir(), '.claude', 'fury.db');
  // libSQL requires file:// URL with forward slashes
  return 'file:///' + dbFile.replace(/\\/g, '/');
}

async function initDb(client: Client): Promise<void> {
  await client.execute('PRAGMA journal_mode=WAL');
  await client.execute('PRAGMA foreign_keys=ON');

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      project       TEXT NOT NULL,
      display       TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      jsonl_hash    TEXT,
      metadata      TEXT,
      -- Lifecycle status. 'archived' is a soft delete: the row and all its
      -- messages / raw_jsonl / usage_events are preserved (Stats keeps counting
      -- it) but the sidebar hides it. Owned exclusively by the delete/restore
      -- actions — the archiver must never write it. See docs/delete-to-archive.md.
      status        TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content       TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      turn_index    INTEGER NOT NULL,
      UNIQUE(session_id, turn_index)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS raw_jsonl (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      line_number   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      UNIQUE(session_id, line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_jsonl_session ON raw_jsonl(session_id);

    -- Per-message token usage, one row per unique assistant API message.
    -- Powers the Stats tab (spend by day / project / model). Cost is computed
    -- at read time from lib/pricing.ts, never stored here, so re-pricing is
    -- just a pricing-table edit. ts is an ISO-8601 string (bucket to local day
    -- in the query layer).
    CREATE TABLE IF NOT EXISTS usage_events (
      session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id   TEXT NOT NULL,
      model        TEXT,
      ts           TEXT,
      input        INTEGER NOT NULL DEFAULT 0,
      output       INTEGER NOT NULL DEFAULT 0,
      cache_write    INTEGER NOT NULL DEFAULT 0,
      cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0,
      cache_read   INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      -- Subagent call. Its tokens are billed (cost aggregation keeps them), but
      -- it runs its own small context with its own model, so anything reading
      -- context/window per event MUST exclude it or a subagent's ~3k call reads
      -- as the main thread's context.
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);

    -- Append-only history of model pricing. On startup we diff lib/pricing.ts
    -- against the newest row per model and insert a new row whenever a rate
    -- changed, giving a running log of pricing over time. Rates are $/Mtok.
    CREATE TABLE IF NOT EXISTS pricing_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at    INTEGER NOT NULL,
      model          TEXT NOT NULL,
      input          REAL NOT NULL,
      output         REAL NOT NULL,
      cache_write_5m REAL NOT NULL,
      cache_write_1h REAL NOT NULL,
      cache_read     REAL NOT NULL,
      effective_from TEXT,
      source         TEXT,
      note           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_log_model ON pricing_log(model, recorded_at DESC);

    -- Every pricing-poll attempt (ok or failed). The poller calibrates its next
    -- run from MAX(checked_at) on boot, so a restart doesn't reset the cadence.
    CREATE TABLE IF NOT EXISTS pricing_checks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at   INTEGER NOT NULL,
      status       TEXT NOT NULL,     -- 'ok' | 'failed'
      http_status  INTEGER,
      trigger      TEXT,              -- 'startup' | 'scheduled' | 'manual'
      models_seen  INTEGER DEFAULT 0,
      changes      INTEGER DEFAULT 0,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_checks_at ON pricing_checks(checked_at DESC);

    -- Poller-discovered rate periods, merged on top of the code constant so a
    -- price change takes effect forward-only (events before effective_from keep
    -- the old rate). Loaded into lib/pricing at boot / after each poll.
    CREATE TABLE IF NOT EXISTS pricing_overrides (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      model          TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      input          REAL NOT NULL,
      output         REAL NOT NULL,
      cache_write_5m REAL NOT NULL,
      cache_write_1h REAL NOT NULL,
      cache_read     REAL NOT NULL,
      discovered_at  INTEGER NOT NULL,
      source         TEXT,
      UNIQUE(model, effective_from)
    );
  `);

  // Migration: add metadata column to existing databases
  try {
    await client.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT');
  } catch {
    // Column already exists — expected after first migration
  }

  // Migration: soft-delete support. 'archived' rows are preserved intact
  // (transcript + usage_events + metadata) but hidden from the sidebar; Stats
  // still counts them. The NOT NULL DEFAULT backfills every pre-existing row to
  // 'active', so no separate backfill is needed. See docs/delete-to-archive.md.
  try {
    await client.execute(
      "ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
    );
  } catch {
    // Column already exists — expected after first migration
  }

  // Index the sidebar's hot-path filter. Must run AFTER the ALTER above, not in
  // the CREATE TABLE block: on a pre-migration DB the column doesn't exist yet,
  // and a failed CREATE INDEX would abort the whole executeMultiple.
  await client.execute(
    'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)'
  );

  // Migration: add effective_from to pricing_log (point-in-time pricing).
  try {
    await client.execute('ALTER TABLE pricing_log ADD COLUMN effective_from TEXT');
  } catch {
    // Column already exists — expected after first migration
  }

  // Migration: split cache_write into 5m/1h TTL buckets for accurate pricing.
  // Existing rows keep cache_write (the total); the split columns default to 0
  // and the stats route attributes a legacy total to 1h until a session is
  // re-archived (which repopulates them from the JSONL's cache_creation split).
  for (const col of ['cache_write_5m', 'cache_write_1h']) {
    try {
      await client.execute(`ALTER TABLE usage_events ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — expected after first migration
    }
  }

  // Migration: flag subagent (sidechain) calls. Their tokens are billed, so cost
  // still counts them, but they run their own small context under a possibly
  // different model — /api/stats excludes them from peak/final context and the
  // window, otherwise a subagent's ~3k call dents the curve and can be reported
  // as the session's ending context. Rows written before this default to 0
  // (treated as main thread) until the session is re-archived.
  try {
    await client.execute('ALTER TABLE usage_events ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — expected after first migration
  }

  // Migration: record the model's context window per usage event. Can't be
  // derived from the transcript — the JSONL logs "claude-opus-4-8" whether or
  // not the [1m] beta was active and has no window field — so it's captured at
  // runtime from the SDK's result.modelUsage. 0 means "unknown", and the UI
  // renders context size without a fill % rather than guessing a denominator.
  // Per-event rather than per-session because the model can change mid-session.
  try {
    await client.execute('ALTER TABLE usage_events ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — expected after first migration
  }

  // Migration: backfill numCompactions metadata for existing archived sessions.
  // Counts compaction user messages in raw_jsonl per session and stores the count.
  // Also migrates old hasCompaction boolean to numCompactions integer.
  try {
    const compacted = await client.execute(`
      SELECT r.session_id, COUNT(*) as cnt
      FROM raw_jsonl r
      JOIN sessions s ON s.session_id = r.session_id
      WHERE r.content LIKE '%"content":"This session is being continued from a previous conversation that ran out of context%'
        AND r.content LIKE '%"type":"user"%'
        AND (s.metadata IS NULL OR s.metadata NOT LIKE '%numCompactions%')
      GROUP BY r.session_id
    `);
    for (const row of compacted.rows) {
      const sid = row.session_id as string;
      const cnt = row.cnt as number;
      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.numCompactions = cnt;
      delete meta.hasCompaction;
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
    }
    if (compacted.rows.length > 0) {
      console.log(`[DB] Backfilled numCompactions for ${compacted.rows.length} sessions`);
    }
  } catch (err) {
    console.error('[DB] numCompactions backfill error:', err);
  }

  // Migration: backfill totalOutputTokens metadata for existing archived
  // sessions. Re-parses raw_jsonl per session and stores the cumulative
  // output token count (deduped by message id inside parseTranscriptJsonl).
  // Always writes the field — even 0 — so the migration doesn't re-run on
  // sessions that genuinely had no billable assistant output.
  try {
    const targets = await client.execute(`
      SELECT session_id FROM sessions
      WHERE metadata IS NULL OR metadata NOT LIKE '%totalOutputTokens%'
    `);
    let updated = 0;
    for (const row of targets.rows) {
      const sid = row.session_id as string;
      const rawRows = await client.execute({
        sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
        args: [sid],
      });
      if (rawRows.rows.length === 0) continue;
      const content = rawRows.rows.map(r => r.content as string).join('\n');
      let total = 0;
      try {
        total = parseTranscriptJsonl(content).totalOutputTokens;
      } catch (e) {
        console.warn(`[DB] totalOutputTokens parse failed for ${sid}:`, e);
        continue;
      }
      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.totalOutputTokens = total;
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
      updated++;
    }
    if (updated > 0) {
      console.log(`[DB] Backfilled totalOutputTokens for ${updated} sessions`);
    }
  } catch (err) {
    console.error('[DB] totalOutputTokens backfill error:', err);
  }

  // Migration: backfill usage_events for existing archived sessions. Re-parses
  // raw_jsonl per session and inserts the full per-message token breakdown for
  // the Stats tab. Sets metadata.totalTokens (and hasUsageEvents); the guard
  // below keys on totalTokens so the migration skips sessions that already have
  // it. The reactive archive path writes the same fields for sessions archived
  // after this deploy. (Note: totalTokens is not a substring of the pre-existing
  // totalOutputTokens, so old sessions are still picked up.)
  try {
    const targets = await client.execute(`
      SELECT session_id FROM sessions
      WHERE metadata IS NULL OR metadata NOT LIKE '%totalTokens%'
    `);
    let updated = 0;
    for (const row of targets.rows) {
      const sid = row.session_id as string;
      const rawRows = await client.execute({
        sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
        args: [sid],
      });
      if (rawRows.rows.length === 0) continue;
      const content = rawRows.rows.map(r => r.content as string).join('\n');
      let events;
      try {
        events = parseTranscriptJsonl(content).usageEvents;
      } catch (e) {
        console.warn(`[DB] usage_events parse failed for ${sid}:`, e);
        continue;
      }

      // Replace usage_events for this session, then set the done flag.
      const stmts: { sql: string; args: any[] }[] = [
        { sql: 'DELETE FROM usage_events WHERE session_id = ?', args: [sid] },
      ];
      for (const u of events) {
        stmts.push({
          sql: `INSERT INTO usage_events (session_id, message_id, model, ts, input, output, cache_write, cache_write_5m, cache_write_1h, cache_read, is_sidechain)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [sid, u.messageId, u.model, u.timestamp, u.input, u.output, u.cacheWrite, u.cacheWrite5m, u.cacheWrite1h, u.cacheRead, u.isSidechain ? 1 : 0],
        });
      }
      // Chunk to stay under batch size limits on very large sessions.
      const CHUNK = 500;
      for (let off = 0; off < stmts.length; off += CHUNK) {
        await client.batch(stmts.slice(off, off + CHUNK), 'write');
      }

      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.hasUsageEvents = true;
      meta.totalTokens = events.reduce(
        (s, u) => s + u.input + u.output + u.cacheWrite + u.cacheRead, 0);
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
      updated++;
    }
    if (updated > 0) {
      console.log(`[DB] Backfilled usage_events for ${updated} sessions`);
    }
  } catch (err) {
    console.error('[DB] usage_events backfill error:', err);
  }

  // Migration: backfill metadata.contextTokens (current context occupancy) for
  // existing archived sessions, replacing the cumulative token count the session
  // list used to render. Re-parses raw_jsonl per session, same as the migrations
  // above. Always writes the field — even 0 — so it doesn't re-run on sessions
  // with no assistant calls.
  //
  // Also recovers context_window where it is *logically certain*: a single API
  // call cannot exceed the model's window, so any session whose largest call
  // exceeded 200k was necessarily running a 1M-window model. Sessions that
  // stayed under 200k are genuinely ambiguous (200k and 1M both explain the
  // data), so they're left at 0 = unknown and the UI omits the fill % for them.
  // Going forward the exact value comes from the SDK at runtime; this only
  // rescues history.
  try {
    const targets = await client.execute(`
      SELECT session_id FROM sessions
      WHERE metadata IS NULL OR metadata NOT LIKE '%contextTokens%'
    `);
    let updated = 0;
    let windowsRecovered = 0;
    for (const row of targets.rows) {
      const sid = row.session_id as string;
      const rawRows = await client.execute({
        sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
        args: [sid],
      });
      // A session with no raw_jsonl, or one we can't parse, still has to get the
      // field written — the guard above selects on `metadata NOT LIKE
      // '%contextTokens%'`, so skipping the write (the old `continue`) made the
      // backfill re-select and re-query it on EVERY boot, forever. Record 0
      // (= unknown/nothing to measure) and move on.
      let parsed: ReturnType<typeof parseTranscriptJsonl> | null = null;
      if (rawRows.rows.length > 0) {
        const content = rawRows.rows.map(r => r.content as string).join('\n');
        try {
          parsed = parseTranscriptJsonl(content);
        } catch (e) {
          console.warn(`[DB] contextTokens parse failed for ${sid} — recording 0 so it doesn't re-run:`, e);
        }
      }

      // Sidechain calls are excluded: this infers the MAIN thread's window, and
      // a subagent can run a different model with a different window, so
      // including them makes the ">200k proves 1M" inference unsound.
      const maxCall = (parsed?.usageEvents ?? []).reduce(
        (m, u) => (u.isSidechain ? m : Math.max(m, u.input + u.cacheWrite + u.cacheRead)), 0);
      const inferredWindow = maxCall > 200_000 ? 1_000_000 : 0;

      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.contextTokens = parsed?.contextTokens ?? 0;
      // Never downgrade a window the runtime already captured exactly.
      const known = typeof meta.contextWindow === 'number' ? meta.contextWindow as number : 0;
      if (!known && inferredWindow > 0) {
        meta.contextWindow = inferredWindow;
        windowsRecovered++;
        await client.execute({
          sql: 'UPDATE usage_events SET context_window = ? WHERE session_id = ? AND context_window = 0',
          args: [inferredWindow, sid],
        });
      }
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
      updated++;
    }
    if (updated > 0) {
      console.log(
        `[DB] Backfilled contextTokens for ${updated} sessions ` +
        `(${windowsRecovered} with a recoverable context window)`);
    }
  } catch (err) {
    console.error('[DB] contextTokens backfill error:', err);
  }

  // Migration: populate is_sidechain on existing usage_events rows.
  //
  // The ALTER above defaults every pre-existing row to 0 (= main thread), and
  // NOTHING else would ever correct them: the usage_events and contextTokens
  // backfills are gated on metadata.totalTokens / metadata.contextTokens, which
  // are already set for every archived session, and scanAndArchiveAll skips on a
  // hash match — so a finished session is never re-archived. Hence a FRESH
  // metadata key; the obvious two are burned.
  //
  // Sessions that never ran a subagent are unaffected (their rows are correctly
  // 0), but any session with Task/Agent history would otherwise report subagent
  // calls as main-thread context forever.
  try {
    const targets = await client.execute(`
      SELECT session_id FROM sessions
      WHERE metadata IS NULL OR metadata NOT LIKE '%hasSidechainFlag%'
    `);
    let updated = 0;
    let flagged = 0;
    for (const row of targets.rows) {
      const sid = row.session_id as string;
      const rawRows = await client.execute({
        sql: 'SELECT content FROM raw_jsonl WHERE session_id = ? ORDER BY line_number',
        args: [sid],
      });

      let sidechainIds: string[] = [];
      if (rawRows.rows.length > 0) {
        try {
          const content = rawRows.rows.map(r => r.content as string).join('\n');
          sidechainIds = parseTranscriptJsonl(content).usageEvents
            .filter(u => u.isSidechain)
            .map(u => u.messageId);
        } catch (e) {
          console.warn(`[DB] is_sidechain parse failed for ${sid} — flagging anyway so it doesn't re-run:`, e);
        }
      }

      if (sidechainIds.length > 0) {
        const stmts = sidechainIds.map(id => ({
          sql: 'UPDATE usage_events SET is_sidechain = 1 WHERE session_id = ? AND message_id = ?',
          args: [sid, id],
        }));
        for (let off = 0; off < stmts.length; off += 500) {
          await client.batch(stmts.slice(off, off + 500), 'write');
        }
        flagged += sidechainIds.length;
      }

      // Always stamp the flag — including for raw-less/unparseable sessions and
      // ones with no sidechains — so this can never re-select them next boot.
      const existing = await client.execute({
        sql: 'SELECT metadata FROM sessions WHERE session_id = ?',
        args: [sid],
      });
      let meta: Record<string, unknown> = {};
      if (existing.rows[0]?.metadata) {
        try { meta = JSON.parse(existing.rows[0].metadata as string); } catch {}
      }
      meta.hasSidechainFlag = true;
      await client.execute({
        sql: 'UPDATE sessions SET metadata = ? WHERE session_id = ?',
        args: [JSON.stringify(meta), sid],
      });
      updated++;
    }
    if (updated > 0) {
      console.log(`[DB] Backfilled is_sidechain for ${updated} sessions (${flagged} subagent events flagged)`);
    }
  } catch (err) {
    console.error('[DB] is_sidechain backfill error:', err);
  }

  await syncPricingLog(client);
}

/**
 * Diff the version-controlled pricing table (lib/pricing.ts) against the newest
 * row per model in pricing_log, and append a new row for any model whose rates
 * changed (or that has no row yet). This gives a running history of pricing
 * without a live source; a future poller can insert rows the same way.
 */
async function syncPricingLog(client: Client): Promise<void> {
  try {
    const now = Date.now();
    let inserted = 0;
    for (const [model, periods] of Object.entries(PRICING)) {
      // Mirror the current (latest) period; when a new dated period is appended
      // to lib/pricing.ts, its rate differs from the last logged row and we
      // append a new audit entry carrying its effective date.
      const r = periods[periods.length - 1];
      const latest = await client.execute({
        sql: `SELECT input, output, cache_write_5m, cache_write_1h, cache_read, effective_from
              FROM pricing_log WHERE model = ? ORDER BY recorded_at DESC LIMIT 1`,
        args: [model],
      });
      const prev = latest.rows[0];
      const unchanged =
        prev &&
        prev.input === r.input &&
        prev.output === r.output &&
        prev.cache_write_5m === r.cacheWrite5m &&
        prev.cache_write_1h === r.cacheWrite1h &&
        prev.cache_read === r.cacheRead &&
        (prev.effective_from ?? '') === r.effectiveFrom;
      if (unchanged) continue;
      await client.execute({
        sql: `INSERT INTO pricing_log
                (recorded_at, model, input, output, cache_write_5m, cache_write_1h, cache_read, effective_from, source, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [now, model, r.input, r.output, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.effectiveFrom,
               'lib/pricing.ts', prev ? `updated (as of ${PRICING_AS_OF})` : `seed (as of ${PRICING_AS_OF})`],
      });
      inserted++;
    }
    if (inserted > 0) {
      console.log(`[DB] Logged pricing changes for ${inserted} models`);
    }
  } catch (err) {
    console.error('[DB] pricing_log sync error:', err);
  }
}

/**
 * Get the database client singleton. Creates and initializes on first call.
 * Uses a promise lock to prevent duplicate initialization from concurrent callers.
 */
export function getDb(): Promise<Client> {
  const g = globalThis as any;
  if (g[GLOBAL_KEY]) return Promise.resolve(g[GLOBAL_KEY] as Client);
  if (g[PROMISE_KEY]) return g[PROMISE_KEY] as Promise<Client>;

  g[PROMISE_KEY] = (async () => {
    try {
      const client = createClient({ url: getDbPath() });
      await initDb(client);
      g[GLOBAL_KEY] = client;

      // Kick off startup scan (fire-and-forget, don't block callers)
      scanAndArchiveAll(client).catch(err =>
        console.error('[DB] Startup scan error:', err)
      );

      return client;
    } catch (err) {
      // Clear the cached promise so the next call retries initialization
      delete g[PROMISE_KEY];
      throw err;
    }
  })();

  return g[PROMISE_KEY];
}

// ---- Startup scan ----

interface HistoryInfo {
  project: string;
  display: string;
  timestamp: number;
}

async function buildHistoryMap(): Promise<Map<string, HistoryInfo>> {
  const map = new Map<string, HistoryInfo>();
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const content = await readFile(historyPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) {
          // Keep the first (earliest) entry per session for display,
          // but update if we find a better (non-skippable) display.
          const existing = map.get(entry.sessionId);
          if (!existing) {
            map.set(entry.sessionId, {
              project: entry.project || '',
              display: entry.display || '',
              timestamp: entry.timestamp || Date.now(),
            });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* history.jsonl may not exist */ }
  return map;
}

async function scanAndArchiveAll(client: Client): Promise<void> {
  const { archiveTranscript, isCurrentlyArchived, computeHash } = await import('./transcriptArchiver');

  const projectsBase = join(homedir(), '.claude', 'projects');
  const historyMap = await buildHistoryMap();

  let dirs: string[];
  try {
    dirs = await readdir(projectsBase);
  } catch {
    console.log('[DB] No projects directory found, skipping startup scan');
    return;
  }

  let archived = 0;
  let skipped = 0;
  let errors = 0;

  for (const slug of dirs) {
    const slugDir = join(projectsBase, slug);
    let files: string[];
    try {
      const s = await stat(slugDir);
      if (!s.isDirectory()) continue;
      files = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');

      try {
        const filePath = join(slugDir, file);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) continue;

        const hash = computeHash(content);

        if (await isCurrentlyArchived(sessionId, hash)) {
          skipped++;
          continue;
        }

        const { messages, rawLines, numCompactions, totalOutputTokens, usageEvents, contextTokens } = parseTranscriptJsonl(content);
        if (messages.length === 0) {
          skipped++;
          continue;
        }

        // Get metadata from history map — skip sessions with no history entry
        // since we need the real project path (not the slug) for the frontend
        const info = historyMap.get(sessionId);
        if (!info?.project) {
          skipped++;
          continue;
        }
        const project = info.project;
        const display = info.display || messages[0]?.content?.substring(0, 200) || sessionId;

        await archiveTranscript(sessionId, project, display, content, messages, rawLines, true, { numCompactions, totalOutputTokens, usageEvents, contextTokens });
        archived++;
      } catch (err) {
        errors++;
        console.error(`[DB] Failed to archive ${sessionId}:`, err);
      }
    }
  }

  console.log(
    `[DB] Startup scan complete: ${archived} archived, ${skipped} already current` +
    (errors > 0 ? `, ${errors} errors` : '')
  );
}
