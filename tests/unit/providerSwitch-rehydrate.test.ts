import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@/lib/settingsPersistence';

// --- Mocks (must be declared before importing the module under test) ---

vi.mock('@/lib/settingsPersistence', () => ({
  settingsPersistence: { loadSettings: vi.fn() },
}));

vi.mock('@/lib/eventBus', () => ({
  eventBus: { emitApp: vi.fn() },
}));

// In-memory virtual filesystem for fs/promises so the rehydrate path
// can read its log + write resolution entries without touching disk.
const virtualFs: Record<string, string> = {};

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p !== 'string' || !(p in virtualFs)) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return virtualFs[p];
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    virtualFs[p] = data;
  }),
  appendFile: vi.fn(async (p: string, data: string) => {
    virtualFs[p] = (virtualFs[p] || '') + data;
  }),
  copyFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => typeof p === 'string' && p in virtualFs),
}));

import {
  rehydrateSwitchBackTimer,
  cancelScheduledSwitchBack,
  switchToAnthropic,
  switchToBedrock,
} from '@/lib/providerSwitch';
import { settingsPersistence } from '@/lib/settingsPersistence';
import { writeFile, appendFile, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const mockLoadSettings = settingsPersistence.loadSettings as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockAppendFile = appendFile as ReturnType<typeof vi.fn>;

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const LOG_PATH = join(homedir(), '.claude', 'provider-fallback-log.jsonl');

const BASE_SETTINGS: AppSettings = {
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
  bedrockAwsProfile: 'test-profile',
  bedrockAwsRegion: 'us-east-1',
  bedrockModel: 'us.anthropic.claude-sonnet-4-6',
  bedrockSmallFastModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  bedrockAuthRefreshCmd: 'aws sso login --profile test-profile',
  bedrockClaudeFailoverEnabled: true,
};

function clearVirtualFs() {
  for (const k of Object.keys(virtualFs)) delete virtualFs[k];
}

function setSettingsBedrock() {
  virtualFs[SETTINGS_PATH] = JSON.stringify({
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'test-profile',
      ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
    },
  });
}

function setSettingsAnthropic() {
  virtualFs[SETTINGS_PATH] = JSON.stringify({ env: {} });
}

function appendLogEntry(entry: Record<string, unknown>) {
  virtualFs[LOG_PATH] = (virtualFs[LOG_PATH] || '') + JSON.stringify(entry) + '\n';
}

beforeEach(() => {
  vi.clearAllMocks();
  clearVirtualFs();
  cancelScheduledSwitchBack();
  mockLoadSettings.mockResolvedValue(BASE_SETTINGS);
});

describe('rehydrateSwitchBackTimer', () => {
  it('is a no-op when there is no fallback log', async () => {
    setSettingsBedrock();

    await rehydrateSwitchBackTimer();

    // No settings.json write means no provider switch happened.
    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites).toHaveLength(0);
  });

  it('is a no-op when the latest log event already resolved the failover', async () => {
    setSettingsBedrock();
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 60 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: Date.now() - 30 * 60_000,
    });
    appendLogEntry({
      type: 'switched-to-anthropic',
      ts: Date.now() - 25 * 60_000,
      trigger: 'scheduled',
    });

    await rehydrateSwitchBackTimer();

    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites).toHaveLength(0);
  });

  it('switches back to Anthropic immediately when a past-due failover is found', async () => {
    setSettingsBedrock();
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 6 * 60 * 60_000, // 6h ago
      trigger: 'auto-failover',
      rawResetTime: '5:40pm (America/New_York)',
      scheduledReturnAt: Date.now() - 60 * 60_000, // 1h ago
      reason: 'anthropic-rate-limit',
    });

    await rehydrateSwitchBackTimer();

    const settingsWrite = mockWriteFile.mock.calls.find(([p]) => p === SETTINGS_PATH);
    expect(settingsWrite, 'expected a settings.json write to switch to Anthropic').toBeDefined();
    const written = JSON.parse(String(settingsWrite![1]));
    expect(written.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();

    // And the audit log gets a resolution entry tagged rehydrated-past-due.
    const logAppends = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH);
    const lastEntry = JSON.parse(String(logAppends.at(-1)![1]).trim());
    expect(lastEntry.type).toBe('switched-to-anthropic');
    expect(lastEntry.trigger).toBe('rehydrated-past-due');
  });

  it('does not switch when Bedrock failover has been disabled in settings since the failover fired', async () => {
    setSettingsBedrock();
    mockLoadSettings.mockResolvedValue({
      ...BASE_SETTINGS,
      bedrockClaudeFailoverEnabled: false,
    });
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 60 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: Date.now() - 5 * 60_000,
    });

    await rehydrateSwitchBackTimer();

    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites).toHaveLength(0);
  });

  it('records a bookkeeping entry tagged rehydrated-already-resolved when provider is already Anthropic', async () => {
    setSettingsAnthropic();
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 60 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: Date.now() - 5 * 60_000,
    });

    await rehydrateSwitchBackTimer();

    // No new settings.json write — we were already on Anthropic.
    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites).toHaveLength(0);
    // But a resolution entry was appended so we don't keep firing on every boot.
    // The trigger must distinguish this case from a real switch
    // (rehydrated-past-due) for the audit trail to be honest.
    const logAppends = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH);
    expect(logAppends.length).toBeGreaterThan(0);
    const lastEntry = JSON.parse(String(logAppends.at(-1)![1]).trim());
    expect(lastEntry.type).toBe('switched-to-anthropic');
    expect(lastEntry.trigger).toBe('rehydrated-already-resolved');
  });

  it('arms an in-memory timer (no immediate switch) when the scheduled return is still in the future', async () => {
    setSettingsBedrock();
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 5 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: Date.now() + 60 * 60_000, // 1h in the future
    });

    await rehydrateSwitchBackTimer();

    // No immediate switch — settings.json should not have been touched.
    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites).toHaveLength(0);
    // Clean up the timer we just armed so it doesn't leak between tests.
    cancelScheduledSwitchBack();
  });
});

