/**
 * Corrupt-settings recovery.
 *
 * settings.json got the atomic-write fix but kept a bare `catch { return DEFAULTS }`
 * on the read side. Atomic writes stop Fury CREATING new tears; they do nothing for
 * a file already torn — by the pre-fix race, an external edit, or a killed process.
 * For such a user the sequence was:
 *
 *   loadSettings()  -> parse throws -> DEFAULTS (silently, no warning)
 *   saveSettings({}) -> merges onto DEFAULTS -> atomically writes DEFAULTS
 *
 * i.e. the stored auth hash and API key were destroyed on the first save after
 * upgrading, with no warning and no recoverable copy. state.json had recovery;
 * the higher-stakes file did not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { salvageLeadingObject } from '../../lib/corruptState';

const REAL_SETTINGS = {
  authUsername: 'petya',
  authPasswordHash: 'deadbeefsalt:cafebabehash',
  anthropicApiKey: 'sk-ant-secret-key',
  localhostOnly: false,
  ttsEnabled: true,
};

/** The corruption shape seen in the wild: complete doc + tail of a longer one. */
function spliced(obj: unknown, tail = '\n  "lastUpdated": 1785780651923\n}'): string {
  return JSON.stringify(obj, null, 2) + tail;
}

const tmpDirs: string[] = [];
async function persister() {
  const dir = await mkdtemp(join(tmpdir(), 'fury-settings-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, '.claude-ui-state'), { recursive: true });
  const file = join(dir, '.claude-ui-state', 'settings.json');
  const { settingsPersistence } = await import('../../lib/settingsPersistence');
  (settingsPersistence as unknown as { stateFile: string }).stateFile = file;
  return { s: settingsPersistence, file };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('salvageLeadingObject', () => {
  it('recovers the leading document from a spliced file', () => {
    expect(salvageLeadingObject(spliced(REAL_SETTINGS))).toEqual(REAL_SETTINGS);
  });

  it('is not fooled by braces inside string values', () => {
    // bedrockAuthRefreshCmd routinely contains shell braces.
    const withBraces = { bedrockAuthRefreshCmd: 'aws sso login && echo {"ok":true}', authUsername: 'p' };
    expect(salvageLeadingObject(spliced(withBraces))).toEqual(withBraces);
  });

  it('handles escaped quotes and backslashes in values', () => {
    const tricky = { cmd: 'say \\"hi\\" }{', path: 'C:\\\\Users\\\\petya' };
    expect(salvageLeadingObject(spliced(tricky))).toEqual(tricky);
  });

  it('refuses a truncated document rather than guessing', () => {
    const truncated = JSON.stringify(REAL_SETTINGS, null, 2).slice(0, 60);
    expect(salvageLeadingObject(truncated)).toBeNull();
  });

  it('refuses when the head is garbage', () => {
    expect(salvageLeadingObject('garbage' + JSON.stringify(REAL_SETTINGS))).toBeNull();
  });

  it('refuses non-objects', () => {
    expect(salvageLeadingObject('[1,2,3]')).toBeNull();
    expect(salvageLeadingObject('"a string"')).toBeNull();
    expect(salvageLeadingObject('')).toBeNull();
  });
});

describe('loadSettings on a corrupt file', () => {
  it('recovers the auth hash and API key instead of collapsing to defaults', async () => {
    const { s, file } = await persister();
    await writeFile(file, spliced(REAL_SETTINGS), 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await s.loadSettings();
    expect(loaded.authUsername).toBe('petya');
    expect(loaded.authPasswordHash).toBe('deadbeefsalt:cafebabehash');
    expect(loaded.anthropicApiKey).toBe('sk-ant-secret-key');
    expect(loaded.localhostOnly).toBe(false);
  });

  it('SURVIVES the save that used to destroy it', async () => {
    // The reported failure end-to-end: corrupt file, then any settings write.
    const { s, file } = await persister();
    await writeFile(file, spliced(REAL_SETTINGS), 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await s.saveSettings({ ttsEnabled: false });

    const onDisk = JSON.parse(await readFile(file, 'utf-8'));
    expect(onDisk.authPasswordHash).toBe('deadbeefsalt:cafebabehash');
    expect(onDisk.anthropicApiKey).toBe('sk-ant-secret-key');
    expect(onDisk.ttsEnabled).toBe(false); // the update still applied
  });

  it('preserves the original bytes and repairs the file', async () => {
    const { s, file } = await persister();
    const raw = spliced(REAL_SETTINGS);
    await writeFile(file, raw, 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await s.loadSettings();

    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(raw);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow(); // repaired
  });

  it('warns rather than failing silently', async () => {
    const { s, file } = await persister();
    await writeFile(file, spliced(REAL_SETTINGS), 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await s.loadSettings();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was corrupt'));
  });

  it('unrecoverable content: defaults, but LOUD and with the bytes preserved', async () => {
    const { s, file } = await persister();
    await writeFile(file, '{"authUsername": "petya", TRUNCATED', 'utf-8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loaded = await s.loadSettings();
    expect(loaded.authUsername).toBeNull();          // DEFAULTS, as designed
    expect(err).toHaveBeenCalledWith(expect.stringContaining('could NOT be recovered'));
    expect(existsSync(`${file}.corrupt`)).toBe(true); // recoverable by hand
  });

  it('a missing file is still silent DEFAULTS (normal first run)', async () => {
    const { s } = await persister();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loaded = await s.loadSettings();
    expect(loaded.localhostOnly).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('a valid file is untouched — no quarantine, no rewrite', async () => {
    const { s, file } = await persister();
    const clean = JSON.stringify(REAL_SETTINGS, null, 2);
    await writeFile(file, clean, 'utf-8');

    const loaded = await s.loadSettings();
    expect(loaded.anthropicApiKey).toBe('sk-ant-secret-key');
    expect(readFileSync(file, 'utf-8')).toBe(clean);
    expect(existsSync(`${file}.corrupt`)).toBe(false);
  });
});

describe('loadSettingsSync (middleware path)', () => {
  it('salvages in memory so auth still works while corrupt', async () => {
    const { s, file } = await persister();
    await writeFile(file, spliced(REAL_SETTINGS), 'utf-8');

    const loaded = s.loadSettingsSync();
    expect(loaded.authUsername).toBe('petya');
    expect(loaded.authPasswordHash).toBe('deadbeefsalt:cafebabehash');
  });

  it('does NOT write from the request path', async () => {
    const { s, file } = await persister();
    const raw = spliced(REAL_SETTINGS);
    await writeFile(file, raw, 'utf-8');

    s.loadSettingsSync();

    expect(readFileSync(file, 'utf-8')).toBe(raw);       // untouched
    expect(existsSync(`${file}.corrupt`)).toBe(false);   // no quarantine either
  });

  it('fails CLOSED when nothing can be salvaged', async () => {
    const { s, file } = await persister();
    await writeFile(file, '{"authUsername": "petya", TRUNCATED', 'utf-8');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loaded = s.loadSettingsSync();
    // middleware denies external access on both of these.
    expect(loaded.localhostOnly).toBe(true);
    expect(loaded.authPasswordHash).toBeNull();
  });
});
