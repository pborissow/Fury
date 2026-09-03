'use client';

/**
 * Full-size image viewer for transcript thumbnails.
 *
 * The chat bubbles render reduced previews (thumbnails capped at ~240px);
 * clicking one opens this viewer on the same source — an inline data URL for
 * recent turns, or /api/images/<sessionId>/<hash> for persisted ones. Built on
 * the common Dialog, so it drags, resizes, and maximizes (double-click the
 * header) like every other Fury dialog.
 *
 * SIZING — the dialog opens pre-sized to the clicked image, aspect preserved:
 *   - big images are scaled down so the whole image fits within 90% of the
 *     viewport;
 *   - small images are oversampled (scaled UP) toward a comfortable minimum
 *     (800×600 landscape / 600×800 portrait);
 *   - the dialog never opens larger than 90% or smaller than the minimum
 *     (extreme aspect ratios letterbox inside the minimum box).
 * The image's natural size is only known after it loads, and the common
 * Dialog applies defaultWidth/Height on its open edge — so the source is
 * PRELOADED (instant: data URL or local API) and the dialog opens once the
 * size is computed.
 *
 * CAROUSEL — when the clicked bubble holds several images, chevron overlays
 * (and ←/→ keys) cycle through them with wrap-around, without closing the
 * dialog. The dialog KEEPS the size computed for the first-opened image —
 * no window jumping per step — and each newly shown image re-fits its zoom
 * to the current window instead.
 *
 * ZOOM — a footer toolbar carries the download link, a slider (10%–400%,
 * floor lowered for huge images whose fit scale is below 10%), a percent
 * readout, and a fit icon. The image renders at an explicit zoomed width;
 * smaller-than-view images center, larger ones scroll. Clicking the image
 * toggles fit ↔ 1:1.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Scan } from 'lucide-react';
import Dialog from '@/components/Dialog';

/** Header bar height (py-3 + text-sm line + border) above the content. */
const HEADER_H = 45;
/** Footer zoom-toolbar height (py-1.5 + controls + border). */
const FOOTER_H = 38;

const MAX_ZOOM = 4; // 400%

interface Dims { w: number; h: number }

interface ViewerBox {
  /** Dialog outer size. */
  w: number;
  h: number;
  /** The uniform scale the dialog was sized for — the initial "fit" zoom. */
  fit: number;
}

/** Dialog size for an image: fit within 90% of the viewport, oversample small
 *  images toward the minimum box, preserve aspect ratio throughout. */
function computeViewerBox(imgW: number, imgH: number): ViewerBox {
  const maxW = Math.floor(window.innerWidth * 0.9);
  const maxH = Math.floor(window.innerHeight * 0.9);
  // Orientation-aware minimum: portrait images get the tall variant.
  const portrait = imgH > imgW;
  const minW = Math.min(portrait ? 600 : 800, maxW);
  const minH = Math.min(portrait ? 800 : 600, maxH);

  const chromeH = HEADER_H + FOOTER_H;
  // Uniform scale: shrink big images to the 90% cap; grow small ones until
  // they fill the minimum box (contain — never past the cap).
  const fitMax = Math.min(maxW / imgW, (maxH - chromeH) / imgH);
  let scale = 1;
  if (fitMax < 1) {
    scale = fitMax;
  } else {
    const fitMin = Math.min(minW / imgW, (minH - chromeH) / imgH);
    if (fitMin > 1) scale = Math.min(fitMin, fitMax);
  }

  return {
    w: Math.round(Math.min(maxW, Math.max(minW, imgW * scale))),
    h: Math.round(Math.min(maxH, Math.max(minH, imgH * scale + chromeH))),
    fit: scale,
  };
}

interface ImageViewerDialogProps {
  /** Resolvable sources of the clicked bubble's images (data URLs or
   *  /api/images/... URLs). Null/empty = closed. A fresh array per open. */
  images: string[] | null;
  /** Which of `images` was clicked. */
  initialIndex?: number;
  onClose: () => void;
}

