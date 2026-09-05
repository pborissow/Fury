/**
 * Provider switch: toggles Claude Code between Anthropic (direct) and
 * Amazon Bedrock by writing / removing env vars in ~/.claude/settings.json.
 *
 * Ported from the standalone `claude-auth-mode.py` script so Fury can
 * perform the switch programmatically — including automatic failover
 * when the Anthropic usage limit is hit.
 *
 * Cross-platform: works on macOS, Linux, and Windows.
 */

import { readFile, writeFile, copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { eventBus } from './eventBus';
import { settingsPersistence, type AppSettings } from './settingsPersistence';
import {
  appendFallbackLogEntry,
  getPendingSwitchBack,
  type SwitchTrigger,
} from './providerFallbackLog';

/** Metadata passed to switchTo* for audit-log purposes. */
export interface SwitchMeta {
  trigger?: SwitchTrigger;
  rawResetTime?: string;
  scheduledReturnAt?: number;
  reason?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const STASH_PATH = join(CLAUDE_DIR, 'settings.bedrock-stash.json');

// ---------------------------------------------------------------------------
// Bedrock defaults  (from "Amazon Bedrock Best Practices — Developers")
// ---------------------------------------------------------------------------

export interface BedrockConfig {
  awsProfile: string;
  awsRegion: string;
  model: string;
  smallFastModel: string;
  awsAuthRefresh?: string;
}

/**
 * Pull the Bedrock connection config from user-saved settings.
 * Returns null if the configuration is incomplete (missing profile, region,
 * or model) — callers should treat that as "Bedrock not available".
 *
 * Accepts an optional pre-loaded `AppSettings` to avoid redundant file
 * reads when the caller already has the settings in hand.
 */
async function loadBedrockConfigFromSettings(preloaded?: AppSettings): Promise<BedrockConfig | null> {
  const s: AppSettings = preloaded ?? await settingsPersistence.loadSettings();
  if (!s.bedrockAwsProfile?.trim() || !s.bedrockAwsRegion?.trim() || !s.bedrockModel?.trim()) {
    return null;
  }
  return {
    awsProfile: s.bedrockAwsProfile.trim(),
    awsRegion: s.bedrockAwsRegion.trim(),
    model: s.bedrockModel.trim(),
    smallFastModel: (s.bedrockSmallFastModel || s.bedrockModel).trim(),
    awsAuthRefresh: s.bedrockAuthRefreshCmd?.trim() || undefined,
  };
}

// Keys that belong to Bedrock routing (removed when switching to Anthropic)
const BEDROCK_ENV_KEYS = new Set([
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_PROFILE',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
]);

// ---------------------------------------------------------------------------
// Usage-limit detection
// ---------------------------------------------------------------------------

/**
 * Pattern that captures the reset time from a usage-limit message.
 * Matches both wordings the CLI is known to emit:
 *   - "you're out of extra usage. resets 12pm (America/New_York)"
 *   - "You've hit your limit · resets 5:40pm (America/New_York)"
 * Capture group 1 is the raw reset-time string (e.g. "5:40pm (America/New_York)").
 */
const USAGE_LIMIT_PATTERN =
  /(?:out of extra usage|hit your limit).*?resets?\s+(.+?(?:\s*\([\w/]+\))?)\s*$/i;

/**
 * Secondary patterns for limit messages where we may not be able to
 * parse a reset time. Includes both human-readable phrases and the
 * machine token form (e.g. "rate_limit") that the CLI emits as a
 * top-level `error` field on synthetic assistant events.
 */
const RATE_LIMIT_PATTERNS = [
  /you'?re out of extra usage/i,
  /you'?ve hit your limit/i,
  /hit your limit/i,
  // The per-model usage-limit wording the CLI emits as a synthetic 429, e.g.
  // "You've reached your Fable limit. Switch to another model …". Neither the
  // "hit your limit" nor "usage limit" patterns match "reached your … limit".
  // Anchored on a model family or a usage/plan keyword so it does NOT fire on
  // unrelated prose like "reached your storage limit" / "configured turn limit" —
  // this feeds automatic Bedrock failover, so a false positive switches providers.
  /reached your (?:fable|mythos|opus|sonnet|haiku|usage|plan|weekly|daily|monthly|5[\s-]?hour)\b.{0,20}?\blimit\b/i,
  /usage limit reached/i,
  /rate limit exceeded/i,
  /exceeded your current usage/i,
  /\brate[\s_-]?limit\b/i,
  /\busage[\s_-]?limit\b/i,
];

export interface UsageLimitInfo {
  detected: boolean;
  resetTimeRaw?: string;   // e.g. "12pm (America/New_York)"
  resetTimeMs?: number;     // epoch ms when the limit resets (best-effort)
  rawMessage?: string;
}

/**
 * Check whether a chunk of text contains a usage-limit message.
 *
 * **Call-site contract:** `RATE_LIMIT_PATTERNS` includes broad token
 * forms (`rate_limit`, `usage_limit`) that can collide with normal
 * assistant prose if matched against arbitrary model output. Only call
 * this with text that is already known to be an *error signal* — e.g.
 * the contents of a `json.error` field, stderr, or the `text` blocks
 * of a synthetic `<synthetic>`-model assistant message that came
 * alongside an `error` indicator. `sessionManager.ts` enforces this by
 * gating the synthetic-content branch on `hasErrorIndicator`. Anyone
 * adding a new caller must preserve that contract or the failover
 * will start firing on legitimate user/assistant text.
 *
 * Returns structured info including the parsed reset time when the
 * full-form "resets HH:MM(am|pm) (TZ)" suffix is present.
 */
export function detectUsageLimit(text: string): UsageLimitInfo {
  const match = text.match(USAGE_LIMIT_PATTERN);
  if (match) {
    const resetTimeRaw = match[1]?.trim();
    return {
      detected: true,
      resetTimeRaw,
      resetTimeMs: parseResetTime(resetTimeRaw),
      rawMessage: text,
    };
  }

  // Fallback: broader patterns without reset-time extraction
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(text)) {
      return { detected: true, rawMessage: text };
    }
  }

  return { detected: false };
}

