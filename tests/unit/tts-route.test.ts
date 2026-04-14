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
    vi.restoreAllMocks();
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

  it('passes the text to generateSpeech', async () => {
    mockGenerateSpeech.mockResolvedValue(Buffer.from('wav'));

    await POST(makeRequest({ text: 'Test input' }));
    expect(mockGenerateSpeech).toHaveBeenCalledWith('Test input', expect.anything());
  });
});
