'use client';

import { useCallback, useEffect, useState } from 'react';

export interface NotesState {
  /** Latest notes for the project ('' when none / no project). */
  content: string;
  isLoading: boolean;
  /** Editor onChange: keep `content` current and persist to the server. */
  onChange: (content: string) => Promise<void>;
}

/**
 * Per-project notes: loads when `projectPath` changes, saves on change.
 *
 * Call this from a component that STAYS MOUNTED (not from NotesView, which is
 * mounted only while its tab is selected). When the notes editor unmounts it
 * flushes its pending debounced edit through onChange; that must land in state
 * that outlives the view, so reopening Notes shows it immediately instead of
 * refetching — a refetch would race the flushed save and could show (then
 * re-save over) the older text.
 */
export function useNotes(projectPath: string | null): NotesState {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!projectPath) { setContent(''); return; }
      setIsLoading(true);
      try {
        const response = await fetch(`/api/notes?projectPath=${encodeURIComponent(projectPath)}`);
        const data = await response.json();
        if (response.ok) setContent(data.notes || '');
      } catch (error) {
        console.error('Error loading notes:', error);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [projectPath]);

  const onChange = useCallback(async (next: string) => {
    if (!projectPath) return;
    setContent(next);
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, notes: next }),
      });
    } catch (error) {
      console.error('Error saving notes:', error);
    }
  }, [projectPath]);

  return { content, isLoading, onChange };
}
