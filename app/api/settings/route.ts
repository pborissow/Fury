import { NextResponse } from 'next/server';
import { settingsPersistence } from '@/lib/settingsPersistence';

export async function GET() {
  try {
    const settings = await settingsPersistence.loadSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error('[Settings API] Failed to load:', error);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const updates = await request.json();
    const settings = await settingsPersistence.saveSettings(updates);
    return NextResponse.json(settings);
  } catch (error) {
    console.error('[Settings API] Failed to save:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
