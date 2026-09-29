'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import type { AskUserQuestionState } from '@/lib/types';

type BufferSnapshot = { pendingAsk?: { toolUseID?: string; questions?: unknown } | null };
type StructuredAnswer = {
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string }>;
};

interface AskUserQuestionOptions {
  sdkSessionsEnabled: boolean;
  /** The session in view. */
  sessionId: string | null;
  /** Latest active session, for async guards (updated synchronously on switch). */
  activeSessionRef: RefObject<string | null>;
  /** CLI path: the prose answer, to be sent as a brand-new user turn. */
  onProseAnswer: (answer: string) => void;
}

/**
 * The AskUserQuestion dialog's state and its two backends.
 *
 * SDK: the turn is PARKED in canUseTool; the answer resolves the tool call in
 * place (/api/claude-sdk/answer, keyed by toolUseID). The server holds the
 * pending question, so every buffer restore (refresh, switch-back, re-shown
 * tab) must re-open it — else the turn is stranded with nothing on screen.
 *
 * CLI (--print): the tool auto-errors, so there's nothing to resolve
 * (toolUseID null); the answer goes out as a new prose turn.
 */
export function useAskUserQuestion({
  sdkSessionsEnabled, sessionId, activeSessionRef, onProseAnswer,
}: AskUserQuestionOptions) {
  const [question, setQuestion] = useState<AskUserQuestionState | null>(null);
  /** When a question last PARKED, via SSE. Guards the stale-close race below. */
  const lastAskEventAtRef = useRef(0);
  /** The last question the user ANSWERED and when. Guards the stale-RE-OPEN race
   *  (P18): a reconnect/visibility buffer fetch issued before the answer landed can
   *  still return the question as pending and flash the just-answered dialog back on. */
  const answeredAskRef = useRef<{ toolUseID: string; at: number } | null>(null);

  /** SDK: a question parked (SSE). Stamped so an in-flight buffer fetch, issued
   *  before this and answering `pendingAsk: null`, can't close it. */
  const park = useCallback((toolUseID: string, questions: AskUserQuestionState['input']['questions']) => {
    lastAskEventAtRef.current = Date.now();
    setQuestion({ toolUseID, input: { questions } });
  }, []);

  /** CLI: open a question with nothing to resolve (answered as a prose turn). */
  const openCli = useCallback((input: AskUserQuestionState['input']) => {
    setQuestion({ toolUseID: null, input });
  }, []);

  /** Close the dialog (session switch, or the question was settled elsewhere). */
  const clear = useCallback(() => setQuestion(null), []);

  /**
   * Re-open (or close) the dialog from a /api/stream-buffer response. Called
   * from every buffer restore site, since each is a moment the dialog could have
   * been lost.
   *
   * A null pendingAsk closes a stale SDK dialog (answered elsewhere — another
   * tab, an abort). Guarded on toolUseID so it never closes a CLI-sourced
   * dialog, which the server has no record of.
   *
   * `issuedAt` is when the fetch was SENT, and the null branch needs it: the
   * response is a snapshot of the past with no ordering guarantee against SSE.
   * If a question parks after we asked but before the answer lands, that stale
   * null would close a dialog that had only just opened — and Claude would park
   * forever with nothing on screen to answer it. Never let a snapshot older than
   * the last park close anything.
   */
  const applyFromBuffer = useCallback((bufData: BufferSnapshot, issuedAt: number) => {
    if (!sdkSessionsEnabled) return;
    const pending = bufData?.pendingAsk;
    if (pending?.toolUseID && Array.isArray(pending.questions)) {
      // P18: don't re-open a dialog the user already answered. A snapshot issued
      // BEFORE the answer can still carry it as pending — ignore it. A fetch
      // issued AFTER the answer that STILL shows pending is genuinely unresolved
      // (e.g. the answer POST failed), so let it re-open.
      const answered = answeredAskRef.current;
      if (answered && answered.toolUseID === pending.toolUseID && answered.at >= issuedAt) return;
      lastAskEventAtRef.current = Date.now();
      setQuestion({
        toolUseID: pending.toolUseID,
        input: { questions: pending.questions as AskUserQuestionState['input']['questions'] },
      });
    } else if (pending === null) {
      // >= not >: a park stamped in the same millisecond the fetch was issued is
      // unordered with respect to it, so treat it as newer. Ties fail toward
      // KEEPING the dialog — the cost of a wrong close is a turn parked forever
      // with nothing on screen; the cost of a wrong keep is a harmless 409.
      if (lastAskEventAtRef.current >= issuedAt) return; // snapshot predates the park
      setQuestion(prev => (prev?.toolUseID ? null : prev));
    }
  }, [sdkSessionsEnabled]);

  /**
   * SDK: POST an answer (or a skip) for the parked question, closing the dialog
   * optimistically and putting it BACK if the post didn't land — else the server
   * stays parked with the composer locked and no dialog: the stranded turn this
   * design exists to prevent. NOT restored on a genuine 409 (settled by someone
   * else): re-opening would show an unanswerable dialog.
   */
  const postAnswer = async (body: Record<string, unknown>, label: string) => {
    const current = question;
    const toolUseID = current?.toolUseID;
    const mySessionId = sessionId;
    setQuestion(null);
    if (!toolUseID || !mySessionId) return;
    // Record the answer so a stale still-pending buffer read can't re-open it (P18).
    answeredAskRef.current = { toolUseID, at: Date.now() };

    // Only restore if nothing newer took the slot and we're still on the same
    // session — a plain set would clobber a question that parked while we waited.
    const restore = () => {
      if (activeSessionRef.current !== mySessionId) return;
      setQuestion(prev => prev ?? current);
    };

    try {
      const res = await fetch('/api/claude-sdk/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: mySessionId, toolUseID, ...body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error(`Failed to ${label} question:`, data.error || `HTTP ${res.status}`);
        // 409 'no_pending' = really settled already — don't restore. 409
        // 'sdk_disabled' = the answer never landed and the turn is still parked
        // — restore. Any other status also restores.
        if (res.status !== 409 || data.code === 'sdk_disabled') restore();
      }
    } catch (error) {
      // Network failure — the server never heard us, so it is still parked.
      console.error(`Failed to ${label} question:`, error);
      restore();
    }
  };

  /** SDK: resolve the parked tool call in place — no new turn. */
  const submitStructured = (result: StructuredAnswer) => postAnswer(result, 'answer');
  /** SDK: dismissal denies the tool, which the model handles gracefully. */
  const skipStructured = () => postAnswer({ skip: true }, 'skip');

  /** CLI: send the prose answer as a new turn. */
  const answerProse = (answer: string) => {
    setQuestion(null);
    if (!answer.trim()) return;
    onProseAnswer(answer);
  };
  const skipProse = () => setQuestion(null);

  return {
    question,
    park, openCli, clear, applyFromBuffer,
    /** Dialog wiring: `structured` picks the SDK handlers — only with a live tool
     *  call to resolve. A CLI question (toolUseID null) MUST take the prose path. */
    handlers: {
      structured: !!(sdkSessionsEnabled && question?.toolUseID),
      onSubmit: answerProse,
      onSubmitStructured: submitStructured,
      onSkip: skipProse,
      onSkipStructured: skipStructured,
    },
  };
}
