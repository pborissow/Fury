'use client';

import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, File, Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
}

function FileTreeItem({ node, depth }: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isDirectory = node.type === 'directory';
  const hasChildren = isDirectory && node.children && node.children.length > 0;

  const handleToggle = () => {
    if (isDirectory) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div>
      <div
        className={`
          flex items-center gap-2 px-2 py-1 cursor-pointer
          hover:bg-accent rounded-sm text-sm
          transition-colors
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleToggle}
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
            <Folder className="h-4 w-4 text-blue-500" />
          </>
        ) : (
          <>
            <div className="w-4" />
            <File className="h-4 w-4 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </div>

      {isDirectory && isExpanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  projectPath: string | null;
}

export default function FileTree({ projectPath }: FileTreeProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setTree([]);
      return;
    }

    const fetchTree = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/tree?path=${encodeURIComponent(projectPath)}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch directory tree');
        }

        setTree(data.tree);
      } catch (err) {
        console.error('Error fetching file tree:', err);
        setError(err instanceof Error ? err.message : 'Failed to load directory tree');
      } finally {
        setLoading(false);
      }
    };

    fetchTree();
  }, [projectPath]);

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
    <ScrollArea className="h-full">
      <div className="py-2">
        {tree.map((node) => (
          <FileTreeItem key={node.path} node={node} depth={0} />
        ))}
      </div>
    </ScrollArea>
  );
}
