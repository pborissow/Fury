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

const DEFAULT_BEDROCK_CONFIG: BedrockConfig = {
  awsProfile: 'bg-dev-bedrock',
  awsRegion: 'us-east-1',
  model: 'us.anthropic.claude-sonnet-4-6',
  smallFastModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  awsAuthRefresh: 'aws sso login --profile bg-dev-bedrock',
};

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
 * Pattern that matches the "out of extra usage" message from Anthropic.
 * Captures the reset time string (e.g. "12pm (America/New_York)").
 */
const USAGE_LIMIT_PATTERN =
  /out of extra usage.*?resets?\s+(.+?(?:\([\w/]+\))?)\s*$/i;

/** Secondary patterns for other common limit messages */
const RATE_LIMIT_PATTERNS = [
  /you'?re out of extra usage/i,
  /usage limit reached/i,
  /rate limit exceeded/i,
  /exceeded your current usage/i,
];

export interface UsageLimitInfo {
  detected: boolean;
  resetTimeRaw?: string;   // e.g. "12pm (America/New_York)"
  resetTimeMs?: number;     // epoch ms when the limit resets (best-effort)
  rawMessage?: string;
}

/**
 * Check whether a chunk of text (stdout or stderr) contains a usage-limit
 * message. Returns structured info including the parsed reset time.
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

  // Build a date string for today in the given timezone
  try {
    const now = new Date();
    // Format today's date in the target timezone
    const dateInTz = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

    // Build ISO string: "2026-03-26T12:00:00"
    const pad = (n: number) => n.toString().padStart(2, '0');
    const isoish = `${dateInTz}T${pad(hours)}:${pad(minutes)}:00`;

    // Use a formatter to find the UTC offset for that timezone at that time
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
    // offsetPart looks like "GMT-5" or "GMT+5:30"
    const offsetMatch = offsetPart.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === '-' ? -1 : 1;
      offsetMinutes = sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10));
    }

    // Parse as local time, then adjust by the offset
    const localDate = new Date(isoish);
    const utcMs = localDate.getTime() - offsetMinutes * 60_000;

    // If the computed time is in the past, assume it's tomorrow
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
 */
export async function switchToAnthropic(): Promise<SwitchResult> {
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

  console.log(`[ProviderSwitch] ${result.message}`);
  return result;
}

/**
 * Switch to Amazon Bedrock by restoring env vars from the stash file,
 * or using the provided (or default) config if no stash exists.
 */
export async function switchToBedrock(
  config: Partial<BedrockConfig> = {},
): Promise<SwitchResult> {
  const cfg = { ...DEFAULT_BEDROCK_CONFIG, ...config };
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

  console.log(`[ProviderSwitch] ${result.message}`);
  return result;
}

// ---------------------------------------------------------------------------
// Auto-switch scheduler
// ---------------------------------------------------------------------------

let switchBackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Called when a usage limit is detected. Switches to Bedrock immediately
 * and schedules an automatic switch-back at the reset time.
 */
export async function handleUsageLimitDetected(
  info: UsageLimitInfo,
): Promise<SwitchResult | null> {
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

  const result = await switchToBedrock();

  // Schedule switch-back if we know the reset time
  if (info.resetTimeMs) {
    const delayMs = info.resetTimeMs - Date.now();
    if (delayMs > 0) {
      // Add 2-minute buffer after the stated reset time
      const bufferedDelay = delayMs + 2 * 60_000;
      console.log(
        `[ProviderSwitch] Scheduling switch-back to Anthropic in ${Math.round(bufferedDelay / 60_000)} minutes`,
      );

      if (switchBackTimer) clearTimeout(switchBackTimer);
      switchBackTimer = setTimeout(async () => {
        console.log('[ProviderSwitch] Reset time reached — switching back to Anthropic.');
        try {
          await switchToAnthropic();
          eventBus.emitApp({
            type: 'provider:switched',
            provider: 'anthropic',
            message: 'Auto-switched back to Anthropic after usage limit reset.',
          } as any);
        } catch (err) {
          console.error('[ProviderSwitch] Failed to auto-switch back:', err);
        }
        switchBackTimer = null;
      }, bufferedDelay);
    }
  }

  return result;
}

/**
 * Cancel any pending switch-back timer (e.g. if the user manually switches).
 */
export function cancelScheduledSwitchBack(): void {
  if (switchBackTimer) {
    clearTimeout(switchBackTimer);
    switchBackTimer = null;
    console.log('[ProviderSwitch] Cancelled scheduled switch-back.');
  }
}

export function getSwitchBackScheduled(): { scheduled: boolean; resetTimeMs?: number } {
  return {
    scheduled: switchBackTimer !== null,
  };
}
