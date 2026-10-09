'use client';

/**
 * Ask-mode status surfaces above the result cards (docs/ticket-ask-search.md
 * §5): live progress with cancel, the agent's summary, and the two fallbacks
 * (prose answer, keyword results). The cards themselves are ordinary
 * ResultCards rendered by SearchTab.
 */
import { useEffect, useState } from 'react';
import { Loader2, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { AskState, AskStep } from './useAsk';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** One progress line per agent tool call. */
export function describeStep(s: AskStep): string {
  switch (s.tool) {
    case 'list_projects': return 'Looking up your projects';
    case 'search_transcripts':
      return `Searching “${s.input.q ?? '…'}”${s.input.project ? ` in ${baseName(s.input.project)}` : ''}`;
    case 'get_session': return 'Reading a session to confirm';
    default: return s.tool;
  }
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

const REASONS: Record<string, string> = {
  timeout: 'took too long',
  session_died: 'stopped unexpectedly',
  result_error: 'could not finish',
  disposed: 'was shut down',
};

export default function AskPanel({ state, onCancel }: { state: AskState; onCancel: () => void }) {
  if (state.status === 'running') {
    return (
      <div className="sh-fade-in mt-5 mb-3 rounded-lg border border-border bg-muted/40 px-4 py-3" data-testid="ask-progress" aria-live="polite">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
          <span className="font-medium">Search agent is looking…</span>
          <span className="text-xs text-muted-foreground"><Elapsed since={state.startedAt} /></span>
          <button
            onClick={onCancel}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1 pointer-coarse:py-2 rounded-md hover:bg-accent/40"
            data-testid="ask-cancel"
          >
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
        {state.steps.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" data-testid="ask-steps">
            {state.steps.map((s, i) => (
              <li key={i} className={i === state.steps.length - 1 ? 'text-foreground/80' : ''}>
                {i === state.steps.length - 1 ? '› ' : '✓ '}{describeStep(s)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (state.status === 'answer') {
    return (
      <div className="sh-fade-in mt-5 mb-3 rounded-lg border border-border bg-muted/40 px-4 py-3" data-testid="ask-summary">
        <div className="flex items-start gap-2">
          <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm" data-testid="ask-summary-text">{state.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Search agent · {state.sessions.length} session{state.sessions.length === 1 ? '' : 's'} · {(state.durationMs / 1000).toFixed(1)}s
              <span className="text-muted-foreground/70"> · the summary is the agent&apos;s reading; open a session to check</span>
            </p>
            {state.dropped > 0 && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="ask-dropped">
                {state.dropped} suggested session{state.dropped === 1 ? '' : 's'} couldn&apos;t be found in your archive and {state.dropped === 1 ? 'was' : 'were'} left out.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (state.status === 'prose') {
    return (
      <div className="sh-fade-in mt-5 mb-3 rounded-lg border border-border bg-muted/40 px-4 py-3" data-testid="ask-prose">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> The search agent answered in text instead of results:
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">{state.text}</p>
      </div>
    );
  }

  if (state.status === 'fallback') {
    return (
      <div className="sh-fade-in mt-5 mb-3 flex items-start gap-2 text-xs text-muted-foreground" data-testid="ask-fallback">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-500" />
        <span>
          The search agent {REASONS[state.reason] ?? 'was unavailable'}, so these are <strong>keyword fallback</strong> results
          {state.query ? <> for “{state.query}”</> : null}
          {state.project ? <> in {baseName(state.project)}</> : null}.
          {state.sessions.length === 0 && ' Nothing matched; try a shorter keyword search.'}
        </span>
      </div>
    );
  }

  return (
    <div className="sh-fade-in mt-5 mb-3 flex items-start gap-2 text-xs text-destructive" data-testid="ask-error">
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span>{state.message}</span>
    </div>
  );
}
