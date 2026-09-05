'use client';

import React, { useCallback, useState } from 'react';
import Dialog from '@/components/Dialog';
import { AlertTriangleIcon } from 'lucide-react';
import { useModelCatalog, norm } from '@/components/useModelCatalog';
import ModelFamilyRows from '@/components/ModelFamilyRows';

export interface LimitReachedInfo {
  sessionId: string;
  /** The model that was limited (bare wire id), used to steer the user away. */
  limitedModel: string | null;
  /** The provider's own message, shown verbatim. */
  message: string;
}

interface LimitReachedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: LimitReachedInfo | null;
  /** True when a Bedrock fallback is configured AND enabled in settings. Only
   *  then is the Bedrock button live; otherwise a subtle "configure" hint shows. */
  bedrockConfigured: boolean;
  /** Switch the session to `model` (null = follow the provider default) and
   *  auto-resend the prompt that was limited. Owner does the setModel + resend. */
  onSwitchAndRetry: (model: string | null) => void | Promise<void>;
  /** Fail the session's provider over to the configured Bedrock fallback, then
   *  resend. Only invoked when `bedrockConfigured`. */
  onUseBedrock: () => void | Promise<void>;
  /** Open the settings panel at the Bedrock section (from the "configure" hint). */
  onOpenSettings?: () => void;
  /** A recovery error to show inline (e.g. the model switch was rejected) — the
   *  dialog stays open so the user can pick a different model. */
  error?: string | null;
}

/**
 * Raised when a turn hits a TERMINAL usage/rate limit on its model (server
 * `session:limit` event). Unlike the mid-session ModelPickerDialog this is a
 * RECOVERY flow: it names the limit, lets the user pick another model, and — via
 * onSwitchAndRetry — auto-resends the prompt that failed so the turn completes
 * with no retyping. Reuses the shared catalog + family rows so the picker matches
 * the rest of the app. "Ask every time": no remembered choice, no auto-switch.
 */
export default function LimitReachedDialog({
  open,
  onOpenChange,
  info,
  bedrockConfigured,
  onSwitchAndRetry,
  onUseBedrock,
  onOpenSettings,
  error,
}: LimitReachedDialogProps) {
  const sessionId = info?.sessionId ?? null;
  const limitedModel = info?.limitedModel ?? null;
  const catalog = useModelCatalog({ open, sessionId, activeModel: limitedModel });
  const { selection, loading, defaultNorm } = catalog;

  const [applying, setApplying] = useState(false);

  // Gate the primary button until the user picks a model that is NOT the limited
  // one (retrying it would just fail again). Compare the selection's EFFECTIVE
  // model: the default row resolves to `defaultNorm`, so when the limited model IS
  // the provider default, selecting default must count as same-as-limited too —
  // otherwise setModel(null) loops straight back onto the limited model.
  const limitedNorm = limitedModel ? norm(limitedModel) : '';
  const selectedEffectiveNorm = selection.isDefault ? (defaultNorm ?? '') : norm(selection.id);
  const sameAsLimited = !!limitedNorm && selectedEffectiveNorm === limitedNorm;

  const applyModel = selection.isDefault || !selection.id ? null : selection.id;

  const handleSwitch = useCallback(async () => {
    if (sameAsLimited) return;
    setApplying(true);
    try {
      await onSwitchAndRetry(applyModel);
    } finally {
      setApplying(false);
    }
  }, [applyModel, sameAsLimited, onSwitchAndRetry]);

  const handleBedrock = useCallback(async () => {
    setApplying(true);
    try {
      await onUseBedrock();
    } finally {
      setApplying(false);
    }
  }, [onUseBedrock]);

  const limitedLabel = limitedModel
    ? limitedModel.replace(/^claude-/, '').replace(/-/g, ' ')
    : 'this model';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangleIcon size={16} style={{ color: 'var(--warning, #d97706)' }} />
          Usage limit reached
        </span>
      }
      defaultWidth={520}
      defaultHeight={480}
      buttons={[
        {
          label: 'Not now',
          variant: 'ghost',
          onClick: () => onOpenChange(false),
          disabled: applying,
        },
        ...(bedrockConfigured
          ? [{
              label: 'Use Bedrock fallback',
              variant: 'secondary' as const,
              onClick: handleBedrock,
              disabled: applying,
            }]
          : []),
        {
          label: applying ? 'Switching…' : 'Switch & retry',
          variant: 'default' as const,
          onClick: handleSwitch,
          disabled: applying || loading || sameAsLimited,
        },
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          {info?.message || `You've reached your ${limitedLabel} limit.`}
        </p>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
          Pick another model to continue — your last message will be resent
          automatically on the model you choose.
        </p>

        <ModelFamilyRows
          catalog={catalog}
          radioName="limit-reached-model"
          emptyHint="No model catalog available. Pick the default to follow the provider default."
        />

        {sameAsLimited && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--warning, #d97706)' }}>
            That&apos;s the model that was just limited — choose a different one.
          </p>
        )}

        {error && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--destructive, #dc2626)' }}>
            {error}
          </p>
        )}

        {!bedrockConfigured && (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
            A Bedrock fallback isn&apos;t configured.{' '}
            {onOpenSettings && (
              <button
                type="button"
                onClick={() => { onOpenChange(false); onOpenSettings(); }}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent, #2563eb)', cursor: 'pointer',
                  textDecoration: 'underline', font: 'inherit',
                }}
              >
                Configure it in Settings
              </button>
            )}{' '}
            to enable automatic provider failover.
          </p>
        )}
      </div>
    </Dialog>
  );
}
