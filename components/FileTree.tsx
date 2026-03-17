'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, File, Loader2, Search, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

type VcsFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'C' | '!';
type VcsStatusMap = Record<string, VcsFileStatus>;

const VCS_STATUS_COLORS: Record<VcsFileStatus, string> = {
  'M': 'text-yellow-500',
  'A': 'text-green-500',
  'D': 'text-red-500',
  'R': 'text-blue-500',
  '?': 'text-green-500',
  'C': 'text-orange-500',
  '!': 'text-red-500',
};

const VCS_STATUS_LABELS: Record<VcsFileStatus, string> = {
  'M': 'M',
  'A': 'A',
  'D': 'D',
  'R': 'R',
  '?': 'U',
  'C': 'C',
  '!': '!',
};

function VcsStatusBadge({ status }: { status?: VcsFileStatus }) {
  if (!status) return null;
  return (
    <span className={`ml-auto shrink-0 text-xs font-mono font-semibold ${VCS_STATUS_COLORS[status]}`}>
      {VCS_STATUS_LABELS[status]}
    </span>
  );
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  onFileDoubleClick?: (filePath: string) => void;
  fileStatuses: VcsStatusMap | null;
}

function FileTreeItem({ node, depth, onFileDoubleClick, fileStatuses }: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isDirectory = node.type === 'directory';
  const hasChildren = isDirectory && node.children && node.children.length > 0;

  const handleClick = () => {
    if (isDirectory) {
      setIsExpanded(!isExpanded);
    } else if (onFileDoubleClick) {
      onFileDoubleClick(node.path);
    }
  };

  const fileStatus = !isDirectory && fileStatuses ? fileStatuses[node.path] : undefined;

  // Check if a directory contains any changed files
  const dirHasChanges = isDirectory && fileStatuses && hasChildren
    ? hasChangedDescendant(node, fileStatuses)
    : false;

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
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )
            ) : (
              <div className="w-4" />
            )}
            <Folder className={`h-4 w-4 ${dirHasChanges ? 'text-yellow-500' : 'text-blue-500'}`} />
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

      {isDirectory && isExpanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} onFileDoubleClick={onFileDoubleClick} fileStatuses={fileStatuses} />
          ))}
        </div>
      )}
    </div>
  );
}

function hasChangedDescendant(node: FileTreeNode, fileStatuses: VcsStatusMap): boolean {
  if (!node.children) return false;
  for (const child of node.children) {
    if (child.type === 'file' && fileStatuses[child.path]) return true;
    if (child.type === 'directory' && hasChangedDescendant(child, fileStatuses)) return true;
  }
  return false;
}

function collectFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  const files: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      files.push(node);
    }
    if (node.children) {
      files.push(...collectFiles(node.children));
    }
  }
  return files;
}

interface FileTreeProps {
  projectPath: string | null;
  onFileDoubleClick?: (filePath: string) => void;
}

export default function FileTree({ projectPath, onFileDoubleClick }: FileTreeProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [fileStatuses, setFileStatuses] = useState<VcsStatusMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const initialLoadDone = useRef(false);

  const fetchTree = useCallback(async (showLoading: boolean) => {
    if (!projectPath) return;
    if (showLoading) setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tree?path=${encodeURIComponent(projectPath)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch directory tree');
      }

      setTree(data.tree);
      setFileStatuses(data.fileStatuses || null);
    } catch (err) {
      console.error('Error fetching file tree:', err);
      setError(err instanceof Error ? err.message : 'Failed to load directory tree');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectPath]);

  // Initial fetch
  useEffect(() => {
    initialLoadDone.current = false;
    if (!projectPath) {
      setTree([]);
      setFileStatuses(null);
      return;
    }

    fetchTree(true).then(() => {
      initialLoadDone.current = true;
    });
  }, [projectPath, fetchTree]);

  // Subscribe to file system changes via SSE
  useEffect(() => {
    if (!projectPath) return;

    const eventSource = new EventSource(
      `/api/tree/watch?path=${encodeURIComponent(projectPath)}`
    );

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'change' && initialLoadDone.current) {
          fetchTree(false);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    eventSource.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => {
      eventSource.close();
    };
  }, [projectPath, fetchTree]);

  const allFiles = useMemo(() => collectFiles(tree), [tree]);

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return null;
    const query = search.trim().toLowerCase();
    return allFiles.filter((f) => f.name.toLowerCase().startsWith(query));
  }, [search, allFiles]);

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

  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Empty directory
      </div>
    );
  }

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
        {filteredFiles !== null ? (
          <div className="py-1">
            {filteredFiles.length === 0 ? (
              <div className="px-4 py-6 text-center text-muted-foreground text-sm">
                No files found
              </div>
            ) : (
              filteredFiles.map((file) => {
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
              })
            )}
          </div>
        ) : (
          <div className="py-2">
            {tree.map((node) => (
              <FileTreeItem key={node.path} node={node} depth={0} onFileDoubleClick={onFileDoubleClick} fileStatuses={fileStatuses} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
