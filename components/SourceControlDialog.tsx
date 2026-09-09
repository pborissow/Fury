'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Loader2, RefreshCw, GitBranch, Plus, Minus, Pencil, ArrowRight,
  TriangleAlert, CircleAlert, ChevronDown, ChevronRight, GitCommitHorizontal,
} from 'lucide-react';
import Dialog from '@/components/Dialog';
import { DiffView, buildDiffRows } from '@/components/DiffView';
import { VCS_STATUS_COLORS, VCS_STATUS_LABELS, type VcsFileStatus } from '@/components/FileTree';
import type { StatusPayload, VcsFileEntry } from '@/lib/vcsServer';

// GitKraken-style source-control dialog: side-by-side diff of the selected
// file on the left; unstaged/staged lists + commit message editor on the right.
//
// SVN has no staging area — the "staged" list is a client-side selection of
// files to include in `svn commit` (the server runs `svn add`/`svn delete`
// for untracked/missing selections at commit time).

const MIN_WIDTH = 700;
const MIN_HEIGHT = 450;

// Default to 95% of the viewport (the Dialog clamps to 95vw/95vh anyway);
// a user-resized geometry persisted via /api/ui-state still takes precedence.
function defaultSize() {
  if (typeof window !== 'undefined') {
    return {
      width: Math.round(window.innerWidth * 0.95),
      height: Math.round(window.innerHeight * 0.95),
    };
  }
  return { width: 1100, height: 700 };
}

type Side = 'staged' | 'unstaged';

interface Selection {
  entry: VcsFileEntry;
  side: Side;
}

