'use client';

import type { ComponentProps } from 'react';
import { Activity, FileText, FolderTree, Plug } from 'lucide-react';
import TabbedPane from '@/components/panes/TabbedPane';
import FilesView from '@/components/files/FilesView';
import NotesView from '@/components/notes/NotesView';
import type { NotesState } from '@/components/notes/useNotes';
import StreamEventsPanel from '@/components/StreamEventsPanel';
import McpPanel from '@/components/McpPanel';

export type ChatSideView = 'stream' | 'files' | 'notes' | 'mcp';

interface ChatSidePaneProps {
  projectPath: string | null;
  /** Controlled — ChatTab switches to Stream when the in-flight bubble is clicked. */
  view: ChatSideView;
  onViewChange: (view: ChatSideView) => void;
  stream: ComponentProps<typeof StreamEventsPanel>;
  /** From useNotes, held by the always-mounted owner (see useNotes). */
  notes: NotesState;
  mcpFailedServers: ComponentProps<typeof McpPanel>['runtimeFailed'];
  /** Icon-only view switcher with touch-sized targets (phone layout). */
  compact?: boolean;
}

/** The Chat tab's side views: live Stream, project Files, Notes, MCP servers. */
export default function ChatSidePane({
  projectPath, view, onViewChange, stream, notes, mcpFailedServers, compact,
}: ChatSidePaneProps) {
  return (
    <TabbedPane
      className="bg-card"
      compact={compact}
      value={view}
      onValueChange={(id) => onViewChange(id as ChatSideView)}
      views={[
        {
          id: 'stream', label: 'Stream', icon: <Activity className="h-4 w-4" />,
          badge: stream.transcriptLoading ? <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" /> : undefined,
          content: <StreamEventsPanel {...stream} />,
        },
        {
          id: 'files', label: 'Files', icon: <FolderTree className="h-4 w-4" />,
          keepMounted: true, // preserves the tree's expansion state
          content: <FilesView projectPath={projectPath} />,
        },
        {
          id: 'notes', label: 'Notes', icon: <FileText className="h-4 w-4" />,
          content: <NotesView projectPath={projectPath} notes={notes} />,
        },
        {
          id: 'mcp', label: 'MCP', icon: <Plug className="h-4 w-4" />,
          content: <McpPanel projectPath={projectPath} runtimeFailed={mcpFailedServers} />,
        },
      ]}
    />
  );
}
