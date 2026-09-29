'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import type { LimitReachedInfo } from '@/components/LimitReachedDialog';
import { setSessionModel } from '@/lib/setSessionModel';
import type { AttachedImage } from '@/lib/clientImage';
import type { ChatDialogsProps } from '../ChatDialogs';

/** The most recent send, per session — what a limit recovery resends. */
export type LastSend = { sessionId: string; prompt: string; images: AttachedImage[] };

interface LimitHandlingOptions {
  /** Latest active session (updated synchronously on switch). */
  activeSessionRef: RefObject<string | null>;
  /** The viewed session's project. */
  projectPath: string | null;
  /** The normal send path, with the stashed images as an override. Must be the
   *  CURRENT render's — a stale one sees an old session and early-returns. */
  send: (prompt: string, imagesOverride: AttachedImage[]) => Promise<void> | void;
  /** Surface a problem in the conversation (e.g. nothing to resend). */
  onError: (message: string) => void;
  /** Refresh provider status (the Bedrock button must be current). */
  refreshProvider: () => void;
  setCurrentModel: (model: string | null) => void;
  /** An automatic Bedrock failover is enabled AND configured. */
  bedrockConfigured: boolean;
}

/**
 * The limited turn already persisted its prompt (the CLI writes the user message
 * before the 429). Drop that dangling turn before resending so the model doesn't
 * see the instruction twice. GUARDED: only truncates when the transcript's last
 * message is exactly this prompt as a user turn — if a reply followed, the turn
 * really ran. A duplicate is acceptable; truncating a real turn is not, so this
 * fails safe toward skipping.
 */
async function dropLimitedTurnIfMatches(sessionId: string, project: string, prompt: string) {
  try {
    const res = await fetch(
      `/api/transcript?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
    );
    if (!res.ok) return;
    const data = await res.json();
    const msgs: { role: string; content: string; askAnswer?: boolean }[] = data.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user' || last.content !== prompt) return;
    // Count TURNS, not raw user messages: an AskUserQuestion answer is user-role
    // but doesn't start a turn. Including it over-counts, so turnIndex points
    // past the last real turn and the server can't find it (the drop no-ops,
    // leaving the limited prompt in place — the model may then see it twice).
    const userTurns = msgs.filter(m => m.role === 'user' && !m.askAnswer).length;
    await fetch('/api/session', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, project, turnIndex: userTurns - 1, removeLastHistoryEntry: false }),
    });
  } catch { /* best effort — see the fail-safe note above */ }
}

/**
 * Terminal usage/rate limit recovery (server `session:limit`): the dialog, and
 * its two ways out — switch model, or fail over to Bedrock — each followed by an
 * automatic resend of the prompt that hit the limit.
 */
export function useLimitHandling({
  activeSessionRef, projectPath, send, onError, refreshProvider, setCurrentModel, bedrockConfigured,
}: LimitHandlingOptions) {
  const [info, setInfo] = useState<LimitReachedInfo | null>(null);
  /** Inline recovery error (e.g. a rejected model switch) — keeps the dialog open
   *  for another choice instead of a silent retry. */
  const [error, setError] = useState<string | null>(null);
  /** Sessions whose dialog the user dismissed with "Not now" — so a stream-buffer
   *  restore doesn't keep re-popping it. Re-armed when a FRESH limit fires. */
  const dismissedRef = useRef<Set<string>>(new Set());
  /** The last prompt + attachments sent, per session — written by the send path
   *  so a terminal limit can resend it verbatim on the newly chosen model. */
  const lastSendRef = useRef<LastSend | null>(null);

  /** Raise the dialog. `force` (a fresh SSE event) re-arms a dismissed session; a
   *  buffer restore does not. Never overrides a dialog already open for the same
   *  session. Stable: safe to hold in long-lived handlers. */
  const raise = useCallback(
    (sid: string, limitedModel: string | null, message: string, force: boolean) => {
      if (!message) return;
      if (force) dismissedRef.current.delete(sid);
      else if (dismissedRef.current.has(sid)) return;
      setError(null);
      setInfo(prev => (prev?.sessionId === sid ? prev : { sessionId: sid, limitedModel, message }));
      // So the Bedrock button (and status bar) are correct right now.
      refreshProvider();
    },
    [refreshProvider],
  );

  // Plain functions (NOT useCallback): they must reach the CURRENT render's
  // `send` — a memoized copy would freeze an early closure whose session is null,
  // and the resend would silently early-return.
  const resendLastPrompt = async () => {
    const st = lastSendRef.current;
    if (!st || st.sessionId !== activeSessionRef.current) {
      onError('Model switched, but the message couldn’t be resent automatically — please send it again.');
      return;
    }
    if (projectPath) {
      await dropLimitedTurnIfMatches(st.sessionId, projectPath, st.prompt);
    }
    void send(st.prompt, st.images);
  };

  // Switch the session to `model` (null = provider default), then auto-resend.
  // The dialog stays OPEN until this resolves — so its "Switching…" state renders
  // and a rejected switch shows inline instead of resending on the limited model.
  const switchAndRetry = async (model: string | null) => {
    const sessionId = info?.sessionId;
    if (!sessionId) { setInfo(null); return; }
    setError(null);
    const res = await setSessionModel(sessionId, model);
    if (!res.ok) {
      setError(`Couldn’t switch model: ${res.error ?? 'unknown error'}. Try another one.`);
      return; // keep the dialog open for another choice
    }
    if (model) setCurrentModel(model);
    setInfo(null);
    await resendLastPrompt();
  };

  // Fail the provider over to the configured Bedrock fallback, then auto-resend.
  // Recycles the warm process (so the next turn spawns under Bedrock env); the
  // pin-clear it performs means the resend follows the Bedrock default.
  const failOverToBedrock = async () => {
    const sessionId = info?.sessionId;
    if (!sessionId) { setInfo(null); return; }
    setError(null);
    try {
      const res = await fetch('/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'bedrock' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetch('/api/claude-sdk/recycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      setError('Failed to switch to the Bedrock fallback. Check the Bedrock settings.');
      return; // keep the dialog open
    }
    setCurrentModel(null); // pin cleared server-side → follow the Bedrock default
    setInfo(null);
    await resendLastPrompt();
  };

  const dialog: ChatDialogsProps['limit'] = {
    info,
    error,
    bedrockConfigured,
    // "Not now" / backdrop / escape — remember the dismissal so a buffer restore
    // doesn't re-pop it. (Switch/Bedrock clear `info` directly, bypassing this,
    // and clear the server's pendingLimit on the next turn.)
    onDismiss: () => {
      if (info) dismissedRef.current.add(info.sessionId);
      setInfo(null);
    },
    onSwitchAndRetry: switchAndRetry,
    onUseBedrock: failOverToBedrock,
  };

  return { raise, dialog, lastSendRef };
}
