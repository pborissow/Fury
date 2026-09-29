'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Which session the Chat tab is showing, and its project directory.
 *
 * Split out so the hooks that need the viewed session (question dialog, limit
 * recovery, drafts) don't depend on the session stream, which in turn depends on
 * them.
 */
export function useViewedSession() {
  const [id, setId] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);

  /** The viewed session for async guards ("is this response still for the
   *  session on screen?"). Set SYNCHRONOUSLY by `select` — before the state
   *  commits — so a previous session's in-flight handlers stop at once. */
  const activeSessionRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionRef.current = id;
  }, [id]);

  /** Mirror of `id` for long-lived handlers (e.g. the global SSE chime rule). */
  const idRef = useRef<string | null>(null);
  useEffect(() => {
    idRef.current = id;
  }, [id]);

  /** Show `sessionId` (in `projectPath`). */
  const select = useCallback((sessionId: string, projectPath: string) => {
    activeSessionRef.current = sessionId;
    setId(sessionId);
    setProject(projectPath);
  }, []);

  /** Show no session (the welcome screen). */
  const clear = useCallback(() => setId(null), []);

  return { id, project, activeSessionRef, idRef, select, clear };
}

export type ViewedSession = ReturnType<typeof useViewedSession>;
