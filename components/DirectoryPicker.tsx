'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Folder, Home, ChevronRight, ChevronUp, Loader2, HardDrive, Link2 } from 'lucide-react';
import Dialog from '@/components/Dialog';

interface Directory {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
}

interface DirectoryData {
  currentPath: string;
  parentPath: string | null;
  directories: Directory[];
  homeDir: string;
  drives?: string[];
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
  const [drives, setDrives] = useState<string[]>([]);

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
      if (data.drives) setDrives(data.drives);
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

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select Working Directory"
      defaultWidth={832}
      defaultHeight={620}
      minWidth={500}
      minHeight={400}
      buttons={[
        { label: 'Cancel', onClick: handleCancel, variant: 'outline' },
        { label: 'Select Directory', onClick: handleSelect, disabled: !selectedPath },
      ]}
    >
      {/* Description */}
      <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-4 text-sm text-muted-foreground border-b border-border">
        Choose the directory where this chat session will run
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden -mx-4 px-4 min-h-0">
        <div className="flex gap-4 h-full">
          {/* Left Panel - Recent Directories */}
          {uniqueRecentDirs.length > 0 && (
            <div className="w-64 border-r pr-4 shrink-0 flex flex-col">
              <h3 className="text-sm font-semibold mb-2 text-foreground shrink-0">Recent Directories</h3>
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-1">
                  {uniqueRecentDirs.map((dir, index) => {
                    const sep = drives.length > 0 ? '\\' : '/';
                    const segments = dir.replace(/\\/g, '/').replace(/\/$/, '').split('/');
                    const shortLabel = segments.slice(-2).join(sep);
                    return (
                      <button
                        key={index}
                        onClick={() => loadDirectory(dir)}
                        className="w-full flex flex-col px-2 py-2 rounded hover:bg-muted transition-colors text-left text-sm"
                        title={dir}
                      >
                        <div className="flex items-center gap-2">
                          <Folder className="h-4 w-4 text-blue-500 flex-shrink-0" />
                          <span className="flex-1 truncate">{shortLabel}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
                          {dir}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Right Panel - Directory Browser */}
          <div className="flex-1 space-y-4 min-w-0 flex flex-col">
            {/* Current path and navigation */}
            <div className="flex items-center gap-2 shrink-0">
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

            {/* Windows drive selector */}
            {drives.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap shrink-0">
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground mr-1" />
                {drives.map((drive) => {
                  const isActive = currentPath.toUpperCase().startsWith(drive.charAt(0).toUpperCase());
                  return (
                    <Button
                      key={drive}
                      variant={isActive ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 px-2 text-xs font-mono"
                      onClick={() => loadDirectory(drive)}
                      disabled={loading}
                    >
                      {drive.substring(0, 2)}
                    </Button>
                  );
                })}
              </div>
            )}

            {/* Directory list - fills remaining space */}
            <ScrollArea className="flex-1 border rounded min-h-0">
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
                      {dir.isSymlink && (
                        <span title="Symbolic link"><Link2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" /></span>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </div>

    </Dialog>
  );
}
