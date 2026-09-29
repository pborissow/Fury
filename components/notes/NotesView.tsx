'use client';

import RichTextEditor from '@/components/RichTextEditor';
import type { NotesState } from './useNotes';

interface NotesViewProps {
  projectPath: string | null;
  /** From useNotes(projectPath), called by a component that stays mounted —
   *  see useNotes for why the state can't live in this view. */
  notes: NotesState;
}

/** Per-project notes editor (auto-saves, 2s debounce). Remounts per project. */
export default function NotesView({ projectPath, notes }: NotesViewProps) {
  return (
    <div className="flex-1 overflow-hidden p-4">
      {notes.isLoading ? (
        <div className="flex items-center justify-center h-full text-muted-foreground">Loading notes...</div>
      ) : (
        <RichTextEditor
          key={projectPath || 'no-project'}
          initialContent={notes.content}
          onChange={notes.onChange}
          onSubmit={() => {}}
          placeholder={projectPath ? "Write your notes here..." : "Select a session with a project directory to use notes"}
          disabled={!projectPath}
          persistContent={true}
          showButtonBar={false}
          debounceMs={2000}
        />
      )}
    </div>
  );
}
