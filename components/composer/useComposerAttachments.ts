'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { normalizeImage, type AttachedImage } from '@/lib/clientImage';
import { appendImages, removeImage, stageFiles } from './attachments';

export interface ComposerAttachments {
  /** Images staged for the next send. */
  images: AttachedImage[];
  /** Why the last paste/drop was (partially) rejected — shown beside the chips. */
  error: string | null;
  /** Paste/drop handler: normalize + stage (capped), surfacing failures. */
  add: (files: File[]) => Promise<void>;
  remove: (id: string) => void;
  /** Drop all staged images and the error (a normal send). */
  clear: () => void;
  clearError: () => void;
  /** Replace the staged images — per-session draft restore, or putting a failed
   *  send's images back (pass an updater, see prependImages). */
  set: Dispatch<SetStateAction<AttachedImage[]>>;
}

/**
 * Controlled image-attachment state for a Composer. The owner holds it (not the
 * Composer) because it outlives editor clears and travels with per-session
 * drafts and the limit auto-resend.
 */
export function useComposerAttachments(): ComposerAttachments {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async (files: File[]) => {
    const { added, error: failure } = await stageFiles(files, normalizeImage);
    setError(failure);
    if (added.length === 0) return;
    setImages(prev => appendImages(prev, added));
  }, []);

  const remove = useCallback((id: string) => {
    setImages(prev => removeImage(prev, id));
  }, []);

  const clear = useCallback(() => {
    setImages([]);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { images, error, add, remove, clear, clearError, set: setImages };
}
