/**
 * Client-side image normalization for paste-to-attach (browser only).
 *
 * Screenshots pasted into the composer are drawn to a canvas, capped on the
 * long edge (~1568px — Anthropic downsamples around there anyway), and
 * re-encoded to a compact, vision-valid format (webp when supported, else
 * jpeg/png). This bounds both token cost and transcript/store size regardless
 * of the source resolution.
 */

import { ACCEPTED_IMAGE_MEDIA_TYPES, estimateBase64Bytes } from './types';

/** Anthropic image blocks accept only these media types (shared source of
 *  truth in lib/types.ts — also used by /api/claude and the scrubber). */
const ACCEPTED = new Set(ACCEPTED_IMAGE_MEDIA_TYPES);

/** Long-edge cap; matches Anthropic's internal downscale threshold. */
const MAX_EDGE = 1568;

/** Hard per-image byte cap — MUST match /api/claude's MAX_IMAGE_BYTES. The
 *  fallback paths below hand back the ORIGINAL bytes when canvas processing
 *  fails; without this cap an undecodable >5MB image would pass the composer
 *  and then be rejected server-side after the user hit send. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface AttachedImage {
  /** Stable id for React keys / removal. */
  id: string;
  /** data: URL for preview + optimistic render (also used to derive base64). */
  dataUrl: string;
  /** Base64 payload WITHOUT the data: prefix — what the SDK image block needs. */
  base64: string;
  /** Normalized media type (image/webp | image/jpeg | image/png). */
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
 * unsupported types. Falls back to the original bytes if canvas encoding fails.
 */
export async function normalizeImage(file: File): Promise<AttachedImage> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || 'unknown'}`);
  }

  const sourceUrl = await readAsDataUrl(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(sourceUrl);
  } catch {
    // Undecodable — hand back the original as-is.
    return dataUrlToAttached(sourceUrl, file.type, 0, 0);
  }

  const { width: sw, height: sh } = img;
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
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    return dataUrlToAttached(sourceUrl, file.type, sw, sh);
  }

  // Preserve transparency for png/gif sources; otherwise prefer webp/jpeg.
  const sourceHasAlpha = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
  let mediaType: string;
  if (supportsWebp()) mediaType = 'image/webp';
  else if (sourceHasAlpha) mediaType = 'image/png';
  else mediaType = 'image/jpeg';

  let outUrl: string;
  try {
    outUrl = canvas.toDataURL(mediaType, 0.85);
    if (!outUrl.startsWith(`data:${mediaType}`)) {
      // Browser silently substituted a format — trust the returned prefix.
      mediaType = outUrl.slice(5, outUrl.indexOf(';')) || 'image/png';
    }
  } catch {
    return dataUrlToAttached(sourceUrl, file.type, sw, sh);
  }

  return dataUrlToAttached(outUrl, mediaType, w, h);
}

function dataUrlToAttached(dataUrl: string, mediaType: string, width: number, height: number): AttachedImage {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  // Every normalizeImage return path funnels through here, so this single cap
  // covers the fallback paths that hand back ORIGINAL (un-downscaled) bytes.
  // Throwing at attach time surfaces "too large" on the paste, not after send.
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
