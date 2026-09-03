import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { getImagePath, isValidHash, mediaTypeForExt, sanitizeSessionId } from '@/lib/imageStore';

export const runtime = 'nodejs';

/**
 * GET /api/images/<sessionId>/<hash>
 *
 * Streams the bytes of a persisted (externalized) transcript image from the
 * per-session store. Content-addressed, so the response is immutable and
 * long-cacheable. 404 when the image isn't present (ephemeral mode, an archived
 * session whose folder was purged, or a not-yet-persisted image) — the UI
 * renders a graceful placeholder chip on 404.
 *
 * Auth is enforced by the global middleware. Path traversal is prevented by
 * strict sessionId/hash sanitization + store-dir confinement in imageStore.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; hash: string }> },
) {
  const { sessionId: rawSessionId, hash: rawHash } = await params;
  const sessionId = sanitizeSessionId(rawSessionId);
  const hash = (rawHash || '').toLowerCase();

  if (!sessionId || !isValidHash(hash)) {
    return NextResponse.json({ error: 'Invalid image reference' }, { status: 400 });
  }

  const filePath = getImagePath(sessionId, hash);
  if (!filePath) {
    return NextResponse.json({ error: 'Image not found' }, { status: 404 });
  }

  try {
    const bytes = await readFile(filePath);
    const ext = extname(filePath).slice(1);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mediaTypeForExt(ext),
        'Content-Length': String(bytes.length),
        // Content-addressed ⇒ the bytes at this URL never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Image not found' }, { status: 404 });
  }
}
