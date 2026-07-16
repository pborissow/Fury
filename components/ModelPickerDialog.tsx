'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Dialog, { ConfirmDialog } from '@/components/Dialog';
import { cacheRewriteCost, contextWindowFor, modelTierRank } from '@/lib/pricing';

/** Mirror of the SDK's ModelInfo — kept structural so this stays a client
 *  component without pulling the SDK (a node-only package) into the bundle. */
interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
}

interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  /** The model actually serving turns right now (from the session:model event).
   *  Ground truth for the "active" badge — see activeValue. */
  activeModel: string | null;
}

/**
 * The catalog's alias row for "whatever the provider default is".
 *
 * It is NOT a model: it arrives byte-identical to whichever real row it points
 * at (same resolvedModel, same description), differing only in displayName. So
 * it's dropped from the list — rendering it showed the same option twice — and
 * surfaced instead as a "(current default)" annotation on the row it resolves
 * to. Selecting that row maps to `model: null`, the SDK's documented
 * setModel(undefined), which leaves the session with no override so it keeps
 * following the default if that ever moves.
 */
const DEFAULT_VALUE = 'default';

export default function ModelPickerDialog({
  open,
  onOpenChange,
  sessionId,
  activeModel,
}: ModelPickerDialogProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [live, setLive] = useState(true);
  /** The session's saved override (undefined = none, i.e. following the default). */
  const [current, setCurrent] = useState<string | undefined>(undefined);
  /** The user's pick this time round; null until they touch a radio. Kept apart
   *  from `current` so the effective selection can fall back to the default row
   *  once the catalog lands — the fetch can't know it yet. */
  const [picked, setPicked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Current prompt occupancy, for the confirm step's cost + window checks. */
  const [contextTokens, setContextTokens] = useState(0);
  const [confirming, setConfirming] = useState(false);

  // Fetch on open. supportedModels() resolves from the SDK's cached initialize
  // response, so this is cheap enough to redo every time rather than holding a
  // list that goes stale after a provider/settings change.
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPicked(null);
    fetch(`/api/claude-sdk/model?sessionId=${encodeURIComponent(sessionId)}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) { setError(data.error); return; }
        setModels(data.models ?? []);
        setLive(data.live ?? false);
        setCurrent(data.current);
        setContextTokens(data.contextTokens ?? 0);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load models'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, sessionId]);

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

  /**
   * The row the `default` alias points at — badged "(current default)", and the
   * one that maps back to "no override". Null when the catalog ships no alias,
   * or it resolves to something not otherwise listed; then there's no
   * annotation and every pick is an explicit pin.
   */
  const defaultRowValue = useMemo(() => {
    const def = models.find(m => m.value === DEFAULT_VALUE);
    if (!def?.resolvedModel) return null;
    return rows.find(m => strip(m.resolvedModel) === strip(def.resolvedModel))?.value ?? null;
  }, [models, rows]);

  /** What's in force: the override, else the default row (which is what an
   *  override-less session actually runs). */
  const effectiveCurrent = current ?? defaultRowValue ?? null;
  const selected = picked ?? effectiveCurrent ?? '';

  /**
   * The single row to badge as "active".
   *
   * The context-variant suffix has to be normalised away: the catalog annotates
   * ('claude-opus-4-8[1m]') but the RUNNING model is reported without it
   * ('claude-opus-4-8' — see the init event, assistant messages, and the JSONL),
   * so a raw compare matches nothing and badges no row at all.
   *
   * Prefer the session's own override when it agrees with the live model;
   * otherwise fall back to the first row matching the live model — which is what
   * keeps this honest if a fallbackModel demotion swaps the model out from under
   * the override.
   */
  const activeValue = useMemo(() => {
    const active = strip(activeModel ?? undefined);
    const matches = (m: ModelInfo) =>
      active != null && (strip(m.value) === active || strip(m.resolvedModel) === active);
    if (effectiveCurrent) {
      const cur = rows.find(m => m.value === effectiveCurrent);
      if (cur && matches(cur)) return cur.value;
    }
    return rows.find(matches)?.value ?? null;
  }, [rows, effectiveCurrent, activeModel]);

  // --- Confirm-step facts, computed from the SELECTED row -------------------
  const selectedInfo = rows.find(m => m.value === selected);
  /** Wire id without the catalog's context-variant suffix — the pricing/window
   *  tables are keyed by bare ids. */
  const targetId = strip(selectedInfo?.resolvedModel || selectedInfo?.value) ?? '';
  const targetWindow = contextWindowFor(targetId);
  // null window = no published figure; stay silent rather than guess.
  const overflows = targetWindow != null && contextTokens > targetWindow;
  /** The charge you wouldn't have paid by staying put — a same-model turn reads
   *  the cache at ~1/20th of this. Null when the model has no published rate. */
  const rewriteCost = cacheRewriteCost(targetId, contextTokens);

  const fmtTokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

  const targetName = selectedInfo?.displayName ?? 'this model';

  /**
   * Disable Select only when applying would be a genuine no-op: the pick already
   * matches what's in force AND that's what's actually serving.
   *
   * After a fallbackModel demotion those diverge — the override still says Haiku
   * while something else runs — and re-applying it is meaningful, so the button
   * has to stay live or the user is stuck. When the live model is unknown
   * (activeValue null, e.g. no turn yet) there's nothing to disagree with, so
   * treat a matching pick as the no-op it is.
   */
  const unchanged =
    !!selected && selected === effectiveCurrent && (activeValue === null || activeValue === selected);

  const handleApply = useCallback(async () => {
    if (!sessionId) return;
    setConfirming(false);
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/claude-sdk/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          // Picking the default row means "follow the default", not "pin this
          // model" — clear the override rather than latching its current target.
          model: selected === defaultRowValue ? null : selected,
        }),
      });
      const data = await res.json();
      // A rejected model (bad id, or blocked by enforceAvailableModels) keeps
      // the dialog open with the reason — the switch didn't take, so closing
      // would imply it did.
      if (!res.ok || data.error) { setError(data.error || 'Failed to switch model'); return; }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch model');
    } finally {
      setApplying(false);
    }
  }, [sessionId, selected, defaultRowValue, onOpenChange]);

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select model"
      defaultWidth={460}
      defaultHeight={420}
      minWidth={360}
      minHeight={260}
      buttons={[
        { label: 'Cancel', onClick: () => onOpenChange(false), variant: 'ghost' },
        {
          label: applying ? 'Switching...' : 'Select',
          // Confirm first — a switch resets the prompt cache, so it's never free.
          onClick: () => setConfirming(true),
          disabled: applying || loading || unchanged,
        },
      ]}
    >
      <div className="space-y-2">
        {loading && <div className="text-xs text-muted-foreground">Loading models...</div>}

        {error && (
          <div className="text-xs text-destructive px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30">
            {error}
          </div>
        )}

        {!loading && !live && rows.length > 0 && (
          <div className="text-[10px] text-muted-foreground">
            Showing the last known model list — this session has no running process yet.
            Your choice applies when it starts.
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="text-xs text-muted-foreground">
            No model list available yet. Send a message first — the list loads when the session starts.
          </div>
        )}

        {rows.map(m => {
          const isSelected = selected === m.value;
          return (
            <label
              key={m.value}
              className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent/50'
              }`}
            >
              <input
                type="radio"
                name="model-picker"
                checked={isSelected}
                onChange={() => setPicked(m.value)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  {m.displayName}
                  {activeValue === m.value && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400 bg-green-950/60 border border-green-700/50 rounded px-1.5 py-0.5">
                      active
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

    {/* Always confirm: a model switch invalidates the prompt cache in full
        (caches are model-scoped, and a model change invalidates the tools,
        system AND messages tiers), so the next turn re-processes the entire
        conversation as a cache write instead of a ~20x cheaper cache read.
        That cost is invisible at the moment of clicking and only shows up
        later as a cache_write spike in Stats. */}
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
            // Deliberately describes the mismatch, not the outcome: we haven't
            // verified what the CLI does when a session outgrows the window.
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
