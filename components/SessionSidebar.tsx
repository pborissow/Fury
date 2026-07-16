'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { AlertTriangle, ShieldAlert, Pencil, Trash2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import HistoryTimestamp from '@/components/HistoryTimestamp';
import type { HistoryEntry, PendingSession } from '@/lib/types';
import SmartPath from '@/components/SmartPath';
import FreshnessLeaf from '@/components/FreshnessLeaf';
import AnimatedTokenCount, { formatContext } from '@/components/AnimatedTokenCount';

interface SessionSidebarProps {
  pendingNewSessions: PendingSession[];
  history: HistoryEntry[];
  liveSessionIds: Set<string>;
  /** Per-session epoch-ms of the last turn completion, used to anchor the
   *  prompt-cache freshness leaf. Falls back to the entry timestamp. */
  sessionActivity: Record<string, number>;
  /** Per-session live context occupancy + window, overlaying the archived
   *  metadata so the reading tracks as Claude streams. An absolute level, not
   *  an increment. Keyed by sessionId; absent when no turn is in flight.
   *  `window` is 0 until the turn's result reports it. */
  liveContext: Record<string, { tokens: number; window: number }>;
  viewingTranscriptId: string | null;
  transcriptLoading: boolean;
  isLoadingHistory: boolean;
  historyHasMore: boolean;
  isLoadingMoreHistory: boolean;
  onLoadMoreHistory: () => void;
  onSelectSession: (sessionId: string, project: string, display: string) => void;
  onRestorePending: (pending: PendingSession) => void;
  onLabelEdit: (sessionId: string, currentLabel: string) => void;
  onDeleteConfirm: (entry: { sessionId: string; project: string; display: string; isLive: boolean }) => void;
  onContextMenu: (e: React.MouseEvent, entry: HistoryEntry & { isLive: boolean }) => void;
}

