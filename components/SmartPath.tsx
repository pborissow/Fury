'use client';

import { useEffect, useRef, useState } from 'react';

interface SmartPathProps {
  path: string;
  keepSegments?: number;
  className?: string;
  title?: string;
}

function splitPath(path: string): { parts: string[]; sep: string } {
  const isWindows = /\\/.test(path) || /^[A-Za-z]:/.test(path);
  const sep = isWindows ? '\\' : '/';
  const parts = path.replace(/\\/g, '/').replace(/\/$/, '').split('/').filter(Boolean);
  return { parts, sep };
}

let _canvasCtx: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!_canvasCtx) {
    const canvas = document.createElement('canvas');
    _canvasCtx = canvas.getContext('2d');
  }
  return _canvasCtx;
}

const ELLIPSIS = '…';
// Sub-pixel rendering / font-metric quirks can make a string that canvas
// measures as "just fits" still wrap in the browser. Trim a few pixels off
// the available width to stay on the safe side.
const SAFETY_PX = 2;

export default function SmartPath({ path, keepSegments = 2, className, title }: SmartPathProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [display, setDisplay] = useState(path);

  useEffect(() => {
    const el = containerRef.current;
    const ctx = getCtx();
    if (!el || !ctx) return;

    const compute = () => {
      const available = el.clientWidth - SAFETY_PX;
      if (available <= 0) return;
      const cs = window.getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const measure = (s: string) => ctx.measureText(s).width;

      if (measure(path) <= available) {
        setDisplay(path);
        return;
      }
      const { parts, sep } = splitPath(path);
      if (parts.length <= keepSegments) {
        setDisplay(path);
        return;
      }
      const tail = parts.slice(-keepSegments).join(sep);
      const head = parts.slice(0, -keepSegments).join(sep) + sep;

      // If even (ellipsis + tail) doesn't fit, fall back to tail alone and
      // let overflow clipping handle the rest.
      if (measure(ELLIPSIS + tail) > available) {
        setDisplay(tail);
        return;
      }
      // Binary-search the longest head prefix that still fits with the tail.
      let lo = 0;
      let hi = head.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const w = measure(head.slice(0, mid) + ELLIPSIS + tail);
        if (w <= available) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      setDisplay(head.slice(0, best) + ELLIPSIS + tail);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [path, keepSegments]);

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden whitespace-nowrap${className ? ` ${className}` : ''}`}
      title={title ?? path}
    >
      {display}
    </div>
  );
}
