'use client';

/** One chat bubble as a SINGLE continuous path — rounded rect + tail drawn in
 *  one outline, so the stroke never crosses the seam where the tail meets the
 *  body (separate rect+triangle showed a dividing line through the glass).
 *  `tail.from` = distance from the left edge to the tail base; the tip lands
 *  at (base + dx, bottom + dy), so negative dx points down-left. */
function bubblePath(
  x: number, y: number, w: number, h: number, r: number,
  tail: { from: number; width: number; dx: number; dy: number },
) {
  const bl = x + tail.from;
  const br = bl + tail.width;
  const bottom = y + h;
  return [
    `M ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${bottom - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${bottom}`,
    `H ${br}`,
    `L ${bl + tail.dx} ${bottom + tail.dy}`,
    `L ${bl} ${bottom}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${bottom - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/** Landing hero — frosted-glass 3D chat bubbles (you're searching
 *  conversations). Blue glass = your messages, gray glass = Claude's (the
 *  chat panel's own palette), and ONE amber bubble stands out among them —
 *  the match you're searching for, in the same amber as the result
 *  highlights. gradientUnits="userSpaceOnUse" makes every panel sample one
 *  shared vertical gradient, so overlapping glass stacks read as consistent
 *  depth on both dark and light backgrounds.
 *  Motion (sh-roam/sh-mid/sh-bokeh classes) lives in globals.css. */
export default function SearchHero() {
  const glass = 'url(#sh-glass)';
  const gray = 'url(#sh-gray)';
  const edge = { stroke: '#ffffff', strokeOpacity: 0.35, strokeWidth: 1 };
  return (
    // Wide scene so far-layer bubbles have room to roam (bokeh style: the
    // crisp cluster is "in focus", blurred bubbles wander at other depths).
    <svg
      viewBox="0 0 800 260"
      aria-hidden="true"
      className="w-full max-w-[680px] mx-auto mb-2"
    >
      <defs>
        <linearGradient id="sh-glass" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="180">
          <stop offset="0" stopColor="#93c5fd" stopOpacity="0.55" />
          <stop offset="1" stopColor="#3b82f6" stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id="sh-gray" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="180">
          <stop offset="0" stopColor="#d4d4d4" stopOpacity="0.5" />
          <stop offset="1" stopColor="#737373" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="sh-amber" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="58">
          <stop offset="0" stopColor="#fcd34d" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
        <filter id="sh-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1e3a8a" floodOpacity="0.3" />
        </filter>
      </defs>

      {/* Far bokeh layer — out-of-focus bubbles wandering at other depths.
          Blur/opacity/roam+breathe all come from the sh-bokeh-* classes; no
          drop shadow (out-of-focus things don't cast crisp shadows). */}
      <g className="sh-bokeh-1"><path d={bubblePath(70, 48, 64, 38, 12, { from: 14, width: 12, dx: -6, dy: 11 })} fill={glass} {...edge} /></g>
      <g className="sh-bokeh-2"><path d={bubblePath(655, 150, 74, 44, 13, { from: 46, width: 12, dx: 7, dy: 12 })} fill={gray} {...edge} /></g>
      <g className="sh-bokeh-3"><path d={bubblePath(420, 14, 52, 32, 10, { from: 12, width: 10, dx: -5, dy: 10 })} fill={glass} {...edge} /></g>
      <g className="sh-bokeh-4"><path d={bubblePath(115, 185, 58, 36, 11, { from: 36, width: 10, dx: 6, dy: 10 })} fill={gray} {...edge} /></g>
      <g className="sh-bokeh-5"><path d={bubblePath(645, 28, 60, 36, 11, { from: 40, width: 11, dx: 6, dy: 11 })} fill={glass} {...edge} /></g>

      {/* Mid depth layer — lightly blurred, bridging the far bokeh and the
          in-focus cluster so the depth-of-field reads as continuous. Keeps
          its drop shadow (still near enough to cast one). */}
      <g className="sh-mid-1" filter="url(#sh-shadow)"><path d={bubblePath(168, 118, 70, 42, 13, { from: 16, width: 12, dx: -6, dy: 12 })} fill={gray} {...edge} /></g>
      <g className="sh-mid-2" filter="url(#sh-shadow)"><path d={bubblePath(582, 62, 76, 46, 14, { from: 48, width: 12, dx: 7, dy: 12 })} fill={glass} {...edge} /></g>
      <g className="sh-mid-3" filter="url(#sh-shadow)"><path d={bubblePath(352, 206, 64, 38, 12, { from: 14, width: 11, dx: -6, dy: 11 })} fill={glass} {...edge} /></g>

      {/* In-focus cluster, centered in the scene. sh-roam-* = slow travel
          (see globals.css); each bubble wanders independently so the glass
          overlaps shift over time. */}
      <g transform="translate(230, 34)">
        {/* back layer — Claude (gray) top-left, you (blue) right */}
        <g filter="url(#sh-shadow)">
          <path className="sh-roam-1" d={bubblePath(52, 18, 80, 46, 14, { from: 18, width: 15, dx: -7, dy: 14 })} fill={gray} {...edge} />
          <path className="sh-roam-2" d={bubblePath(240, 52, 84, 58, 16, { from: 16, width: 16, dx: -8, dy: 15 })} fill={glass} {...edge} />
        </g>

        {/* mid layer — you (blue) left, Claude (gray) bottom-center */}
        <g filter="url(#sh-shadow)">
          <path className="sh-roam-3" d={bubblePath(16, 62, 94, 62, 16, { from: 22, width: 17, dx: -9, dy: 16 })} fill={glass} {...edge} />
          <path className="sh-roam-4" d={bubblePath(76, 112, 98, 50, 16, { from: 66, width: 15, dx: 9, dy: 15 })} fill={gray} {...edge} />
        </g>

        {/* main glass panel */}
        <g filter="url(#sh-shadow)">
          <path className="sh-roam-5" d={bubblePath(104, 44, 152, 88, 22, { from: 112, width: 17, dx: 11, dy: 17 })} fill={glass} {...edge} />
        </g>

        {/* THE match — one amber bubble standing out among the glass; it
            gets the liveliest roam (see globals.css) to draw the eye first. */}
        <g filter="url(#sh-shadow)">
          <path className="sh-roam-6" d={bubblePath(262, 10, 52, 34, 11, { from: 33, width: 11, dx: 7, dy: 12 })} fill="url(#sh-amber)" />
        </g>
      </g>
    </svg>
  );
}
