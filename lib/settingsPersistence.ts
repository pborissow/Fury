import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { scryptSync, timingSafeEqual } from 'crypto';
import path from 'path';
import { atomicWriteFile } from './atomicWrite';
import { recoverCorruptJsonFile, salvageLeadingObject } from './corruptState';
import { furySettingsFile } from './furyHome';

/** Parse settings content, or null if it is not a usable JSON object. */
function parseSettingsObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    // A bare string/array/number parses but must not be spread over DEFAULTS.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Re-run the parse purely to capture the error for the log message. */
function lastParseError(content: string): unknown {
  try {
    JSON.parse(content);
    return new Error('not a JSON object');
  } catch (err) {
    return err;
  }
}

export interface AppSettings {
  promptSuggestionsEnabled: boolean;
  ttsEnabled: boolean;
  localhostOnly: boolean;
  authUsername: string | null;
  authPasswordHash: string | null;
  anthropicApiKey: string | null;
  summarizerProvider: 'none' | 'haiku' | 'ollama';
  ollamaHost: string;
  ollamaPort: string;
  ttsProvider: 'local' | 'remote';
  ttsRemoteHost: string;
  ttsRemotePort: string;
  bedrockAwsProfile: string;
  bedrockAwsRegion: string;
  bedrockModel: string;
  bedrockSmallFastModel: string;
  bedrockAuthRefreshCmd: string;
  bedrockClaudeFailoverEnabled: boolean;
  /** Poll Anthropic's published pricing on a schedule (Stats tab cost accuracy). */
  pricingPollEnabled: boolean;
  /** Days between pricing checks. Calibrated from the last recorded check on boot. */
  pricingPollIntervalDays: number;
  /** Refresh the selectable model/version catalog (GET /v1/models via the CLI's
   *  OAuth token) on a schedule. Feeds the model picker's version dropdowns. */
  modelCatalogPollEnabled: boolean;
  /** Days between model-catalog refreshes. Calibrated from the last recorded
   *  check on boot, same durable-timer pattern as the pricing poller. */
  modelCatalogPollIntervalDays: number;
  /** Route chat turns through the persistent @anthropic-ai/claude-agent-sdk
   *  session manager (lib/sdkSessionManager.ts) instead of the one-shot
   *  `claude --print` manager. Keeps the CLI process alive across turns, so
   *  background tasks and scheduled wakeups survive instead of being orphaned.
   *  Default ON in the sdk-session-prototype branch. */
  sdkSessionsEnabled: boolean;
  /** How pasted/Read-tool images are handled once they age past the recent
   *  window (see keepRecentTurns). 'ephemeral' scrubs them to a placeholder and
   *  discards the bytes (no new disk footprint, images vanish from history).
   *  'persist' externalizes the bytes to the per-session on-disk store
   *  (~/.fury/images/<sessionId>/<hash>.<ext>) and leaves a
   *  fury-img://<hash> ref in the transcript so the thumbnail survives reload. */
  imagePersistence: 'ephemeral' | 'persist';
  /** Number of recent turns whose transcript images stay INLINE (true vision on
   *  resume + direct render) before scrubbing/externalizing kicks in. 1 = the
   *  current turn keeps its inline image, everything older is scrubbed. */
  keepRecentTurns: number;
}

/** Exported so fallback consumers (lib/tts.ts) can't drift from the real
 *  defaults by hand-copying them — which had already happened once
 *  (imagePersistence: 'ephemeral' vs this 'persist'). */
export const DEFAULT_SETTINGS: AppSettings = {
  promptSuggestionsEnabled: true,
  ttsEnabled: false,
  localhostOnly: true,
  authUsername: null,
  authPasswordHash: null,
  anthropicApiKey: null,
  summarizerProvider: 'none',
  ollamaHost: '',
  ollamaPort: '11434',
  ttsProvider: 'local',
  ttsRemoteHost: '',
  ttsRemotePort: '5656',
  bedrockAwsProfile: '',
  bedrockAwsRegion: 'us-east-1',
  bedrockModel: 'us.anthropic.claude-sonnet-4-6',
  bedrockSmallFastModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  bedrockAuthRefreshCmd: '',
  bedrockClaudeFailoverEnabled: false,
  pricingPollEnabled: true,
  pricingPollIntervalDays: 7,
  modelCatalogPollEnabled: true,
  modelCatalogPollIntervalDays: 7,
  sdkSessionsEnabled: true,
  // Persist by default: every image in a session stays renderable via
  // /api/images/<sessionId>/<hash>. `scrubImages` externalizes an image's bytes
  // to the store in the SAME pass that replaces it with a fury-img://<hash> ref,
  // so any ref we render (live JSONL or DB fallback) is guaranteed to resolve.
  imagePersistence: 'persist',
  keepRecentTurns: 1,
};

