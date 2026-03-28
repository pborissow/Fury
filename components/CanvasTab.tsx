'use client';

import { useState, useRef, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import DrawflowCanvas from '@/components/DrawflowCanvas';
import WorkflowsPanel from '@/components/WorkflowsPanel';
import NodeChatModal from '@/components/NodeChatModal';

interface CanvasTabProps {
  canvasHorizontalLayout: number[];
  onLayoutChange: (sizes: number[]) => void;
  initialWorkflowId: string | null;
  onWorkflowIdChange: (id: string | null) => void;
}

export default function CanvasTab({
  canvasHorizontalLayout,
  onLayoutChange,
  initialWorkflowId,
  onWorkflowIdChange,
}: CanvasTabProps) {
  const exportFlowDataRef = useRef<(() => any) | null>(null);
  const importFlowDataRef = useRef<((data: any, id?: string) => void) | null>(null);
  const updateNodeDataRef = useRef<((nodeId: string, chatSession: any) => void) | null>(null);

  // Workflow state — initialWorkflowId is only read on first mount.
  // Safe because layoutsLoaded gates rendering, so the value is final by mount time.
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(initialWorkflowId);

  // Node chat modal state
  const [nodeChatModalOpen, setNodeChatModalOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeSession, setSelectedNodeSession] = useState<any>(null);

  const handleWorkflowSelect = useCallback((id: string | null) => {
    setActiveWorkflowId(id);
    onWorkflowIdChange(id);
  }, [onWorkflowIdChange]);

  const handleWorkflowAutoSave = useCallback(async (data: any, workflowId: string) => {
    if (!workflowId) return;
    try {
      await fetch('/api/workflows', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: workflowId, data }),
      });
    } catch (error) {
      console.error('[CanvasTab] Failed to auto-save workflow:', error);
    }
  }, []);

  const handleNodeDoubleClick = useCallback((nodeId: string, chatSession: any) => {
    setSelectedNodeId(nodeId);
    setSelectedNodeSession(chatSession);
    setNodeChatModalOpen(true);
  }, []);

  const handleNodeSessionUpdate = useCallback((nodeId: string, session: any) => {
    if (updateNodeDataRef.current) {
      updateNodeDataRef.current(nodeId, session);
    }
    setSelectedNodeSession(session);
  }, []);

  return (
    <>
      <PanelGroup direction="horizontal" onLayout={onLayoutChange}>
        {/* Left Panel - Workflows */}
        <Panel defaultSize={canvasHorizontalLayout[0]} minSize={15}>
          <WorkflowsPanel
            activeWorkflowId={activeWorkflowId}
            onWorkflowSelect={handleWorkflowSelect}
            onWorkflowLoad={(workflow) => {
              if (importFlowDataRef.current) {
                importFlowDataRef.current(workflow.data, workflow.id);
              }
            }}
            onSaveWorkflow={() => {}}
            getCurrentFlowData={() => {
              if (exportFlowDataRef.current) {
                return exportFlowDataRef.current();
              }
              return {
                drawflow: {
                  Home: {
                    data: {}
                  }
                }
              };
            }}
          />
        </Panel>

        <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

        {/* Middle Panel - Canvas */}
        <Panel defaultSize={canvasHorizontalLayout[1]} minSize={50}>
          <DrawflowCanvas
            className="h-full"
            activeWorkflowId={activeWorkflowId}
            onEditorReady={(exportFn, importFn, updateNodeDataFn) => {
              exportFlowDataRef.current = exportFn;
              importFlowDataRef.current = importFn;
              updateNodeDataRef.current = updateNodeDataFn;
            }}
            onAutoSave={handleWorkflowAutoSave}
            onNodeDoubleClick={handleNodeDoubleClick}
          />
        </Panel>
      </PanelGroup>

      {/* Node Chat Modal */}
      <NodeChatModal
        key={selectedNodeId || 'no-node'}
        open={nodeChatModalOpen}
        onOpenChange={(open) => {
          setNodeChatModalOpen(open);
          if (!open) {
            setSelectedNodeId(null);
            setSelectedNodeSession(null);
          }
        }}
        nodeId={selectedNodeId}
        initialSession={selectedNodeSession}
        onSessionUpdate={handleNodeSessionUpdate}
      />
    </>
  );
}