/**
 * Best-effort parse of the reset time string from the usage-limit message.
 * Example input: "12pm (America/New_York)"
 * Returns epoch ms, or undefined if parsing fails.
 */
function parseResetTime(raw?: string): number | undefined {
  if (!raw) return undefined;

  // Extract timezone and time parts
  const tzMatch = raw.match(/\(([^)]+)\)/);
  const timeStr = raw.replace(/\([^)]+\)/, '').trim();
  const tz = tzMatch?.[1] || 'America/New_York';

  // Parse "12pm", "3:30am", "12:00pm", etc.
  const timeParts = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!timeParts) return undefined;

  let hours = parseInt(timeParts[1], 10);
  const minutes = parseInt(timeParts[2] || '0', 10);
  const meridiem = timeParts[3].toLowerCase();

  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  // Build the "today" date string in the target timezone, then convert
  // (date + parsed time) into a true UTC epoch.
  //
  // The math expressed below is:
  //   1. Date.UTC(...)  → epoch ms as if the parsed clock-time were UTC.
  //                       This is the *naive* UTC value, regardless of
  //                       what the JS runtime's local timezone happens
  //                       to be. Using `new Date(isoish)` would parse
  //                       as runtime-local time and give the wrong
  //                       answer on any non-UTC machine.
  //   2. subtract `offsetMinutes`  → shift to true UTC. For zones west
  //                                  of UTC (offset negative, e.g.
  //                                  EDT = -240) this *adds* hours,
  //                                  which is correct: 4:50pm EDT is
  //                                  20:50 UTC.
  try {
    const now = new Date();
    // Format today's date in the target timezone (handles the case
    // where the user's runtime is on a different calendar day than
    // the target timezone, e.g. UTC after midnight vs NY before).
    const dateInTz = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [year, month, day] = dateInTz.split('-').map(n => parseInt(n, 10));
    if (!year || !month || !day) return undefined;

    // Find the UTC offset that the target timezone is using *at the
    // current moment* (so we get the right offset across DST changes).
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
    // offsetPart looks like "GMT-5", "GMT+5:30", or just "GMT" for UTC.
    const offsetMatch = offsetPart.match(/GMT([+-])?(\d{1,2})?(?::(\d{2}))?/);
    let offsetMinutes = 0;
    if (offsetMatch && offsetMatch[2]) {
      const sign = offsetMatch[1] === '-' ? -1 : 1;
      offsetMinutes = sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10));
    }

    // Naive UTC: pretend the clock time is already UTC.
    const naiveUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0);
    // True UTC: shift by the target zone's offset.
    const utcMs = naiveUtcMs - offsetMinutes * 60_000;

    // If the computed time is in the past, assume the message refers
    // to tomorrow (handles end-of-day rollover where Anthropic says
    // "resets 12am" right after midnight in the target zone).
    if (utcMs <= Date.now()) {
      return utcMs + 24 * 60 * 60_000;
    }
    return utcMs;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

