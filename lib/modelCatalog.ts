/**
 * Model-catalog poller — keeps the model picker's per-family version list current
 * by periodically fetching the Anthropic Models API (GET /v1/models) and caching
 * the result.
 *
 * Why this exists: the CLI's `Query.supportedModels()` only advertises the
 * current-generation aliases (opus 4.8, sonnet 5, haiku, fable) — it does NOT
 * enumerate older versions. But `setModel()` happily accepts them
 * (`claude-sonnet-4-6`, `claude-opus-4-7`, dated snapshots, …). The Models API is
 * the missing enumeration source, and it authenticates with the same OAuth token
 * the user already logged in with via Claude Code — no separate Fury login.
 *
 * Design (mirrors lib/pricingPoller's durable-timer pattern):
 *   - Every attempt (ok or failed) is written to the `model_checks` table.
 *   - On boot, `rehydrateModelCatalogPoller()` reads the last check and schedules
 *     the next run at lastCheck + interval — a restart never resets the cadence.
 *   - Cadence is `modelCatalogPollIntervalDays` (default 7), re-read on each
 *     (re)schedule.
 *   - A successful refresh REPLACES `model_catalog` wholesale (it's a point-in-time
 *     mirror of what the account can select, not an append-only history). Any
 *     failure leaves the previous snapshot intact so the picker never goes blank.
 *
 * The OAuth token is read fresh from ~/.claude/.credentials.json on each fetch and
 * never leaves the server — the picker receives only the parsed catalog.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from './db';
import { settingsPersistence } from './settingsPersistence';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 15_000;
const MIN_DELAY_MS = 5_000; // don't run instantly at boot; let startup settle
// After a FAILED check, retry on this short backoff instead of deferring the next
// attempt by a full poll interval (up to 7 days). A transient failure (expired
// OAuth, network blip) then recovers automatically within the hour (P13).
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const STATE_KEY = '__fury_model_catalog_poller__';
const MAX_PAGES = 10; // safety bound; the catalog is ~10 models today

/** Display + sort order by family, most capable first. Matches pricing.ts's
 *  MODEL_FAMILY_ORDER so the picker and the Stats tab agree. */
const FAMILY_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

export interface CatalogEntry {
  /** Wire model id passed straight to setModel() (e.g. 'claude-sonnet-4-6'). */
  id: string;
  /** 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos' | raw fallback. */
  family: string;
  /** Decimal-ish version, e.g. '4.8', '5', '4.5'. */
  versionLabel: string;
  /** 'Claude Sonnet 4.6'. */
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsEffort: boolean;
  /** Model release date from the API (ISO), for tie-break sorting. */
  createdAt: string | null;
}

export interface FamilyGroup {
  family: string;
  /** Family label for the row header, e.g. 'Opus'. */
  displayName: string;
  /** Rank for picker ordering (lower = more capable/first). */
  rank: number;
  /** Versions newest-first. */
  versions: CatalogEntry[];
}

interface PollerState { timer: ReturnType<typeof setTimeout> | null }
function state(): PollerState {
  const g = globalThis as any;
  return (g[STATE_KEY] ??= { timer: null });
}

// ---- OAuth token ----

/** Pull `claudeAiOauth.accessToken` out of a raw credentials JSON blob. */
function parseAccessToken(raw: string): string | null {
  const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  return typeof tok === 'string' && tok.length > 0 ? tok : null;
}

/**
 * The Claude Code OAuth access token, read from wherever the CLI stores it on
 * this platform:
 *   - macOS: the login Keychain, under the generic-password item
 *     'Claude Code-credentials'. There is NO ~/.claude/.credentials.json on Mac.
 *   - Linux / everything else: ~/.claude/.credentials.json on disk.
 *
 * Read fresh on every call: the CLI rotates the short-lived access token (~6h
 * TTL), so caching it in-process would go stale. Returns null when it can't be
 * found or is malformed — the caller records a failed check and keeps the prior
 * snapshot. We do NOT attempt a refresh here; that's the CLI's job.
 */
