'use client';

/**
 * Search tab (docs/plan-search-tab.md §4, §6) — find sessions & messages
 * across the SQLite transcript archive, including sessions that no longer
 * exist on disk (archived = DB-only; searching them is the archive's payoff).
 *
 * A single centered column: type → debounced /api/search → session cards with
 * highlighted snippets → click through into the Chat tab (card header opens
 * the session; a snippet opens it scrolled to that turn). No preview pane —
 * Chat already renders transcripts perfectly.
 *
 * Snippets arrive with / boundary markers around matches and are
 * rendered by SPLITTING on those markers into <mark> spans — snippet text is
 * never interpreted as HTML (message content can contain markup).
 *
 * Keyboard: "/" focuses the box, Esc clears it, ↑/↓ move a selection ring
 * across sessions & hits, Enter opens the selection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, Search, X } from 'lucide-react';
import SmartPath from '@/components/SmartPath';
import HistoryTimestamp from '@/components/HistoryTimestamp';

export interface SearchPrefs {
  query: string;
  includeArchived: boolean;
  role: 'all' | 'user' | 'assistant';
  sort: 'relevance' | 'recent';
}

interface SearchHit {
  role: 'user' | 'assistant';
  turnIndex: number;
  timestamp: string;
  snippet: string;
  rank: number;
  /** Normalized relevance 1–100 (100 = best hit in the response). Absent in
   *  LIKE-fallback mode, which has no ranking signal — render nothing then. */
  score?: number;
}

interface SearchSessionResult {
  sessionId: string;
  project: string;
  display: string;
  status: string;
  messageCount: number;
  updatedAt: number;
  titleMatch: boolean;
  hits: SearchHit[];
  hitCount: number;
}

interface Corpus {
  sessions: number;
  archived: number;
  messages: number;
  projects: string[];
}

interface SearchTabProps {
  isActive: boolean;
  /** Deep link into the Chat tab; turnIndex scrolls to the matching bubble. */
  onOpenSession: (sessionId: string, project: string, display: string, turnIndex?: number) => void;
  initialPrefs?: Partial<SearchPrefs>;
  onPrefsChange?: (prefs: SearchPrefs) => void;
}

/** How many snippets a session card shows before the "+N more" expander. */
const COLLAPSED_HITS = 2;

/** Render snippet text, translating the \u0001/\u0002 boundary markers into
 *  <mark>. Everything else is plain text — NEVER dangerouslySetInnerHTML. */
function Snippet({ text }: { text: string }) {
  // Merge marks separated only by whitespace ("image" "clipboard") into ONE
  // mark so a matched phrase reads as a phrase, not as chopped-up pills.
  const merged = text.replace(/\u0002(\s+)\u0001/g, '$1');
  const nodes: React.ReactNode[] = [];
  const opens = merged.split('\u0001');
  nodes.push(opens[0]);
  for (let i = 1; i < opens.length; i++) {
    const [marked, ...rest] = opens[i].split('\u0002');
    nodes.push(
      // --highlight tokens (globals.css): amber, the one hue not already
      // spoken for in the grayscale theme (blue = user, green = live). A gray
      // "highlight" is invisible — this is THE thing the eye scans for.
      <mark key={i} className="bg-highlight text-highlight-foreground font-medium rounded-[3px] px-0.5 -mx-px">
        {marked}
      </mark>,
    );
    nodes.push(rest.join(''));
  }
  // The snippet IS the content being scanned, so it gets near-full contrast at
  // rest (metadata stays muted); it still brightens on row hover as a
  // "this is clickable" cue.
  return <span className="text-sm text-foreground/85 group-hover/hit:text-foreground transition-colors leading-relaxed">{nodes}</span>;
}

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
 *  depth on both dark and light backgrounds. */
function SearchHero() {
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
            gets the liveliest roam (38s cycle) to draw the eye first. */}
        <g filter="url(#sh-shadow)">
          <path className="sh-roam-6" d={bubblePath(262, 10, 52, 34, 11, { from: 33, width: 11, dx: 7, dy: 12 })} fill="url(#sh-amber)" />
        </g>
      </g>
    </svg>
  );
}

/** Compact segmented control — replaces native <select>s in the filter row so
 *  the controls match the app's custom chrome (native selects are OS-styled). */
