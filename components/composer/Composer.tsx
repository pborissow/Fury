'use client';

import { forwardRef, type ReactNode } from 'react';
import RichTextEditor, { type RichTextEditorHandle } from '@/components/RichTextEditor';
import AttachmentStrip from './AttachmentStrip';
import type { ComposerAttachments } from './useComposerAttachments';

export interface ComposerProps {
  /** Receives the editor text. Attachments aren't passed — the owner reads them
   *  from the same state it passed in as `attachments`. */
  onSubmit: (text: string) => void;
  /** Base placeholder; the key hint is appended according to `submitOnEnter`. */
  placeholder?: string;
  /** Enter sends (default). False: Enter is a new line and the button sends. */
  submitOnEnter?: boolean;
  disabled?: boolean;
  isProcessing?: boolean;
  onStop?: () => void;
  submitLabel?: string;
  /** Controlled attachment state (useComposerAttachments). Omit for a
   *  text-only composer: no chips, and paste/drop inlines as before. */
  attachments?: Pick<ComposerAttachments, 'images' | 'error' | 'add' | 'remove'>;
  /** Accept new paste/drop images into `attachments` (default true). Already
   *  staged images still show — and send — when false. */
  acceptImages?: boolean;
  /** Rendered under the attachments, e.g. the Chat tab's model label. */
  footer?: ReactNode;
}

/**
 * Chat input: RichTextEditor + staged-image strip + footer slot. Forwards the
 * editor's RichTextEditorHandle (drafts use setContent/getContent). Knows
 * nothing about the Chat tab; the transcript/composer split is the caller's.
 */
const Composer = forwardRef<RichTextEditorHandle, ComposerProps>(function Composer({
  onSubmit,
  placeholder = '',
  submitOnEnter = true,
  disabled,
  isProcessing,
  onStop,
  submitLabel,
  attachments,
  acceptImages = true,
  footer,
}, ref) {
  const images = attachments?.images ?? [];
  const error = attachments?.error ?? null;
  const hint = submitOnEnter ? ' (Enter to send, Shift+Enter for new line)' : '';

  return (
    <RichTextEditor
      ref={ref}
      onSubmit={onSubmit}
      placeholder={`${placeholder}${hint}`}
      submitOnEnter={submitOnEnter}
      disabled={disabled}
      submitLabel={submitLabel}
      isProcessing={isProcessing}
      onStop={onStop}
      onImagesAdded={attachments && acceptImages ? attachments.add : undefined}
      hasAttachments={images.length > 0}
      statusBar={(images.length > 0 || error || footer) ? (
        <div>
          {attachments && <AttachmentStrip images={images} error={error} onRemove={attachments.remove} />}
          {footer}
        </div>
      ) : undefined}
    />
  );
});

export default Composer;
