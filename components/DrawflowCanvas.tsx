'use client';

import { useEffect, useRef, useState } from 'react';
import Drawflow from 'drawflow';
import 'drawflow/dist/drawflow.min.css';

interface NodeChatSession {
  workingDirectory: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface DrawflowCanvasProps {
  className?: string;
  onEditorReady?: (
    exportFn: () => any,
    importFn: (data: any, workflowId?: string) => void,
    updateNodeDataFn: (nodeId: string, chatSession: NodeChatSession) => void
  ) => void;
  onAutoSave?: (data: any, workflowId: string) => void;
  onNodeDoubleClick?: (nodeId: string, chatSession: NodeChatSession | null) => void;
  activeWorkflowId?: string | null;
}

// Add custom styles for diamond nodes
const customStyles = `
  .drawflow-node.diamond {
    width: 116px;
    height: 116px;
  }
`;

export default function DrawflowCanvas({ className = '', onEditorReady, onAutoSave, onNodeDoubleClick, activeWorkflowId }: DrawflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Drawflow | null>(null);
  const [draggedNodeType, setDraggedNodeType] = useState<string | null>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentWorkflowIdRef = useRef<string | null>(null);

  // Debounced auto-save function
  const triggerAutoSave = () => {
    if (!onAutoSave || !editorRef.current || !currentWorkflowIdRef.current) return;

    // Clear existing timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    // Capture the current workflow ID to prevent saving to wrong workflow
    const workflowIdAtTimeOfChange = currentWorkflowIdRef.current;

    // Set new timer - save after 2 seconds of inactivity
    autoSaveTimerRef.current = setTimeout(() => {
      // Only save if we're still on the same workflow
      if (editorRef.current && currentWorkflowIdRef.current === workflowIdAtTimeOfChange) {
        const data = editorRef.current.export();
        // Pass the captured workflow ID to ensure we save to the correct workflow
        onAutoSave(data, workflowIdAtTimeOfChange);
        console.log('[DrawflowCanvas] Auto-saved workflow:', workflowIdAtTimeOfChange);
      } else {
        console.log('[DrawflowCanvas] Skipped auto-save - workflow changed');
      }
    }, 2000);
  };

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;

    // Inject custom styles
    const styleElement = document.createElement('style');
    styleElement.textContent = customStyles;
    document.head.appendChild(styleElement);

    // Initialize Drawflow with proper context
    const editor = new Drawflow(containerRef.current);

    // Enable rerouting of connections
    editor.reroute = true;

    // Enable zoom
    editor.zoom = 1;
    editor.zoom_max = 1.6;
    editor.zoom_min = 0.5;
    editor.zoom_value = 0.1;

    // Start the editor
    editor.start();

    editorRef.current = editor;

    // Add event listeners for auto-save
    editor.on('nodeCreated', (id: number) => {
      console.log('Node created:', id);
      triggerAutoSave();
    });

    editor.on('nodeRemoved', (id: number) => {
      console.log('Node removed:', id);
      triggerAutoSave();
    });

    editor.on('nodeMoved', (id: number) => {
      console.log('Node moved:', id);
      triggerAutoSave();
    });

    editor.on('connectionCreated', (info: any) => {
      console.log('Connection created:', info);
      triggerAutoSave();
    });

    editor.on('connectionRemoved', (info: any) => {
      console.log('Connection removed:', info);
      triggerAutoSave();
    });

    editor.on('addReroute', (id: number) => {
      console.log('Reroute added:', id);
      triggerAutoSave();
    });

    editor.on('removeReroute', (id: number) => {
      console.log('Reroute removed:', id);
      triggerAutoSave();
    });

    // Add double-click event listener for nodes
    const handleNodeDoubleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const nodeElement = target.closest('.drawflow-node');

      if (nodeElement && onNodeDoubleClick) {
        const nodeId = nodeElement.getAttribute('id');
        if (nodeId) {
          // Extract numeric ID from the element ID (format: node-123)
          const numericId = nodeId.replace('node-', '');
          const nodeData = editor.getNodeFromId(numericId);

          if (nodeData) {
            // Get chat session from node data if it exists
            const chatSession = nodeData.data?.chatSession || null;
            console.log('[DrawflowCanvas] Node double-clicked:', numericId, chatSession);
            onNodeDoubleClick(numericId, chatSession);
          }
        }
      }
    };

