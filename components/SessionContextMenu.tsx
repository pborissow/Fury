'use client';

import { useEffect } from 'react';
import { Archive } from 'lucide-react';

interface SessionContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  project: string;
  display: string;
  isLive: boolean;
  onArchive: (entry: { sessionId: string; project: string; display: string; isLive: boolean }) => void;
  onClose: () => void;
}

export default function SessionContextMenu({ x, y, sessionId, project, display, isLive, onArchive, onClose }: SessionContextMenuProps) {
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
      {/* Not styled destructive: archiving preserves the transcript and its
          accounting, and is reversible. Red would miscommunicate that. */}
      <button
        className="w-full px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-muted"
        onClick={() => {
          onArchive({ sessionId, project, display, isLive });
          onClose();
        }}
      >
        <Archive className="h-4 w-4" />
        Archive Session
      </button>
    </div>
  );
}
