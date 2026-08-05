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
const SCHEMA_VER_KEY = '__fury_db_schema_v__';
const REMIGRATE_KEY = '__fury_db_remigrate__';
// Bump when adding a migration that the archiver/reader relies on, so a Next.js HMR
// (which reuses the globalThis-cached DB client and would NOT re-run initDb) applies
// it without a full restart — otherwise the reloaded archiver could INSERT/SELECT a
// column the live schema still lacks. initDb is idempotent, so re-running it is safe.
const SCHEMA_VERSION = 2; // 2: usage_events.agent_id + subagent-usage backfill

// Under vitest, skip the startup scan (which walks the user's REAL ~/.claude and
// re-archives sessions) so importing the DB in a test has no side effects. Tests
// that need a DB point FURY_DB_PATH at a scratch file.
const IN_TEST = !!process.env.VITEST || process.env.NODE_ENV === 'test';

function getDbPath(): string {
  const dbFile = process.env.FURY_DB_PATH || join(homedir(), '.claude', 'fury.db');
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
      -- For a sidechain row, the subagent it came from (agent-<id>.jsonl); NULL for
      -- main-thread rows. Enables per-subagent cost drill-down. The message_id is
      -- also namespaced "<agent_id>:<msgId>" so two subagents can't collide on the PK.
      agent_id TEXT,
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

    -- Cached snapshot of the selectable model/version catalog, fetched from the
    -- Anthropic Models API (GET /v1/models) using the CLI's OAuth token. Unlike
    -- pricing_overrides this is REPLACED wholesale on each successful refresh —
    -- it's a point-in-time mirror of what the account can select, not an
    -- append-only history. Feeds the model picker's per-family version dropdowns.
    CREATE TABLE IF NOT EXISTS model_catalog (
      id                TEXT PRIMARY KEY,   -- wire model id passed to setModel()
      family            TEXT NOT NULL,      -- 'opus' | 'sonnet' | 'haiku' | 'fable' | ...
      version_label     TEXT NOT NULL,      -- '4.8', '5', '4.5' — the decimal-ish version
      display_name      TEXT NOT NULL,      -- 'Claude Sonnet 4.6'
      max_input_tokens  INTEGER,
      max_output_tokens INTEGER,
      supports_effort   INTEGER DEFAULT 0,  -- 0/1
      created_at        TEXT,               -- model release date from the API
      fetched_at        INTEGER NOT NULL    -- when this snapshot was written
    );
    CREATE INDEX IF NOT EXISTS idx_model_catalog_family ON model_catalog(family);

    -- Every model-catalog refresh attempt (ok or failed). The poller calibrates
    -- its next run from MAX(checked_at) on boot, so a restart doesn't reset the
    -- weekly cadence — same durable-timer pattern as pricing_checks.
    CREATE TABLE IF NOT EXISTS model_checks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at   INTEGER NOT NULL,
      status       TEXT NOT NULL,     -- 'ok' | 'failed'
      http_status  INTEGER,
      trigger      TEXT,              -- 'scheduled' | 'scheduled-overdue' | 'manual'
      models_seen  INTEGER DEFAULT 0,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_model_checks_at ON model_checks(checked_at DESC);
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

  // Migration: per-subagent attribution for sidechain rows. NULL for main thread.
  try {
    await client.execute('ALTER TABLE usage_events ADD COLUMN agent_id TEXT');
  } catch {
    // Column already exists — expected after first migration
  }

  // One-time backfill: ingest historical subagent (sidechain) usage. Subagent turns
  // live in <slug>/<sid>/subagents/agent-*.jsonl, which the archiver didn't read
  // before — so every delegated session undercounted cost (up to ~10x). Guarded by a
  // marker so the (heavy) disk scan runs ONCE, and run in the BACKGROUND so a large
  // scan never blocks server boot. See docs/ticket-stats-undercount-subagent-tokens.md.
  try {
    await client.execute('CREATE TABLE IF NOT EXISTS schema_flags (key TEXT PRIMARY KEY, ts INTEGER)');
    const done = await client.execute({
      sql: 'SELECT 1 FROM schema_flags WHERE key = ? LIMIT 1',
      args: ['subagent_usage_backfill_v1'],
    });
    if (!done.rows.length && !IN_TEST) {
      // Fire-and-forget: don't hold up init on a big re-archive.
      void backfillSubagentUsage()
        .then(() => client.execute({
          sql: 'INSERT OR IGNORE INTO schema_flags (key, ts) VALUES (?, ?)',
          args: ['subagent_usage_backfill_v1', Date.now()],
        }))
        .catch((e) => console.error('[DB] subagent usage backfill failed:', e));
    }
  } catch (e) {
    console.error('[DB] subagent usage backfill setup failed:', e);
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
  //
  // P5: this contextTokens backfill and the is_sidechain backfill below are each an
  // N+1 re-parse of raw_jsonl over the ENTIRE archive. Awaited inline they gated
  // server readiness — getDb() awaits initDb() and every API route awaits getDb() —
  // so the first boot after upgrade stalled ALL data endpoints (history, stats,
  // sessions) until the whole re-parse finished. Run them fire-and-forget AFTER
  // init returns instead (mirrors the subagent backfill above). Kept CHAINED inside
  // ONE async IIFE — never concurrent — so their two per-session metadata
  // read-modify-writes can't clobber each other's key. Both are marker-guarded and
  // per-session, so a partial run resumes cleanly on the next boot.
  void (async () => {
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
      // Never downgrade a window the runtime already captured exactly.
      const known = typeof meta.contextWindow === 'number' ? meta.contextWindow as number : 0;
      const patch: Record<string, unknown> = { contextTokens: parsed?.contextTokens ?? 0 };
      if (!known && inferredWindow > 0) {
        patch.contextWindow = inferredWindow;
        windowsRecovered++;
        await client.execute({
          // is_sidechain = 0: subagent rows are written with context_window = 0 on
          // purpose (they don't have the main thread's window); don't backfill them
          // with the inferred main-thread window.
          sql: 'UPDATE usage_events SET context_window = ? WHERE session_id = ? AND context_window = 0 AND is_sidechain = 0',
          args: [inferredWindow, sid],
        });
      }
      // R1: route the metadata write through the LOCKED writer. P5 moved this
      // backfill to fire-and-forget, so it now overlaps live traffic; a raw
      // whole-blob UPDATE here would clobber a concurrent persistSessionModel /
      // persistSessionContextWindow (dropping a just-picked model — the exact
      // symptom P3's lock exists to prevent). updateSessionMetadata merges under
      // the per-session lock, preserving keys it doesn't touch.
      const { updateSessionMetadata } = await import('./transcriptArchiver');
      await updateSessionMetadata(sid, patch);
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
      // Route through the LOCKED metadata writer (R1): P5 made this backfill run
      // concurrently with live traffic, so a raw whole-blob write here could clobber
      // a concurrent persistSessionModel/ContextWindow. updateSessionMetadata merges
      // hasSidechainFlag under the per-session lock, preserving other keys.
      const { updateSessionMetadata } = await import('./transcriptArchiver');
      await updateSessionMetadata(sid, { hasSidechainFlag: true });
      updated++;
    }
    if (updated > 0) {
      console.log(`[DB] Backfilled is_sidechain for ${updated} sessions (${flagged} subagent events flagged)`);
    }
  } catch (err) {
    console.error('[DB] is_sidechain backfill error:', err);
  }
  })().catch((e) => console.error('[DB] history backfill failed:', e));

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
  if (g[GLOBAL_KEY]) {
    // Client survives HMR. If migrations were added since it was initialized,
    // re-run initDb (idempotent, single-flight) BEFORE handing the client back, so
    // callers never touch a column the live schema lacks.
    if (g[SCHEMA_VER_KEY] === SCHEMA_VERSION) return Promise.resolve(g[GLOBAL_KEY] as Client);
    if (!g[REMIGRATE_KEY]) {
      g[REMIGRATE_KEY] = initDb(g[GLOBAL_KEY] as Client)
        .then(() => { g[SCHEMA_VER_KEY] = SCHEMA_VERSION; })
        .catch((err: unknown) => { console.error('[DB] re-migration failed:', err); })
        .finally(() => { delete g[REMIGRATE_KEY]; });
    }
    return (g[REMIGRATE_KEY] as Promise<void>).then(() => g[GLOBAL_KEY] as Client);
  }
  if (g[PROMISE_KEY]) return g[PROMISE_KEY] as Promise<Client>;

  g[PROMISE_KEY] = (async () => {
    try {
      const client = createClient({ url: getDbPath() });
      await initDb(client);
      g[GLOBAL_KEY] = client;
      g[SCHEMA_VER_KEY] = SCHEMA_VERSION;

      // Kick off startup scan (fire-and-forget, don't block callers). Skipped in
      // tests so a DB import doesn't re-archive the developer's real sessions.
      if (!IN_TEST) {
        scanAndArchiveAll(client).catch(err =>
          console.error('[DB] Startup scan error:', err)
        );
      }

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

/**
 * One-time backfill of historical subagent usage. Finds every session that has a
 * `<slug>/<sid>/subagents/agent-*.jsonl` sidecar, and re-archives it through the
 * (now sidecar-aware) archiveSessionFromDisk so its subagent tokens land in
 * usage_events with is_sidechain=1. Idempotent — archiveTranscript wipes+reinserts
 * usage_events per session; invalidating the hash first forces the re-archive since
 * the MAIN JSONL is unchanged. Best-effort per session so one bad file can't abort
 * the whole backfill. See docs/ticket-stats-undercount-subagent-tokens.md.
 */
async function backfillSubagentUsage(): Promise<void> {
  const db = await getDb();
  const projectsBase = join(homedir(), '.claude', 'projects');
  let slugs: string[];
  try { slugs = await readdir(projectsBase); } catch { return; }
  const { archiveSessionFromDisk } = await import('./transcriptArchiver');

  let backfilled = 0;
  for (const slug of slugs) {
    const slugDir = join(projectsBase, slug);
    let entries: import('fs').Dirent[];
    try { entries = await readdir(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sid = e.name; // <slug>/<sid>/ holds the subagents sidecar dir
      let hasSub = false;
      try {
        const subFiles = await readdir(join(slugDir, sid, 'subagents'));
        hasSub = subFiles.some((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
      } catch { continue; }
      if (!hasSub) continue;
      // Only sessions we've archived (so we have their real project path).
      const row = await db.execute({ sql: 'SELECT project FROM sessions WHERE session_id = ? LIMIT 1', args: [sid] });
      const project = row.rows[0]?.project as string | undefined;
      if (!project) continue;
      try {
        await db.execute({ sql: 'UPDATE sessions SET jsonl_hash = NULL WHERE session_id = ?', args: [sid] });
        await archiveSessionFromDisk(sid, project);
        backfilled++;
      } catch (err) {
        console.error(`[DB] subagent backfill re-archive failed for ${sid}:`, err);
      }
    }
  }
  if (backfilled) console.log(`[DB] subagent usage backfill: re-archived ${backfilled} delegated session(s)`);
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
