import { NextRequest, NextResponse } from 'next/server';
import { settingsPersistence, verifyPassword } from '@/lib/settingsPersistence';

export async function GET(request: NextRequest) {
  const settings = await settingsPersistence.loadSettings();

  if (!settings.authUsername || !settings.authPasswordHash) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
  }

  const authHeader = request.headers.get('authorization');

  // No credentials — send WWW-Authenticate to trigger the browser's
  // auto-retry with credentials from xhr.open(url, true, user, pass)
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Access Denied"',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  // Credentials provided — validate
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return new NextResponse('Unauthorized', { status: 403 });
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (
    username.toLowerCase() === settings.authUsername.toLowerCase() &&
    verifyPassword(password, settings.authPasswordHash)
  ) {
    return NextResponse.json({ username });
  }

  // Wrong credentials — 403, no WWW-Authenticate (no browser dialog)
  return new NextResponse('Unauthorized', {
    status: 403,
    headers: {
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
