import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// External access enabled with credentials configured (admin / admin).
vi.mock('@/lib/settingsPersistence', () => ({
  settingsPersistence: {
    loadSettingsSync: () => ({
      localhostOnly: false,
      authUsername: 'admin',
      authPasswordHash: 'hash',
    }),
  },
  verifyPassword: (pw: string) => pw === 'admin',
}));

import { middleware } from '@/middleware';

const EXTERNAL = { 'x-forwarded-for': '192.168.1.100' };
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, 'http://fury.local:3000'), {
    headers: { ...EXTERNAL, ...headers },
  });
}

describe('middleware: external BASIC auth', () => {
  it('redirects unauthenticated page navigation to /login', () => {
    const res = middleware(req('/', { accept: 'text/html,*/*', 'sec-fetch-dest': 'document' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://fury.local:3000/login');
  });

  it('lets /login and /api/auth/* through', () => {
    expect(middleware(req('/login', { accept: 'text/html' })).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(req('/api/auth/whoami')).headers.get('x-middleware-next')).toBe('1');
  });

  // Regression: the login page's logo, the PWA manifest/icons and the
  // metadata icons are fetched as subresources of /login. A 401 with
  // WWW-Authenticate on any of them pops the browser's native login dialog.
  it.each([
    ['/fury-mark.svg', 'image'],
    ['/fury-mark-sm.svg', 'image'],
    ['/icon.svg?abc123', 'image'],
    ['/apple-icon.png?abc123', 'image'],
    ['/icons/icon-192.png', 'image'],
    ['/manifest.webmanifest', 'manifest'],
  ])('serves public login-page asset %s without auth', (path, dest) => {
    const res = middleware(req(path, { accept: 'image/*,*/*;q=0.8', 'sec-fetch-dest': dest }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('never challenges non-XHR subresources (no native dialog)', () => {
    const res = middleware(req('/some/protected.png', { accept: 'image/*', 'sec-fetch-dest': 'image' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('still challenges the login XHR to / so the browser caches credentials', () => {
    const res = middleware(req('/', { accept: '*/*', 'sec-fetch-dest': 'empty' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="Fury"');
  });

  it('still challenges XHR when Sec-Fetch-Dest is absent (older browsers)', () => {
    const res = middleware(req('/', { accept: '*/*' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="Fury"');
  });

  it('accepts valid credentials and rejects bad ones without a challenge', () => {
    expect(middleware(req('/', { authorization: basic('admin', 'admin') })).headers.get('x-middleware-next')).toBe('1');
    const bad = middleware(req('/', { authorization: basic('admin', 'nope') }));
    expect(bad.status).toBe(403);
    expect(bad.headers.get('www-authenticate')).toBeNull();
  });

  it('localhost requests bypass auth', () => {
    const r = new NextRequest(new URL('/fury-mark.svg', 'http://localhost:3000'));
    expect(middleware(r).headers.get('x-middleware-next')).toBe('1');
  });
});
