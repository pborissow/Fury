import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';
import { settingsPersistence } from '@/lib/settingsPersistence';
import { ACCEPTED_IMAGE_MEDIA_TYPES, estimateBase64Bytes } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * POST /api/claude
 *
 * Sends a message to a Claude session. Returns immediately after queuing the
 * message — all stream data is delivered via SSE through /api/events.
 *
 * When `sdkSessionsEnabled` is on (default in the sdk-session-prototype
 * branch), the turn is routed to the persistent @anthropic-ai/claude-agent-sdk
 * manager (lib/sdkSessionManager.ts) instead of the one-shot `claude --print`
 * manager. Both emit the SAME eventBus events, so the frontend and /api/events
 * SSE stream are identical either way — the frontend keeps calling /api/claude
 * and doesn't need to know which backend served the turn.
 *
 * Body: { prompt: string, sessionId: string, projectPath?: string }
 * Response: { ok: true, backend: 'sdk' | 'cli' }
 */
export async function POST(req: NextRequest) {
  try {
    const { prompt, sessionId, projectPath, confirmTakeover, images } = await req.json();

    // Validate image attachments (SDK path only — see below). Each must be a
    // base64 string + an Anthropic-accepted media type, and be within size
    // bounds: the client downscales, but its fallback paths can hand back the
    // ORIGINAL bytes (undecodable image), and a stale/malicious client could
    // POST a huge blob → oversized request, token blowup, giant inline base64
    // in the JSONL. ALL-OR-NOTHING: any invalid image fails the request with a
    // 400 the client surfaces (and restores the attachments from), instead of
    // silently dropping it — a silent drop meant the UI showed the image as
    // sent while Claude replied "I don't see any image".
    const MAX_IMAGE_COUNT = 8;                       // per turn (plan §7)
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;         // per image
    const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;  // per turn
    let totalImageBytes = 0;
    const safeImages: { base64: string; mediaType: string }[] = [];
    if (Array.isArray(images)) {
      const reject = (error: string) => Response.json({ error }, { status: 400 });
      if (images.length > MAX_IMAGE_COUNT) {
        return reject(`Too many images (max ${MAX_IMAGE_COUNT} per turn)`);
      }
      for (const i of images) {
        if (!i || typeof i.base64 !== 'string' || typeof i.mediaType !== 'string') {
          return reject('Malformed image attachment');
        }
        if (!ACCEPTED_IMAGE_MEDIA_TYPES.includes(i.mediaType)) {
          return reject(`Unsupported image type ${i.mediaType} (accepted: png, jpeg, gif, webp)`);
        }
        const bytes = estimateBase64Bytes(i.base64);
        if (bytes === 0) return reject('Empty image attachment');
        if (bytes > MAX_IMAGE_BYTES) {
          return reject(`Image too large (${(bytes / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
        }
        totalImageBytes += bytes;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
          return reject(`Images too large in total (max ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024}MB per turn)`);
        }
        safeImages.push({ base64: i.base64, mediaType: i.mediaType });
      }
    }

    // A turn must carry text or at least one image.
    if (!prompt && safeImages.length === 0) {
      return Response.json({ error: 'Prompt is required' }, { status: 400 });
    }

    if (!sessionId) {
      return Response.json({ error: 'Session ID is required' }, { status: 400 });
    }

    // Default to the SDK path if the setting can't be read, matching the
    // branch default (fail toward the behavior under test here).
    let useSdk = true;
    try {
      useSdk = (await settingsPersistence.loadSettings()).sdkSessionsEnabled !== false;
    } catch (err) {
      console.error('[Claude API] settings load failed, defaulting to SDK path:', err);
    }

    // A parked question blocks the turn mid-tool. sendMessage REJECTS in that
    // case, but the dispatch below is fire-and-forget — the rejection would
    // become a server-side console line while the client is told {ok:true},
    // then waits forever for SSE that can never arrive (sendMessage throws
    // before startQuery, so no health event ever fires). Spinner forever,
    // message silently gone.
    //
    // So the check has to happen HERE, where a status code can still be
    // returned. ChatTab's send already renders a non-ok `error` and clears the
    // spinner, which is the "reject with a clear error" the design called for.
    // sendMessage keeps its own guard as defense in depth (another client, a
    // race) — this is the one that can actually talk to the user.
    if (useSdk && sdkSessionManager.getPendingAsk(sessionId)) {
      return Response.json(
        { error: 'Claude is waiting for an answer to its question. Answer or dismiss it first.' },
        { status: 409 },
      );
    }

    // If this session is live in an external terminal, DON'T silently take it
    // over: sending would spawn Fury's resume query alongside the terminal CLI,
    // two writers on one JSONL, and (pre-fix) SIGKILL the user's terminal out
    // from under them. Detect it here — where a status code can still reach the
    // client — and return a 409 the UI renders as a takeover confirmation. The
    // confirmed re-send carries confirmTakeover, which lets this check pass and
    // instructs sendMessage to end the terminal cleanly (SIGTERM) first. Same
    // shape as the pendingAsk guard above: a pre-dispatch 409, since the actual
    // send is fire-and-forget over SSE. See
    // docs/ticket-resume-live-cli-session-hard-kill.md.
    if (useSdk && !confirmTakeover) {
      const owner = await sdkSessionManager.detectExternalOwner(sessionId);
      if (owner) {
        return Response.json(
          {
            needsTakeoverConfirm: true,
            owner: { pid: owner.pid, name: owner.name, cwd: owner.cwd },
            error: 'This session is live in a terminal.',
          },
          { status: 409 },
        );
      }
    }

    // Fire-and-forget: the manager runs in the background, emitting stream
    // events and health updates via the eventBus.
    if (useSdk) {
      sdkSessionManager.sendMessage(sessionId, prompt, projectPath, {
        confirmTakeover: !!confirmTakeover,
        images: safeImages,
      }).catch(error => {
        console.error('[Claude API] SDK sendMessage failed:', error);
      });
    } else {
      // The CLI (`--print`) path cannot carry image blocks. Reject loudly
      // instead of silently dropping: a drop meant the UI showed the image as
      // sent (200 OK) while the turn went out text-only — and an image-only
      // turn would have spawned `claude --print` with an EMPTY prompt. The UI
      // gates the paste affordance to SDK sessions (sdkSessionsEnabled), so
      // this only fires for a stale client.
      if (safeImages.length > 0) {
        return Response.json(
          { error: 'Image attachments require the SDK backend (enable SDK sessions in Settings)' },
          { status: 400 },
        );
      }
      sessionManager.processMessage(sessionId, prompt, [], projectPath).catch(error => {
        console.error('[Claude API] processMessage failed:', error);
      });
    }

    return Response.json({ ok: true, backend: useSdk ? 'sdk' : 'cli' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