    // Add event listener to container
    if (containerRef.current) {
      containerRef.current.addEventListener('dblclick', handleNodeDoubleClick);
    }

    // Expose export/import/updateNodeData functions to parent
    if (onEditorReady) {
      const exportFn = () => editor.export();

      const updateNodeDataFn = (nodeId: string, chatSession: NodeChatSession) => {
        console.log('[DrawflowCanvas] Updating node data:', nodeId, chatSession);
        const nodeData = editor.getNodeFromId(nodeId);

        if (nodeData) {
          // Update the node's data with the chat session
          nodeData.data = {
            ...nodeData.data,
            chatSession,
          };

          // Update the node in the editor
          editor.updateNodeDataFromId(nodeId, nodeData.data);

          // Trigger auto-save
          triggerAutoSave();

          console.log('[DrawflowCanvas] Node data updated successfully');
        } else {
          console.error('[DrawflowCanvas] Node not found:', nodeId);
        }
      };

      const importFn = (data: any, workflowId?: string) => {
        console.log('[DrawflowCanvas] importFn called with data:', JSON.stringify(data, null, 2));
        console.log('[DrawflowCanvas] Workflow ID:', workflowId);

        // Update the current workflow ID ref IMMEDIATELY
        if (workflowId) {
          currentWorkflowIdRef.current = workflowId;
          console.log('[DrawflowCanvas] Updated currentWorkflowIdRef to:', workflowId);
        }

        // Cancel any pending auto-save when switching workflows
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
          console.log('[DrawflowCanvas] Cancelled pending auto-save');
        }

        editor.clear();

        // Validate and fix data structure if needed
        if (!data || typeof data !== 'object') {
          console.log('[DrawflowCanvas] Invalid data, creating empty workflow');
          return;
        }

        // Ensure drawflow property exists with proper structure
        if (!data.drawflow || typeof data.drawflow !== 'object') {
          console.log('[DrawflowCanvas] Missing drawflow property, creating empty workflow');
          return;
        }

        // Ensure Home module exists
        if (!data.drawflow.Home || typeof data.drawflow.Home !== 'object') {
          console.log('[DrawflowCanvas] Missing Home module, creating empty workflow');
          return;
        }

        // Log node count before import
        const nodeCount = data.drawflow.Home.data ? Object.keys(data.drawflow.Home.data).length : 0;
        console.log(`[DrawflowCanvas] Importing ${nodeCount} nodes`);

        editor.import(data);

        // Verify nodes were imported
        const importedData = editor.export();
        const importedNodeCount = importedData.drawflow.Home.data ? Object.keys(importedData.drawflow.Home.data).length : 0;
        console.log(`[DrawflowCanvas] After import: ${importedNodeCount} nodes in editor`);
        console.log('[DrawflowCanvas] Imported workflow successfully');
      };
      onEditorReady(exportFn, importFn, updateNodeDataFn);
    }

    return () => {
      // Clear auto-save timer
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }

      // Remove double-click event listener
      if (containerRef.current) {
        containerRef.current.removeEventListener('dblclick', handleNodeDoubleClick);
      }

      if (editorRef.current) {
        editorRef.current.clear();
      }

      // Clean up style element
      document.head.removeChild(styleElement);
    };
  }, [onEditorReady]);

  const handleDragStart = (nodeType: string) => {
    setDraggedNodeType(nodeType);
  };

  const handleDragEnd = () => {
    setDraggedNodeType(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!editorRef.current || !draggedNodeType || !containerRef.current) return;

    const editor = editorRef.current;
    const rect = containerRef.current.getBoundingClientRect();

    // Account for zoom and canvas position
    const posX = (e.clientX - rect.left) * (1 / editor.zoom);
    const posY = (e.clientY - rect.top) * (1 / editor.zoom);

    // Create node HTML based on type - with proper Drawflow structure
    let html = '';
    let inputs = 1;
    let outputs = 1;

    if (draggedNodeType === 'rectangle') {
      html = `
        <div style="padding: 15px 30px; background: #4f46e5; color: white; border-radius: 8px; text-align: center; min-width: 120px;">
          <div style="font-size: 14px; font-weight: 500;">Rectangle</div>
        </div>
      `;
    } else if (draggedNodeType === 'diamond') {
      html = `
        <div style="position: relative; width: 100px; height: 100px; display: flex; align-items: center; justify-content: center;">
          <div style="width: 80px; height: 80px; background: #10b981; transform: rotate(45deg); position: absolute;"></div>
          <span style="position: relative; z-index: 1; color: white; font-size: 12px; font-weight: 500;">Diamond</span>
        </div>
      `;
      inputs = 1;
      outputs = 1;
    } else if (draggedNodeType === 'circle') {
      html = `
        <div style="width: 80px; height: 80px; background: #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 500;">
          Circle
        </div>
      `;
      inputs = 0;
      outputs = 1;
    }

    const data = {
      nodeType: draggedNodeType,
      chatSession: null  // Initialize with no chat session
    };

    // Add node with connection points
    editor.addNode(
      draggedNodeType,
      inputs,
      outputs,
      posX,
      posY,
      draggedNodeType,
      data,
      html
    );

    setDraggedNodeType(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const isDisabled = !activeWorkflowId;

  return (
    <div className={`flex h-full ${className} ${isDisabled ? 'pointer-events-none opacity-50' : ''}`}>
      {/* Vertical Toolbar */}
      <div className="w-20 bg-card border-r border-border flex flex-col items-center py-4 gap-4 flex-shrink-0">
        <div className="text-xs text-muted-foreground mb-2">Nodes</div>

        {/* Rectangle Icon */}
        <div
          draggable
          onDragStart={() => handleDragStart('rectangle')}
          onDragEnd={handleDragEnd}
          className="w-14 h-14 cursor-grab active:cursor-grabbing hover:bg-accent rounded-lg flex items-center justify-center transition-colors"
          title="Rectangle Node (1 input, 1 output)"
        >
          <div className="w-10 h-8 bg-primary rounded-md border-2 border-primary-foreground"></div>
        </div>

        {/* Diamond Icon */}
        <div
          draggable
          onDragStart={() => handleDragStart('diamond')}
          onDragEnd={handleDragEnd}
          className="w-14 h-14 cursor-grab active:cursor-grabbing hover:bg-accent rounded-lg flex items-center justify-center transition-colors"
          title="Diamond Node (1 input, 1 output)"
        >
          <div className="w-8 h-8 bg-green-500 rotate-45 border-2 border-green-700"></div>
        </div>

        {/* Circle Icon */}
        <div
          draggable
          onDragStart={() => handleDragStart('circle')}
          onDragEnd={handleDragEnd}
          className="w-14 h-14 cursor-grab active:cursor-grabbing hover:bg-accent rounded-lg flex items-center justify-center transition-colors"
          title="Circle Node (0 inputs, 1 output)"
        >
          <div className="w-8 h-8 bg-orange-500 rounded-full border-2 border-orange-700"></div>
        </div>
      </div>

      {/* Drawflow Canvas */}
      <div className="flex-1 relative">
        {isDisabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-card z-10">
            <div className="text-center text-muted-foreground">
              <p className="text-lg mb-2">No Workflow Selected</p>
              <p className="text-sm">Create or select a workflow to start building</p>
            </div>
          </div>
        )}
        <div
          ref={containerRef}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full h-full"
          id="drawflow"
        />
      </div>
    </div>
  );
}
