'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Resizable } from 're-resizable';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Folder, Home, ChevronRight, ChevronUp, Loader2, HardDrive, Link2, XIcon } from 'lucide-react';

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

const DEFAULT_WIDTH = 832;
const DEFAULT_HEIGHT = 620;
const MIN_WIDTH = 500;
const MIN_HEIGHT = 400;

export function DirectoryPicker({ open, onOpenChange, onSelect, recentDirectories = [] }: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [drives, setDrives] = useState<string[]>([]);

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [size, setSize] = useState<{ width: number; height: number }>({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Center the dialog when it opens
  useEffect(() => {
    if (open) {
      setPosition({
        x: Math.round((window.innerWidth - size.width) / 2),
        y: Math.round((window.innerHeight - size.height) / 2),
      });
      loadDirectory();
    }
  }, [open]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from the header area, not buttons/inputs inside it
    if ((e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    if (!open) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };
    const handleMouseUp = () => {
      dragging.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
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

  // Height for the scrollable content area (total height minus header ~80px and footer ~64px and gaps ~32px)
  const contentHeight = size.height - 176;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed z-50 outline-none"
          style={{ left: position.x, top: position.y }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Resizable
            size={size}
            minWidth={MIN_WIDTH}
            minHeight={MIN_HEIGHT}
            onResizeStop={(_e, _dir, _ref, d) => {
              setSize(prev => ({
                width: prev.width + d.width,
                height: prev.height + d.height,
              }));
            }}
            className="bg-background border rounded-lg shadow-lg flex flex-col overflow-hidden"
          >
            {/* Draggable header */}
            <div
              className="p-6 pb-4 cursor-move select-none shrink-0"
              onMouseDown={handleMouseDown}
            >
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-2">
                  <DialogPrimitive.Title className="text-lg leading-none font-semibold">
                    Select Working Directory
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="text-muted-foreground text-sm">
                    Choose the directory where this chat session will run
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close className="ring-offset-background focus:ring-ring rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
                  <XIcon />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Body - fills available space */}
            <div className="flex-1 px-6 overflow-hidden">
              <div className="flex gap-4 h-full" style={{ height: contentHeight > 0 ? contentHeight : 300 }}>
                {/* Left Panel - Recent Directories */}
                {uniqueRecentDirs.length > 0 && (
                  <div className="w-64 border-r pr-4 shrink-0">
                    <h3 className="text-sm font-semibold mb-2 text-foreground">Recent Directories</h3>
                    <ScrollArea style={{ height: contentHeight - 28 > 0 ? contentHeight - 28 : 272 }}>
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

            {/* Footer */}
            <div className="p-6 pt-4 flex justify-end gap-2 shrink-0">
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={handleSelect} disabled={!selectedPath}>
                Select Directory
              </Button>
            </div>
          </Resizable>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
