'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Dialog from '@/components/Dialog';
import { modelTierRank } from '@/lib/pricing';
import { shortenPath } from '@/lib/utils';

/** Mirror of the SDK's ModelInfo — kept structural so this stays a client
 *  component without pulling the SDK (a node-only package) into the bundle.
 *  Matches components/ModelPickerDialog.tsx. */
interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
}

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

/** The catalog's alias row for "whatever the provider default is" — see
 *  ModelPickerDialog for the full rationale. Selecting it maps to `null`. */
const DEFAULT_VALUE = 'default';

/**
 * Step (b) of the new-session wizard: pick the model the first prompt runs on.
 *
 * Unlike ModelPickerDialog (mid-session switching), there is no session yet and
 * nothing is running, so there is no prompt-cache to invalidate — the
 * cost/confirm step is deliberately omitted. The catalog is fetched from the
 * session-less GET /api/claude-sdk/model, which warms it when cold.
 */
export default function NewSessionModelStep({
  open,
  onOpenChange,
  onBack,
  onCreate,
  directory,
}: NewSessionModelStepProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** The user's pick; null until they touch a radio, then falls back to the
   *  default row once the catalog lands. */
  const [picked, setPicked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPicked(null);
    // No sessionId: the wizard runs before a session exists, so this warms and
    // returns the catalog alone.
    fetch('/api/claude-sdk/model')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) { setError(data.error); return; }
        setModels(data.models ?? []);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load models'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open]);

  const strip = (v: string | undefined) => v?.replace(/\[[^\]]*\]/g, '');

  /** Real models only, most capable first (fable → opus → sonnet → haiku). */
  const rows = useMemo(
    () =>
      models
        .filter(m => m.value !== DEFAULT_VALUE)
        .sort(
          (a, b) =>
            modelTierRank(a.resolvedModel ?? a.value) - modelTierRank(b.resolvedModel ?? b.value),
        ),
    [models],
  );

  /** The row the `default` alias resolves to — badged "(default)" and mapped
   *  back to "no override". Null when the catalog ships no alias. */
  const defaultRowValue = useMemo(() => {
    const def = models.find(m => m.value === DEFAULT_VALUE);
    if (!def?.resolvedModel) return null;
    return rows.find(m => strip(m.resolvedModel) === strip(def.resolvedModel))?.value ?? null;
  }, [models, rows]);

  /** Preselect the provider default; else the first (most capable) row. */
  const selected = picked ?? defaultRowValue ?? rows[0]?.value ?? '';

  const handleCreate = useCallback(() => {
    // Picking the default row means "follow the default", not "pin it": clear the
    // override (model=null). But still surface the default's CONCRETE wire id as
    // the label — the wizard already knows what the default resolves to — so the
    // status bar names the real model instead of a bare "Claude (Anthropic)"
    // until the first turn's session:model init event lands. `resolvedModel` is
    // label-only; it does not pin an override.
    const isDefault = !selected || selected === defaultRowValue;
    const resolved = rows.find(m => m.value === selected)?.resolvedModel ?? (selected || null);
    onCreate(isDefault ? null : selected, resolved);
    onOpenChange(false);
  }, [selected, defaultRowValue, rows, onCreate, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select model"
      defaultWidth={460}
      defaultHeight={440}
      minWidth={360}
      minHeight={280}
      buttons={[
        { label: '← Back', onClick: onBack, variant: 'ghost' },
        {
          // Even with an empty catalog (warm failed) the user can proceed: the
          // session is created on the default model and stays changeable once
          // the first turn opens the picker.
          label: 'Create session',
          onClick: handleCreate,
          disabled: loading,
        },
      ]}
    >
      <div className="space-y-2">
        {directory && (
          <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-2 text-xs text-muted-foreground border-b border-border">
            New session in <span className="font-mono text-foreground">{shortenPath(directory)}</span>
          </div>
        )}

        {loading && <div className="text-xs text-muted-foreground">Loading models...</div>}

        {error && (
          <div className="text-xs text-destructive px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30">
            {error}
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="text-xs text-muted-foreground">
            No model list available. You can still create the session — it will use the default
            model, and you can change it once the first turn starts.
          </div>
        )}

        {rows.map(m => {
          const isSelected = selected === m.value;
          const isDefault = m.value === defaultRowValue;
          return (
            <label
              key={m.value}
              className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
              }`}
            >
              <input
                type="radio"
                name="new-session-model"
                checked={isSelected}
                onChange={() => setPicked(m.value)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  {m.displayName}
                  {isDefault && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted border border-border rounded px-1.5 py-0.5">
                      default
                    </span>
                  )}
                </div>
                {m.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">{m.description}</div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}
