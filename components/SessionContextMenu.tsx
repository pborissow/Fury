'use client';

import { useEffect } from 'react';
import { Trash2 } from 'lucide-react';

interface SessionContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  project: string;
  display: string;
  isLive: boolean;
  onDelete: (entry: { sessionId: string; project: string; display: string; isLive: boolean }) => void;
  onClose: () => void;
}

export default function SessionContextMenu({ x, y, sessionId, project, display, isLive, onDelete, onClose }: SessionContextMenuProps) {
  // Close on click-outside or Escape
  useEffect(() => {
    const handleClick = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed z-50 min-w-[160px] bg-popover border border-border rounded-md shadow-md py-1"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="w-full px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-muted text-destructive"
        onClick={() => {
          onDelete({ sessionId, project, display, isLive });
          onClose();
        }}
      >
        <Trash2 className="h-4 w-4" />
        Delete Session
      </button>
    </div>
  );
}
