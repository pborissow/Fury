'use client';

import React, { useCallback, useState } from 'react';
import Dialog, { ConfirmDialog } from '@/components/Dialog';
import { cacheRewriteCost, contextWindowFor } from '@/lib/pricing';
import { useModelCatalog } from '@/components/useModelCatalog';
import ModelFamilyRows from '@/components/ModelFamilyRows';

interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  /** The model actually serving turns right now (from the session:model event).
   *  Ground truth for the "active" badge. Reported as a bare wire id. */
  activeModel: string | null;
}

/**
 * Mid-session model switcher. The family/version rows, catalog loading, and
 * selection logic live in the shared useModelCatalog hook + ModelFamilyRows
 * component (also used by NewSessionModelStep). This dialog owns only what's
 * specific to switching a LIVE session: the always-confirm cache-cost step and the
 * setModel POST.
 */
export default function ModelPickerDialog({
  open,
  onOpenChange,
  sessionId,
  activeModel,
}: ModelPickerDialogProps) {
  const catalog = useModelCatalog({ open, sessionId, activeModel });
  const { selection, contextTokens, unchanged, loading } = catalog;

  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // --- confirm-step facts, from the SELECTED version -------------------------
  const targetName = selection.version?.displayName ?? 'this model';
  // Prefer the API's own context window; fall back to the static table.
  const targetWindow = selection.version?.maxInputTokens ?? contextWindowFor(selection.id);
  const overflows = targetWindow != null && contextTokens > targetWindow;
  const rewriteCost = cacheRewriteCost(selection.id, contextTokens);

  const fmtTokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

  const handleApply = useCallback(async () => {
    if (!sessionId) return;
    setConfirming(false);
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/claude-sdk/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The default-resolved version means "follow the default" (clear the
        // override); anything else pins that exact version. An EMPTY selection (no
        // catalog) also means "follow the default", not a literal empty-string pin (P12).
        body: JSON.stringify({ sessionId, model: selection.isDefault || !selection.id ? null : selection.id }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || 'Failed to switch model'); return; }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch model');
    } finally {
      setApplying(false);
    }
  }, [sessionId, selection.id, selection.isDefault, onOpenChange]);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Select model"
        defaultWidth={620}
        defaultHeight={520}
        minWidth={460}
        minHeight={360}
        buttons={[
          { label: 'Cancel', onClick: () => onOpenChange(false), variant: 'ghost' },
          {
            label: applying ? 'Switching...' : 'Select',
            onClick: () => setConfirming(true),
            // Also disabled when there's no real selection (empty catalog): there's
            // nothing to pin, and proceeding would post an empty-string model (P12).
            disabled: applying || loading || unchanged || !selection.id,
          },
        ]}
      >
        {error && (
          <div className="text-xs text-destructive px-3 py-2 mb-2 rounded-md bg-destructive/10 border border-destructive/30">
            {error}
          </div>
        )}
        <ModelFamilyRows
          catalog={catalog}
          radioName="model-picker"
          emptyHint="No model list available yet. Send a message first, or refresh the list below."
        />
      </Dialog>

      {/* Always confirm: a model switch invalidates the prompt cache in full (caches
          are model-scoped), so the next turn re-processes the whole conversation as a
          cache write instead of a ~20x cheaper cache read. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Switch to ${targetName}?`}
        confirmLabel="Switch"
        confirmVariant={overflows ? 'destructive' : 'default'}
        onCancel={() => setConfirming(false)}
        onConfirm={handleApply}
        message={
          <div className="space-y-3">
            <div>
              The conversation is kept, but its prompt cache is not — caches are
              per-model, so the next turn re-processes the whole conversation at
              cache-write rates instead of reading it back.
            </div>
            {contextTokens > 0 && (
              <div>
                About <span className="font-medium">{fmtTokens(contextTokens)} tokens</span> to
                re-process
                {rewriteCost != null && (
                  <> — roughly <span className="font-medium">${rewriteCost.toFixed(2)}</span> on {targetName}</>
                )}
                .
              </div>
            )}
            {overflows && targetWindow != null && (
              <div className="text-xs px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30">
                This session already holds ~{fmtTokens(contextTokens)} tokens, which exceeds{' '}
                {targetName}&apos;s {fmtTokens(targetWindow)} context window. Older turns may be
                compacted or dropped to fit.
              </div>
            )}
          </div>
        }
      />
    </>
  );
}
