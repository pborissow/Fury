'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, File, Loader2, Search, X, GitBranch, GitCommitHorizontal } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { dirHasChange } from '@/lib/treePaths';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export type VcsFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'C' | '!';
type VcsStatusMap = Record<string, VcsFileStatus>;

export const VCS_STATUS_COLORS: Record<VcsFileStatus, string> = {
  'M': 'text-yellow-500',
  'A': 'text-green-500',
  'D': 'text-red-500',
  'R': 'text-blue-500',
  '?': 'text-green-500',
  'C': 'text-orange-500',
  '!': 'text-red-500',
};

export const VCS_STATUS_LABELS: Record<VcsFileStatus, string> = {
  'M': 'M',
  'A': 'A',
  'D': 'D',
  'R': 'R',
  '?': 'U',
  'C': 'C',
  '!': '!',
};

export function VcsStatusBadge({ status }: { status?: VcsFileStatus }) {
  if (!status) return null;
  return (
    <span className={`ml-auto shrink-0 text-xs font-mono font-semibold ${VCS_STATUS_COLORS[status]}`}>
      {VCS_STATUS_LABELS[status]}
    </span>
  );
}

/** Shared per-render state threaded to every FileTreeItem — the normalized store
 *  plus the expand/open handlers. Passed as one object to avoid prop drilling. */
interface TreeCtx {
  expanded: Set<string>;
  childrenByPath: Map<string, FileTreeNode[]>;
  loadingPaths: Set<string>;
  fileStatuses: VcsStatusMap | null;
  onToggle: (dir: string) => void;
  onFileDoubleClick?: (filePath: string) => void;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  ctx: TreeCtx;
}

