import { NextRequest, NextResponse } from 'next/server';
import { settingsPersistence, verifyPassword } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function middleware(request: NextRequest) {
  const settings = settingsPersistence.loadSettingsSync();

  // Determine if this is a local request
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    '';
  const isLocal = !ip || LOCALHOST_ADDRS.has(ip);

  // Localhost requests always pass through
  if (isLocal) {
    return NextResponse.next();
  }

  // External request — block if localhostOnly
  if (settings.localhostOnly) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // External connections allowed — if credentials are configured, require BASIC auth
  if (settings.authUsername && settings.authPasswordHash) {
    const pathname = request.nextUrl.pathname;

    // Auth utility endpoints and login page bypass middleware auth
    if (pathname.startsWith('/api/auth/') || pathname === '/login') {
      return NextResponse.next();
    }

    // All other routes — validate BASIC auth
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      const accept = request.headers.get('accept') || '';
      if (accept.includes('text/html')) {
        // Browser page navigation → redirect to login page
        return NextResponse.redirect(new URL('/login', request.url));
      }
      // XHR/fetch → 401 with WWW-Authenticate so the browser's challenge-response
      // can cache credentials at this path level (critical for root-level caching)
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Fury"',
          'Cache-Control': 'no-cache, no-transform',
        },
      });
    }

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    if (
      username.toLowerCase() !== settings.authUsername.toLowerCase() ||
      !verifyPassword(password, settings.authPasswordHash)
    ) {
      // Wrong credentials — no WWW-Authenticate (don't trigger native dialog)
      return new NextResponse('Unauthorized', { status: 403 });
    }
  }

  return NextResponse.next();
}
