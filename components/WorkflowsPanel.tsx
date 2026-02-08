'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Trash2, Edit2, Download } from 'lucide-react';

interface Workflow {
  id: string;
  name: string;
  data: any;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowsPanelProps {
  activeWorkflowId: string | null;
  onWorkflowSelect: (id: string) => void;
  onWorkflowLoad: (workflow: Workflow) => void;
  onSaveWorkflow: (name: string, data: any) => void;
  getCurrentFlowData: () => any;
}

export default function WorkflowsPanel({
  activeWorkflowId,
  onWorkflowSelect,
  onWorkflowLoad,
  onSaveWorkflow,
  getCurrentFlowData,
}: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('');

  // Load workflows from server
  useEffect(() => {
    loadWorkflows();
  }, []);

  const loadWorkflows = async () => {
    try {
      const res = await fetch('/api/workflows');
      if (res.ok) {
        const data = await res.json();
        setWorkflows(data.workflows || []);
      }
    } catch (error) {
      console.error('Failed to load workflows:', error);
    }
  };

  const handleCreateNew = () => {
    setWorkflowName('');
    setEditingWorkflowId(null);
    setShowSaveDialog(true);
  };

  const handleSave = async () => {
    if (!workflowName.trim()) return;

    // Get empty workflow structure for new workflows
    const flowData = {
      drawflow: {
        Home: {
          data: {}
        }
      }
    };

    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: workflowName,
          data: flowData,
        }),
      });

      if (res.ok) {
        const newWorkflow = await res.json();
        setWorkflows([...workflows, newWorkflow.workflow]);
        setShowSaveDialog(false);
        setWorkflowName('');
        // Set active workflow FIRST so auto-save will work
        onWorkflowSelect(newWorkflow.workflow.id);
        // Then load the workflow data
        onWorkflowLoad(newWorkflow.workflow);
      }
    } catch (error) {
      console.error('Failed to save workflow:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/workflows?id=${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setWorkflows(workflows.filter(w => w.id !== id));
        if (activeWorkflowId === id) {
          onWorkflowSelect('');
        }
      }
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    }
  };

  const handleRename = async () => {
    if (!editingWorkflowId || !workflowName.trim()) return;

    try {
      const res = await fetch('/api/workflows', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: editingWorkflowId,
          name: workflowName,
        }),
      });

      if (res.ok) {
        setWorkflows(workflows.map(w =>
          w.id === editingWorkflowId ? { ...w, name: workflowName } : w
        ));
        setShowEditDialog(false);
        setEditingWorkflowId(null);
        setWorkflowName('');
      }
    } catch (error) {
      console.error('Failed to rename workflow:', error);
    }
  };

  const handleLoad = async (workflow: Workflow) => {
    // IMPORTANT: Save current workflow BEFORE switching to prevent data loss
    if (activeWorkflowId && activeWorkflowId !== workflow.id) {
      console.log('[WorkflowsPanel] Saving current workflow before switching:', activeWorkflowId);
      try {
        const currentFlowData = getCurrentFlowData();
        await fetch('/api/workflows', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: activeWorkflowId,
            data: currentFlowData,
          }),
        });
        console.log('[WorkflowsPanel] Current workflow saved successfully');
      } catch (error) {
        console.error('[WorkflowsPanel] Failed to save current workflow:', error);
      }
    }

    // Set active workflow FIRST so auto-save will work
    onWorkflowSelect(workflow.id);

    // Always reload from server to get latest data
    try {
      const res = await fetch(`/api/workflows?id=${workflow.id}`);
      if (res.ok) {
        const data = await res.json();
        const freshWorkflow = data.workflow;

        if (freshWorkflow && freshWorkflow.id) {
          console.log('[WorkflowsPanel] Loaded workflow from server:', freshWorkflow.id);
          onWorkflowLoad(freshWorkflow);
        } else {
          console.warn('[WorkflowsPanel] Workflow data is invalid, using cached version');
          onWorkflowLoad(workflow);
        }
      } else {
        console.warn('[WorkflowsPanel] Failed to load workflow from server, using cached version');
        onWorkflowLoad(workflow);
      }
    } catch (error) {
      console.error('[WorkflowsPanel] Error loading workflow:', error);
      // Fallback to cached version
      onWorkflowLoad(workflow);
    }
  };

  return (
    <div className="h-full bg-card border-r border-border flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border flex justify-between items-center">
        <h2 className="text-foreground text-lg font-semibold">Workflows</h2>
        <Button
          onClick={handleCreateNew}
          variant="outline"
          size="sm"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Workflow List */}
      <div className="flex-1 overflow-y-auto p-2">
        {workflows.length === 0 && (
          <div className="text-center text-muted-foreground mt-8 text-sm">
            No workflows yet
          </div>
        )}

        {workflows.map((workflow) => (
          <div
            key={workflow.id}
            className={`mb-2 p-3 rounded border transition-colors cursor-pointer ${
              workflow.id === activeWorkflowId
                ? 'bg-primary/10 border-primary'
                : 'bg-muted border-border hover:border-ring'
            }`}
            onClick={() => handleLoad(workflow)}
          >
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm font-medium text-foreground truncate">
                {workflow.name}
              </span>
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() => {
                    setEditingWorkflowId(workflow.id);
                    setWorkflowName(workflow.name);
                    setShowEditDialog(true);
                  }}
                >
                  <Edit2 className="h-3 w-3" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete &ldquo;{workflow.name}&rdquo;. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDelete(workflow.id)}>
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {new Date(workflow.updatedAt).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>

      {/* Save Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workflow</DialogTitle>
            <DialogDescription>
              Enter a name for your new workflow
            </DialogDescription>
          </DialogHeader>
          <Input
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            placeholder="Workflow name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && workflowName.trim()) {
                handleSave();
              } else if (e.key === 'Escape') {
                setShowSaveDialog(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!workflowName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Workflow</DialogTitle>
            <DialogDescription>
              Enter a new name for this workflow
            </DialogDescription>
          </DialogHeader>
          <Input
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            placeholder="Workflow name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && workflowName.trim()) {
                handleRename();
              } else if (e.key === 'Escape') {
                setShowEditDialog(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={!workflowName.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
