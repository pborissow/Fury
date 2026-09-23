/**
 * The SDK manager must restore a session's JSONL from the SQLite archive before
 * opening its query. Claude CLI deletes transcripts after 30 days; without the
 * restore, startQuery saw no JSONL, opened a FRESH session under the old id
 * (`sessionId:` instead of `resume:`), and the chat tab showed only the new turn
 * even though the archive still held the full history. sessionManager.ts already
 * had this preamble; the SDK path didn't.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const jsonlPresent = { value: false };

vi.mock('../../lib/sessionPaths', async (orig) => ({
  ...(await orig<typeof import('../../lib/sessionPaths')>()),
  findSessionJsonlDir: vi.fn(() => (jsonlPresent.value ? '/fake/dir' : null)),
}));

vi.mock('../../lib/transcriptArchiver', async (orig) => ({
  ...(await orig<typeof import('../../lib/transcriptArchiver')>()),
  restoreJsonlFromArchive: vi.fn(async () => {
    calls.push('restore');
    return '/fake/dir/session.jsonl';
  }),
}));

import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { restoreJsonlFromArchive } from '../../lib/transcriptArchiver';

type Mgr = {
  getOrCreate(id: string): { q: unknown; isProcessing: boolean; model?: string };
  sessions: Map<string, unknown>;
  startQuery: (s: unknown) => void;
  ensureModelHydrated: (s: unknown) => Promise<void>;
};
const mgr = sdkSessionManager as unknown as Mgr;

describe('SDK manager restores a missing JSONL from the archive', () => {
  const originalStart = mgr.startQuery;
  const originalHydrate = mgr.ensureModelHydrated;

  beforeEach(() => {
    calls.length = 0;
    vi.mocked(restoreJsonlFromArchive).mockReset(); // drops any unconsumed *Once impl; keeps the factory impl
    mgr.ensureModelHydrated = async () => {};
    return () => {
      mgr.startQuery = originalStart;
      mgr.ensureModelHydrated = originalHydrate;
    };
  });

  it('sendMessage restores BEFORE startQuery when the JSONL is gone', async () => {
    const id = 'restore-send-fixture';
    jsonlPresent.value = false;
    mgr.startQuery = () => { calls.push('startQuery'); throw new Error('stop-here'); };

    await expect(sdkSessionManager.sendMessage(id, 'hi', '/proj')).rejects.toThrow('stop-here');

    expect(calls).toEqual(['restore', 'startQuery']);
    expect(restoreJsonlFromArchive).toHaveBeenCalledWith(id, '/proj');
    mgr.sessions.delete(id);
  });

  it('does not touch the archive when the JSONL exists', async () => {
    const id = 'restore-present-fixture';
    jsonlPresent.value = true;
    mgr.startQuery = () => { calls.push('startQuery'); throw new Error('stop-here'); };

    await expect(sdkSessionManager.sendMessage(id, 'hi', '/proj')).rejects.toThrow('stop-here');

    expect(calls).toEqual(['startQuery']);
    expect(restoreJsonlFromArchive).not.toHaveBeenCalled();
    mgr.sessions.delete(id);
  });

  it('a failed restore releases the turn guard and does not block the send', async () => {
    const id = 'restore-fail-fixture';
    jsonlPresent.value = false;
    vi.mocked(restoreJsonlFromArchive).mockRejectedValueOnce(new Error('db locked'));
    mgr.startQuery = () => { calls.push('startQuery'); throw new Error('stop-here'); };

    // Restore failure is swallowed; the send proceeds to startQuery.
    await expect(sdkSessionManager.sendMessage(id, 'hi', '/proj')).rejects.toThrow('stop-here');
    expect(calls).toEqual(['startQuery']);
    mgr.sessions.delete(id);
  });

  it('rewind restores before re-opening a torn-down query', async () => {
    const id = 'restore-rewind-fixture';
    jsonlPresent.value = false;
    const rewindFiles = vi.fn(async () => ({ canRewind: true }));
    mgr.startQuery = (s) => { calls.push('startQuery'); (s as { q: unknown }).q = { rewindFiles }; };

    await sdkSessionManager.rewind(id, 'uuid-1', '/proj');

    expect(calls).toEqual(['restore', 'startQuery']);
    expect(rewindFiles).toHaveBeenCalledWith('uuid-1');
    mgr.sessions.delete(id);
  });
});