export function readOAuthToken(): string | null {
  // macOS: credentials live in the Keychain, not on disk. Fall through to the
  // file if the Keychain lookup fails (e.g. a non-standard setup).
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5_000 },
      );
      const tok = parseAccessToken(raw);
      if (tok) return tok;
    } catch {
      // fall through to the on-disk credentials file
    }
  }

  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    return parseAccessToken(raw);
  } catch {
    return null;
  }
}

// ---- parsing ----

/** Space form, e.g. from display_name 'Claude Sonnet 4.6'. */
const FAMILY_RE = /(fable|mythos|opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i;
/** Hyphen form, e.g. from a wire id 'claude-sonnet-4-6' (minor after a dash). */
const FAMILY_ID_RE = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i;

/** Title-case a family key for the row header ('opus' -> 'Opus'). */
function familyLabel(family: string): string {
  return family ? family[0].toUpperCase() + family.slice(1) : family;
}

/** Rank for FAMILY_ORDER; unknown families sort last but keep catalog order. */
export function familyRank(family: string): number {
  const i = FAMILY_ORDER.indexOf(family.toLowerCase());
  return i === -1 ? FAMILY_ORDER.length : i;
}

/**
 * Parse one Models-API object into a CatalogEntry, or null if it isn't a Claude
 * chat model we can place into a family (e.g. an unrecognized name shape).
 *
 * Prefers `display_name` ('Claude Sonnet 4.6') for the family+version — it's the
 * clean human form; the `id` varies between bare aliases ('claude-sonnet-5') and
 * dated snapshots ('claude-sonnet-4-5-20250929'). Falls back to the id when the
 * display name doesn't parse.
 */
export function parseModel(m: {
  id?: unknown;
  display_name?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  created_at?: unknown;
  capabilities?: { effort?: { supported?: unknown } };
}): CatalogEntry | null {
  const id = typeof m.id === 'string' ? m.id : '';
  if (!id) return null;
  const displayName = typeof m.display_name === 'string' && m.display_name ? m.display_name : id;

  // Prefer the display name's clean 'Sonnet 4.6' form; fall back to the wire id,
  // where the version's minor is dash-separated ('sonnet-4-6' -> '4.6').
  let family: string;
  let versionLabel: string;
  const nameMatch = displayName.match(FAMILY_RE);
  if (nameMatch) {
    family = nameMatch[1].toLowerCase();
    versionLabel = nameMatch[2];
  } else {
    const idMatch = id.match(FAMILY_ID_RE);
    if (!idMatch) return null;
    family = idMatch[1].toLowerCase();
    versionLabel = idMatch[3] ? `${idMatch[2]}.${idMatch[3]}` : idMatch[2];
  }

  return {
    id,
    family,
    versionLabel,
    displayName,
    maxInputTokens: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : null,
    maxOutputTokens: typeof m.max_tokens === 'number' ? m.max_tokens : null,
    supportsEffort: m.capabilities?.effort?.supported === true,
    createdAt: typeof m.created_at === 'string' ? m.created_at : null,
  };
}

/** Numeric value of a version label for descending sort ('4.8' -> 4.8). */
function versionValue(label: string): number {
  const n = parseFloat(label);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Group flat entries into per-family rows, families ordered most-capable-first
 * and versions within each newest-first. Pure — unit-tested directly.
 */
export function groupByFamily(entries: CatalogEntry[]): FamilyGroup[] {
  const byFamily = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    (byFamily.get(e.family) ?? byFamily.set(e.family, []).get(e.family)!).push(e);
  }
  const groups: FamilyGroup[] = [];
  for (const [family, versions] of byFamily) {
    versions.sort((a, b) => {
      const d = versionValue(b.versionLabel) - versionValue(a.versionLabel);
      if (d !== 0) return d;
      // Tie-break newest release first, then id for stability.
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id);
    });
    groups.push({ family, displayName: familyLabel(family), rank: familyRank(family), versions });
  }
  groups.sort((a, b) => a.rank - b.rank || a.family.localeCompare(b.family));
  return groups;
}

