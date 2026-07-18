import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/sdkSessionManager', () => ({
  sdkSessionManager: {
    warmModels: vi.fn(),
    listModels: vi.fn(),
  },
}));
vi.mock('@/lib/settingsPersistence', () => ({
  settingsPersistence: { loadSettings: vi.fn() },
}));

import { GET } from '@/app/api/claude-sdk/model/route';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { settingsPersistence } from '@/lib/settingsPersistence';

const mockWarm = sdkSessionManager.warmModels as ReturnType<typeof vi.fn>;
const mockList = sdkSessionManager.listModels as ReturnType<typeof vi.fn>;
const mockSettings = settingsPersistence.loadSettings as ReturnType<typeof vi.fn>;

const CATALOG = [
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '' },
];

const req = (qs = '') => new NextRequest(`http://localhost/api/claude-sdk/model${qs}`);

describe('GET /api/claude-sdk/model — session-less warm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.mockResolvedValue({ sdkSessionsEnabled: true });
  });

  it('warms and returns the catalog alone when no sessionId is given', async () => {
    mockWarm.mockResolvedValue(CATALOG);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(mockWarm).toHaveBeenCalledOnce();
    expect(mockList).not.toHaveBeenCalled();
    expect(json).toEqual({ models: CATALOG, live: false, current: undefined, contextTokens: 0 });
  });

  it('does not require a UUID in the session-less case', async () => {
    mockWarm.mockResolvedValue([]);
    const res = await GET(req()); // no sessionId at all
    expect(res.status).toBe(200);
  });

  it('still serves the per-session catalog when a valid sessionId is given', async () => {
    mockList.mockResolvedValue({ models: CATALOG, live: true, current: 'claude-opus-4-8', contextTokens: 1234 });

    const res = await GET(req('?sessionId=f51df77b-ce31-4407-be85-7be6c4e3017a'));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(mockList).toHaveBeenCalledWith('f51df77b-ce31-4407-be85-7be6c4e3017a');
    expect(mockWarm).not.toHaveBeenCalled();
    expect(json.current).toBe('claude-opus-4-8');
  });

  it('rejects a malformed sessionId (present but not a UUID)', async () => {
    const res = await GET(req('?sessionId=not-a-uuid'));
    expect(res.status).toBe(400);
    expect(mockWarm).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 409 when SDK sessions are disabled', async () => {
    mockSettings.mockResolvedValue({ sdkSessionsEnabled: false });
    const res = await GET(req());
    expect(res.status).toBe(409);
    expect(mockWarm).not.toHaveBeenCalled();
  });
});