function Segmented<T extends string>({ value, options, onChange, testid }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testid?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted p-0.5" data-testid={testid}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-2 py-0.5 rounded-[5px] text-xs cursor-pointer transition-colors ${
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function SearchTab({ isActive, onOpenSession, initialPrefs, onPrefsChange }: SearchTabProps) {
  const [query, setQuery] = useState(initialPrefs?.query ?? '');
  const [includeArchived, setIncludeArchived] = useState(initialPrefs?.includeArchived ?? true);
  const [role, setRole] = useState<SearchPrefs['role']>(initialPrefs?.role ?? 'all');
  const [sort, setSort] = useState<SearchPrefs['sort']>(initialPrefs?.sort ?? 'relevance');
  const [project, setProject] = useState<string>('all');

  const [results, setResults] = useState<SearchSessionResult[]>([]);
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [totalHits, setTotalHits] = useState(0);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState(-1);
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against out-of-order responses (fast typing + slow request). */
  const requestSeq = useRef(0);

  const runSearch = useCallback(async (q: string, arch: boolean, r: string, proj: string) => {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams();
    params.set('q', q);
    if (!arch) params.set('archived', '0');
    if (r !== 'all') params.set('role', r);
    if (proj !== 'all') params.set('project', proj);
    setLoading(true);
    try {
      const res = await fetch(`/api/search?${params.toString()}`);
      const data = await res.json();
      if (seq !== requestSeq.current) return; // superseded
      if (data.corpus) setCorpus(data.corpus);
      setResults(data.results || []);
      setTotalHits(data.totalHits || 0);
      setTookMs(typeof data.tookMs === 'number' ? data.tookMs : null);
      setSearched(!!q.trim());
      setExpanded(new Set());
      setSelection(-1);
    } catch {
      if (seq === requestSeq.current) { setResults([]); setSearched(!!q.trim()); }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Search-as-you-type (~200 ms debounce; queries are sub-ms server-side).
  // The same debounce persists the prefs, so typing doesn't spam POSTs.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(query, includeArchived, role, project);
      onPrefsChange?.({ query, includeArchived, role, sort });
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, includeArchived, role, project, sort]);

  // Live pills + corpus stats on activation (cheap; also covers the case where
  // sessions went live/idle while another tab was in view).
  useEffect(() => {
    if (!isActive) return;
    fetch('/api/live-sessions').then(r => r.json())
      .then(d => setLiveIds(new Set<string>(d.liveSessionIds || [])))
      .catch(() => {});
    if (!corpus) {
      fetch('/api/search?q=').then(r => r.json())
        .then(d => { if (d.corpus) setCorpus(d.corpus); })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // "/" focuses the box from anywhere in the tab; Esc (in the box) clears.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  // Display order: relevance = server order (title hits pinned, then bm25);
  // recent = last-activity. Recomputed locally so the toggle is instant.
  const ordered = useMemo(
    () => (sort === 'recent' ? [...results].sort((a, b) => b.updatedAt - a.updatedAt) : results),
    [results, sort],
  );

  /** Flattened keyboard-navigation targets: the visible hits of each session.
   *  Index into this array = the selection ring position. Session HEADERS are
   *  not targets — they no longer open the session (the hit rows are the
   *  click-through). A title-only match (no message hits) contributes a single
   *  hit-less "Open session" row so it stays reachable by click and keyboard. */
  const navItems = useMemo(() => {
    const items: { session: SearchSessionResult; hit?: SearchHit }[] = [];
    for (const s of ordered) {
      const visible = expanded.has(s.sessionId) ? s.hits : s.hits.slice(0, COLLAPSED_HITS);
      if (visible.length === 0) items.push({ session: s });
      for (const h of visible) items.push({ session: s, hit: h });
    }
    return items;
  }, [ordered, expanded]);

  const openItem = useCallback((item: { session: SearchSessionResult; hit?: SearchHit }) => {
    onOpenSession(item.session.sessionId, item.session.project, item.session.display, item.hit?.turnIndex);
  }, [onOpenSession]);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuery('');
      return;
    }
    if (e.key === 'Enter') {
      if (selection >= 0 && selection < navItems.length) {
        openItem(navItems[selection]);
      } else if (debounceRef.current) {
        // Enter = search NOW (skip the debounce tail).
        clearTimeout(debounceRef.current);
        runSearch(query, includeArchived, role, project);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelection(prev => {
        const next = e.key === 'ArrowDown'
          ? Math.min(prev + 1, navItems.length - 1)
          : Math.max(prev - 1, -1);
        // Keep the ring on screen.
        setTimeout(() => {
          listRef.current?.querySelector('[data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest' });
        }, 0);
        return next;
      });
    }
  };

  const hasQuery = !!query.trim();

  return (
    // bg-card matches the Chat tab's middle panel (#171717 dark / #fff light).
    <div className="h-full overflow-y-auto bg-card" data-testid="search-tab">
      <div className="max-w-[800px] mx-auto px-6 py-8">
        {/* Hero for the initial (no query) state. No heading — the input's
            placeholder already says "Search sessions and messages", so a
            title would just repeat it.
            Stays MOUNTED and transitions out when a query starts: fade +
            drift up + height collapse (grid-rows 1fr→0fr animates the fluid
            height), so the search box glides up instead of jumping.
            Clearing the query reverses it.
            NOTE: visibility is deliberately OUT of the transition list and
            never set here. The tab panels hide via `visibility: hidden` on
            their wrapper (page.tsx) and visibility INHERITS — if this
            element set its own visibility it would bleed through into other
            tabs, and if it merely TRANSITIONED visibility (transition-all),
            the inherited flip would animate discretely and the hero would
            ghost over the next tab for 500ms. With neither, tab switches
            hide it instantly while the query fade still animates. */}
        <div
          aria-hidden={hasQuery}
          className={`grid transition-[grid-template-rows,opacity,transform] duration-500 ease-out ${
            hasQuery
              ? 'grid-rows-[0fr] opacity-0 -translate-y-8'
              : 'grid-rows-[1fr] opacity-100 translate-y-0'
          }`}
        >
          <div className="overflow-hidden min-h-0">
            <div className="text-center mt-12 mb-2">
              <SearchHero />
            </div>
          </div>
        </div>

        {/* Search box */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search sessions and messages…"
            autoFocus
            data-testid="search-input"
            className="w-full pl-9 pr-9 py-2.5 rounded-lg bg-muted border border-border focus:border-ring focus:outline-none text-sm"
          />
          {!hasQuery && (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-border bg-background text-[10px] leading-none text-muted-foreground font-mono pointer-events-none">
              /
            </kbd>
          )}
          {hasQuery && (
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
              title="Clear (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filter row — segmented pills instead of native controls so the
            chrome matches the rest of the app (native selects are OS-styled).
            The Project filter stays a <select>: its option count is unbounded.
            Only rendered once there's a query: filters are meaningless with
            nothing to filter, and the initial screen stays clean. */}
        {hasQuery && (
        <div className="sh-fade-in flex flex-wrap items-center gap-2 mt-3 text-xs text-muted-foreground">
          <Segmented
            value={role}
            onChange={v => setRole(v)}
            testid="search-role-toggle"
            options={[
              { value: 'all' as const, label: 'All' },
              { value: 'user' as const, label: 'You' },
              { value: 'assistant' as const, label: 'Claude' },
            ]}
          />
          <button
            onClick={() => setIncludeArchived(!includeArchived)}
            aria-pressed={includeArchived}
            data-testid="search-archived-toggle"
            title={includeArchived ? 'Archived sessions included — click to exclude' : 'Archived sessions excluded — click to include'}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 cursor-pointer transition-colors ${
              includeArchived
                ? 'border-border bg-muted text-foreground'
                : 'border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Archive className="h-3 w-3" />
            Archived
          </button>
          {corpus && corpus.projects.length > 1 && (
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              aria-label="Project"
              className="bg-muted border border-border rounded-md px-2 py-1 text-xs max-w-56 truncate cursor-pointer"
            >
              <option value="all">All projects</option>
              {corpus.projects.map(p => (
                <option key={p} value={p}>{p.split(/[\\/]/).filter(Boolean).pop() || p}</option>
              ))}
            </select>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <span>Sort</span>
            <Segmented
              value={sort}
              onChange={v => setSort(v)}
              options={[
                { value: 'relevance' as const, label: 'Relevance' },
                { value: 'recent' as const, label: 'Recent' },
              ]}
            />
          </div>
        </div>
        )}

        {/* Result count line */}
        {hasQuery && searched && !loading && (
          <div className="sh-fade-in flex items-baseline justify-between mt-5 mb-3 text-xs text-muted-foreground" data-testid="search-result-count">
            <span>
              {totalHits === 0 && results.length === 0
                ? 'No matches'
                : `${totalHits} match${totalHits === 1 ? '' : 'es'} in ${results.length} session${results.length === 1 ? '' : 's'}`}
              {tookMs != null && <span className="text-muted-foreground/60"> · {tookMs < 1 ? '<1' : tookMs} ms</span>}
            </span>
          </div>
        )}

        {/* Zero-results escape hatches */}
        {hasQuery && searched && !loading && results.length === 0 && (
          <div className="text-center mt-8 text-sm text-muted-foreground" data-testid="search-zero-state">
            <p>Nothing matched.</p>
            {!includeArchived && (
              <button
                onClick={() => setIncludeArchived(true)}
                className="mt-2 text-primary hover:underline"
              >
                Search archived sessions too
              </button>
            )}
          </div>
        )}

        {/* Results */}
        <div ref={listRef} className="space-y-4 pb-10">
          {hasQuery && ordered.map(s => {
            const isLive = liveIds.has(s.sessionId);
            const isExpanded = expanded.has(s.sessionId);
            const visibleHits = isExpanded ? s.hits : s.hits.slice(0, COLLAPSED_HITS);
            /** Only meaningful for title-only cards (their single "Open
             *  session" row); -1 otherwise. */
            const openRowNavIndex = visibleHits.length === 0
              ? navItems.findIndex(it => it.session === s && !it.hit)
              : -1;
            return (
              <div
                key={s.sessionId}
                className="rounded-lg border border-border bg-card overflow-hidden"
                data-testid="search-result-card"
              >
                {/* Card header — context only (title, badges, project). NOT a
                    click target: opening happens via the hit rows below.
                    Two-tone: muted header over card-bg hit rows, so the
                    session grouping reads at a glance. The path sits inline
                    after the title — it's usually the same for many cards, so
                    it doesn't earn its own line. */}
                <div className="px-4 py-2.5 bg-muted/60 flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-semibold truncate shrink-0 max-w-[60%]">{s.display}</span>
                  {isLive && (
                    <span className="shrink-0 text-[10px] text-green-500 flex items-center gap-1 self-center">
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
                  <div className="flex-1 min-w-0 text-xs text-muted-foreground/80">
                    <SmartPath path={s.project} className="truncate" />
                  </div>
                </div>

                {/* Hits → open scrolled to the turn. The p-1.5 gutter insets
                    each row's hover rectangle from the card edges — a full-
                    bleed hover border would sit flush against (and get clipped
                    by) the card's own border + overflow-hidden rounding. */}
                {visibleHits.length > 0 && (
                  <div className="border-t border-border p-1.5">
                    {visibleHits.map((h, hi) => {
                      const navIndex = navItems.findIndex(it => it.session === s && it.hit === h);
                      // messages.timestamp is an ISO string; HistoryTimestamp
                      // wants epoch ms. NaN (malformed row) → omit the time.
                      const hitMs = Date.parse(h.timestamp);
                      return (
                        <button
                          key={`${h.turnIndex}-${hi}`}
                          onClick={() => openItem({ session: s, hit: h })}
                          data-selected={selection === navIndex || undefined}
                          data-testid="search-hit"
                          // group/hit lets the snippet text brighten on row
                          // hover; cursor-pointer is REQUIRED for the pointer
                          // cursor — Tailwind v4 preflight no longer applies it
                          // to <button> (browser default is an arrow).
                          // border-transparent reserves the 1px so the row
                          // doesn't shift when hover:border-ring appears — the
                          // same light-gray hover border the Chat sidebar's
                          // session cards use (SessionSidebar: hover:border-ring).
                          className={`group/hit w-full text-left px-2.5 py-2 rounded-md cursor-pointer border border-transparent hover:border-ring hover:bg-accent/40 transition-colors block ${
                            selection === navIndex ? 'ring-2 ring-primary ring-inset' : ''
                          }`}
                          title="Open in Chat, scrolled to this turn"
                        >
                          {/* 2px left accent echoes the transcript palette
                              (blue = you, neutral = claude) without the cost
                              of a chip row — faster who-said-what scanning. */}
                          <div
                            data-testid="hit-role-accent"
                            data-role={h.role}
                            className={`border-l-2 pl-3 ${
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
                        onClick={() => setExpanded(prev => new Set(prev).add(s.sessionId))}
                        className="w-full text-left px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 cursor-pointer flex items-center gap-1 transition-colors"
                        data-testid="search-expand"
                      >
                        <ChevronDown className="h-3 w-3" />
                        {s.hitCount - COLLAPSED_HITS} more match{s.hitCount - COLLAPSED_HITS === 1 ? '' : 'es'} in this session
                      </button>
                    )}
                  </div>
                )}

                {/* Title-only match (no message hits): the header isn't a click
                    target anymore, so give the card one hit-style row to open
                    the session — otherwise the result would be unreachable. */}
                {visibleHits.length === 0 && (
                  <div className="border-t border-border p-1.5">
                    <button
                      onClick={() => openItem({ session: s })}
                      data-selected={(openRowNavIndex >= 0 && selection === openRowNavIndex) || undefined}
                      data-testid="search-open-session"
                      className={`w-full text-left px-2.5 py-2 rounded-md text-xs text-muted-foreground cursor-pointer border border-transparent hover:border-ring hover:bg-accent/40 hover:text-foreground transition-colors ${
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
          })}
        </div>
      </div>
    </div>
  );
}
