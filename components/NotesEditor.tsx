'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading2,
  Quote,
  Undo,
  Redo,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NotesEditorProps {
  sessionId: string | null;
  disabled?: boolean;
}

export default function NotesEditor({ sessionId, disabled = false }: NotesEditorProps) {
  const [notes, setNotes] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: 'Write your notes here...',
      }),
    ],
    content: notes,
    editable: !disabled && !!sessionId,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setNotes(html);

      // Auto-save after 2 seconds of inactivity
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        if (sessionId) {
          saveNotes(html);
        }
      }, 2000);
    },
  });

  // Load notes when session changes
  useEffect(() => {
    if (!editor) return;

    if (!sessionId) {
      editor.commands.setContent('');
      setNotes('');
      setLastSaved(null);
      return;
    }

    const loadNotes = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/notes?sessionId=${encodeURIComponent(sessionId)}`);
        const data = await response.json();

        if (response.ok) {
          const content = data.notes || '';
          setNotes(content);
          editor.commands.setContent(content);
        }
      } catch (error) {
        console.error('Error loading notes:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Save notes function
  const saveNotes = async (content: string) => {
    if (!sessionId) return;

    setIsSaving(true);
    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          notes: content,
        }),
      });

      if (response.ok) {
        setLastSaved(new Date());
      }
    } catch (error) {
      console.error('Error saving notes:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  if (!editor) {
    return null;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="border-b border-border p-2 flex items-center gap-1 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('bold') ? 'bg-muted' : ''}
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('italic') ? 'bg-muted' : ''}
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('heading', { level: 2 }) ? 'bg-muted' : ''}
        >
          <Heading2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('bulletList') ? 'bg-muted' : ''}
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('orderedList') ? 'bg-muted' : ''}
        >
          <ListOrdered className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          disabled={disabled || !sessionId}
          className={editor.isActive('blockquote') ? 'bg-muted' : ''}
        >
          <Quote className="h-4 w-4" />
        </Button>
        <div className="w-px h-6 bg-border mx-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={disabled || !sessionId || !editor.can().undo()}
        >
          <Undo className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={disabled || !sessionId || !editor.can().redo()}
        >
          <Redo className="h-4 w-4" />
        </Button>

        {/* Save status */}
        <div className="ml-auto text-xs text-muted-foreground flex items-center gap-2">
          {isSaving && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Saving...</span>
            </>
          )}
          {!isSaving && lastSaved && (
            <span>
              Saved at {lastSaved.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      </div>

      {/* Editor Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading notes...</span>
          </div>
        ) : (
          <EditorContent
            editor={editor}
            className="h-full prose prose-sm max-w-none p-4 focus:outline-none"
          />
        )}
      </div>
    </div>
  );
}