function FileTreeItem({ node, depth, ctx }: FileTreeItemProps) {
  const isDirectory = node.type === 'directory';
  const isExpanded = isDirectory && ctx.expanded.has(node.path);
  const isLoading = isDirectory && ctx.loadingPaths.has(node.path);
  const children = isDirectory ? ctx.childrenByPath.get(node.path) : undefined;

  const handleClick = () => {
    if (isDirectory) {
      ctx.onToggle(node.path);
    } else if (ctx.onFileDoubleClick) {
      ctx.onFileDoubleClick(node.path);
    }
  };

  const fileStatus = !isDirectory && ctx.fileStatuses ? ctx.fileStatuses[node.path] : undefined;

  // Folder "has changes" dot: derived from the full-repo status map (a prefix
  // test), NOT from loaded children — so it's correct even while the folder is
  // collapsed and its subtree isn't in memory.
  const dirHasChanges = isDirectory && dirHasChange(node.path, ctx.fileStatuses);

  return (
    <div>
      <div
        className={`
          flex items-center gap-2 px-2 py-1 cursor-pointer
          hover:bg-accent rounded-sm text-sm
          transition-colors
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Folder className={`h-4 w-4 ${dirHasChanges ? 'text-yellow-500' : 'text-blue-500'}`} />
            )}
          </>
        ) : (
          <>
            <div className="w-4" />
            <File className={`h-4 w-4 ${fileStatus ? VCS_STATUS_COLORS[fileStatus] : 'text-muted-foreground'}`} />
          </>
        )}
        <span className={`truncate ${fileStatus ? VCS_STATUS_COLORS[fileStatus] : ''}`}>{node.name}</span>
        <VcsStatusBadge status={fileStatus} />
      </div>

      {isDirectory && isExpanded && children && (
        children.length === 0 ? (
          <div
            className="px-2 py-1 text-xs text-muted-foreground/60 italic"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            empty
          </div>
        ) : (
          <div>
            {children.map((child) => (
              <FileTreeItem key={child.path} node={child} depth={depth + 1} ctx={ctx} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

interface FileTreeProps {
  projectPath: string | null;
  onFileDoubleClick?: (filePath: string) => void;
  /** When set and the directory is a git/svn working copy, a source-control
   *  button is shown next to the search box. */
  onOpenSourceControl?: () => void;
}

const enc = encodeURIComponent;

export default function FileTree({ projectPath, onFileDoubleClick, onOpenSourceControl }: FileTreeProps) {
  // Normalized, lazily-populated store — replaces the old single recursive tree.
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileTreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  const [fileStatuses, setFileStatuses] = useState<VcsStatusMap | null>(null);
  const [vcs, setVcs] = useState<'git' | 'svn' | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<FileTreeNode[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);

  const initialLoadDone = useRef(false);

  // Refs mirrored from state so the (stable) SSE handlers can read the current
  // open set / store without re-subscribing the EventSource on every change.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const childrenRef = useRef(childrenByPath);
  childrenRef.current = childrenByPath;

  // ---- Root load -----------------------------------------------------------
  const fetchRoot = useCallback(async (showLoading: boolean) => {
    if (!projectPath) return;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tree?path=${enc(projectPath)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch directory tree');
      setChildrenByPath(new Map([[projectPath, data.tree as FileTreeNode[]]]));
      setFileStatuses(data.fileStatuses || null);
      setVcs(data.vcs || null);
      setBranch(data.branch || null);
    } catch (err) {
      console.error('Error fetching file tree:', err);
      setError(err instanceof Error ? err.message : 'Failed to load directory tree');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectPath]);

  // Fetch (or refetch) a single directory's immediate children.
  //  - `force`  refetch even if already cached (re-expand / watcher event).
  //  - `silent` skip the per-node spinner (background refresh over stale cache).
  const loadChildren = useCallback(async (dir: string, force = false, silent = false) => {
    if (!force && childrenRef.current.has(dir)) return;
    if (!silent) setLoadingPaths((prev) => new Set(prev).add(dir));
    try {
      const response = await fetch(`/api/tree?path=${enc(dir)}&childrenOnly=1`);
      const data = await response.json();
      if (response.ok) {
        setChildrenByPath((prev) => new Map(prev).set(dir, data.tree as FileTreeNode[]));
      }
    } catch {
      // Transient — the next expand or watcher event will retry.
    } finally {
      if (!silent) {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      }
    }
  }, []);

  // Refresh only the VCS badges (status-only; the tree structure is untouched).
  const fetchVcsStatus = useCallback(async () => {
    if (!projectPath) return;
    try {
      const response = await fetch(`/api/tree?path=${enc(projectPath)}&statusOnly=1`);
      if (!response.ok) return;
      const data = await response.json();
      setFileStatuses(data.fileStatuses || null);
      setVcs(data.vcs || null);
      setBranch(data.branch || null);
    } catch {
      // Transient; the next event will retry.
    }
  }, [projectPath]);

  // Coalesce VCS-status refreshes: a branch switch (or a burst of saves across
  // several open folders) can fire many change/vcs-change events in quick
  // succession, each of which would otherwise spawn its own `git status` exec.
  // At most one refresh per window.
  const vcsStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleVcsStatus = useCallback(() => {
    if (vcsStatusTimerRef.current) return; // one already pending — fold into it
    vcsStatusTimerRef.current = setTimeout(() => {
      vcsStatusTimerRef.current = null;
      void fetchVcsStatus();
    }, 200);
  }, [fetchVcsStatus]);

  // ---- Watch control channel (POST add/remove) -----------------------------
  const subscriptionIdRef = useRef<string | null>(null);
  const pendingAddRef = useRef<Set<string>>(new Set());
  const pendingRemoveRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushWatch = useCallback(() => {
    flushTimerRef.current = null;
    const id = subscriptionIdRef.current;
    if (!id) {
      // Not connected yet — retry once the SSE `connected` message lands.
      flushTimerRef.current = setTimeout(flushWatch, 120);
      return;
    }
    const add = [...pendingAddRef.current];
    const remove = [...pendingRemoveRef.current];
    if (!add.length && !remove.length) return;
    pendingAddRef.current.clear();
    pendingRemoveRef.current.clear();
    fetch('/api/tree/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: id, add, remove }),
    }).catch(() => { /* the connection will re-sync on reconnect */ });
  }, []);

  // Coalesce rapid expand/collapse toggles into one POST (add cancels a pending
  // remove of the same dir and vice versa).
  const queueWatch = useCallback((op: 'add' | 'remove', dir: string) => {
    if (op === 'add') {
      pendingRemoveRef.current.delete(dir);
      pendingAddRef.current.add(dir);
    } else {
      pendingAddRef.current.delete(dir);
      pendingRemoveRef.current.add(dir);
    }
    if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushWatch, 120);
  }, [flushWatch]);

  // ---- Expand / collapse ---------------------------------------------------
  // Side effects (fetch, watch POST) run OUTSIDE the state updater: React may
  // double-invoke an updater (StrictMode dev, concurrent features), and a
  // duplicated fetch is a real network call — the updater must stay pure.
  const onToggle = useCallback((dir: string) => {
    const isOpen = expandedRef.current.has(dir);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (isOpen) {
      queueWatch('remove', dir);
    } else {
      queueWatch('add', dir);
      // First expand → spinner. Re-expand → show cached instantly but refresh
      // in the background (it may have changed while collapsed/unwatched).
      const cached = childrenRef.current.has(dir);
      void loadChildren(dir, cached, cached);
    }
  }, [queueWatch, loadChildren]);

  // ---- Initial fetch -------------------------------------------------------
  useEffect(() => {
    initialLoadDone.current = false;
    // Reset the store and any queued watch ops for the previous project.
    setChildrenByPath(new Map());
    setExpanded(new Set());
    setLoadingPaths(new Set());
    pendingAddRef.current.clear();
    pendingRemoveRef.current.clear();

    if (!projectPath) {
      setFileStatuses(null);
      setVcs(null);
      setBranch(null);
      return;
    }

    fetchRoot(true).then(() => {
      initialLoadDone.current = true;
    });
  }, [projectPath, fetchRoot]);

  // ---- SSE subscription ----------------------------------------------------
  // Stable handler refs, reassigned each render so they close over current state
  // without forcing the EventSource effect (below) to re-run on every change.
  const onConnected = (id: string) => {
    subscriptionIdRef.current = id;
    // A fresh subscription only watches root + VCS meta; re-add every open
    // folder so a reconnect (or HMR) restores the watched set.
    for (const dir of expandedRef.current) pendingAddRef.current.add(dir);
    if (expandedRef.current.size && !flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushWatch, 0);
    }
  };

  const onServerEvent = (data: { type: string; dir?: string }) => {
    if (!initialLoadDone.current) return;
    if (data.type === 'change') {
      const dir = data.dir || projectPath || '';
      // Only refetch a directory that's actually visible (the root, or open).
      // Silent: a save shouldn't flicker the folder icon to a spinner.
      if (dir === projectPath || expandedRef.current.has(dir)) {
        void loadChildren(dir, true, true);
      }
      // Keep working-file badges in visible folders live.
      scheduleVcsStatus();
    } else if (data.type === 'vcs-change') {
      scheduleVcsStatus();
    }
  };

  const handlersRef = useRef({ onConnected, onServerEvent });
  handlersRef.current = { onConnected, onServerEvent };

  useEffect(() => {
    if (!projectPath) return;
    const eventSource = new EventSource(`/api/tree/watch?root=${enc(projectPath)}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          handlersRef.current.onConnected(data.subscriptionId);
          return;
        }
        handlersRef.current.onServerEvent(data);
      } catch {
        // Ignore malformed messages
      }
    };
    eventSource.onerror = () => {
      // EventSource auto-reconnects; a new `connected` will re-sync the set.
    };

    return () => {
      eventSource.close();
      subscriptionIdRef.current = null;
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (vcsStatusTimerRef.current) {
        clearTimeout(vcsStatusTimerRef.current);
        vcsStatusTimerRef.current = null;
      }
    };
  }, [projectPath]);

  // ---- Search (server-side, debounced) -------------------------------------
  useEffect(() => {
    if (!projectPath) return;
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearchTruncated(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/tree/search?path=${enc(projectPath)}&q=${enc(q)}`);
        const data = await response.json();
        if (cancelled || !response.ok) return;
        setSearchResults((data.matches as FileTreeNode[]) || []);
        setSearchTruncated(!!data.truncated);
      } catch {
        // Transient — a later keystroke will retry.
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, projectPath]);

  const rootChildren = projectPath ? childrenByPath.get(projectPath) : undefined;

  if (!projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project path set
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading directory tree...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm p-4 text-center">
        {error}
      </div>
    );
  }

  if (rootChildren && rootChildren.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Empty directory
      </div>
    );
  }

  const ctx: TreeCtx = {
    expanded,
    childrenByPath,
    loadingPaths,
    fileStatuses,
    onToggle,
    onFileDoubleClick,
  };

  return (
    <div className="flex flex-col h-full select-none">
      {/* Search bar */}
      <div className="px-2 pt-2 pb-1 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-muted/50 border border-border rounded-md pl-8 pr-8 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tree or search results */}
      <ScrollArea className="flex-1 overflow-hidden">
        {searchResults !== null ? (
          <div className="py-1">
            {searchResults.length === 0 ? (
              <div className="px-4 py-6 text-center text-muted-foreground text-sm">
                No files found
              </div>
            ) : (
              <>
                {searchResults.map((file) => {
                  const fileStatus = fileStatuses ? fileStatuses[file.path] : undefined;
                  return (
                    <div
                      key={file.path}
                      className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-accent rounded-sm text-sm transition-colors"
                      onClick={() => onFileDoubleClick?.(file.path)}
                    >
                      <File className={`h-4 w-4 shrink-0 ${fileStatus ? VCS_STATUS_COLORS[fileStatus] : 'text-muted-foreground'}`} />
                      <span className={`truncate ${fileStatus ? VCS_STATUS_COLORS[fileStatus] : ''}`}>{file.name}</span>
                      <span className="text-xs text-muted-foreground/60 truncate ml-auto">
                        {file.path.replace(/\\/g, '/').split('/').slice(-2, -1)[0]}
                      </span>
                      <VcsStatusBadge status={fileStatus} />
                    </div>
                  );
                })}
                {searchTruncated && (
                  <div className="px-4 py-2 text-center text-xs text-muted-foreground/70">
                    Results truncated — narrow your search.
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="py-2">
            {(rootChildren || []).map((node) => (
              <FileTreeItem key={node.path} node={node} depth={0} ctx={ctx} />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Source-control toolbar — only when the directory is a git/svn working copy */}
      {vcs && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 flex items-center justify-between gap-2 bg-muted/30">
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0"
            title={branch ? `${vcs}: ${branch}` : vcs}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{branch || vcs}</span>
          </span>
          {onOpenSourceControl && (
            <button
              onClick={onOpenSourceControl}
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:text-foreground hover:bg-accent border border-border transition-colors"
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              Stage Changes
            </button>
          )}
        </div>
      )}
    </div>
  );
}
