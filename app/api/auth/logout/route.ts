import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  // Only send WWW-Authenticate if prompt=true (to re-trigger login dialog)
  // Default: no WWW-Authenticate so the browser doesn't pop a native dialog
  const prompt = request.nextUrl.searchParams.get('prompt');

  const headers: Record<string, string> = {
    'Cache-Control': 'no-cache, no-transform',
  };

  if (prompt === 'true') {
    headers['WWW-Authenticate'] = 'Basic realm="This site is restricted. Please enter your username and password."';
  }

  return new NextResponse('Unauthorized', { status: 401, headers });
}