describe('manual switches log with trigger=manual', () => {
  it('switchToBedrock without meta logs trigger=manual and no scheduledReturnAt', async () => {
    setSettingsAnthropic();

    await switchToBedrock();

    const logAppends = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH);
    expect(logAppends).toHaveLength(1);
    const entry = JSON.parse(String(logAppends[0][1]).trim());
    expect(entry.type).toBe('switched-to-bedrock');
    expect(entry.trigger).toBe('manual');
    expect(entry.scheduledReturnAt).toBeUndefined();
  });

  it('switchToAnthropic without meta logs trigger=manual', async () => {
    setSettingsBedrock();

    await switchToAnthropic();

    const logAppends = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH);
    expect(logAppends).toHaveLength(1);
    const entry = JSON.parse(String(logAppends[0][1]).trim());
    expect(entry.type).toBe('switched-to-anthropic');
    expect(entry.trigger).toBe('manual');
  });
});

describe('getPendingSwitchBack via real log file', () => {
  // Re-import without mocks to test the real file-walking logic.
  it('correctly identifies the latest unresolved failover among interleaved events', async () => {
    // Simulate three failover/resolve cycles, with the most recent
    // failover left unresolved.
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: 1000,
      trigger: 'auto-failover',
      scheduledReturnAt: 2000,
    });
    appendLogEntry({ type: 'switched-to-anthropic', ts: 2100, trigger: 'scheduled' });
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: 3000,
      trigger: 'auto-failover',
      scheduledReturnAt: 4000,
    });
    appendLogEntry({ type: 'switched-to-anthropic', ts: 4100, trigger: 'scheduled' });
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: 5000,
      trigger: 'auto-failover',
      rawResetTime: '5:40pm',
      scheduledReturnAt: 6000,
    });

    const { getPendingSwitchBack } = await import('@/lib/providerFallbackLog');
    // Force re-read by reading directly from virtualFs path.
    const pending = await getPendingSwitchBack();
    expect(pending).not.toBeNull();
    expect(pending?.scheduledReturnAt).toBe(6000);
    expect(pending?.rawResetTime).toBe('5:40pm');
    expect(pending?.triggeredAt).toBe(5000);
  });

  it('returns null when the latest event is a resolution', async () => {
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: 1000,
      trigger: 'auto-failover',
      scheduledReturnAt: 2000,
    });
    appendLogEntry({ type: 'switched-to-anthropic', ts: 2100, trigger: 'scheduled' });

    const { getPendingSwitchBack } = await import('@/lib/providerFallbackLog');
    expect(await getPendingSwitchBack()).toBeNull();
  });

  it('returns null when the latest Bedrock event is a manual switch (no scheduledReturnAt)', async () => {
    appendLogEntry({ type: 'switched-to-bedrock', ts: 1000, trigger: 'manual' });

    const { getPendingSwitchBack } = await import('@/lib/providerFallbackLog');
    expect(await getPendingSwitchBack()).toBeNull();
  });

  it('tolerates corrupt lines in the log', async () => {
    virtualFs[LOG_PATH] =
      JSON.stringify({ type: 'switched-to-bedrock', ts: 1000, trigger: 'auto-failover', scheduledReturnAt: 2000 }) + '\n' +
      'this is not valid json\n' +
      JSON.stringify({ type: 'switched-to-anthropic', ts: 3000, trigger: 'scheduled' }) + '\n';

    const { getPendingSwitchBack } = await import('@/lib/providerFallbackLog');
    expect(await getPendingSwitchBack()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: redundant POST /api/provider must not mask a pending failover
// ---------------------------------------------------------------------------
//
// Original bug: clicking the *current* provider in the UI would call
// `cancelScheduledSwitchBack()` and `switchTo*` unconditionally. The
// new manual `switched-to-bedrock` log entry (with no
// `scheduledReturnAt`) became the newest match for
// `getPendingSwitchBack()`, masking the prior auto-failover entry and
// permanently losing the auto-return — even across server restarts.

describe('POST /api/provider — redundant-click regression', () => {
  it('does NOT cancel or mask a pending auto-return when the user clicks the current provider', async () => {
    // System state: on Bedrock, with an auto-failover entry scheduled
    // to return to Anthropic in one hour.
    setSettingsBedrock();
    const triggerTs = Date.now() - 10 * 60_000;
    const scheduledReturnAt = Date.now() + 60 * 60_000;
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: triggerTs,
      trigger: 'auto-failover',
      rawResetTime: '5:40pm (America/New_York)',
      scheduledReturnAt,
      reason: 'anthropic-rate-limit',
    });

    // Snapshot how many appends/writes happened during setup so we can
    // assert that the redundant click added zero of either.
    const appendsBefore = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH).length;
    const writesBefore = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH).length;

    // User redundantly clicks "Bedrock" in the UI.
    const { POST } = await import('@/app/api/provider/route');
    const req = new Request('http://localhost/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'bedrock' }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.newProvider).toBe('bedrock');
    expect(data.message).toMatch(/already on bedrock/i);

    // Critical assertions:
    //  1. No new log entries were appended.
    const appendsAfter = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH).length;
    expect(appendsAfter).toBe(appendsBefore);
    //  2. settings.json was not rewritten (no redundant fs churn).
    const writesAfter = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH).length;
    expect(writesAfter).toBe(writesBefore);
    //  3. The pending auto-return is still discoverable — durable
    //     record is intact, so a server restart would still recover.
    const { getPendingSwitchBack } = await import('@/lib/providerFallbackLog');
    const pending = await getPendingSwitchBack();
    expect(pending).not.toBeNull();
    expect(pending?.scheduledReturnAt).toBe(scheduledReturnAt);
    expect(pending?.triggeredAt).toBe(triggerTs);
  });

  it('still performs a real switch when the user picks the *other* provider', async () => {
    setSettingsBedrock();
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 10 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: Date.now() + 60 * 60_000,
    });

    const { POST } = await import('@/app/api/provider/route');
    const req = new Request('http://localhost/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.newProvider).toBe('anthropic');

    // settings.json must be rewritten and the audit log gains a
    // switched-to-anthropic entry tagged trigger:'manual'.
    const settingsWrites = mockWriteFile.mock.calls.filter(([p]) => p === SETTINGS_PATH);
    expect(settingsWrites.length).toBeGreaterThan(0);
    const logAppends = mockAppendFile.mock.calls.filter(([p]) => p === LOG_PATH);
    const lastEntry = JSON.parse(String(logAppends.at(-1)![1]).trim());
    expect(lastEntry.type).toBe('switched-to-anthropic');
    expect(lastEntry.trigger).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// getSwitchBackScheduled exposes the actual target time
// ---------------------------------------------------------------------------

describe('getSwitchBackScheduled', () => {
  it('returns scheduled=false when no timer is armed', async () => {
    const { getSwitchBackScheduled } = await import('@/lib/providerSwitch');
    expect(getSwitchBackScheduled()).toEqual({
      scheduled: false,
      resetTimeMs: undefined,
    });
  });

  it('returns scheduled=true with the actual target time after rehydrate arms a future timer', async () => {
    setSettingsBedrock();
    const targetMs = Date.now() + 60 * 60_000;
    appendLogEntry({
      type: 'switched-to-bedrock',
      ts: Date.now() - 5 * 60_000,
      trigger: 'auto-failover',
      scheduledReturnAt: targetMs,
    });

    await rehydrateSwitchBackTimer();

    const { getSwitchBackScheduled } = await import('@/lib/providerSwitch');
    const result = getSwitchBackScheduled();
    expect(result.scheduled).toBe(true);
    expect(result.resetTimeMs).toBe(targetMs);

    cancelScheduledSwitchBack();
    expect(getSwitchBackScheduled()).toEqual({
      scheduled: false,
      resetTimeMs: undefined,
    });
  });
});

// Suppress unused-import lint
void readFile;