// ---- fetch ----

/** Fetch every model page from the Models API. Throws on non-2xx / network error. */
async function fetchAllModels(token: string): Promise<CatalogEntry[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const out: CatalogEntry[] = [];
    let url: string | null = `${MODELS_URL}?limit=100`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res: Response = await fetch(url, {
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data?: unknown[]; has_more?: boolean; last_id?: string } = await res.json();
      for (const m of json.data ?? []) {
        const entry = parseModel(m as Record<string, unknown>);
        if (entry) out.push(entry);
      }
      url = json.has_more && json.last_id
        ? `${MODELS_URL}?limit=100&after_id=${encodeURIComponent(json.last_id)}`
        : null;
    }
    return out;
  } finally {
    clearTimeout(to);
  }
}

// ---- the check ----

export interface CheckResult { status: 'ok' | 'failed'; models: number; note: string }

export async function runModelCatalogCheck(trigger: string): Promise<CheckResult> {
  const db = await getDb();
  let status: 'ok' | 'failed' = 'ok';
  let httpStatus = 0;
  let models = 0;
  let note = '';

  try {
    const token = readOAuthToken();
    if (!token) throw new Error(
      'no Claude Code OAuth token found (macOS Keychain "Claude Code-credentials" / ~/.claude/.credentials.json)',
    );

    let entries: CatalogEntry[];
    try {
      entries = await fetchAllModels(token);
    } catch (e: any) {
      const m = String(e?.message || e).match(/HTTP (\d+)/);
      if (m) httpStatus = Number(m[1]);
      throw e;
    }
    models = entries.length;
    if (models === 0) throw new Error('Models API returned 0 usable models (format may have changed)');
    httpStatus = 200;

    // Replace the snapshot atomically: one batch clears the old rows and writes
    // the new. On any failure above we never reach here, so the prior snapshot
    // survives untouched.
    const now = Date.now();
    await db.batch(
      [
        { sql: 'DELETE FROM model_catalog', args: [] },
        ...entries.map(e => ({
          sql: `INSERT INTO model_catalog
                  (id, family, version_label, display_name, max_input_tokens,
                   max_output_tokens, supports_effort, created_at, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            e.id, e.family, e.versionLabel, e.displayName,
            e.maxInputTokens, e.maxOutputTokens, e.supportsEffort ? 1 : 0, e.createdAt, now,
          ],
        })),
      ],
      'write',
    );
    note = `cached ${models} models`;
  } catch (e: any) {
    status = 'failed';
    note = String(e?.message || e).slice(0, 300);
  }

  await db.execute({
    sql: `INSERT INTO model_checks (checked_at, status, http_status, trigger, models_seen, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [Date.now(), status, httpStatus || null, trigger, models, note || null],
  });
  const level = status === 'ok' ? 'log' : 'warn';
  console[level](`[ModelCatalog] ${trigger} check: ${status}, ${models} models. ${note}`);
  return { status, models, note };
}

// ---- reading the cache ----

/** The cached catalog as flat entries (empty if never fetched). */
export async function loadCatalog(): Promise<CatalogEntry[]> {
  const db = await getDb();
  const rows = await db.execute(
    `SELECT id, family, version_label, display_name, max_input_tokens,
            max_output_tokens, supports_effort, created_at
     FROM model_catalog`,
  );
  return rows.rows.map(r => ({
    id: r.id as string,
    family: r.family as string,
    versionLabel: r.version_label as string,
    displayName: r.display_name as string,
    maxInputTokens: r.max_input_tokens == null ? null : Number(r.max_input_tokens),
    maxOutputTokens: r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    supportsEffort: Number(r.supports_effort) === 1,
    createdAt: (r.created_at as string) ?? null,
  }));
}

/** When the catalog was last successfully refreshed (ms), or null if never. */
export async function lastSuccessfulCheckAt(): Promise<number | null> {
  const db = await getDb();
  const row = await db.execute(
    `SELECT MAX(checked_at) AS m FROM model_checks WHERE status = 'ok'`,
  );
  const v = Number(row.rows[0]?.m);
  return v > 0 ? v : null;
}

// ---- scheduler ----

/**
 * (Re)schedule the next refresh, calibrated from the last recorded check so a
 * restart continues the cadence instead of resetting it. Re-reads the interval
 * from settings each time.
 */
async function scheduleNext(): Promise<void> {
  const st = state();
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }

  const settings = await settingsPersistence.loadSettings();
  if (!settings.modelCatalogPollEnabled) {
    console.log('[ModelCatalog] disabled in settings — not scheduling.');
    return;
  }
  const intervalMs = Math.max(1, settings.modelCatalogPollIntervalDays) * DAY_MS;

  const db = await getDb();
  // Anchor the cadence on the last SUCCESSFUL check, not the last check of any kind
  // (P13). Every attempt — ok OR failed — writes a model_checks row, so keying off
  // MAX(checked_at) let a single transient failure push the next auto-attempt a full
  // interval (≤7d) into the future. It also kept the scheduling clock (all attempts)
  // out of step with the "Index updated" label (successes only). Now: schedule from
  // the last success normally, and from a SHORT backoff when the most recent attempt
  // failed, so a transient failure recovers within the hour.
  const okRow = await db.execute("SELECT MAX(checked_at) AS m FROM model_checks WHERE status = 'ok'");
  const lastOkAt = Number(okRow.rows[0]?.m) || 0;
  const lastRow = await db.execute('SELECT checked_at, status FROM model_checks ORDER BY checked_at DESC LIMIT 1');
  const lastAt = Number(lastRow.rows[0]?.checked_at) || 0;
  const lastFailed = lastAt > 0 && lastRow.rows[0]?.status !== 'ok';

  let nextAt: number;
  if (!lastAt) {
    nextAt = Date.now(); // never checked → check now
  } else if (lastFailed) {
    // Retry soon on the failure backoff, but never later than the normal cadence
    // would already fire (so an already-overdue catalog still checks now).
    nextAt = Math.min(lastAt + FAILURE_BACKOFF_MS, (lastOkAt || Date.now()) + intervalMs);
  } else {
    nextAt = lastOkAt + intervalMs;
  }
  const overdue = nextAt <= Date.now();
  const delay = Math.max(MIN_DELAY_MS, nextAt - Date.now());

  st.timer = setTimeout(async () => {
    await runModelCatalogCheck(overdue && lastAt ? 'scheduled-overdue' : 'scheduled').catch(e =>
      console.error('[ModelCatalog] check error:', e));
    await scheduleNext().catch(e => console.error('[ModelCatalog] reschedule error:', e));
  }, delay);

  console.log(
    `[ModelCatalog] next refresh in ~${Math.round(delay / 1000)}s ` +
    `(interval ${settings.modelCatalogPollIntervalDays}d, last ok ` +
    `${lastOkAt ? new Date(lastOkAt).toISOString() : 'never'}` +
    `${lastFailed ? ', last attempt FAILED → backoff' : ''})`,
  );
}

/**
 * Boot hook — schedule the next refresh calibrated from the last recorded one.
 * Idempotent (clears any existing timer). Call once after the HTTP server is
 * listening so failures don't block startup.
 */
export async function rehydrateModelCatalogPoller(): Promise<void> {
  try {
    await scheduleNext();
  } catch (err) {
    console.error('[ModelCatalog] rehydrate error:', err);
  }
}

/** Run a refresh now (manual trigger), then re-arm the schedule from it. */
export async function triggerModelCatalogCheck(): Promise<CheckResult> {
  const result = await runModelCatalogCheck('manual');
  await scheduleNext().catch(e => console.error('[ModelCatalog] reschedule error:', e));
  return result;
}

/** Re-arm the schedule (e.g. after a settings change). */
export async function rescheduleModelCatalogPoller(): Promise<void> {
  await scheduleNext();
}
