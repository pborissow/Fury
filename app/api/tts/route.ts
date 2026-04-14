import { NextResponse } from 'next/server';
import { generateSpeech } from '@/lib/tts';
import { settingsPersistence } from '@/lib/settingsPersistence';

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_TEXT_LENGTH = 50_000;

export async function POST(request: Request) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { text } = await request.json();
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` }, { status: 400 });
    }

    const settings = await settingsPersistence.loadSettings();
    const wav = await generateSpeech(text, timeoutController.signal, settings);
    return new NextResponse(new Uint8Array(wav), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
      },
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      return NextResponse.json({ error: 'TTS generation timed out' }, { status: 504 });
    }
    console.error('[TTS API]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'TTS generation failed' },
      { status: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
