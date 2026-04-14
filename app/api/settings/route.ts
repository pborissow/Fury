import { NextResponse } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { settingsPersistence } from '@/lib/settingsPersistence';
import { warmupTTS } from '@/lib/tts';

function sanitizeForClient(settings: Awaited<ReturnType<typeof settingsPersistence.loadSettings>>) {
  return {
    ...settings,
    authPasswordHash: undefined,
    anthropicApiKey: undefined,
    hasCredentials: !!(settings.authUsername && settings.authPasswordHash),
    hasAnthropicApiKey: !!settings.anthropicApiKey,
  };
}

export async function GET() {
  try {
    const settings = await settingsPersistence.loadSettings();
    return NextResponse.json(sanitizeForClient(settings));
  } catch (error) {
    console.error('[Settings API] Failed to load:', error);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

const ALLOWED_KEYS = [
  'promptSuggestionsEnabled', 'ttsEnabled', 'localhostOnly',
  'authUsername', 'anthropicApiKey',
  'summarizerProvider', 'ollamaHost', 'ollamaPort',
  'ttsProvider', 'ttsRemoteHost', 'ttsRemotePort',
] as const;

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const updates: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (body[key] !== undefined) {
        updates[key] = key === 'anthropicApiKey' ? (body[key] || null) : body[key];
      }
    }

    for (const portKey of ['ollamaPort', 'ttsRemotePort'] as const) {
      if (updates[portKey] !== undefined) {
        const n = parseInt(String(updates[portKey]), 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535) {
          return NextResponse.json({ error: `Invalid port: ${updates[portKey]}` }, { status: 400 });
        }
        updates[portKey] = String(n);
      }
    }

    if (body.authPassword !== undefined) {
      if (body.authPassword) {
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(body.authPassword, salt, 64).toString('hex');
        updates.authPasswordHash = `${salt}:${hash}`;
      } else {
        updates.authPasswordHash = null;
      }
    }

    const settings = await settingsPersistence.saveSettings(updates);

    if (body.ttsEnabled === true) warmupTTS();

    return NextResponse.json(sanitizeForClient(settings));
  } catch (error) {
    console.error('[Settings API] Failed to save:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
