'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@/lib/types';

const HISTORY_PAGE_SIZE = 25;

export type ProviderStaleReason = 'activate' | 'switched' | 'reconnect';

interface SessionHistoryOptions {
  /** Sessions that just LEFT the live set — a turn finished (incl. background
   *  work draining). Only from a live SSE event, never from a baseline fetch
   *  (mount, reconnect catch-up): sessions that finished unseen are old news. */
  onTurnsFinished?: (sessionIds: string[]) => void;
  /** Provider status may have changed: the tab was shown ('activate'), a switch
   *  event arrived ('switched'), or the stream reconnected ('reconnect'). */
  onProviderStale?: (reason: ProviderStaleReason) => void;
}

/**
 * The session list (paged by server cursor) and which sessions are live, kept
 * current by the global `/api/events` stream while the tab is active.
 */
export function useSessionHistory(isActive: boolean, options: SessionHistoryOptions) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const historyLengthRef = useRef(0);
  /** Server-issued cursor for the last history entry we hold (see fetchHistory). */
  const historyCursorRef = useRef<string | null>(null);
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set());
  /** Live-session ids as of the LAST global SSE event / baseline fetch; a turn
   *  finished = an id leaving this set. */
  const prevLiveIdsRef = useRef<Set<string>>(new Set());

  // The SSE effect binds once per activation; read the caller's latest callbacks.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // A non-append refresh (the default) is fired on `history-updated` SSE, SSE
  // reconnect, mount, and after deletes — events that arrive often while
  // chatting. To avoid collapsing previously-loaded pages back to the first 25,
  // ask the API for at least as many entries as we already display.
  // Stable: reads only refs and setters.
  const fetchHistory = useCallback(async (opts?: { append?: boolean }) => {
    const append = opts?.append === true;

    // Append pages by CURSOR, never by offset. The list mutates under us while
    // scrolling (a new session is prepended on submit, an archive removes one),
    // and a positional offset silently skips or repeats entries across that
    // seam. The cursor names the last entry we hold, so the server resumes
    // exactly after it regardless of what moved.
    if (append && !historyCursorRef.current) return;

    // A refresh re-requests everything currently on screen so a deep scroll
    // position survives it. The server applies no upper bound, so this can't
    // come back short and truncate the list.
    const limit = append
      ? HISTORY_PAGE_SIZE
      : Math.max(HISTORY_PAGE_SIZE, historyLengthRef.current);
    const qs = append
      ? `limit=${limit}&cursor=${encodeURIComponent(historyCursorRef.current!)}`
      : `limit=${limit}`;

    if (append) setIsLoadingMoreHistory(true); else setIsLoadingHistory(true);
    try {
      const res = await fetch(`/api/history?${qs}`);
      if (res.ok) {
        const data = await res.json();
        const incoming: HistoryEntry[] = data.entries || [];
        if (append) {
          setHistory(prev => {
            // Dedup is a belt-and-braces guard only; the cursor should already
            // guarantee no overlap. It must NOT drive the next cursor, which
            // comes from the server's own last-returned entry.
            const seen = new Set(prev.map(e => e.sessionId).filter(Boolean) as string[]);
            const merged = [...prev];
            for (const e of incoming) {
              if (e.sessionId && seen.has(e.sessionId)) continue;
              merged.push(e);
            }
            historyLengthRef.current = merged.length;
            return merged;
          });
        } else {
          setHistory(incoming);
          historyLengthRef.current = incoming.length;
        }
        // Track the server's cursor for the last entry it returned. On a
        // refresh this re-anchors to the end of the refreshed window.
        if (data.nextCursor) historyCursorRef.current = data.nextCursor;
        else if (!append) historyCursorRef.current = null;
        setHistoryHasMore(!!data.hasMore);
      }
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      if (append) setIsLoadingMoreHistory(false); else setIsLoadingHistory(false);
    }
  }, []);

  const loadMoreHistory = useCallback(() => {
    fetchHistory({ append: true });
  }, [fetchHistory]);

  // Fetch history on mount
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Keep ref in sync with history length so a refresh keeps the loaded depth
  // even when entries are added/removed outside of fetchHistory (e.g. prepend
  // on submit, archive).
  useEffect(() => {
    historyLengthRef.current = history.length;
  }, [history.length]);

  // Global SSE for live-sessions / history / provider events. Connects when the
  // tab becomes active, disconnects when hidden to save resources; re-fetches on
  // (re)connect to cover the gap.
  useEffect(() => {
    if (!isActive) return;

    const baselineLiveSessions = () => {
      fetch('/api/live-sessions').then(res => res.json()).then(data => {
        const ids = new Set<string>(data.liveSessionIds || []);
        prevLiveIdsRef.current = ids; // baseline — never a "finished" signal
        setLiveSessionIds(ids);
      }).catch(() => {});
    };

    // Fetch initial / catch-up data
    baselineLiveSessions();
    fetchHistory();
    optionsRef.current.onProviderStale?.('activate');

    const es = new EventSource('/api/events');

    es.addEventListener('live-sessions', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const ids = new Set<string>(data.liveSessionIds || []);
      const finished = [...prevLiveIdsRef.current].filter(id => !ids.has(id));
      if (finished.length > 0) optionsRef.current.onTurnsFinished?.(finished);
      prevLiveIdsRef.current = ids;
      setLiveSessionIds(ids);
    });

    es.addEventListener('history-updated', () => {
      fetchHistory();
    });

    es.addEventListener('provider-switched', () => {
      optionsRef.current.onProviderStale?.('switched');
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CONNECTING) {
        // Re-fetch state to cover any events we missed while the SSE connection
        // was dropped (e.g. provider switch-back fired during a server restart).
        baselineLiveSessions();
        fetchHistory();
        optionsRef.current.onProviderStale?.('reconnect');
      }
    };

    return () => es.close();
  }, [isActive, fetchHistory]);

  return {
    history,
    /** Direct updates: optimistic add on send, label edits. */
    setHistory,
    isLoadingHistory,
    historyHasMore,
    isLoadingMoreHistory,
    fetchHistory,
    loadMoreHistory,
    liveSessionIds,
    /** Optimistic add on send / removal on a rolled-back send. */
    setLiveSessionIds,
  };
}
