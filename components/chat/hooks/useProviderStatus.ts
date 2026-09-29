'use client';

import { useCallback, useState } from 'react';
import { formatModelName } from '@/lib/formatModelName';

type ProviderStatusPayload = {
  current?: string;
  bedrockEnv?: Record<string, string>;
  failoverConfigured?: boolean;
};

/**
 * Provider (Anthropic / Bedrock) + model state behind the composer's status
 * label and the limit dialog's Bedrock button.
 */
export function useProviderStatus() {
  const [source, setSource] = useState<'Anthropic' | 'Bedrock' | null>(null);
  const [configuredModel, setConfiguredModel] = useState<string | null>(null);
  /** The viewed session's model (CLI init event, last turn, or a pick). */
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  /** An automatic Bedrock failover is enabled AND configured. */
  const [failoverConfigured, setFailoverConfigured] = useState(false);

  // One definition, reused by the SSE effect and the limit dialog (which used to
  // do a partial refetch that left source/configuredModel stale).
  const apply = useCallback((data: ProviderStatusPayload) => {
    setSource(data.current === 'bedrock' ? 'Bedrock' : 'Anthropic');
    setConfiguredModel(data.bedrockEnv?.ANTHROPIC_MODEL || null);
    setFailoverConfigured(!!data.failoverConfigured);
  }, []);

  /** Refetch; on failure keep what we have. */
  const refresh = useCallback(() => {
    fetch('/api/provider').then(res => res.json()).then(apply).catch(() => {});
  }, [apply]);

  /** Initial / catch-up fetch; on failure clear, so no stale label shows. */
  const load = useCallback(() => {
    fetch('/api/provider').then(res => res.json()).then(apply).catch(() => {
      setSource(null);
      setConfiguredModel(null);
    });
  }, [apply]);

  // Prefer the per-session model, then ANTHROPIC_MODEL (Bedrock mode), then a
  // generic "Claude".
  const modelLabel = formatModelName(currentModel) || formatModelName(configuredModel) || 'Claude';
  /** e.g. "Claude Opus 4.8 (Anthropic)"; '' until the provider is known. */
  const label = source ? `${modelLabel} (${source})` : '';

  return { label, currentModel, setCurrentModel, failoverConfigured, apply, refresh, load };
}