// Internal alias — the class body reads naturally as "merged over DEFAULTS".
const DEFAULTS = DEFAULT_SETTINGS;

class SettingsPersistence {
  /** Test hook: when set, wins over the resolver. Production leaves it unset. */
  private stateFile: string | null = null;

  /**
   * Resolved lazily (per call, not in the constructor): the module loads
   * before the startup migration runs, and lib/furyHome's read-fallback could
   * capture the legacy $cwd/.claude-ui-state path the migration is about to
   * move. Was $cwd-relative — launching Fury from a different directory
   * silently "reset" settings; ~/.fury/state fixes that.
   */
  private file(): string {
    return this.stateFile ?? furySettingsFile();
  }

  private async ensureStorageDir(): Promise<void> {
    const dir = path.dirname(this.file());
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Load settings, merged over DEFAULTS.
   *
   * A missing file is normal (first run) and returns DEFAULTS silently. A file
   * that exists but will not parse is NOT normal and is no longer swallowed: the
   * old `catch { return DEFAULTS }` meant a torn settings.json collapsed to
   * defaults with no warning, and the next saveSettings — which merges onto
   * whatever this returns — wrote those defaults back, permanently dropping the
   * stored auth hash and API key. Recovery now runs first (see ./corruptState),
   * and if it fails the original is preserved at settings.json.corrupt and the
   * loss is logged loudly.
   */
  async loadSettings(): Promise<AppSettings> {
    const stateFile = this.file();
    let content: string;
    try {
      content = await fs.readFile(stateFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[SettingsPersistence] Could not read settings:', error);
      }
      return { ...DEFAULTS };
    }

    const parsed = parseSettingsObject(content);
    if (parsed) return { ...DEFAULTS, ...parsed };

    const recovered = await recoverCorruptJsonFile(
      stateFile, content, 'SettingsPersistence', lastParseError(content),
    );
    return { ...DEFAULTS, ...(recovered ?? {}) };
  }

  /**
   * Synchronous read for use in middleware (Edge-compatible when file exists).
   *
   * Salvages in memory but deliberately does NOT quarantine or repair: this runs
   * on the request path for every request, and a read should not turn into a
   * write there. The async loadSettings does the durable repair on the next call
   * from anywhere else (any API route, the pollers, saveSettings).
   *
   * Failing to salvage here is fail-CLOSED, not fail-open: DEFAULTS carry
   * `localhostOnly: true` and no credentials, so middleware answers 403 to
   * external requests rather than letting them through unauthenticated.
   */
  loadSettingsSync(): AppSettings {
    let content: string;
    try {
      content = readFileSync(this.file(), 'utf-8');
    } catch {
      return { ...DEFAULTS };
    }

    const parsed = parseSettingsObject(content);
    if (parsed) return { ...DEFAULTS, ...parsed };

    const salvaged = salvageLeadingObject(content);
    if (salvaged) return { ...DEFAULTS, ...salvaged };

    console.error(
      '[SettingsPersistence] settings.json is unreadable; serving defaults ' +
      '(external access denied until it is repaired).',
    );
    return { ...DEFAULTS };
  }

  async saveSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    await this.ensureStorageDir();
    const current = await this.loadSettings();
    const merged = { ...current, ...updates };
    // Atomic (see ./atomicWrite). This file sits next to state.json, which a
    // non-atomic write spliced into invalid JSON when two servers shared a cwd.
    // The stakes are higher here — this merge writes back whatever loadSettings
    // returned, so a torn file that silently read as DEFAULTS would destroy the
    // stored auth hash and API key right here. That is now the read side's job
    // to prevent (./corruptState); this end just guarantees no NEW tear.
    await atomicWriteFile(this.file(), JSON.stringify(merged, null, 2));
    return merged;
  }
}

export const settingsPersistence = new SettingsPersistence();

/**
 * Verify a plaintext password against a stored salt:hash string.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}
