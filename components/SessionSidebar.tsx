'use client';

import { AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import HistoryTimestamp from '@/components/HistoryTimestamp';
import type { HistoryEntry, PendingSession } from '@/lib/types';

interface SessionSidebarProps {
  pendingNewSessions: PendingSession[];
  history: HistoryEntry[];
  liveSessionIds: Set<string>;
  viewingTranscriptId: string | null;
  transcriptLoading: boolean;
  isLoadingHistory: boolean;
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
  viewingTranscriptId,
  transcriptLoading,
  isLoadingHistory,
  onSelectSession,
  onRestorePending,
  onLabelEdit,
  onDeleteConfirm,
  onContextMenu,
}: SessionSidebarProps) {
  return (
    <div className="flex-1 overflow-y-auto p-2">
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
            <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={pending.project}>
              {pending.project}
            </div>
          </div>
        );
      })}

      {/* History Entries */}
      {(() => {
        return history.map((entry, index) => {
          const isLive = !!entry.sessionId && liveSessionIds.has(entry.sessionId);
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
                <HistoryTimestamp timestamp={entry.timestamp} />
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
                  </span>
                  {entry.messageCount >= 50 && (
                    <AlertTriangle className="h-3 w-3 text-yellow-500" />
                  )}
                </div>
              )}
              <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={entry.project}>
                {entry.project}
              </div>
            </div>
          );
        });
      })()}

      {history.length === 0 && !isLoadingHistory && (
        <div className="text-center text-muted-foreground mt-8 text-sm">
          No sessions found
        </div>
      )}
      </TooltipProvider>
    </div>
  );
}
