'use client';

import { useRef, type RefObject } from 'react';
import type { RichTextEditorHandle } from '@/components/RichTextEditor';
import type { ComposerAttachments } from '@/components/composer/useComposerAttachments';
import type { AttachedImage } from '@/lib/clientImage';

/**
 * Unsent composer state per session: editor HTML + staged image attachments.
 * Attachments MUST travel with the text — stashing only the HTML left the images
 * behind on switch, so a pasted image followed the user into the next session
 * (and got sent with, or cleared by, that session's next turn). Same family of
 * bug as the AskUserQuestion draft store in AskUserQuestionDialog.tsx.
 *
 * Every navigation path must call `stash` (for the session being left) and
 * `restore` (for the session being opened) as a pair.
 */
export function useSessionDrafts(
  editorRef: RefObject<RichTextEditorHandle | null>,
  attachments: Pick<ComposerAttachments, 'images' | 'set' | 'clearError'>,
) {
  const draftsRef = useRef<Map<string, { html: string; images: AttachedImage[] }>>(new Map());

  /** Save the composer (editor + attachment chips) as `sessionId`'s draft —
   *  the session being left. */
  const stash = (sessionId: string | null) => {
    if (!sessionId || !editorRef.current) return;
    const html = editorRef.current.getContent();
    const hasText = !!(editorRef.current.getPlainText?.()?.trim?.() || html.replace(/<[^>]*>/g, '').trim());
    if (hasText || attachments.images.length > 0) {
      draftsRef.current.set(sessionId, { html: hasText ? html : '', images: attachments.images });
    } else {
      draftsRef.current.delete(sessionId);
    }
  };

  /** Restore (or clear) the composer for the session being switched TO. A
   *  session with no stashed draft gets an empty editor and NO chips — a new or
   *  clean session must never inherit another session's attachments. */
  const restore = (targetSessionId: string) => {
    const draft = draftsRef.current.get(targetSessionId);
    attachments.set(draft?.images || []);
    attachments.clearError();
    setTimeout(() => editorRef.current?.setContent(draft?.html || ''), 50);
  };

  /** Forget a session's draft (it was just sent). */
  const discard = (targetSessionId: string) => {
    draftsRef.current.delete(targetSessionId);
  };

  return { stash, restore, discard };
}

export type SessionDrafts = ReturnType<typeof useSessionDrafts>;
