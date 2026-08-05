'use client';

import React, { useCallback } from 'react';
import Dialog from '@/components/Dialog';
import { shortenPath } from '@/lib/utils';
import { useModelCatalog } from '@/components/useModelCatalog';
import ModelFamilyRows from '@/components/ModelFamilyRows';

interface NewSessionModelStepProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Return to the directory step (step a). */
  onBack: () => void;
  /** Commit the choice and create the session.
   *  @param model         the value to pin, or `null` to follow the provider
   *                       default (no override).
   *  @param resolvedModel the picked row's wire model id (e.g.
   *                       "claude-haiku-4-5-20251001"), for the status-bar label
   *                       so it reflects the choice before the first turn's init
   *                       event lands. `null` when following the default. */
  onCreate: (model: string | null, resolvedModel: string | null) => void;
  /** The directory chosen in step (a), shown for context. */
  directory?: string;
}

/**
 * Step (b) of the new-session wizard: pick the model + version the first prompt
 * runs on. Shares the family/version rows, catalog loading, and selection logic
 * with ModelPickerDialog via useModelCatalog + ModelFamilyRows, so the two views
 * stay in lockstep.
 *
 * Unlike ModelPickerDialog there is no session yet — nothing is running, so there
 * is no prompt cache to invalidate and the cost/confirm step is deliberately
 * omitted. Passing `sessionId: null` puts the hook in warm-catalog mode.
 */
export default function NewSessionModelStep({
  open,
  onOpenChange,
  onBack,
  onCreate,
  directory,
}: NewSessionModelStepProps) {
  const catalog = useModelCatalog({ open, sessionId: null });
  const { selection, loading } = catalog;

  const handleCreate = useCallback(() => {
    // Picking the default row means "follow the default" (model=null), but still
    // surface the concrete wire id as the label so the status bar names the real
    // model until the first turn's session:model init event lands.
    //
    // Coerce an EMPTY selection to null too (P12): with an empty catalog there is no
    // selectedGroup, so selection.id === '' and selection.isDefault === false —
    // without this we'd pin an empty-string model instead of following the default.
    const pinned = selection.isDefault || !selection.id ? null : selection.id;
    onCreate(pinned, selection.id || null);
    onOpenChange(false);
  }, [selection.isDefault, selection.id, onCreate, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select model"
      defaultWidth={620}
      defaultHeight={520}
      minWidth={460}
      minHeight={360}
      buttons={[
        { label: '← Back', onClick: onBack, variant: 'ghost' },
        {
          // Even with an empty catalog the user can proceed: the session is created
          // on the default model and stays changeable once the first turn opens the
          // picker.
          label: 'Create session',
          onClick: handleCreate,
          disabled: loading,
        },
      ]}
    >
      {directory && (
        <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-2 text-xs text-muted-foreground border-b border-border">
          New session in <span className="font-mono text-foreground">{shortenPath(directory)}</span>
        </div>
      )}
      <ModelFamilyRows
        catalog={catalog}
        radioName="new-session-model"
        emptyHint="No model list available. You can still create the session — it will use the default model, and you can change it once the first turn starts."
      />
    </Dialog>
  );
}
