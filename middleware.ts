import { NextRequest, NextResponse } from 'next/server';
import { settingsPersistence } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

// Localhost identifiers
const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function middleware(request: NextRequest) {
  const settings = settingsPersistence.loadSettingsSync();

  if (!settings.localhostOnly) {
    return NextResponse.next();
  }

  // Check the connecting IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    '';

  if (ip && !LOCALHOST_ADDRS.has(ip)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return NextResponse.next();
}
