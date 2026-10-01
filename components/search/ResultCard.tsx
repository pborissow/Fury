'use client';

import { ChevronDown } from 'lucide-react';
import SmartPath from '@/components/SmartPath';
import HistoryTimestamp from '@/components/HistoryTimestamp';
import Snippet from './Snippet';
import { COLLAPSED_HITS, type SearchHit, type SearchSessionResult } from './types';

interface ResultCardProps {
  session: SearchSessionResult;
  isLive: boolean;
  isExpanded: boolean;
  /** Current keyboard-selection ring position (index into SearchTab's
   *  flattened navItems). */
  selection: number;
  /** Nav-ring index of one of this card's rows: a hit row, or (no arg) the
   *  title-only card's "Open session" row. -1 = not a nav target. */
  navIndexOf: (hit?: SearchHit) => number;
  /** Open in Chat — with a hit, scrolled to that turn. */
  onOpen: (hit?: SearchHit) => void;
  onExpand: () => void;
}

/** One session's result card: context header (title, badges, project path)
 *  over clickable hit rows. The header is NOT a click target — opening
 *  happens via the rows, which double as the keyboard-navigation targets. */
export default function ResultCard({
  session: s, isLive, isExpanded, selection, navIndexOf, onOpen, onExpand,
}: ResultCardProps) {
  const visibleHits = isExpanded ? s.hits : s.hits.slice(0, COLLAPSED_HITS);
  const openRowNavIndex = visibleHits.length === 0 ? navIndexOf() : -1;

  return (
    <div
      className="rounded-lg border border-border bg-card overflow-hidden"
      data-testid="search-result-card"
    >
      {/* Card header — two-tone: muted header over card-bg hit rows, so the
          session grouping reads at a glance. Desktop: the path sits INLINE
          after the title (it's usually the same for many cards, so it doesn't
          earn its own line at 800px). Phone: inline truncation turns the path
          into noise ("Use…JavaScript/Fury"), so it stacks under the title —
          two SmartPath renders, one hidden per breakpoint (the hidden one
          measures clientWidth 0 and skips its ellipsis work). */}
      <div className="px-4 py-2.5 max-md:px-3 bg-muted/60 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold truncate shrink-0 max-w-[60%] max-md:max-w-none max-md:shrink max-md:flex-1">{s.display}</span>
          {isLive && (
            <span className="shrink-0 text-[10px] text-green-700 dark:text-green-500 flex items-center gap-1 self-center">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" /> Live
            </span>
          )}
          {s.status === 'archived' && (
            <span
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground self-center"
              data-testid="archived-badge"
            >
              archived
            </span>
          )}
          <div className="flex-1 min-w-0 text-xs text-muted-foreground/80 max-md:hidden">
            <SmartPath path={s.project} className="truncate" />
          </div>
        </div>
        <div className="hidden max-md:block mt-0.5 text-xs text-muted-foreground/80 min-w-0">
          <SmartPath path={s.project} className="truncate" />
        </div>
      </div>

      {/* Hits → open scrolled to the turn. The p-1.5 gutter insets each row's
          hover rectangle from the card edges — a full-bleed hover border
          would sit flush against (and get clipped by) the card's own border +
          overflow-hidden rounding. */}
      {visibleHits.length > 0 && (
        <div className="border-t border-border p-1.5">
          {visibleHits.map((h, hi) => {
            const navIndex = navIndexOf(h);
            // messages.timestamp is an ISO string; HistoryTimestamp wants
            // epoch ms. NaN (malformed row) → omit the time.
            const hitMs = Date.parse(h.timestamp);
            return (
              <button
                key={`${h.turnIndex}-${hi}`}
                onClick={() => onOpen(h)}
                data-selected={selection === navIndex || undefined}
                data-testid="search-hit"
                // group/hit lets the snippet text brighten on row hover;
                // cursor-pointer is REQUIRED for the pointer cursor —
                // Tailwind v4 preflight no longer applies it to <button>.
                // border-transparent reserves the 1px so the row doesn't
                // shift when hover:border-ring appears (same hover border as
                // the Chat sidebar's session cards).
                className={`group/hit w-full text-left px-2.5 py-2 pointer-coarse:py-2.5 rounded-md cursor-pointer border border-transparent hover:border-ring hover:bg-accent/40 transition-colors block ${
                  selection === navIndex ? 'ring-2 ring-primary ring-inset' : ''
                }`}
                title="Open in Chat, scrolled to this turn"
              >
                {/* 2px left accent echoes the transcript palette (blue = you,
                    neutral = claude) without the cost of a chip row. */}
                <div
                  data-testid="hit-role-accent"
                  data-role={h.role}
                  className={`border-l-2 pl-3 max-md:pl-2.5 ${
                    h.role === 'user'
                      ? 'border-blue-600 dark:border-blue-500'
                      : 'border-border'
                  }`}
                >
                  <div className="text-xs mb-0.5 flex items-baseline gap-1.5">
                    <span className={`font-medium ${
                      h.role === 'user'
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-muted-foreground'
                    }`}>
                      {h.role === 'user' ? 'You' : 'Claude'}
                    </span>
                    {Number.isFinite(hitMs) && (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <HistoryTimestamp timestamp={hitMs} />
                      </>
                    )}
                    {typeof h.score === 'number' && (
                      <span
                        className="ml-auto shrink-0 tabular-nums text-muted-foreground/60"
                        title="Relevance, relative to the best match in these results"
                        data-testid="hit-score"
                      >
                        {h.score}%
                      </span>
                    )}
                  </div>
                  <Snippet text={h.snippet} />
                </div>
              </button>
            );
          })}
          {s.hitCount > COLLAPSED_HITS && !isExpanded && (
            <button
              onClick={onExpand}
              className="w-full text-left px-2.5 py-1.5 pointer-coarse:py-2.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 cursor-pointer flex items-center gap-1 transition-colors"
              data-testid="search-expand"
            >
              <ChevronDown className="h-3 w-3" />
              {s.hitCount - COLLAPSED_HITS} more match{s.hitCount - COLLAPSED_HITS === 1 ? '' : 'es'} in this session
            </button>
          )}
        </div>
      )}

      {/* Title-only match (no message hits): the header isn't a click target,
          so give the card one hit-style row to open the session — otherwise
          the result would be unreachable. */}
      {visibleHits.length === 0 && (
        <div className="border-t border-border p-1.5">
          <button
            onClick={() => onOpen()}
            data-selected={(openRowNavIndex >= 0 && selection === openRowNavIndex) || undefined}
            data-testid="search-open-session"
            className={`w-full text-left px-2.5 py-2 pointer-coarse:py-2.5 rounded-md text-xs text-muted-foreground cursor-pointer border border-transparent hover:border-ring hover:bg-accent/40 hover:text-foreground transition-colors ${
              openRowNavIndex >= 0 && selection === openRowNavIndex ? 'ring-2 ring-primary ring-inset' : ''
            }`}
            title="Open in Chat"
          >
            Open session →
          </button>
        </div>
      )}
    </div>
  );
}
