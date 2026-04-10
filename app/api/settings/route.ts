import { NextResponse } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { settingsPersistence } from '@/lib/settingsPersistence';

export async function GET() {
  try {
    const settings = await settingsPersistence.loadSettings();
    // Return whether credentials exist, but never expose the hash
    return NextResponse.json({
      ...settings,
      authPasswordHash: undefined,
      hasCredentials: !!(settings.authUsername && settings.authPasswordHash),
    });
  } catch (error) {
    console.error('[Settings API] Failed to load:', error);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // If a plaintext password is provided, hash it before persisting
    if (body.authPassword !== undefined) {
      if (body.authPassword) {
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(body.authPassword, salt, 64).toString('hex');
        body.authPasswordHash = `${salt}:${hash}`;
      } else {
        body.authPasswordHash = null;
      }
      delete body.authPassword;
    }

    const settings = await settingsPersistence.saveSettings(body);
    return NextResponse.json({
      ...settings,
      authPasswordHash: undefined,
      hasCredentials: !!(settings.authUsername && settings.authPasswordHash),
    });
  } catch (error) {
    console.error('[Settings API] Failed to save:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
