import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@/lib/settingsPersistence';

// Mocks must be declared before importing the module under test.
vi.mock('@/lib/settingsPersistence', () => ({
  settingsPersistence: { loadSettings: vi.fn() },
}));

vi.mock('@/lib/eventBus', () => ({
  eventBus: { emitApp: vi.fn() },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import {
  handleUsageLimitDetected,
  switchToBedrock,
  cancelScheduledSwitchBack,
} from '@/lib/providerSwitch';
import { settingsPersistence } from '@/lib/settingsPersistence';
import { writeFile, appendFile } from 'fs/promises';

const mockLoadSettings = settingsPersistence.loadSettings as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockAppendFile = appendFile as ReturnType<typeof vi.fn>;

const BASE_SETTINGS: AppSettings = {
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
  pricingPollEnabled: true,
  pricingPollIntervalDays: 7,
  modelCatalogPollEnabled: true,
  modelCatalogPollIntervalDays: 7,
  sdkSessionsEnabled: true,
  imagePersistence: 'ephemeral',
  keepRecentTurns: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Make sure no scheduled switch-back leaks between tests.
  cancelScheduledSwitchBack();
});

describe('handleUsageLimitDetected gating', () => {
  it('does nothing when Claude failover is disabled', async () => {
    mockLoadSettings.mockResolvedValue({
      ...BASE_SETTINGS,
      bedrockClaudeFailoverEnabled: false,
    });

    const result = await handleUsageLimitDetected({ detected: true });

    expect(result).toBeNull();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does nothing when Bedrock profile is not configured', async () => {
    mockLoadSettings.mockResolvedValue({ ...BASE_SETTINGS, bedrockAwsProfile: '' });
    expect(await handleUsageLimitDetected({ detected: true })).toBeNull();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does nothing when Bedrock region is not configured', async () => {
    mockLoadSettings.mockResolvedValue({ ...BASE_SETTINGS, bedrockAwsRegion: '' });
    expect(await handleUsageLimitDetected({ detected: true })).toBeNull();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does nothing when Bedrock model is not configured', async () => {
    mockLoadSettings.mockResolvedValue({ ...BASE_SETTINGS, bedrockModel: '' });
    expect(await handleUsageLimitDetected({ detected: true })).toBeNull();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('switches to Bedrock when failover is enabled and Bedrock is configured', async () => {
    mockLoadSettings.mockResolvedValue(BASE_SETTINGS);

    const result = await handleUsageLimitDetected({ detected: true });

    expect(result).not.toBeNull();
    expect(result?.newProvider).toBe('bedrock');
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('writes the user-configured Bedrock env vars (no hardcoded account)', async () => {
    mockLoadSettings.mockResolvedValue(BASE_SETTINGS);

    await handleUsageLimitDetected({ detected: true });

    const settingsWrite = mockWriteFile.mock.calls.find(([p]) =>
      typeof p === 'string' && p.endsWith('settings.json'),
    );
    expect(settingsWrite, 'expected a write to settings.json').toBeDefined();
    const written = String(settingsWrite![1]);
    expect(written).toContain('"AWS_PROFILE": "test-profile"');
    expect(written).toContain('"AWS_REGION": "us-east-1"');
    expect(written).toContain('"ANTHROPIC_MODEL": "us.anthropic.claude-sonnet-4-6"');
    expect(written).toContain('"CLAUDE_CODE_USE_BEDROCK": "1"');
  });

  it('appends a fallback-log entry with auto-failover trigger and scheduled return time', async () => {
    mockLoadSettings.mockResolvedValue(BASE_SETTINGS);

    const now = Date.now();
    const resetTimeMs = now + 60 * 60_000; // one hour from now
    await handleUsageLimitDetected({
      detected: true,
      resetTimeRaw: '5:40pm (America/New_York)',
      resetTimeMs,
    });

    const logAppend = mockAppendFile.mock.calls.find(([p]) =>
      typeof p === 'string' && p.endsWith('provider-fallback-log.jsonl'),
    );
    expect(logAppend, 'expected an append to provider-fallback-log.jsonl').toBeDefined();
    const line = String(logAppend![1]).trim();
    const entry = JSON.parse(line);
    expect(entry.type).toBe('switched-to-bedrock');
    expect(entry.trigger).toBe('auto-failover');
    expect(entry.reason).toBe('anthropic-rate-limit');
    expect(entry.rawResetTime).toBe('5:40pm (America/New_York)');
    // Scheduled return is reset time + 2 minute buffer.
    expect(entry.scheduledReturnAt).toBe(resetTimeMs + 2 * 60_000);
  });
});

describe('switchToBedrock', () => {
  it('throws a helpful error when Bedrock is not configured', async () => {
    mockLoadSettings.mockResolvedValue({
      ...BASE_SETTINGS,
      bedrockAwsProfile: '',
      bedrockClaudeFailoverEnabled: false,
    });

    await expect(switchToBedrock()).rejects.toThrow(/not configured/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