interface DiffPayload {
  left?: string;
  right?: string;
  leftLabel?: string;
  rightLabel?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

interface SourceControlDialogProps {
  open: boolean;
  projectPath: string | null;
  onClose: () => void;
}

function fileNameOf(relPath: string): string {
  return relPath.split('/').pop() || relPath;
}

function parentDirOf(relPath: string): string {
  const parts = relPath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

// GitKraken-style status icons: orange pencil = modified, green plus = added/
// untracked, red minus = deleted, blue arrow = renamed, warnings for
// conflict/missing. Colors reuse the FileTree badge palette.
function StatusIcon({ status }: { status: VcsFileStatus }) {
  const cls = `h-3.5 w-3.5 shrink-0 ${VCS_STATUS_COLORS[status]}`;
  switch (status) {
    case 'M': return <Pencil className={cls} />;
    case 'A':
    case '?': return <Plus className={cls} />;
    case 'D': return <Minus className={cls} />;
    case 'R': return <ArrowRight className={cls} />;
    case 'C': return <TriangleAlert className={cls} />;
    case '!': return <CircleAlert className={cls} />;
  }
}

export default React.memo(function SourceControlDialog({ open, projectPath, onClose }: SourceControlDialogProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<{ unstaged: boolean; staged: boolean }>({ unstaged: false, staged: false });
  // svn only: relPaths selected for commit (the client-side "staging area").
  // Mirrored in a ref so status refreshes can prune it without nesting
  // state updaters (which must stay pure).
  const [svnSelection, setSvnSelectionState] = useState<Set<string>>(new Set());
  const svnSelectionRef = useRef<Set<string>>(svnSelection);
  const setSvnSelection = useCallback((next: Set<string>) => {
    svnSelectionRef.current = next;
    setSvnSelectionState(next);
  }, []);
  // Bumped on external file-system changes so the selected diff refetches
  const [fsVersion, setFsVersion] = useState(0);

  // Persisted dialog size — same pattern as CodeViewerDialog (codeViewerSize)
  const [persistedSize, setPersistedSize] = useState(defaultSize);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const savePrefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ui-state');
        if (res.ok) {
          const { state } = await res.json();
          if (state?.sourceControlSize) setPersistedSize(state.sourceControlSize);
        }
      } catch { /* ignore */ }
      setPrefsLoaded(true);
    })();
  }, []);

  const handleResizeEnd = useCallback((s: { width: number; height: number }) => {
    setPersistedSize(s);
    if (savePrefTimer.current) clearTimeout(savePrefTimer.current);
    savePrefTimer.current = setTimeout(async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceControlSize: s }),
        });
      } catch { /* ignore */ }
    }, 500);
  }, []);

  // Keep the selection pointing at a live entry after every status refresh.
  // Prefer the same relPath on the same side, then the other side, then the
  // first available file.
  const reconcileSelection = useCallback((next: StatusPayload | null, svnSel: Set<string>) => {
    setSelected((prev) => {
      if (!next) return null;
      const isSvn = next.vcs === 'svn';
      const stagedList = isSvn
        ? next.unstaged.filter((e) => svnSel.has(e.relPath))
        : next.staged;
      const unstagedList = isSvn
        ? next.unstaged.filter((e) => !svnSel.has(e.relPath))
        : next.unstaged;

      const find = (list: VcsFileEntry[], rel: string) => list.find((e) => e.relPath === rel);
      if (prev) {
        const sameSideList = prev.side === 'staged' ? stagedList : unstagedList;
        const otherSideList = prev.side === 'staged' ? unstagedList : stagedList;
        const same = find(sameSideList, prev.entry.relPath);
        if (same) return { entry: same, side: prev.side };
        const other = find(otherSideList, prev.entry.relPath);
        if (other) return { entry: other, side: prev.side === 'staged' ? 'unstaged' : 'staged' };
      }
      if (unstagedList.length > 0) return { entry: unstagedList[0], side: 'unstaged' };
      if (stagedList.length > 0) return { entry: stagedList[0], side: 'staged' };
      return null;
    });
  }, []);

  const applyStatus = useCallback((next: StatusPayload | null) => {
    setStatus(next);
    let sel = svnSelectionRef.current;
    if (next?.vcs === 'svn') {
      // Prune selections for files that no longer have changes
      const live = new Set(next.unstaged.map((e) => e.relPath));
      const pruned = new Set([...sel].filter((p) => live.has(p)));
      if (pruned.size !== sel.size) {
        sel = pruned;
        setSvnSelection(pruned);
      }
    } else if (sel.size > 0) {
      sel = new Set();
      setSvnSelection(sel);
    }
    reconcileSelection(next, sel);
  }, [reconcileSelection, setSvnSelection]);

  const fetchStatus = useCallback(async () => {
    if (!projectPath) return;
    setStatusError(null);
    try {
      const res = await fetch(`/api/vcs/status?path=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to read VCS status');
      if (!data.vcs) throw new Error('This directory is not a git or svn working copy');
      applyStatus(data as StatusPayload);
    } catch (err) {
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : 'Failed to read VCS status');
    }
  }, [projectPath, applyStatus]);

  // Load status when the dialog opens
  useEffect(() => {
    if (open && projectPath) {
      setActionError(null);
      setStatus(null);
      setSelected(null);
      setDiff(null);
      fetchStatus();
    }
  }, [open, projectPath, fetchStatus]);

  // Live refresh while open: reuse the file-watcher SSE (same as FileTree)
  useEffect(() => {
    if (!open || !projectPath) return;
    const es = new EventSource(`/api/tree/watch?path=${encodeURIComponent(projectPath)}`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'change') {
          fetchStatus();
          setFsVersion((v) => v + 1);
        }
      } catch { /* ignore malformed messages */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [open, projectPath, fetchStatus]);

  // Fetch the diff for the selected file
  useEffect(() => {
    if (!open || !projectPath || !selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    const { entry, side } = selected;
    (async () => {
      setDiffLoading(true);
      try {
        const params = new URLSearchParams({ root: projectPath, path: entry.path, side });
        if (entry.origRelPath) params.set('orig', entry.origRelPath);
        const res = await fetch(`/api/vcs/diff?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || 'Failed to load diff');
        setDiff(data as DiffPayload);
      } catch {
        if (!cancelled) setDiff(null);
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, projectPath, selected, fsVersion]);

  const selectedFileName = selected ? fileNameOf(selected.entry.relPath) : '';

  const diffResult = useMemo(() => {
    if (!diff || diff.binary || diff.tooLarge) return null;
    return buildDiffRows(diff.left || '', diff.right || '', selectedFileName);
  }, [diff, selectedFileName]);

  const isSvn = status?.vcs === 'svn';

  // Visible lists (svn derives "staged" from the client-side selection)
  const stagedList = useMemo(() => {
    if (!status) return [];
    return isSvn ? status.unstaged.filter((e) => svnSelection.has(e.relPath)) : status.staged;
  }, [status, isSvn, svnSelection]);

  const unstagedList = useMemo(() => {
    if (!status) return [];
    return isSvn ? status.unstaged.filter((e) => !svnSelection.has(e.relPath)) : status.unstaged;
  }, [status, isSvn, svnSelection]);

  const runAction = useCallback(async (body: Record<string, unknown>) => {
    if (!projectPath) return false;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch('/api/vcs/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: projectPath, ...body }),
      });
      const data = await res.json();
      if (data.status) applyStatus(data.status as StatusPayload);
      if (!res.ok) {
        setActionError(data.error || 'Action failed');
        return false;
      }
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      return false;
    } finally {
      setBusy(false);
    }
  }, [projectPath, applyStatus]);

  const moveSvnSelection = useCallback((relPaths: string[], stage: boolean) => {
    const next = new Set(svnSelectionRef.current);
    for (const p of relPaths) {
      if (stage) next.add(p); else next.delete(p);
    }
    setSvnSelection(next);
    // Flip the selected row to its new side so the highlight follows the file
    setSelected((sel) =>
      sel && relPaths.includes(sel.entry.relPath)
        ? { ...sel, side: stage ? 'staged' : 'unstaged' }
        : sel
    );
  }, [setSvnSelection]);

  const handleStage = useCallback((entries: VcsFileEntry[]) => {
    const relPaths = entries.map((e) => e.relPath);
    if (isSvn) {
      moveSvnSelection(relPaths, true);
    } else {
      runAction({ op: 'stage', paths: relPaths });
    }
  }, [isSvn, moveSvnSelection, runAction]);

  const handleUnstage = useCallback((entries: VcsFileEntry[]) => {
    const relPaths = entries.map((e) => e.relPath);
    if (isSvn) {
      moveSvnSelection(relPaths, false);
    } else {
      runAction({ op: 'unstage', paths: relPaths });
    }
  }, [isSvn, moveSvnSelection, runAction]);

  const handleStageAll = useCallback(() => {
    if (isSvn) {
      moveSvnSelection(unstagedList.map((e) => e.relPath), true);
    } else {
      runAction({ op: 'stageAll' });
    }
  }, [isSvn, moveSvnSelection, unstagedList, runAction]);

  const handleUnstageAll = useCallback(() => {
    if (isSvn) {
      moveSvnSelection(stagedList.map((e) => e.relPath), false);
    } else {
      runAction({ op: 'unstageAll' });
    }
  }, [isSvn, moveSvnSelection, stagedList, runAction]);

  const canCommit = !busy && summary.trim().length > 0 && stagedList.length > 0;

  const handleCommit = useCallback(async () => {
    const body: Record<string, unknown> = {
      op: 'commit',
      message: summary,
    };
    if (isSvn) body.paths = stagedList.map((e) => e.relPath);
    const ok = await runAction(body);
    if (ok) {
      setSummary('');
      setSvnSelection(new Set());
    }
  }, [summary, isSvn, stagedList, runAction]);

  if (!open || !projectPath || !prefsLoaded) return null;

  const title = (
    <span>
      Source Control
      {status?.branch && !isSvn && (
        <span className="text-muted-foreground font-normal ml-3 text-xs inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {status.branch}
        </span>
      )}
    </span>
  );

  const headerActions = (
    <button
      onClick={fetchStatus}
      disabled={busy}
      title="Refresh"
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={title}
      headerActions={headerActions}
      defaultWidth={persistedSize.width}
      defaultHeight={persistedSize.height}
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      resetOnOpen={false}
      onResizeEnd={handleResizeEnd}
      maximizable
      noPadding
    >
      <div className="flex flex-1 min-h-0">
        {/* Left: diff pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selected && (
            <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border text-sm">
              <StatusIcon status={selected.entry.status} />
              <span className="font-mono truncate" title={VCS_STATUS_LABELS[selected.entry.status]}>{selected.entry.relPath}</span>
              {diff?.leftLabel && (
                <span className="ml-auto text-xs text-muted-foreground shrink-0">
                  {diff.leftLabel} → {diff.rightLabel}
                </span>
              )}
            </div>
          )}
          <div className="flex-1 overflow-auto min-h-0">
            {statusError ? (
              <EmptyState text={statusError} destructive />
            ) : !status ? (
              <EmptyState spinner text="Loading status..." />
            ) : !selected ? (
              <EmptyState text={unstagedList.length + stagedList.length === 0 ? 'No changes' : 'Select a file to view its diff'} />
            ) : diffLoading && !diff ? (
              <EmptyState spinner text="Loading diff..." />
            ) : diff?.binary ? (
              <EmptyState text="Binary file — no diff to display" />
            ) : diff?.tooLarge || diffResult?.tooLarge ? (
              <EmptyState text="Too many changes to display in diff view" />
            ) : diffResult ? (
              <DiffView rows={diffResult.rows} />
            ) : (
              <EmptyState text="No diff available" />
            )}
          </div>
        </div>

        {/* Right: file lists + commit box */}
        <div className="w-80 shrink-0 border-l border-border flex flex-col">
          {/* Collapsible sections — each expanded section scrolls independently */}
          <div className="flex-1 min-h-0 flex flex-col">
            <FileSection
              label="Unstaged Files"
              count={unstagedList.length}
              collapsed={collapsed.unstaged}
              onToggle={() => setCollapsed((c) => ({ ...c, unstaged: !c.unstaged }))}
              actionLabel="Stage All Changes"
              actionStyle="green"
              onAction={handleStageAll}
              actionDisabled={busy || unstagedList.length === 0}
              entries={unstagedList}
              side="unstaged"
              selected={selected}
              onSelect={(entry) => setSelected({ entry, side: 'unstaged' })}
              onRowAction={(entry) => handleStage([entry])}
              rowActionIcon="stage"
              busy={busy}
            />
            <FileSection
              label="Staged Files"
              count={stagedList.length}
              collapsed={collapsed.staged}
              onToggle={() => setCollapsed((c) => ({ ...c, staged: !c.staged }))}
              actionLabel="Unstage All Changes"
              actionStyle="red"
              onAction={handleUnstageAll}
              actionDisabled={busy || stagedList.length === 0}
              entries={stagedList}
              side="staged"
              selected={selected}
              onSelect={(entry) => setSelected({ entry, side: 'staged' })}
              onRowAction={(entry) => handleUnstage([entry])}
              rowActionIcon="unstage"
              busy={busy}
            />
          </div>

          {/* Commit box */}
          <div className="shrink-0 border-t border-border p-3 space-y-2">
            <div className="relative">
              <textarea
                placeholder="Commit message (required)"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                disabled={busy}
                rows={3}
                className="w-full bg-muted/50 border border-border rounded-md px-2.5 py-1.5 pr-10 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
              {summary.length > 0 && (
                <span className="absolute top-1.5 right-2.5 text-xs text-muted-foreground/60 select-none">
                  {summary.length}
                </span>
              )}
            </div>
            {actionError && (
              <div className="text-xs text-destructive break-words">{actionError}</div>
            )}
            <button
              disabled={!canCommit}
              onClick={handleCommit}
              title={
                stagedList.length === 0
                  ? (isSvn ? 'Select files to commit first' : 'Stage files to commit first')
                  : !summary.trim() ? 'Enter a commit message' : undefined
              }
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-green-800 hover:bg-green-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-green-800"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCommitHorizontal className="h-4 w-4" />}
              Commit Changes{stagedList.length > 0 ? ` to ${stagedList.length} File${stagedList.length === 1 ? '' : 's'}` : ''}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
});

