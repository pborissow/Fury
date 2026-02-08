'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Folder, Home, ChevronRight, ChevronUp, Loader2 } from 'lucide-react';

interface Directory {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface DirectoryData {
  currentPath: string;
  parentPath: string | null;
  directories: Directory[];
  homeDir: string;
}

interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  recentDirectories?: string[];
}

export function DirectoryPicker({ open, onOpenChange, onSelect, recentDirectories = [] }: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>('');

  // Load initial directory when dialog opens
  useEffect(() => {
    if (open) {
      loadDirectory();
    }
  }, [open]);

  const loadDirectory = async (path?: string) => {
    setLoading(true);
    try {
      const url = path
        ? `/api/directories?path=${encodeURIComponent(path)}`
        : '/api/directories';

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load directory');

      const data: DirectoryData = await response.json();
      setCurrentPath(data.currentPath);
      setDirectories(data.directories);
      setParentPath(data.parentPath);
      setHomeDir(data.homeDir);
      setSelectedPath(data.currentPath);
    } catch (error) {
      console.error('Error loading directory:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDirectoryClick = (dir: Directory) => {
    loadDirectory(dir.path);
  };

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath);
    }
  };

  const handleGoHome = () => {
    loadDirectory(homeDir);
  };

  const handleSelect = () => {
    onSelect(selectedPath);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  // Shorten path for display
  const getDisplayPath = (fullPath: string) => {
    if (fullPath === homeDir) return '~';
    if (fullPath.startsWith(homeDir)) {
      return '~' + fullPath.substring(homeDir.length);
    }
    return fullPath;
  };

  // Get unique recent directories
  const uniqueRecentDirs = Array.from(new Set(recentDirectories)).slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!min-w-[832px] !w-[832px] !max-w-[832px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Select Working Directory</DialogTitle>
          <DialogDescription>
            Choose the directory where this chat session will run
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 h-[500px]">
          {/* Left Panel - Recent Directories */}
          {uniqueRecentDirs.length > 0 && (
            <div className="w-64 border-r pr-4">
              <h3 className="text-sm font-semibold mb-2 text-foreground">Recent Directories</h3>
              <ScrollArea className="h-[440px]">
                <div className="space-y-1">
                  {uniqueRecentDirs.map((dir, index) => (
                    <button
                      key={index}
                      onClick={() => loadDirectory(dir)}
                      className="w-full flex items-center gap-2 px-2 py-2 rounded hover:bg-muted transition-colors text-left text-sm"
                      title={dir}
                    >
                      <Folder className="h-4 w-4 text-blue-500 flex-shrink-0" />
                      <span className="flex-1 truncate">{getDisplayPath(dir)}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Right Panel - Directory Browser */}
          <div className="flex-1 space-y-4">
          {/* Current path and navigation */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleGoHome}
              disabled={loading}
              title="Go to home directory"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGoUp}
              disabled={loading || !parentPath}
              title="Go to parent directory"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <div className="flex-1 px-3 py-2 bg-muted rounded text-sm font-mono truncate">
              {getDisplayPath(currentPath)}
            </div>
          </div>

          {/* Directory list */}
          <ScrollArea className="h-[400px] border rounded">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : directories.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No subdirectories
              </div>
            ) : (
              <div className="p-2">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => handleDirectoryClick(dir)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-muted transition-colors text-left"
                  >
                    <Folder className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    <span className="flex-1 truncate text-sm">{dir.name}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Selected path */}
          <div className="text-sm">
            <span className="text-muted-foreground">Selected: </span>
            <span className="font-mono">{getDisplayPath(selectedPath)}</span>
          </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSelect} disabled={!selectedPath}>
            Select Directory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