export default function ImageViewerDialog({ images, initialIndex = 0, onClose }: ImageViewerDialogProps) {
  /** Dialog geometry, computed once per open from the FIRST viewed image. */
  const [box, setBox] = useState<ViewerBox | null>(null);
  /** Natural dimensions of the CURRENTLY shown image (0×0 = broken source). */
  const [imgDims, setImgDims] = useState<Dims | null>(null);
  const [index, setIndex] = useState(0);
  /** Current zoom as a scale factor (1 = 100% / natural size). */
  const [zoom, setZoom] = useState(1);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dimsCache = useRef(new Map<string, Dims>());
  /** Monotonic nav token — a stale preload must not clobber a newer one. */
  const navSeq = useRef(0);
  const indexRef = useRef(0);
  indexRef.current = index;

  const count = images?.length ?? 0;

  const preload = (url: string): Promise<Dims> => {
    const cached = dimsCache.current.get(url);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const probe = new window.Image();
      probe.onload = () => {
        const d = { w: probe.naturalWidth || 1, h: probe.naturalHeight || 1 };
        dimsCache.current.set(url, d);
        resolve(d);
      };
      // Broken source: open at the minimum size and let the <img> error show.
      probe.onerror = () => resolve({ w: 0, h: 0 });
      probe.src = url;
    });
  };

  // Open: preload the clicked image, size the dialog for it (see header).
  useEffect(() => {
    setBox(null);
    setImgDims(null);
    if (!images || images.length === 0) return;
    const start = Math.min(Math.max(0, initialIndex), images.length - 1);
    setIndex(start);
    const seq = ++navSeq.current;
    preload(images[start]).then(d => {
      if (seq !== navSeq.current) return;
      const b = d.w ? computeViewerBox(d.w, d.h) : { w: 800, h: 600, fit: 1 };
      setBox(b);
      setImgDims(d);
      setZoom(b.fit);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  /** Fit `d` against the CURRENT body size (the user may have resized the
   *  dialog since open, so the box's stored fit can be stale). */
  const fitZoomFor = (d: Dims): number => {
    const el = bodyRef.current;
    if (el && d.w > 0) return Math.min(el.clientWidth / d.w, el.clientHeight / d.h);
    return box?.fit ?? 1;
  };

  /** Carousel step with wrap-around; the dialog box stays put, the new image
   *  re-fits its zoom to the current window. */
  const goTo = (i: number) => {
    if (!images || images.length < 2) return;
    const next = ((i % images.length) + images.length) % images.length;
    setIndex(next);
    const seq = ++navSeq.current;
    preload(images[next]).then(d => {
      if (seq !== navSeq.current) return;
      setImgDims(d);
      setZoom(fitZoomFor(d));
    });
  };

  // ←/→ navigate while open (Escape stays disabled by the common Dialog).
  useEffect(() => {
    if (!images || images.length < 2 || !box) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(indexRef.current - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(indexRef.current + 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, box]);

  const open = !!images && count > 0 && !!box;
  const src = open ? images![index] : null;
  const imgW = imgDims?.w ?? 0;

  const zoomToFit = () => { if (imgDims) setZoom(fitZoomFor(imgDims)); };

  const zoomPct = Math.round(zoom * 100);
  // Huge images can fit below the slider's 10% floor — extend it so Fit stays
  // reachable on the slider.
  const sliderMin = Math.min(10, box ? Math.max(1, Math.floor(box.fit * 100)) : 10);

  const counter = count > 1 ? ` (${index + 1}/${count})` : '';
  const navBtn = 'absolute top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-black/50 ' +
    'text-white/80 hover:bg-black/70 hover:text-white transition-colors';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={imgW ? `Image${counter} — ${imgW}×${imgDims!.h}` : `Image${counter}`}
      defaultWidth={box?.w ?? 800}
      defaultHeight={box?.h ?? 600}
      minWidth={420}
      minHeight={280}
      maximizable
      noPadding
    >
      {open && (
        <>
          {/* relative wrapper so the chevrons overlay the scrollable body */}
          <div className="flex-1 min-h-0 relative">
            <div
              ref={bodyRef}
              className="absolute inset-0 overflow-auto bg-black/30"
              data-testid="image-viewer-body"
            >
              {/* min-w/h-full + w/h-max: centers the image while it's smaller
                  than the view, becomes the scroll extent once zoomed past it. */}
              <div className="min-w-full min-h-full w-max h-max flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src!}
                  alt="attachment (full size)"
                  style={imgW ? { width: imgW * zoom, maxWidth: 'none' } : undefined}
                  className={zoom < 1 ? 'cursor-zoom-in' : 'cursor-zoom-out'}
                  // Toggle fit ↔ 1:1 with a click, matching the cursor hint.
                  onClick={() => (zoom < 1 ? setZoom(1) : zoomToFit())}
                  draggable={false}
                />
              </div>
            </div>
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => goTo(index - 1)}
                  className={`${navBtn} left-2`}
                  title="Previous image (←)"
                  data-testid="image-viewer-prev"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => goTo(index + 1)}
                  className={`${navBtn} right-2`}
                  title="Next image (→)"
                  data-testid="image-viewer-next"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>

          {/* Zoom toolbar — download on the far left; slider, readout, and the
              fit icon right-aligned. */}
          <div
            className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-t border-border bg-card"
            data-testid="image-viewer-toolbar"
          >
            {/* download works for both data: URLs (where target=_blank is
                blocked by browsers) and /api/images URLs. */}
            <a
              href={src!}
              download="image"
              className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              title="Download image"
              data-testid="image-viewer-download"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
            <div className="flex-1" />
            <input
              type="range"
              min={sliderMin}
              max={MAX_ZOOM * 100}
              step={1}
              value={Math.min(MAX_ZOOM * 100, Math.max(sliderMin, zoomPct))}
              onChange={(e) => setZoom(Number(e.target.value) / 100)}
              className="w-48 accent-blue-500 cursor-pointer"
              aria-label="Zoom"
              data-testid="image-viewer-slider"
            />
            <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
              {zoomPct}%
            </span>
            <button
              type="button"
              onClick={zoomToFit}
              className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              title="Scale to fit the window"
              data-testid="image-viewer-fit"
            >
              <Scan className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
