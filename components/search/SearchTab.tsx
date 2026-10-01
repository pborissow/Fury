'use client';

/**
 * Search tab (docs/plan-search-tab.md §4, §6) — find sessions & messages
 * across the SQLite transcript archive, including sessions that no longer
 * exist on disk (archived = DB-only; searching them is the archive's payoff).
 *
 * A single centered column: type → debounced /api/search → session cards with
 * highlighted snippets → click through into the Chat tab, scrolled to the
 * matching turn. No preview pane — Chat already renders transcripts perfectly.
 *
 * Keyboard: "/" focuses the box, Esc clears it, ↑/↓ move a selection ring
 * across sessions & hits, Enter opens the selection.
 *
 * Pieces (components/search/): SearchHero (landing bubbles), SearchFilters
 * (role/archived/project/sort rail), ResultCard (one session's hits),
 * Snippet (highlight-marker renderer), types (shared shapes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useIsCoarsePointer } from '@/lib/useIsMobile';
import SearchHero from './SearchHero';
import SearchFilters from './SearchFilters';
import ResultCard from './ResultCard';
import { COLLAPSED_HITS, type Corpus, type SearchHit, type SearchPrefs, type SearchSessionResult } from './types';

export type { SearchPrefs } from './types';

interface SearchTabProps {
  isActive: boolean;
  /** Deep link into the Chat tab; turnIndex scrolls to the matching bubble. */
  onOpenSession: (sessionId: string, project: string, display: string, turnIndex?: number) => void;
  initialPrefs?: Partial<SearchPrefs>;
  onPrefsChange?: (prefs: SearchPrefs) => void;
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

  // Touch as primary input: skip autoFocus (it pops the software keyboard
  // over half the viewport the moment the tab opens).
  const isCoarsePointer = useIsCoarsePointer();

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
   *  not targets — the hit rows are the click-through. A title-only match (no
   *  message hits) contributes a single hit-less "Open session" row so it
   *  stays reachable by click and keyboard. */
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
      <div className="max-w-[800px] mx-auto px-6 py-8 max-md:px-4 max-md:py-5">
        {/* Hero for the initial (no query) state. No heading — the input's
            placeholder already says "Search sessions and messages", so a
            title would just repeat it.
            Stays MOUNTED and transitions out when a query starts: fade +
            drift up + height collapse (grid-rows 1fr→0fr animates the fluid
            height), so the search box glides up instead of jumping.
            Clearing the query reverses it.
            PHONE LANDSCAPE (max-height:500px — the same clause MOBILE_QUERY
            uses): the hero alone would fill the whole viewport and push the
            input below the fold, so it's hidden; the input IS the landing.
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
          className={`grid transition-[grid-template-rows,opacity,transform] duration-500 ease-out [@media(max-height:500px)]:hidden ${
            hasQuery
              ? 'grid-rows-[0fr] opacity-0 -translate-y-8'
              : 'grid-rows-[1fr] opacity-100 translate-y-0'
          }`}
        >
          <div className="overflow-hidden min-h-0">
            <div className="text-center mt-12 max-md:mt-6 mb-2">
              <SearchHero />
            </div>
          </div>
        </div>

        {/* Search box. max-md:text-base = 16px — anything smaller makes iOS
            Safari auto-zoom the page on focus. The "/" kbd hint is a hardware-
            keyboard affordance: hidden for touch. */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search sessions and messages…"
            autoFocus={!isCoarsePointer}
            data-testid="search-input"
            className="w-full pl-9 pr-9 py-2.5 rounded-lg bg-muted border border-border focus:border-ring focus:outline-none text-sm max-md:text-base"
          />
          {!hasQuery && (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-border bg-background text-[10px] leading-none text-muted-foreground font-mono pointer-events-none pointer-coarse:hidden">
              /
            </kbd>
          )}
          {hasQuery && (
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 pointer-coarse:p-2 pointer-coarse:right-1 text-muted-foreground hover:text-foreground"
              title="Clear (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filters — only once there's a query: filters are meaningless with
            nothing to filter, and the initial screen stays clean. */}
        {hasQuery && (
          <SearchFilters
            role={role}
            onRoleChange={setRole}
            includeArchived={includeArchived}
            onToggleArchived={() => setIncludeArchived(v => !v)}
            project={project}
            onProjectChange={setProject}
            projects={corpus?.projects ?? []}
            sort={sort}
            onSortChange={setSort}
          />
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
          {hasQuery && ordered.map(s => (
            <ResultCard
              key={s.sessionId}
              session={s}
              isLive={liveIds.has(s.sessionId)}
              isExpanded={expanded.has(s.sessionId)}
              selection={selection}
              navIndexOf={(hit?: SearchHit) => (
                hit
                  ? navItems.findIndex(it => it.hit === hit)
                  : navItems.findIndex(it => it.session === s && !it.hit)
              )}
              onOpen={(hit?: SearchHit) => openItem({ session: s, hit })}
              onExpand={() => setExpanded(prev => new Set(prev).add(s.sessionId))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
