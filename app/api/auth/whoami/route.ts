import { NextRequest, NextResponse } from 'next/server';
import { settingsPersistence, verifyPassword } from '@/lib/settingsPersistence';

export async function GET(request: NextRequest) {
  const settings = await settingsPersistence.loadSettings();

  // No auth configured — treat as authenticated
  if (!settings.authUsername || !settings.authPasswordHash) {
    return NextResponse.json({ authenticated: true });
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    // No WWW-Authenticate — never trigger browser dialog from whoami
    return new NextResponse('', { status: 400 });
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return new NextResponse('', { status: 400 });
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  // Ignore dummy "logout" credentials used to clear browser auth cache
  if (username === 'logout') {
    return new NextResponse('', { status: 400 });
  }

  if (
    username.toLowerCase() === settings.authUsername.toLowerCase() &&
    verifyPassword(password, settings.authPasswordHash)
  ) {
    return NextResponse.json({ authenticated: true, username });
  }

  return new NextResponse('', { status: 400 });
}