export default function SessionSidebar({
  pendingNewSessions,
  history,
  liveSessionIds,
  sessionActivity,
  liveContext,
  viewingTranscriptId,
  transcriptLoading,
  isLoadingHistory,
  historyHasMore,
  isLoadingMoreHistory,
  onLoadMoreHistory,
  onSelectSession,
  onRestorePending,
  onLabelEdit,
  onDeleteConfirm,
  onContextMenu,
}: SessionSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-fetch the next page while the list doesn't fill the viewport.
  // Runs after layout so we can measure scrollHeight vs clientHeight.
  useLayoutEffect(() => {
    if (!historyHasMore || isLoadingHistory || isLoadingMoreHistory) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 16) {
      onLoadMoreHistory();
    }
  }, [history.length, historyHasMore, isLoadingHistory, isLoadingMoreHistory, onLoadMoreHistory]);

  // Infinite scroll: load more when user scrolls near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!historyHasMore || isLoadingMoreHistory) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        onLoadMoreHistory();
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [historyHasMore, isLoadingMoreHistory, onLoadMoreHistory]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
      <TooltipProvider>
      {/* Pending new sessions (not yet submitted) */}
      {pendingNewSessions.map((pending) => {
        const isViewing = viewingTranscriptId === pending.sessionId;
        return (
          <div
            key={`pending-${pending.sessionId}`}
            className={`mb-2 p-3 rounded border cursor-pointer transition-colors ${
              isViewing
                ? 'bg-primary/10 border-primary'
                : 'bg-muted border-dashed border-border hover:border-ring'
            }`}
            onClick={() => !isViewing && onRestorePending(pending)}
          >
            <div className="flex justify-between items-start mb-1">
              <span className="text-sm font-medium text-foreground">New Session</span>
              {isViewing && transcriptLoading && (
                <div className="flex items-center gap-0.5 ml-1">
                  <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                  <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                  <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                </div>
              )}
            </div>
            <SmartPath
              path={pending.project}
              className="mt-1 text-xs text-muted-foreground font-mono"
            />
          </div>
        );
      })}

      {/* History Entries */}
      {(() => {
        return history.map((entry, index) => {
          const isLive = !!entry.sessionId && liveSessionIds.has(entry.sessionId);
          const numCompactions = (entry.metadata?.numCompactions as number) || 0;
          // How much of the model's context window this conversation currently
          // occupies. NOT the old cumulative token count: summing usage across a
          // session re-counts the carried context once per API call, which read
          // ~150x larger than the conversation actually is (a 600k-context
          // session showed "89.6M tokens"). This is the latest call's prompt
          // size — the number "how big is this conversation" actually means.
          //
          // Live overlay wins outright when present: it's the same measurement
          // taken more recently, not an increment to reconcile.
          const live = entry.sessionId ? liveContext[entry.sessionId] : undefined;
          const contextTokens = live?.tokens ?? ((entry.metadata?.contextTokens ?? 0) as number);
          // The window is unknowable for sessions archived before it was
          // captured (the JSONL records the model id without the [1m] marker),
          // and the backfill only recovers it where a call provably exceeded
          // 200k. 0 => render the size but no fill % — never guess a denominator.
          const contextWindow = (live?.window || (entry.metadata?.contextWindow ?? 0)) as number;
          const fill = contextWindow > 0 ? contextTokens / contextWindow : 0;
          // Breakpoint from 173 real sessions: median fill is 28% and only 13%
          // ever exceed 70%, so this stays quiet by default and fires on genuine
          // outliers. (Decay and raw size were both tried and rejected — each
          // flagged >60% of sessions.)
          const contextHigh = fill >= 0.7;
          const isClickable = !!entry.sessionId && !!entry.project;
          const isViewing = viewingTranscriptId === entry.sessionId;
          return (
            <div
              key={`history-${index}`}
              className={`group/session relative mb-2 p-3 rounded border transition-colors ${
                isViewing
                  ? 'bg-primary/10 border-primary'
                  : isLive
                  ? 'border-green-600/50 hover:border-green-500'
                  : 'bg-muted border-border hover:border-ring'
              } ${isClickable ? 'cursor-pointer' : ''}`}
              onClick={isClickable ? () => onSelectSession(entry.sessionId!, entry.project, entry.display) : undefined}
              onContextMenu={entry.sessionId ? (e) => {
                e.preventDefault();
                onContextMenu(e, { ...entry, isLive });
              } : undefined}
            >
              {entry.sessionId && !isLive && (
                <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/session:opacity-100 transition-opacity flex items-center gap-0.5 z-10">
                  <button
                    className="cursor-pointer p-1 rounded hover:bg-yellow-500/20 text-muted-foreground hover:text-yellow-500"
                    title="Edit label"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLabelEdit(entry.sessionId!, entry.metadata?.label || '');
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="cursor-pointer p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConfirm({
                        sessionId: entry.sessionId!,
                        project: entry.project,
                        display: entry.display,
                        isLive,
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <div className="flex justify-between items-start mb-1">
                <div className="flex items-center gap-1.5">
                  <HistoryTimestamp timestamp={entry.timestamp} />
                  {entry.sessionId && (
                    <FreshnessLeaf
                      lastActiveAt={sessionActivity[entry.sessionId] ?? entry.timestamp}
                      live={isLive}
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {isViewing && transcriptLoading && (
                    <div className="flex items-center gap-0.5">
                      <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                      <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                      <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                    </div>
                  )}
                  {isLive && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-green-400 bg-green-950/60 border border-green-700/50 rounded px-1.5 py-0.5">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400"></span>
                      </span>
                      Live
                    </span>
                  )}
                </div>
              </div>
              {entry.metadata?.label ? (
                <div className="text-sm text-foreground break-words line-clamp-2">{entry.metadata.label}</div>
              ) : (
                <div className="text-sm text-foreground break-words line-clamp-2">
                  {entry.display}
                </div>
              )}
              {entry.messageCount != null && (
                <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                  <span>
                    {entry.messageCount} message{entry.messageCount !== 1 ? 's' : ''}
                    {contextTokens > 0 && (
                      <>
                        {', '}
                        <AnimatedTokenCount value={contextTokens} format={formatContext} />
                        {contextWindow > 0 && (
                          <span className={contextHigh ? 'text-yellow-500' : undefined}>
                            {' '}({Math.round(fill * 100)}%)
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  {/* Two distinct failure modes, not two severities of one.
                      Orange (compacted): detail was summarised away — a fidelity
                      loss a restart avoids. Compaction already fixed the *cost*,
                      so it isn't a "too expensive" warning; measured across 173
                      sessions, compacted ones are 4x longer yet carry less
                      context per unit of work than uncompacted ones.
                      Yellow (>=70% full): approaching the wall — act now. */}
                  {/* Rendered independently, not as a ternary chain: these are
                      orthogonal failure modes and a session can be in both at
                      once (already compacted AND back near the wall) — the worst
                      state, where chaining would show only the shield and
                      silently drop the "act now" signal. */}
                  {numCompactions > 0 && (
                    <span
                      title={
                        `Context was auto-summarised ${numCompactions} time${numCompactions !== 1 ? 's' : ''} — ` +
                        `earlier detail may be lost. Start a new session if you need it.`
                      }
                    >
                      <ShieldAlert className="h-3 w-3 text-orange-500" />
                    </span>
                  )}
                  {contextHigh && (
                    <span
                      title={
                        `Context ${Math.round(fill * 100)}% full — start a new session to avoid ` +
                        `losing detail when it is auto-summarised.`
                      }
                    >
                      <AlertTriangle className="h-3 w-3 text-yellow-500" />
                    </span>
                  )}
                </div>
              )}
              <SmartPath
                path={entry.project}
                className="mt-1 text-xs text-muted-foreground font-mono"
              />
            </div>
          );
        });
      })()}

      {history.length === 0 && !isLoadingHistory && (
        <div className="text-center text-muted-foreground mt-8 text-sm">
          No sessions found
        </div>
      )}

      {historyHasMore && history.length > 0 && (
        <button
          type="button"
          onClick={onLoadMoreHistory}
          disabled={isLoadingMoreHistory}
          className="w-full mt-2 py-2 text-xs text-muted-foreground hover:text-foreground border border-border rounded hover:border-ring transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isLoadingMoreHistory ? 'Loading…' : 'Load more'}
        </button>
      )}
      </TooltipProvider>
    </div>
  );
}
