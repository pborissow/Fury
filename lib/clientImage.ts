/**
 * Client-side image normalization for paste-to-attach (browser only).
 *
 * FIDELITY-FIRST (2026-09-04): a pasted image whose bytes already fit the
 * API's hard 5MB-per-image cap is attached UNTOUCHED — no downscale, no
 * re-encode. Two reasons this is strictly better than the old always-normalize
 * path (long-edge cap + WebP q0.85):
 *
 *  1. TOKENS: Anthropic downscales long edges > ~1568px SERVER-side and prices
 *     vision tokens on the POST-resize dimensions — pre-shrinking saves no
 *     tokens, only upload/transcript bytes. And the API's own resampler beats
 *     a single-pass canvas drawImage.
 *  2. QUALITY: the lossy WebP re-encode added artifacts the API would never
 *     add. Text-heavy screenshots (the dominant paste) are the worst case —
 *     users saw visibly grainy images in the viewer, and Claude received the
 *     same degraded bytes.
 *
 * Only when the original exceeds the 5MB cap do we degrade — and then
 * lossless-first: downscale to the ~1568px long edge (matching the API's own
 * threshold, with high-quality smoothing), try PNG, and fall to lossy
 * webp/jpeg only if PNG still doesn't fit. So the stored bytes (what the
 * viewer shows AND what Claude gets) are always the best representation that
 * fits the API.
 */

import { ACCEPTED_IMAGE_MEDIA_TYPES, estimateBase64Bytes } from './types';

/** Anthropic image blocks accept only these media types (shared source of
 *  truth in lib/types.ts — also used by /api/claude and the scrubber). */
const ACCEPTED = new Set(ACCEPTED_IMAGE_MEDIA_TYPES);

/** Long-edge target for the OVERSIZED-only downscale path; matches the
 *  threshold above which the API downscales server-side anyway. */
const MAX_EDGE = 1568;

/** Hard per-image byte cap — MUST match /api/claude's MAX_IMAGE_BYTES (the
 *  API rejects larger images). Originals at or under this pass through
 *  untouched; larger ones go through the degrade ladder below, and anything
 *  that still can't fit throws at attach time (surfaced on the paste, not
 *  after the user hits send). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface AttachedImage {
  /** Stable id for React keys / removal. */
  id: string;
  /** data: URL for preview + optimistic render (also used to derive base64). */
  dataUrl: string;
  /** Base64 payload WITHOUT the data: prefix — what the SDK image block needs. */
  base64: string;
  /** Normalized media type (image/png|jpeg|gif|webp). */
  mediaType: string;
  width: number;
  height: number;
  /** Approximate encoded byte size. */
  bytes: number;
}

export function isAcceptedImageType(type: string): boolean {
  return ACCEPTED.has(type);
}

let webpSupported: boolean | null = null;
function supportsWebp(): boolean {
  if (webpSupported !== null) return webpSupported;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupported = false;
  }
  return webpSupported;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = url;
  });
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `img-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Normalize a pasted/dropped image file into an AttachedImage. Rejects
 * unsupported types.
 *
 *  - fits the 5MB API cap → ORIGINAL bytes, untouched (the common case;
 *    dimensions are decoded best-effort for metadata only);
 *  - over the cap → downscale to MAX_EDGE (high-quality smoothing) and take
 *    the first encoding that fits: png (lossless) → webp 0.85 → jpeg 0.85;
 *  - still doesn't fit / undecodable-and-over-cap → throw at attach time.
 */
export async function normalizeImage(file: File): Promise<AttachedImage> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || 'unknown'}`);
  }

  const sourceUrl = await readAsDataUrl(file);
  let img: HTMLImageElement | null = null;
  try {
    img = await loadImage(sourceUrl);
  } catch {
    // Undecodable in this browser — attach the original as-is (the cap check
    // in dataUrlToAttached still guards the API limit).
    return dataUrlToAttached(sourceUrl, file.type, 0, 0);
  }

  const { width: sw, height: sh } = img;

  // Fidelity-first: within the API cap → pass the original through untouched.
  if (file.size <= MAX_IMAGE_BYTES) {
    return dataUrlToAttached(sourceUrl, file.type, sw, sh);
  }

  // Over the cap: degrade as gently as possible.
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh || 1));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    // Can't process — the original is over the cap, so this will throw the
    // "too large" error below, which is the honest outcome.
    return dataUrlToAttached(sourceUrl, file.type, sw, sh);
  }

  // Lossless first; lossy only if PNG still doesn't fit under the cap.
  const candidates: Array<{ type: string; quality?: number }> = [
    { type: 'image/png' },
    ...(supportsWebp() ? [{ type: 'image/webp', quality: 0.85 }] : []),
    { type: 'image/jpeg', quality: 0.85 },
  ];
  for (const c of candidates) {
    let url: string;
    try {
      url = canvas.toDataURL(c.type, c.quality);
    } catch {
      continue;
    }
    // Browsers silently substitute png for unsupported encoders — trust the prefix.
    const actualType = url.slice(5, url.indexOf(';')) || 'image/png';
    const comma = url.indexOf(',');
    if (estimateBase64Bytes(comma >= 0 ? url.slice(comma + 1) : '') <= MAX_IMAGE_BYTES) {
      return dataUrlToAttached(url, actualType, w, h);
    }
  }
  throw new Error(
    `Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB — could not be reduced under ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
  );
}

function dataUrlToAttached(dataUrl: string, mediaType: string, width: number, height: number): AttachedImage {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  // Every normalizeImage return path funnels through here, so this single cap
  // covers the fallback paths that hand back ORIGINAL bytes. Throwing at
  // attach time surfaces "too large" on the paste, not after the user hit send.
  const bytes = estimateBase64Bytes(base64);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large (${(bytes / 1024 / 1024).toFixed(1)}MB — max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
    );
  }
  // Normalize the media type to the dataUrl's actual prefix when possible.
  const prefixType = dataUrl.startsWith('data:') ? dataUrl.slice(5, dataUrl.indexOf(';')) : mediaType;
  const finalType = ACCEPTED.has(prefixType) ? prefixType : (ACCEPTED.has(mediaType) ? mediaType : 'image/png');
  return {
    id: nextId(),
    dataUrl,
    base64,
    mediaType: finalType,
    width,
    height,
    bytes,
  };
}
