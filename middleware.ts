import { NextRequest, NextResponse } from 'next/server';
import { settingsPersistence, verifyPassword } from '@/lib/settingsPersistence';

export const runtime = 'nodejs';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

// Non-sensitive branding/PWA assets requested by /login before the user has
// credentials (logo <img>, plus the icon/manifest <link>s Next injects from
// app/layout.tsx metadata, app/icon.svg, app/apple-icon.png, app/manifest.ts).
// /icons/* (manifest icons) is allowed by prefix below.
const PUBLIC_ASSETS = new Set([
  '/fury-mark.svg',
  '/fury-mark-sm.svg',
  '/fury-mark-xs.svg',
  '/icon.svg',
  '/apple-icon.png',
  '/manifest.webmanifest',
]);

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

  // No credentials configured — block external access even if localhostOnly is off
  if (!settings.authUsername || !settings.authPasswordHash) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // External connections allowed with credentials — require BASIC auth
  const pathname = request.nextUrl.pathname;

  // Auth utility endpoints, the login page, and the public assets the login
  // page (and root layout metadata) pull in bypass auth
  if (
    pathname.startsWith('/api/auth/') ||
    pathname === '/login' ||
    PUBLIC_ASSETS.has(pathname) ||
    pathname.startsWith('/icons/')
  ) {
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
    // Subresources (<img>, <link rel=manifest|icon>, scripts, fonts, ...) must
    // never get a WWW-Authenticate challenge — the browser answers it with its
    // native login dialog on top of whatever page is showing. Only XHR/fetch
    // (Sec-Fetch-Dest: empty, or absent on older browsers) gets the challenge.
    const dest = request.headers.get('sec-fetch-dest');
    if (dest && dest !== 'empty') {
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: { 'Cache-Control': 'no-cache, no-transform' },
      });
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

  return NextResponse.next();
}