function EmptyState({ text, spinner, destructive }: { text: string; spinner?: boolean; destructive?: boolean }) {
  return (
    <div className={`flex items-center justify-center h-full gap-2 text-sm p-4 text-center ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}>
      {spinner && <Loader2 className="h-5 w-5 animate-spin" />}
      <span>{text}</span>
    </div>
  );
}

interface FileSectionProps {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  actionLabel: string;
  actionStyle: 'green' | 'red';
  onAction: () => void;
  actionDisabled: boolean;
  entries: VcsFileEntry[];
  side: Side;
  selected: Selection | null;
  onSelect: (entry: VcsFileEntry) => void;
  onRowAction: (entry: VcsFileEntry) => void;
  rowActionIcon: 'stage' | 'unstage';
  busy: boolean;
}

function FileSection({
  label, count, collapsed, onToggle, actionLabel, actionStyle, onAction,
  actionDisabled, entries, side, selected, onSelect, onRowAction, rowActionIcon, busy,
}: FileSectionProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  // Green matches the chat send button (bg-green-800/700) for a single
  // "affirmative action" green across the app.
  const actionCls = actionStyle === 'green'
    ? 'bg-green-800 hover:bg-green-700 text-white'
    : 'bg-transparent hover:bg-red-500/10 text-foreground border border-red-500';
  return (
    // Expanded sections share the available height; a collapsed one shrinks to
    // its header, giving the rest to the other section.
    <div className={collapsed ? 'shrink-0 flex flex-col' : 'flex-1 min-h-0 flex flex-col'}>
      <div
        className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 cursor-pointer select-none hover:bg-accent/30 transition-colors"
        onClick={onToggle}
      >
        <span className="flex items-center gap-1 text-sm font-medium min-w-0">
          <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label} ({count})</span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onAction(); }}
          disabled={actionDisabled}
          className={`shrink-0 text-xs px-2 py-1 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${actionCls}`}
        >
          {actionLabel}
        </button>
      </div>
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground/60">No files</div>
          ) : (
            entries.map((entry) => {
              const isSelected = selected?.side === side && selected.entry.relPath === entry.relPath;
              const dir = parentDirOf(entry.relPath);
              return (
                <div
                  key={`${side}:${entry.relPath}`}
                  className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors ${
                    isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                  }`}
                  onClick={() => onSelect(entry)}
                >
                  <StatusIcon status={entry.status} />
                  {/* Two-tone path: muted directory, bright filename */}
                  <span className="truncate flex-1 min-w-0" title={entry.relPath}>
                    {dir && <span className="text-muted-foreground/60">{dir}/</span>}
                    <span className="font-medium text-foreground">{fileNameOf(entry.relPath)}</span>
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRowAction(entry); }}
                    disabled={busy}
                    title={rowActionIcon === 'stage' ? 'Stage file' : 'Unstage file'}
                    className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                  >
                    {rowActionIcon === 'stage' ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
