'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import Dialog, { ConfirmDialog } from '@/components/Dialog';
import { Input } from '@/components/ui/input';
import RichTextEditor from '@/components/RichTextEditor';
import { Plus, Trash2, Edit, Copy } from 'lucide-react';

interface Prompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface PromptsPanelProps {
  onInsertPrompt?: (content: string) => void;
}

export function PromptsPanel({ onInsertPrompt }: PromptsPanelProps) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [promptName, setPromptName] = useState('');
  const [promptContent, setPromptContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Load prompts on mount
  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/prompts');
      const data = await res.json();
      if (data.success) {
        setPrompts(data.prompts || []);
      }
    } catch (error) {
      console.error('Error loading prompts:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreatePrompt = () => {
    setPromptName('');
    setPromptContent('');
    setShowCreateModal(true);
  };

  const handleSaveNewPrompt = async () => {
    if (!promptName.trim() || !promptContent.trim()) {
      return;
    }

    try {
      setIsSaving(true);
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: promptName,
          content: promptContent,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setPrompts((prev) => [data.prompt, ...prev]);
        setShowCreateModal(false);
        setPromptName('');
        setPromptContent('');
      }
    } catch (error) {
      console.error('Error creating prompt:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditPrompt = (prompt: Prompt) => {
    setSelectedPrompt(prompt);
    setPromptName(prompt.name);
    setPromptContent(prompt.content);
    setShowEditModal(true);
  };

  const handleSaveEditedPrompt = async () => {
    if (!selectedPrompt || !promptName.trim() || !promptContent.trim()) {
      return;
    }

    try {
      setIsSaving(true);
      const res = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedPrompt.id,
          name: promptName,
          content: promptContent,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setPrompts((prev) =>
          prev.map((p) => (p.id === selectedPrompt.id ? data.prompt : p))
        );
        setShowEditModal(false);
        setSelectedPrompt(null);
        setPromptName('');
        setPromptContent('');
      }
    } catch (error) {
      console.error('Error updating prompt:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePrompt = (prompt: Prompt) => {
    setSelectedPrompt(prompt);
    setShowDeleteDialog(true);
  };

  const confirmDeletePrompt = async () => {
    if (!selectedPrompt) return;

    try {
      const res = await fetch(`/api/prompts?id=${selectedPrompt.id}`, {
        method: 'DELETE',
      });

      const data = await res.json();
      if (data.success) {
        setPrompts((prev) => prev.filter((p) => p.id !== selectedPrompt.id));
        setShowDeleteDialog(false);
        setSelectedPrompt(null);
      }
    } catch (error) {
      console.error('Error deleting prompt:', error);
    }
  };

  const handleCopyPrompt = async (prompt: Prompt) => {
    if (onInsertPrompt) {
      onInsertPrompt(prompt.content);
    } else {
      // Fallback to clipboard copy
      try {
        await navigator.clipboard.writeText(prompt.content);
      } catch (error) {
        console.error('Error copying prompt:', error);
      }
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

    if (diffInDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInDays === 1) {
      return 'Yesterday';
    } else if (diffInDays < 7) {
      return `${diffInDays} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h3 className="font-semibold text-sm">Prompts</h3>
        <Button
          size="sm"
          onClick={handleCreatePrompt}
          className="h-8 flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          New Prompt
        </Button>
      </div>

      {/* Prompts List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            Loading prompts...
          </div>
        ) : prompts.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            No prompts yet. Create your first prompt!
          </div>
        ) : (
          <div className="space-y-2">
            {prompts.map((prompt) => (
              <div
                key={prompt.id}
                className="p-3 border border-border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm truncate">
                      {prompt.name}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(prompt.updatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => handleCopyPrompt(prompt)}
                      title="Use prompt"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => handleEditPrompt(prompt)}
                      title="Edit prompt"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 hover:bg-destructive/10"
                      onClick={() => handleDeletePrompt(prompt)}
                      title="Delete prompt"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {prompt.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Dialog
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        title="Create New Prompt"
        defaultWidth={720}
        defaultHeight={500}
        minWidth={500}
        minHeight={350}
        buttons={[
          { label: 'Cancel', onClick: () => { setShowCreateModal(false); setPromptName(''); setPromptContent(''); }, variant: 'outline' },
          { label: isSaving ? 'Creating...' : 'Create Prompt', onClick: handleSaveNewPrompt, disabled: !promptName.trim() || !promptContent.trim() || isSaving },
        ]}
      >
        <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-4 text-sm text-muted-foreground border-b border-border">
          Create a reusable prompt template that you can use in your chats.
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">
              Prompt Name
            </label>
            <Input
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
              placeholder="Enter a name for this prompt..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">
              Prompt Content
            </label>
            <div className="border border-border rounded-lg overflow-hidden">
              <RichTextEditor
                initialContent={promptContent}
                onChange={setPromptContent}
                onSubmit={() => {}}
                placeholder="Enter your prompt text here..."
                persistContent={true}
                showButtonBar={true}
              />
            </div>
          </div>
        </div>
      </Dialog>

      {/* Edit Modal */}
      <Dialog
        open={showEditModal}
        onOpenChange={setShowEditModal}
        title="Edit Prompt"
        defaultWidth={720}
        defaultHeight={500}
        minWidth={500}
        minHeight={350}
        buttons={[
          { label: 'Cancel', onClick: () => { setShowEditModal(false); setSelectedPrompt(null); setPromptName(''); setPromptContent(''); }, variant: 'outline' },
          { label: isSaving ? 'Saving...' : 'Save Changes', onClick: handleSaveEditedPrompt, disabled: !promptName.trim() || !promptContent.trim() || isSaving },
        ]}
      >
        <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-4 text-sm text-muted-foreground border-b border-border">
          Update your prompt template.
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">
              Prompt Name
            </label>
            <Input
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
              placeholder="Enter a name for this prompt..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">
              Prompt Content
            </label>
            <div className="border border-border rounded-lg overflow-hidden">
              <RichTextEditor
                key={selectedPrompt?.id}
                initialContent={promptContent}
                onChange={setPromptContent}
                onSubmit={() => {}}
                placeholder="Enter your prompt text here..."
                persistContent={true}
                showButtonBar={true}
              />
            </div>
          </div>
        </div>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete prompt?"
        message={<>This will permanently delete &quot;{selectedPrompt?.name}&quot;. This action cannot be undone.</>}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={confirmDeletePrompt}
        onCancel={() => { setShowDeleteDialog(false); setSelectedPrompt(null); }}
      />
    </div>
  );
}
