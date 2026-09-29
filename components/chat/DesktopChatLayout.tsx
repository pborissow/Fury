'use client';

import type { ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

interface DesktopChatLayoutProps {
  sessions: ReactNode;
  conversation: ReactNode;
  side: ReactNode;
  /** Persisted panel sizes (%) — this layout is their sole writer. */
  horizontalLayout: number[];
  onHorizontalLayoutChange: (sizes: number[]) => void;
}

/** The desktop Chat tab: sessions | conversation | side views, in resizable
 *  columns. The panes are layout-agnostic nodes, so another layout (e.g. mobile)
 *  can arrange the same elements differently. */
export default function DesktopChatLayout({
  sessions, conversation, side, horizontalLayout, onHorizontalLayoutChange,
}: DesktopChatLayoutProps) {
  return (
    <PanelGroup direction="horizontal" onLayout={onHorizontalLayoutChange}>
      <Panel defaultSize={horizontalLayout[0]} minSize={15}>
        {sessions}
      </Panel>

      <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

      <Panel defaultSize={horizontalLayout[1]} minSize={30}>
        {conversation}
      </Panel>

      <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

      <Panel defaultSize={horizontalLayout[2]} minSize={20}>
        {side}
      </Panel>
    </PanelGroup>
  );
}