export type Provider = 'anthropic' | 'bedrock';

export interface ProviderStatus {
  current: Provider;
  hasStash: boolean;
  bedrockEnv: Record<string, string>;
  awsAuthRefresh?: string;
}

async function loadSettings(): Promise<Record<string, any>> {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = await readFile(SETTINGS_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function saveSettings(data: Record<string, any>): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function backupSettings(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d+/, '');
  const bakPath = SETTINGS_PATH + `.bak.${ts}`;
  if (existsSync(SETTINGS_PATH)) {
    await copyFile(SETTINGS_PATH, bakPath);
  }
  return bakPath;
}

function isBedrock(settings: Record<string, any>): boolean {
  const env = settings.env || {};
  const val = String(env.CLAUDE_CODE_USE_BEDROCK || '').trim();
  return ['1', 'true', 'yes'].includes(val.toLowerCase());
}

/**
 * Whether an automatic Bedrock failover is BOTH enabled and fully configured —
 * the exact precondition `handleUsageLimitDetected` gates on. The limit-recovery
 * dialog uses this to decide whether to offer a live "Use Bedrock fallback"
 * button or a "configure it" hint, so the two stay in lock-step.
 */
export async function isFailoverConfigured(): Promise<boolean> {
  const userSettings = await settingsPersistence.loadSettings();
  if (!userSettings.bedrockClaudeFailoverEnabled) return false;
  const cfg = await loadBedrockConfigFromSettings(userSettings);
  return !!cfg;
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  const settings = await loadSettings();
  const env = settings.env || {};
  const bedrockEnv: Record<string, string> = {};
  for (const key of BEDROCK_ENV_KEYS) {
    if (key in env) bedrockEnv[key] = env[key];
  }

  return {
    current: isBedrock(settings) ? 'bedrock' : 'anthropic',
    hasStash: existsSync(STASH_PATH),
    bedrockEnv,
    awsAuthRefresh: settings.awsAuthRefresh,
  };
}

// ---------------------------------------------------------------------------
// Switch operations
// ---------------------------------------------------------------------------

export interface SwitchResult {
  previousProvider: Provider;
  newProvider: Provider;
  backupPath: string;
  message: string;
}

/**
 * Switch to Anthropic (direct API) by removing Bedrock env vars from
 * settings.json and stashing them for later restore.
 *
 * `meta.trigger` defaults to `'manual'` — pass `'scheduled'` from the
 * auto-return timer or `'rehydrated-past-due'` from boot rehydration so
 * the audit log distinguishes those cases.
 */
export async function switchToAnthropic(
  meta: SwitchMeta = {},
): Promise<SwitchResult> {
  const settings = await loadSettings();
  const prev: Provider = isBedrock(settings) ? 'bedrock' : 'anthropic';
  const bakPath = await backupSettings();

  const env: Record<string, string> = { ...(settings.env || {}) };
  const stashEnv: Record<string, string> = {};

  for (const key of Object.keys(env)) {
    if (BEDROCK_ENV_KEYS.has(key)) {
      stashEnv[key] = env[key];
      delete env[key];
    }
  }

  const stashTop: Record<string, any> = {};
  if (settings.awsAuthRefresh) {
    stashTop.awsAuthRefresh = settings.awsAuthRefresh;
    delete settings.awsAuthRefresh;
  }
  if (typeof settings.model === 'string' && settings.model.startsWith('us.anthropic.')) {
    stashTop.model = settings.model;
    delete settings.model;
  }

  // Write stash so we can restore Bedrock later
  if (Object.keys(stashEnv).length > 0 || Object.keys(stashTop).length > 0) {
    const stash = {
      _comment: 'Auto-generated by Fury providerSwitch — Bedrock fragment to merge back',
      _switchedAt: new Date().toISOString(),
      env: stashEnv,
      ...stashTop,
    };
    await mkdir(dirname(STASH_PATH), { recursive: true });
    await writeFile(STASH_PATH, JSON.stringify(stash, null, 2) + '\n', 'utf-8');
  }

  settings.env = env;
  await saveSettings(settings);

  const result: SwitchResult = {
    previousProvider: prev,
    newProvider: 'anthropic',
    backupPath: bakPath,
    message: 'Switched to Anthropic. Bedrock env stashed for later restore.',
  };

  eventBus.emitApp({
    type: 'provider:switched',
    provider: 'anthropic',
    message: result.message,
  } as any);

  await appendFallbackLogEntry({
    type: 'switched-to-anthropic',
    ts: Date.now(),
    trigger: meta.trigger ?? 'manual',
    note: meta.note,
  }).catch(err =>
    console.error('[ProviderSwitch] Failed to append fallback-log entry:', err),
  );

  console.log(`[ProviderSwitch] ${result.message}`);
  return result;
}

/**
 * Switch to Amazon Bedrock by restoring env vars from the stash file,
 * or using the provided (or default) config if no stash exists.
 *
 * `meta.trigger` defaults to `'manual'`. `handleUsageLimitDetected`
 * calls this with `trigger: 'auto-failover'` plus a `scheduledReturnAt`
 * so the audit log carries enough information to rehydrate the
 * switch-back timer after a server restart.
 */
export async function switchToBedrock(
  config: Partial<BedrockConfig> = {},
  meta: SwitchMeta = {},
): Promise<SwitchResult> {
  let cfg: BedrockConfig;
  if (config.awsProfile && config.awsRegion && config.model) {
    // Full config provided by caller — skip redundant settings load.
    cfg = {
      awsProfile: config.awsProfile,
      awsRegion: config.awsRegion,
      model: config.model,
      smallFastModel: config.smallFastModel || config.model,
      awsAuthRefresh: config.awsAuthRefresh,
    };
  } else {
    const fromSettings = await loadBedrockConfigFromSettings();
    if (!fromSettings) {
      throw new Error(
        'Bedrock is not configured. Open Settings → Services → Bedrock and set the AWS profile, region, and model first.',
      );
    }
    cfg = { ...fromSettings, ...config };
  }
  const settings = await loadSettings();
  const prev: Provider = isBedrock(settings) ? 'bedrock' : 'anthropic';
  const bakPath = await backupSettings();

  const env: Record<string, string> = { ...(settings.env || {}) };

  // Try to restore from stash first
  if (existsSync(STASH_PATH)) {
    const stashRaw = await readFile(STASH_PATH, 'utf-8');
    const stash = JSON.parse(stashRaw);

    for (const [key, value] of Object.entries(stash.env || {})) {
      env[key] = value as string;
    }

    if (stash.awsAuthRefresh) settings.awsAuthRefresh = stash.awsAuthRefresh;
    if (stash.model) settings.model = stash.model;
  } else {
    // No stash — use config defaults
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.AWS_REGION = cfg.awsRegion;
    env.AWS_PROFILE = cfg.awsProfile;
    env.ANTHROPIC_MODEL = cfg.model;
    env.ANTHROPIC_SMALL_FAST_MODEL = cfg.smallFastModel;
    if (cfg.awsAuthRefresh) {
      settings.awsAuthRefresh = cfg.awsAuthRefresh;
    }
  }

  settings.env = env;
  await saveSettings(settings);

  const result: SwitchResult = {
    previousProvider: prev,
    newProvider: 'bedrock',
    backupPath: bakPath,
    message: 'Switched to Amazon Bedrock.',
  };

  eventBus.emitApp({
    type: 'provider:switched',
    provider: 'bedrock',
    message: result.message,
  } as any);

  await appendFallbackLogEntry({
    type: 'switched-to-bedrock',
    ts: Date.now(),
    trigger: meta.trigger ?? 'manual',
    rawResetTime: meta.rawResetTime,
    scheduledReturnAt: meta.scheduledReturnAt,
    reason: meta.reason,
    note: meta.note,
  }).catch(err =>
    console.error('[ProviderSwitch] Failed to append fallback-log entry:', err),
  );

  console.log(`[ProviderSwitch] ${result.message}`);
  return result;
}

// ---------------------------------------------------------------------------
// Auto-switch scheduler
// ---------------------------------------------------------------------------

let switchBackTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Absolute epoch-ms at which `switchBackTimer` is scheduled to fire,
 * mirrored here so synchronous callers (e.g. the GET /api/provider
 * route) can report the target without async file I/O. Kept in lock-
 * step with `switchBackTimer` by `armSwitchBackTimer` and
 * `cancelScheduledSwitchBack`.
 */
let switchBackTargetMs: number | null = null;

/**
 * Called when a usage limit is detected. Switches to Bedrock immediately
 * and schedules an automatic switch-back at the reset time.
 */
export async function handleUsageLimitDetected(
  info: UsageLimitInfo,
): Promise<SwitchResult | null> {
  const userSettings = await settingsPersistence.loadSettings();

  if (!userSettings.bedrockClaudeFailoverEnabled) {
    console.log('[ProviderSwitch] Usage limit detected but Claude failover is disabled in settings.');
    return null;
  }

  // Reuse the already-loaded settings to avoid a redundant file read.
  const bedrockCfg = await loadBedrockConfigFromSettings(userSettings);
  if (!bedrockCfg) {
    console.log('[ProviderSwitch] Usage limit detected but Bedrock service is not fully configured.');
    return null;
  }

  const status = await getProviderStatus();

  // Already on Bedrock — nothing to do
  if (status.current === 'bedrock') {
    console.log('[ProviderSwitch] Usage limit detected but already on Bedrock.');
    return null;
  }

  console.log(`[ProviderSwitch] Usage limit detected! Switching to Bedrock...`);
  if (info.resetTimeRaw) {
    console.log(`[ProviderSwitch] Anthropic resets at: ${info.resetTimeRaw}`);
  }

  // Compute the scheduled-return time once so it can be both written
  // into the audit log (for durable rehydration) and used to arm the
  // in-memory timer.
  const SWITCH_BACK_BUFFER_MS = 2 * 60_000;
  const scheduledReturnAt =
    typeof info.resetTimeMs === 'number' && info.resetTimeMs > Date.now()
      ? info.resetTimeMs + SWITCH_BACK_BUFFER_MS
      : undefined;

  // Pass the full bedrockCfg so switchToBedrock skips its own
  // redundant loadBedrockConfigFromSettings() call.
  const result = await switchToBedrock(
    bedrockCfg,
    {
      trigger: 'auto-failover',
      rawResetTime: info.resetTimeRaw,
      scheduledReturnAt,
      reason: 'anthropic-rate-limit',
    },
  );

  // Arm the in-memory switch-back timer. Note this is purely an
  // optimization — the durable record already exists in the fallback
  // log, so a server restart between now and the reset time is
  // recovered by `rehydrateSwitchBackTimer()` on boot.
  if (scheduledReturnAt) {
    armSwitchBackTimer(scheduledReturnAt);
  }

  return result;
}

/**
 * Arm (or re-arm) the in-memory switch-back timer for the given
 * absolute target time. Replaces any existing timer.
 *
 * The timer is best-effort: durability is provided by the fallback log
 * + `rehydrateSwitchBackTimer()`. If `targetMs` is in the past this
 * function switches back immediately.
 */
function armSwitchBackTimer(targetMs: number, trigger: SwitchTrigger = 'scheduled'): void {
  const delayMs = Math.max(0, targetMs - Date.now());
  console.log(
    `[ProviderSwitch] Arming switch-back to Anthropic in ${Math.round(delayMs / 60_000)} minutes (target ${new Date(targetMs).toISOString()})`,
  );

  if (switchBackTimer) clearTimeout(switchBackTimer);
  switchBackTargetMs = targetMs;
  switchBackTimer = setTimeout(async () => {
    console.log('[ProviderSwitch] Reset time reached — switching back to Anthropic.');
    try {
      // Defend against stale timers: if the user (or a different code
      // path) already returned us to Anthropic, just clear state.
      const status = await getProviderStatus();
      if (status.current === 'anthropic') {
        console.log('[ProviderSwitch] Already on Anthropic — skipping auto switch-back.');
      } else {
        await switchToAnthropic({ trigger });
        eventBus.emitApp({
          type: 'provider:switched',
          provider: 'anthropic',
          message: 'Auto-switched back to Anthropic after usage limit reset.',
        } as any);
      }
    } catch (err) {
      console.error('[ProviderSwitch] Failed to auto-switch back:', err);
    }
    switchBackTimer = null;
    switchBackTargetMs = null;
  }, delayMs);
}

/**
 * Read the durable fallback log on boot and either re-arm the
 * switch-back timer or, if the scheduled time has already passed,
 * switch back immediately.
 *
 * Idempotent — calling more than once is safe (re-uses or replaces the
 * existing timer). Should be called once after the HTTP server is
 * listening so any errors don't block startup.
 */
export async function rehydrateSwitchBackTimer(): Promise<void> {
  try {
    const pending = await getPendingSwitchBack();
    if (!pending) {
      console.log('[ProviderSwitch] No pending switch-back found in fallback log.');
      return;
    }

    const status = await getProviderStatus();
    if (status.current === 'anthropic') {
      // The system is already on Anthropic — log was never resolved.
      // Append a resolution entry so the log is consistent and we
      // don't keep matching this stale pending on every boot. Use a
      // distinct trigger so the audit trail is honest about the fact
      // that no actual provider change happened here.
      console.log('[ProviderSwitch] Pending switch-back found but provider is already Anthropic; recording resolution.');
      await appendFallbackLogEntry({
        type: 'switched-to-anthropic',
        ts: Date.now(),
        trigger: 'rehydrated-already-resolved',
        note: 'Provider was already Anthropic on boot; no switch needed.',
      }).catch(() => undefined);
      return;
    }

    // We're on Bedrock and the log says we should be returning at
    // `scheduledReturnAt`. Pre-flight the failover gates so we don't
    // try to flip if the user has since disabled the feature or
    // unconfigured Bedrock.
    const userSettings = await settingsPersistence.loadSettings();
    if (!userSettings.bedrockClaudeFailoverEnabled) {
      console.log('[ProviderSwitch] Pending switch-back exists but failover is now disabled — leaving on Bedrock.');
      return;
    }

    if (pending.scheduledReturnAt <= Date.now()) {
      console.log(
        `[ProviderSwitch] Pending switch-back is past-due (target ${new Date(pending.scheduledReturnAt).toISOString()}) — switching back now.`,
      );
      try {
        await switchToAnthropic({
          trigger: 'rehydrated-past-due',
          note: `Originally triggered ${new Date(pending.triggeredAt).toISOString()}; reset time was ${pending.rawResetTime || 'unknown'}.`,
        });
        eventBus.emitApp({
          type: 'provider:switched',
          provider: 'anthropic',
          message: 'Switched back to Anthropic after usage limit reset (recovered from server restart).',
        } as any);
      } catch (err) {
        console.error('[ProviderSwitch] Failed to switch back during rehydrate:', err);
      }
      return;
    }

    // Scheduled return is still in the future — re-arm the timer.
    armSwitchBackTimer(pending.scheduledReturnAt);
  } catch (err) {
    console.error('[ProviderSwitch] rehydrateSwitchBackTimer error:', err);
  }
}

/**
 * Cancel any pending switch-back timer (e.g. if the user manually switches).
 *
 * Note: this only clears the in-memory timer. The durable record in
 * `provider-fallback-log.jsonl` is implicitly resolved by whichever
 * `switchToAnthropic`/`switchToBedrock` call follows; if no further
 * switch is made, the next `switchTo*` (or `rehydrateSwitchBackTimer`
 * on boot) will close out the audit trail.
 */
export function cancelScheduledSwitchBack(): void {
  if (switchBackTimer) {
    clearTimeout(switchBackTimer);
    switchBackTimer = null;
    switchBackTargetMs = null;
    console.log('[ProviderSwitch] Cancelled scheduled switch-back.');
  }
}

/**
 * Report whether a switch-back is currently scheduled, and when.
 *
 * Prefers the in-memory timer state (cheap, accurate when the timer
 * was armed in this same module instance). Falls back to the durable
 * fallback log when in-memory state is empty — necessary in Next.js
 * dev mode, where different route handlers can be loaded with
 * separate module-graph instances of `lib/providerSwitch.ts`. In that
 * case, an `armSwitchBackTimer` call from the `/api/claude` flow
 * leaves no trace in the `/api/provider` GET handler's module
 * instance, but the durable log is shared (it's a file on disk) and
 * will report the pending state correctly.
 *
 * In production (`next start`) module instances are shared, so the
 * in-memory check always succeeds and the log fallback is unused.
 */
export async function getSwitchBackScheduled(): Promise<{
  scheduled: boolean;
  resetTimeMs?: number;
}> {
  if (switchBackTimer) {
    return {
      scheduled: true,
      resetTimeMs: switchBackTargetMs ?? undefined,
    };
  }
  try {
    const pending = await getPendingSwitchBack();
    if (pending) {
      return {
        scheduled: true,
        resetTimeMs: pending.scheduledReturnAt,
      };
    }
  } catch (err) {
    console.error('[ProviderSwitch] getSwitchBackScheduled log read failed:', err);
  }
  return { scheduled: false };
}
