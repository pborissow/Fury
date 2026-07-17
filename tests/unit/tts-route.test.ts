import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tts module to avoid loading the real model
vi.mock('@/lib/tts', () => ({
  generateSpeech: vi.fn(),
}));

import { POST } from '@/app/api/tts/route';
import { generateSpeech } from '@/lib/tts';

const mockGenerateSpeech = generateSpeech as ReturnType<typeof vi.fn>;

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tts', () => {
  beforeEach(() => {
    // clearAllMocks resets call history between tests (restoreAllMocks does not
    // clear a vi.mock factory's vi.fn, so calls used to accumulate across tests).
    // Implementations set per-test via mockResolvedValue/mockRejectedValue persist.
    vi.clearAllMocks();
  });

  it('returns 400 for missing text', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Missing text');
  });

  it('returns 400 for non-string text', async () => {
    const res = await POST(makeRequest({ text: 123 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty string', async () => {
    const res = await POST(makeRequest({ text: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for text exceeding max length', async () => {
    const res = await POST(makeRequest({ text: 'a'.repeat(50_001) }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('too long');
  });

  it('returns 200 with WAV audio on success', async () => {
    const fakeWav = Buffer.from('RIFF....WAVEfmt ');
    mockGenerateSpeech.mockResolvedValue(fakeWav);

    const res = await POST(makeRequest({ text: 'Hello world' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
    expect(res.headers.get('Content-Length')).toBe(String(fakeWav.length));

    const body = await res.arrayBuffer();
    expect(Buffer.from(body)).toEqual(fakeWav);
  });

  it('returns 500 on generation error', async () => {
    mockGenerateSpeech.mockRejectedValue(new Error('synthesis failed'));

    const res = await POST(makeRequest({ text: 'Hello' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain('synthesis failed');
  });

  it('passes the text, an abort signal, and settings to generateSpeech', async () => {
    mockGenerateSpeech.mockResolvedValue(Buffer.from('wav'));

    await POST(makeRequest({ text: 'Test input' }));

    // Signature: generateSpeech(text, signal, settings, turnMeta?). Assert the
    // forwarded args positionally so it stays robust as the trailing optional
    // (turnMeta) comes and goes, rather than pinning an exact arg list.
    expect(mockGenerateSpeech).toHaveBeenCalledOnce();
    const [text, signal, settings] = mockGenerateSpeech.mock.calls[0];
    expect(text).toBe('Test input');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(settings).toBeDefined();
  });

  it('forwards turnMeta to generateSpeech when the request includes it', async () => {
    mockGenerateSpeech.mockResolvedValue(Buffer.from('wav'));
    const turnMeta = { totalTools: 2, writeFileCount: 1, toolCounts: { Edit: 1, Bash: 1 } };

    await POST(makeRequest({ text: 'Test input', turnMeta }));

    expect(mockGenerateSpeech).toHaveBeenCalledOnce();
    expect(mockGenerateSpeech.mock.calls[0][3]).toEqual(turnMeta);
  });
});
