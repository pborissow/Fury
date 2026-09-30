'use client';

import { useState, useEffect, useEffectEvent, useCallback, useRef, type RefObject } from 'react';
import type { RichTextEditorHandle } from '@/components/RichTextEditor';
import type { StreamEvent } from '@/components/StreamEventsPanel';
import type { ComposerAttachments } from '@/components/composer/useComposerAttachments';
import { prependImages } from '@/components/composer/attachments';
import type { RewindRequest, TakeoverRequest } from '../ChatDialogs';
import type { ViewedSession } from './useViewedSession';
import type { SessionDrafts } from './useSessionDrafts';
import type { useTts } from './useTts';
import type { useSessionHistory } from './useSessionHistory';
import type { useAskUserQuestion } from './useAskUserQuestion';
import type { useLimitHandling } from './useLimitHandling';
import { uiLog } from '@/lib/clientTelemetry';
import { subscribeAppEvents } from '@/lib/appEventStream';
import { stripInFlightPartials } from '@/lib/transcriptStrip';
import {
  reduceSessionStream, appendStreamEvent, applyContextUsage, clearContextUsage,
  reduceHealth, reduceHealthPoll, reduceConnected,
  type SessionStreamPayload, type HealthPayload,
} from '@/lib/sessionEvents';
import { projectEnvelope } from '@/lib/envelopeProjection';
import { findRewindCutIndex, lastClaudeBubble } from '@/lib/transcriptTurns';
import type { Message, TranscriptMsg, TranscriptImagePart } from '@/lib/types';
import type { AttachedImage } from '@/lib/clientImage';
import type { TurnMeta } from '@/lib/transcriptParser';
import type { Liveness } from '@/lib/eventBus';
import { scrollIntoViewY } from '@/lib/scrollIntoViewY';

// Generate a UUID v4
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

type SpeakableMsg = TranscriptMsg & { turnMeta?: TurnMeta };

export interface SessionStreamOptions {
  viewed: ViewedSession;
  /** The Chat tab is visible (SSE work is skipped while hidden, then caught up). */
  isActive: boolean;
  sdkSessionsEnabled: boolean;
  chatEditorRef: RefObject<RichTextEditorHandle | null>;
  attachments: ComposerAttachments;
  drafts: SessionDrafts;
  tts: ReturnType<typeof useTts>;
  setCurrentModel: (model: string | null) => void;
  history: Pick<ReturnType<typeof useSessionHistory>, 'history' | 'setHistory' | 'setLiveSessionIds'>;
  ask: Pick<ReturnType<typeof useAskUserQuestion>, 'applyFromBuffer' | 'park' | 'openCli' | 'clear'>;
  limits: Pick<ReturnType<typeof useLimitHandling>, 'raise' | 'lastSendRef'>;
}

/**
 * The viewed session's conversation: transcript + optimistic overlay, the
 * in-flight turn (streaming text, liveness, stream events), the session-scoped
 * SSE connection that drives it, and the actions on it (open, send, stop,
 * rewind, kill).
 *
 * Receives the other domains (TTS, history, drafts, question dialog, limit
 * recovery) and calls into them; none of them imports this.
 *
 * Session-switch guard: every async continuation re-checks that the session it
 * was started for is still the one in view (`activeSessionRef` /
 * `mySessionId`) before touching state — a late response for session A must
 * never land in session B's view.
 */
export function useSessionStream({
  viewed, isActive, sdkSessionsEnabled, chatEditorRef, attachments, drafts, tts, setCurrentModel,
  history: { history, setHistory, setLiveSessionIds }, ask, limits,
}: SessionStreamOptions) {
  const { id: viewingTranscriptId, project: historyTranscriptProject, activeSessionRef } = viewed;
  // The callbacks this hook's effects use from the other domains. All are
  // memoized: stable, except applyAskFromBuffer, which changes only with
  // sdkSessionsEnabled — so listing them as effect dependencies never makes the
  // session SSE reconnect on its own.
  const { cleanup: ttsCleanup, announce: ttsAnnounce } = tts;
  const { applyFromBuffer: applyAskFromBuffer, park: parkAsk, openCli: openCliAsk, clear: clearAsk } = ask;
  const { raise: raiseLimit } = limits;
  // The last send, stashed for limit recovery's auto-resend (owned by limits).
  const lastSendRef = limits.lastSendRef;

  // Health check state
  const [isStuck, setIsStuck] = useState(false);
  const [stuckReason, setStuckReason] = useState<string | undefined>();

  // Per-session epoch-ms of the last turn completion. Anchors the prompt-cache
  // freshness leaf in the sidebar — stamped when a viewed session stops
  // processing. Sessions without an entry fall back to their history timestamp.
  const [sessionActivity, setSessionActivity] = useState<Record<string, number>>({});
  // Per-session live context occupancy + window, driven by session:usage SSE.
  // Overlays archived metadata so the sidebar tracks context as Claude streams.
  //
  // Unlike the cumulative token count this replaced, context is an ABSOLUTE
  // level, not an increment — the server reports the latest call's prompt size
  // outright. So there's no baseline to freeze, no addition, and no risk of
  // double-counting the archive's mid-turn growth: last value wins.
  const [liveContext, setLiveContext] = useState<
    Record<string, { tokens: number; window: number }>
  >({});

  // New sessions that haven't been submitted yet — persisted in the sidebar so
  // the user can switch away and come back without losing them.
  const [pendingNewSessions, setPendingNewSessions] = useState<
    { sessionId: string; project: string; title: string; createdAt: number }[]
  >([]);

  // Stream events for the right-panel Stream tab
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);

  // History transcript viewer state (renders in center panel)
  const [historyTranscript, setHistoryTranscript] = useState<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnMeta?: TurnMeta; uuid?: string; images?: TranscriptImagePart[]; askAnswer?: boolean; askQuestion?: boolean }[]>([]);
  const [historyTranscriptLoading, setHistoryTranscriptLoading] = useState(false);
  const [transcriptOverlayMessages, setTranscriptOverlayMessages] = useState<(Message & { images?: TranscriptImagePart[] })[]>([]);
  const [transcriptStreaming, setTranscriptStreaming] = useState('');
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  // Independent of transcriptLoading (which is tied to an in-flight MAIN turn and
  // its strip/refetch machinery): true while the session is driving a BACKGROUND
  // subagent between its own turns. Drives ONLY the bouncing dots — deliberately
  // orthogonal so background liveness never touches the fragile in-flight-partials
  // logic. See docs/ticket-live-badge-dark-during-background-subagent.md.
  const [backgroundWorking, setBackgroundWorking] = useState(false);
  // SSOT liveness projection (docs/design-liveness-single-source-of-truth.md, step 2b).
  // The single authoritative "is Claude working?" level, held verbatim from the server
  // (session:health PUSH, seq-gated; /api/health PULL, unconditional). When the flag is
  // on, the dots render off `live.phase` instead of the legacy `transcriptLoading ||
  // backgroundWorking` OR-of-proxies; the legacy machinery stays intact as the fallback
  // (and reseeds the dots when `live` is null / flag off). Reset to null on session switch.
  const [live, setLive] = useState<Liveness | null>(null);
  const liveRef = useRef<Liveness | null>(null);
  // Apply an incoming liveness LEVEL. An SSE beat (PUSH) advances state only when
  // its seq is NEWER — a late/duplicate beat can't move the level backward. A PULL
  // (/api/health, /api/stream-buffer, reconnect/poll) is an authoritative snapshot
  // applied UNCONDITIONALLY: state can move without a push (a wedge self-heal), so
  // a fresh pull may legitimately carry the SAME seq as the last push (design §3
  // seq contract). Component-scoped (not effect-local) so the fetchTranscript
  // restore path can seed `live` — incl. the envelope anchor — on first paint.
  const applyLiveness = useCallback((next: Liveness | undefined | null, fromPull: boolean) => {
    if (!next || typeof next.seq !== 'number') return;
    const cur = liveRef.current;
    if (!fromPull && cur && next.seq <= cur.seq) return;
    liveRef.current = next;
    setLive(next);
  }, []);
  // Opt-in for the projection-driven dots (localStorage `fury.livenessDots`). Off by
  // default so the legacy path is untouched until this is proven in the app; flip it in
  // the browser console to verify. Step 3 makes it the default and deletes the legacy path.
  const [livenessDotsEnabled, setLivenessDotsEnabled] = useState(false);
  const livenessDotsEnabledRef = useRef(false);
  const transcriptLoadingRef = useRef(false);
  const backgroundWorkingRef = useRef(false);
  const transcriptStreamingRef = useRef('');
  // Consecutive `/api/health` isProcessing:false readings from the 15s fallback
  // poll. The SDK singleton swap on Next.js HMR can make a not-yet-recompiled
  // /api/health route momentarily report a live session as idle (documented in
  // lib/sdkSessionManager.ts). A lone transient false must NOT tear down the
  // in-flight view — require two in a row before trusting "the turn ended", and
  // let the authoritative session-health SSE handle real completions instantly.
  const healthFalseStreakRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const lastAssistantRef = useRef<HTMLDivElement>(null);
  const prevAssistantCountRef = useRef(0);
  const skipNextAssistantScrollRef = useRef(true);

  // Tracks the latest prompt-submission timing for the stream panel's
  // "Elapsed Time" indicator. submitEndTime stays null until the response
  // (or error) completes; once set, the timer freezes at the final value.
  const [submitStartTime, setSubmitStartTime] = useState<number | null>(null);
  const [submitEndTime, setSubmitEndTime] = useState<number | null>(null);
  // When overlay messages are restored from a previous session, they belong at a
  // specific position in the transcript (not at the end). null = append at end (live sends).
  const [overlayInsertPoint, setOverlayInsertPoint] = useState<number | null>(null);

  // True when the transcript was reconstructed from history.jsonl (user prompts only, no responses)
  const [transcriptPartial, setTranscriptPartial] = useState(false);

  // Parked when a send hits a session that's live in an external terminal. The
  // backend answers with a 409 {needsTakeoverConfirm}; this holds the owner info
  // plus the confirm/cancel continuations so the user decides whether to take it
  // over (which ends the terminal) or back out. See handleTranscriptSend.
  const [takeoverConfirm, setTakeoverConfirm] = useState<TakeoverRequest | null>(null);
  // A turn-ending error surfaced by the backend (session:stream {error}) — e.g.
  // "Failed to authenticate: OAuth session expired...". Held as a persistent
  // center-panel notice, NOT just a stream event: the transcript parser drops
  // the SDK's synthetic error message (transcriptParser.ts, `model==='<synthetic>'`),
  // so a refetch would erase it and the chat would go silent (the 87487df4 bug).
  // Cleared on the next send and on session switch.
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Durable per-session set of MCP servers that FAILED to connect at init (B4).
  // Server-authoritative: set from the session-stream signal, restored from
  // /api/stream-buffer on open, and cleared when the server reports recovery (an
  // empty set) or on session switch. NOT stored in streamEvents, so it survives
  // turn resets instead of vanishing with the live stream.
  const [mcpFailedServers, setMcpFailedServers] = useState<{ name: string; status: string }[]>([]);

  // --- Scroll helper ---
  const scrollTranscriptToBottom = () => {
    scrollIntoViewY(transcriptEndRef.current, { behavior: 'smooth' });
  };

  // --- Ref sync effects ---

  // Track whether this tab is visible so SSE handlers can skip work when hidden.
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Stop TTS and dictation when switching sessions. (activeSessionRef itself
  // is kept in sync by useViewedSession.)
  useEffect(() => {
    ttsCleanup();
    chatEditorRef.current?.stopRecording();
  }, [viewingTranscriptId, ttsCleanup, chatEditorRef]);

  // Keep refs in sync so SSE event handlers always see the current value
  useEffect(() => {
    transcriptLoadingRef.current = transcriptLoading;
  }, [transcriptLoading]);

  useEffect(() => {
    backgroundWorkingRef.current = backgroundWorking;
  }, [backgroundWorking]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // Read the projection-dots setting once (client-only; localStorage is undefined in
  // SSR). DEFAULT-ON as of step 3 (scenario 1+2 closed and verified live); set
  // `fury.livenessDots='0'` to fall back to the legacy path. The legacy compensators
  // remain in the tree as that fallback until a soak proves the projection, then step-3
  // cleanup deletes them.
  useEffect(() => {
    let on = true;
    try { on = localStorage.getItem('fury.livenessDots') !== '0'; }
    catch { on = true; /* no localStorage (private mode) — default to the projection */ }
    livenessDotsEnabledRef.current = on;
    setLivenessDotsEnabled(on);
  }, []);

  useEffect(() => {
    transcriptStreamingRef.current = transcriptStreaming;
  }, [transcriptStreaming]);


  // --- Logical-task ENVELOPE projection ---
  // A pure function of (historyTranscript, live, overlay) — see
  // lib/envelopeProjection.ts. While the envelope is open, the task's committed
  // intermediate turns are hidden from the main flow and reachable via the dots
  // bubble's modal.
  //
  // Derived ABOVE the scroll effects on purpose: the DISPLAYED transcript is
  // what user-visible reactions (auto-scroll) must key on — the raw
  // historyTranscript legitimately grows mid-envelope (the transcript-updated
  // refetch that feeds the modal), and reacting to the raw growth is what
  // scrolled the panel to the previous turn instead of the dots (the
  // 2026-09-14 macOS report — see the assistant-scroll effect below).
  const { envelopeOpen, displayedTranscript, envelopeHidden, envelopeUserEcho } = projectEnvelope({
    transcript: historyTranscript,
    live,
    livenessDotsEnabled,
    overlay: transcriptOverlayMessages,
  });
  // Auto-scroll transcript viewer during streaming
  useEffect(() => {
    if (transcriptStreaming) {
      scrollTranscriptToBottom();
    }
  }, [transcriptStreaming]);

  // Freeze the elapsed-time counter when the first stream chunk arrives —
  // this is the "time to first chunk" measurement. Fall back to freezing
  // on completion in case the response ends without producing any chunks
  // (e.g. an error before streaming starts).
  useEffect(() => {
    if (submitStartTime == null || submitEndTime != null) return;
    if (streamEvents.length > 0 || !transcriptLoading) {
      setSubmitEndTime(Date.now());
    }
  }, [streamEvents.length, transcriptLoading, submitStartTime, submitEndTime]);

  // Open the prompt-cache freshness window when the response starts streaming.
  // submitEndTime freezes at the first chunk (and is restored from the stream
  // buffer on navigation), which is the point the turn's prompt has been
  // processed and cached — so that's when the 5-min TTL countdown should begin.
  // Turn completion and stop re-anchor it later (see session-health handler and
  // handleTranscriptStop).
  useEffect(() => {
    if (submitEndTime != null && viewingTranscriptId) {
      setSessionActivity(prev => ({ ...prev, [viewingTranscriptId]: submitEndTime }));
    }
  }, [submitEndTime, viewingTranscriptId]);

  // When a new assistant response lands (post-streaming), scroll so that the
  // start of the response is at the top of the panel — letting the user see
  // as much of the response as possible. Skip on initial transcript loads.
  //
  // Counts the DISPLAYED transcript, NOT the raw historyTranscript. The raw
  // array now grows mid-task (the transcript-updated handler refetches inside
  // an open envelope to feed the dots-bubble modal), but every one of those
  // messages is sliced out of display — so a raw-count trigger fired
  // scrollIntoView on `lastAssistantRef`, which points at the last VISIBLE
  // bubble: Claude's PREVIOUS answer, not the bouncing dots (reported on macOS
  // 2026-09-14; masked elsewhere by the streaming bottom-scroll racing it).
  // Keyed on the projection, the count is static while the envelope is open
  // (dots keep the viewport via the streaming/bottom scrolls) and jumps ONCE at
  // the reveal — landing exactly one scroll at the start of the final answer.
  useEffect(() => {
    if (historyTranscriptLoading) {
      skipNextAssistantScrollRef.current = true;
      prevAssistantCountRef.current = 0;
      return;
    }
    const assistantCount = displayedTranscript.reduce(
      (n, m) => (m.role === 'assistant' ? n + 1 : n),
      0,
    );
    if (assistantCount > prevAssistantCountRef.current && !skipNextAssistantScrollRef.current) {
      requestAnimationFrame(() => {
        scrollIntoViewY(lastAssistantRef.current, { behavior: 'smooth', block: 'start' });
      });
    }
    prevAssistantCountRef.current = assistantCount;
    skipNextAssistantScrollRef.current = false;
  }, [displayedTranscript, historyTranscriptLoading]);

  // NOTE: the live-token overlay used to need a reconciliation effect here to
  // drop it once the archived baseline caught up. The context overlay needs no
  // such thing — it's an absolute level that the archive converges to on its
  // own, so a stale overlay can only ever be superseded, never double-counted.

  // --- fetchTranscript ---
  const fetchTranscript = async (sessionId: string, project: string) => {
    // Save current composer draft (text + attachments) before switching
    drafts.stash(viewingTranscriptId);

    // Switch the viewed session. select() updates activeSessionRef
    // synchronously, so SSE handlers for the previous session's
    // isStillActive() return false immediately.
    viewed.select(sessionId, project);

    setHistoryTranscriptLoading(true);
    setHistoryTranscript([]);

    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setSessionError(null);
    // Clear on switch; the target session's restore re-sets it from
    // /api/stream-buffer (mcpFailed) below. NOT cleared on send — a still-failed
    // server's banner must persist across turns.
    setMcpFailedServers([]);
    setTranscriptLoading(false);
    // Clear background-work dots on switch; the target session's restore re-sets
    // it from /api/stream-buffer + /api/health below.
    setBackgroundWorking(false);
    setTranscriptPartial(false);
    // Clear any parked question on switch, UNCONDITIONALLY (P17). The SDK path
    // self-heals (its restore returns pendingAsk:null), but the CLI path never
    // clears a stale dialog — so answering a question carried over from session A
    // while viewing B would post the answer as a new turn against B (wrong session).
    // The target session's own restore below re-sets it from /api/stream-buffer.
    clearAsk();
    setIsStuck(false);
    setStuckReason(undefined);
    setCurrentModel(null);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

    // Restore composer draft (text + attachments) for the target session (or clear)
    drafts.restore(sessionId);
    try {
      const res = await fetch(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`);
      let transcriptMessages: { role: 'user' | 'assistant'; content: string; timestamp: string; images?: TranscriptImagePart[] }[] = [];
      if (res.ok) {
        const data = await res.json();
        transcriptMessages = data.messages || [];
        setTranscriptPartial(!!data.partial);

        // If the API found a prompt that was sent but never processed
        // (e.g. Claude was interrupted), pre-fill the editor so the user
        // can review and re-send it.
        if (data.unprocessedPrompt) {
          setTimeout(() => chatEditorRef.current?.setContent(data.unprocessedPrompt), 100);
        }

        // Replay any AskUserQuestion the CLI auto-errored in --print mode
        // that hasn't been answered by a subsequent user prompt. Without
        // this, navigating away from a session while AskUserQuestion was
        // in flight loses the dialog forever.
        //
        // CLI PATH ONLY — deliberately ignored when SDK sessions are on.
        // transcriptParser derives this from the JSONL, and its state machine is
        // permanently stuck-on for us: it SETS pendingAskUserQuestion for any
        // AskUserQuestion tool_use, and its only clear lives behind
        // `typeof msg.content === 'string'`. On the SDK path the answer arrives
        // as a tool_result — a user entry whose content is an ARRAY — so the
        // clear never runs and the flag survives for the life of the session.
        // Honoring it here would re-open the dialog on EVERY navigation to a
        // session that ever asked anything, for a question already answered, and
        // the JSONL has no toolUseID so that dialog could never resolve anything.
        // A pending SDK question comes from server-held state instead (the
        // stream-buffer's pendingAsk, below) — see docs/ask-user-question-sdk.md
        // TRAP #4. The CLI path keeps the heuristic untouched: we stop LISTENING
        // to it rather than teach the parser about tool_results.
        if (!sdkSessionsEnabled && data.pendingAskUserQuestion) {
          // null toolUseID: the CLI path cannot answer a tool call — the
          // answer is re-sent as a fresh prose turn — so there is nothing to
          // correlate with.
          openCliAsk(data.pendingAskUserQuestion);
        }

        if (data.currentModel) {
          setCurrentModel(data.currentModel);
        }
      }
      setHistoryTranscript(transcriptMessages);

      // Check if this session is actively processing. Restore stream state
      // from the buffer if available, and check health as a fallback.
      let detectedProcessing = false;
      try {
        const bufIssuedAt = Date.now();
        const bufRes = await fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(sessionId)}`);
        if (bufRes.ok) {
          const bufData = await bufRes.json();
          // Before the isActive branch: a parked question must re-open whether
          // or not the buffer is still active.
          applyAskFromBuffer(bufData, bufIssuedAt);
          // Restore the durable failed-MCP banner for this session (B4).
          setMcpFailedServers(Array.isArray(bufData.mcpFailed) ? bufData.mcpFailed : []);
          // Re-raise a terminal usage limit whose SSE event fired while this tab
          // wasn't watching (unless the user already dismissed it).
          if (bufData.pendingLimit?.message) {
            raiseLimit(sessionId, bufData.pendingLimit.limitedModel ?? null, bufData.pendingLimit.message, false);
          }
          // Show the background-work dots immediately when opening a session whose
          // main turn is idle but which is still driving a background subagent.
          setBackgroundWorking(!!bufData.backgroundActive);
          // Seed the SSOT projection from the restore snapshot (a PULL — applied
          // unconditionally). Load-bearing for the envelope: opening a session
          // mid-logical-task must hide its intermediate turn output on the FIRST
          // paint via liveness.envelopeStartedAt, not after the next SSE beat.
          applyLiveness(bufData.liveness, true);
          if (bufData.hasBuffer && bufData.isActive) {
            // The JSONL contains partial assistant messages for the in-flight
            // turn that the stream buffer is handling. Strip everything this
            // turn has written so the chat shows bouncing dots instead of
            // intermediary assistant bubbles.
            //
            // Anchor on the buffer's startedAt, NOT on matching userPrompt. A
            // message sent mid-turn ("please continue") is folded by the CLI
            // into the next tool_result — array content, which the parser never
            // emits as a user message — so the string match silently found
            // nothing (verified live: findLastIndex -> -1) and fell through to a
            // heuristic that walked back over EVERY trailing assistant, cutting
            // earlier completed turns too. It also broke on a repeated prompt.
            // startedAt vs each message's timestamp identifies this turn's
            // output exactly, whatever the prompt was.
            setHistoryTranscript(prev =>
              stripInFlightPartials(prev, typeof bufData.startedAt === 'number' ? bufData.startedAt : 0),
            );

            // Only overlay a REAL prompt. A notification/auto turn's buffer
            // carries userPrompt '' (reassertProcessing — no user-typed prompt),
            // and overlaying that painted a blank "You" bubble AND suppressed
            // envelopeUserEcho (which defers to any overlay), leaving the
            // task's real opening prompt invisible when a session is opened
            // mid-notification-turn (screenshot report, 2026-09-19). With no
            // overlay, the echo resurfaces the committed prompt instead.
            if (bufData.userPrompt) {
              setTranscriptOverlayMessages([{ role: 'user' as const, content: bufData.userPrompt }]);
            }
            setTranscriptStreaming(bufData.accumulatedText || '');
            setStreamEvents(bufData.events || []);
            setTranscriptLoading(true);
            // Restore the elapsed-time counter from the buffer so it survives
            // navigating away and back. submitEndTime mirrors the live freeze
            // semantics ("time to first chunk"): frozen at the first buffered
            // event if one exists, still ticking (null) otherwise.
            setSubmitStartTime(bufData.startedAt ?? null);
            setSubmitEndTime(bufData.events?.[0]?.ts ?? null);
            detectedProcessing = true;
          } else if (bufData.isProcessing) {
            // Session is processing but buffer is inactive or missing. Still strip
            // this turn's partials — otherwise they render as intermediary bubbles
            // above the dots (buffer inactive doesn't mean the JSONL is clean).
            setHistoryTranscript(prev =>
              stripInFlightPartials(prev, typeof bufData.startedAt === 'number' ? bufData.startedAt : 0),
            );
            setTranscriptLoading(true);
            if (bufData.startedAt) setSubmitStartTime(bufData.startedAt);
            detectedProcessing = true;
          }
        }
      } catch {
        // Buffer fetch is best-effort; transcript is already loaded
      }

      // Fallback: if buffer didn't indicate processing, check health directly.
      // This covers external CLI sessions not managed by Fury's sessionManager.
      if (!detectedProcessing) {
        try {
          const healthRes = await fetch(`/api/health?sessionId=${encodeURIComponent(sessionId)}`);
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (healthData.isProcessing) {
              setTranscriptLoading(true);
            }
            setBackgroundWorking(!!healthData.backgroundActive);
            applyLiveness(healthData.liveness, true);
          }
        } catch {
          // Health check is best-effort
        }
      }
    } catch (error) {
      console.error('Failed to fetch transcript:', error);
      setHistoryTranscript([]);
    } finally {
      setHistoryTranscriptLoading(false);
      // Scroll to bottom after transcript renders
      setTimeout(() => scrollTranscriptToBottom(), 100);
    }
  };

  // Free the resend stash (which may hold full-size image payloads) when leaving
  // the session it belongs to — the limit auto-resend only applies to the session
  // in view, so there's no reason to retain another session's attachments.
  useEffect(() => {
    if (lastSendRef.current && lastSendRef.current.sessionId !== viewingTranscriptId) {
      lastSendRef.current = null;
    }
  }, [viewingTranscriptId, lastSendRef]);

  // --- Session-scoped events for stream, health, and transcript ---
  // Delivered over the window's ONE shared /api/events socket
  // (lib/appEventStream.ts) by watching the session through its control
  // channel. A dedicated per-session EventSource here was one permanent
  // connection too many: a browser tab plus the PWA exhausted Chrome's
  // 6-per-origin pool and every fetch hung (docs/ticket-sse-pool-exhaustion-
  // and-memory-floor.md §1).
  useEffect(() => {
    if (!viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    const isStillActive = () => activeSessionRef.current === mySessionId;
    // Skip expensive state updates when the tab is hidden; catch-up happens
    // when isActive flips back to true (see effect below).
    const shouldProcess = () => isStillActive() && isActiveRef.current;
    // The shared socket carries every session this window watches, so each
    // handler must check the event is for THIS session.
    const forMe = (data: object | null | undefined) =>
      !!data && (data as { sessionId?: unknown }).sessionId === mySessionId && shouldProcess();
    const on: Record<string, (data: any) => void> = {};

    // --- SSOT liveness projection (step 2b) ---
    // Reset on session switch so a prior session's phase can't leak into this view.
    // (applyLiveness itself is component-scoped now — see its declaration — so the
    // fetchTranscript restore can seed `live` from /api/stream-buffer's snapshot.)
    setLive(null);
    liveRef.current = null;

    // Once the server confirms the watch, re-fetch the stream buffer to close
    // the gap between the initial restore in fetchTranscript and the point the
    // session's events started flowing. Events emitted in that window were
    // never delivered.
    //
    // This also fires after EVERY reconnect of the shared socket (`resumed`),
    // which is the recovery path: the server is reachable again by then. The
    // old per-session stream did its catch-up in `onerror`, at the moment of
    // the DROP, while the server might still be down, and nothing refetched on
    // recovery.
    const onWatching = (resumed: boolean) => {
      if (!shouldProcess()) return;
      if (resumed) {
        uiLog('info', 'chat.sse', 'resyncing after reconnect', {
          sessionId: mySessionId,
          data: { loading: transcriptLoadingRef.current },
        });
      }

      const bufIssuedAt = Date.now();
      fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(bufData => {
          if (!shouldProcess()) return;

          // A question could have been asked in the gap between the initial
          // restore and this connect — that emit would have had no listener.
          applyAskFromBuffer(bufData, bufIssuedAt);
          // Re-sync the durable failed-MCP banner on connect (B4).
          setMcpFailedServers(Array.isArray(bufData.mcpFailed) ? bufData.mcpFailed : []);
          if (bufData.pendingLimit?.message) {
            raiseLimit(mySessionId, bufData.pendingLimit.limitedModel ?? null, bufData.pendingLimit.message, false);
          }

          // Sync background-work dots on connect (SSE may have missed the change).
          setBackgroundWorking(!!bufData.backgroundActive);
          // Re-sync the SSOT projection too (a PULL — unconditional). Covers the
          // initial-restore→SSE-connect gap for the envelope anchor the same way
          // the buffer re-fetch covers streamed text.
          applyLiveness(bufData.liveness, true);

          const out = reduceConnected(bufData, {
            streamingLength: transcriptStreamingRef.current?.length || 0,
            loading: transcriptLoadingRef.current,
          });
          // Only adopt the buffer's stream if it has more than we currently have.
          if (out.restoreStream) {
            setTranscriptStreaming(bufData.accumulatedText || '');
            setStreamEvents(bufData.events || []);
          }

          // Sync loading state (session-level isProcessing, not just the buffer's
          // isActive, to avoid false negatives during queue processing).
          if (out.startLoading) {
            setTranscriptLoading(true);
          } else if (out.completed) {
            // Processing completed between initial restore and SSE connect —
            // refresh the transcript to get the final response and clear overlays.
            setTranscriptLoading(false);
            setTranscriptStreaming('');
            fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
              .then(res => res.json())
              .then(refreshData => {
                // Bail if a new turn began streaming between issuing this
                // completion refetch and its resolution. Background-task turns
                // now re-assert processing (docs/ticket-background-task-
                // notification-turns-render-dark.md), so by the time this async
                // fetch resolves the health latch-break may have already stripped
                // the new turn's partials and set loading true. Committing the
                // JSONL here would re-leak those in-flight partials as bubbles on
                // top of the stripped view; skip and let the next completion /
                // transcript-updated refetch commit the clean state once the turn
                // truly ends. Matches the transcript-updated and reconnect guards.
                if (refreshData.messages && shouldProcess() && !transcriptLoadingRef.current) {
                  setHistoryTranscript(refreshData.messages);
                  setTranscriptOverlayMessages([]);
                  setOverlayInsertPoint(null);
                }
              })
              .catch(() => {});
          } else if (resumed && !transcriptLoadingRef.current) {
            // Idle across the outage, but a `transcript-updated` (e.g. from an
            // external CLI writing the JSONL) may have been missed while the
            // socket was down. Never while a turn is in flight: the JSONL then
            // holds that turn's partials, which would render as bubbles above
            // the dots (re-checked on resolve, since loading can flip meanwhile).
            fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
              .then(res => res.json())
              .then(refreshData => {
                if (!refreshData.messages || !shouldProcess() || transcriptLoadingRef.current) return;
                setHistoryTranscript(refreshData.messages);
                setTranscriptOverlayMessages([]);
                setOverlayInsertPoint(null);
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };

    // Handle session:stream events — the single path for all stream data.
    // NOTE: These events only fire for sessions managed by Fury's sessionManager.
    // External CLI sessions rely on transcript-updated (file watcher) for updates.
    on['session-stream'] = (data: SessionStreamPayload) => {
      if (!forMe(data)) return;

      const out = reduceSessionStream(data, {
        loading: transcriptLoadingRef.current,
        sdkSessionsEnabled,
      });

      // MCP status signal (B4) — a one-shot init signal, not turn stream data,
      // so it's handled before the loading guard. The server sends only
      // genuinely FAILED servers (benign needs-auth/pending are log-only, so this
      // never fires for an un-authed claude.ai connector), and an EMPTY array is
      // a recovery/clear. Stored in durable per-session state (not streamEvents)
      // so the MCP view's flag survives turn resets and clears on recovery.
      if (out.mcpFailed) {
        setMcpFailedServers(out.mcpFailed);
        if (out.mcpFailed.length > 0) {
          uiLog('warn', 'chat.mcp', 'mcp server(s) failed to connect', {
            sessionId: mySessionId,
            data: { servers: out.mcpFailed },
          });
        }
        return;
      }

      // Stream data arriving after the user stopped processing — buffered events
      // would otherwise overwrite the cleared state.
      if (out.ignore) return;

      if (out.appendText) {
        const text = out.appendText;
        setTranscriptStreaming(prev => prev + text);
      }
      if (out.streamEvent) {
        const now = Date.now();
        setStreamEvents(prev => appendStreamEvent(prev, data, now));
      }
      // AskUserQuestion. CLI: surfaced immediately from the tool_use (the server
      // kills the CLI when it parses the same block, even if the user is viewing
      // another session). SDK: the backend is parked in canUseTool; its event
      // carries the toolUseID /api/claude-sdk/answer needs. `clear` = settled
      // elsewhere (abort, another tab, teardown).
      if (out.ask?.type === 'cli') openCliAsk(out.ask.input);
      else if (out.ask?.type === 'park') parkAsk(out.ask.toolUseID, out.ask.questions);
      else if (out.ask?.type === 'clear') clearAsk();
      if (out.error) {
        setSessionError(out.error);
        uiLog('error', 'chat.stream', 'error surfaced', {
          sessionId: mySessionId,
          data: { error: String(out.error).slice(0, 300) },
        });
      }
    };

    // The CLI tells us which model it spun up in its `system.init` line —
    // capture it so the status bar can show the real model name even when
    // ANTHROPIC_MODEL isn't set (the direct-Anthropic case).
    on['session-model'] = (data) => {
      if (!forMe(data)) return;
      if (data.model) setCurrentModel(data.model);
    };

    // Terminal usage/rate limit on this session's model. Drop the in-flight
    // spinner (the turn is over, it produced nothing) and raise the recovery
    // dialog. Refresh provider status so the Bedrock button reflects config.
    on['session-limit'] = (data) => {
      if (!forMe(data)) return;
      setTranscriptLoading(false);
      setSubmitEndTime(Date.now());
      raiseLimit(mySessionId, data.limitedModel ?? null, String(data.message || ''), true);
      uiLog('warn', 'chat.limit', 'usage limit dialog raised', {
        sessionId: mySessionId,
        data: { limitedModel: data.limitedModel ?? null },
      });
    };

    // Live context occupancy for the in-flight turn. An absolute level, so it
    // replaces rather than accumulates — no baseline, no arithmetic.
    on['session-usage'] = (data) => {
      if (!forMe(data)) return;
      if (typeof data.contextTokens !== 'number') return;
      // Anchor the freshness leaf's countdown on ACTUAL API-call activity, not on
      // the transcriptLoading-gated turn boundary. Each session-usage event
      // corresponds to a message_start/assistant — an API call that just reset the
      // 5-min prompt-cache TTL — so stamping here keeps lastActiveAt current
      // throughout ANY active turn, including background-task notification turns
      // whose completion stamp (:921) fires only on the transcriptLoading flip
      // (docs/ticket-freshness-leaf-false-stale.md). This makes the leaf correct
      // independent of the isProcessing/live signal: even if `live` briefly gaps
      // mid-activity, the countdown restarts from a fresh timestamp rather than a
      // stale turn-boundary one, then freezes at the last call when things go idle.
      // Known limitation (called out in the ticket, not fixed here): session-usage
      // only flows for the currently-viewed session, so a session live in the
      // background still anchors its post-idle countdown on entry.timestamp; its
      // `live` prop (global live-sessions event) still pins it green while active.
      setSessionActivity(prev => ({ ...prev, [mySessionId]: Date.now() }));
      // Absolute level, last value wins; keeps the last non-zero window.
      setLiveContext(prev => applyContextUsage(prev, mySessionId, data));
    };

    // Handle session:health events (replaces health polling)
    on['session-health'] = (data: HealthPayload) => {
      if (!forMe(data)) return;
      const out = reduceHealth(data, { loading: transcriptLoadingRef.current });
      setIsStuck(!!out.isStuck);
      setStuckReason(out.stuckReason);

      // SSOT: adopt the pushed liveness level (seq-gated). The heartbeat re-sends this
      // every few seconds while non-idle, so `live.phase` is self-correcting.
      applyLiveness(data.liveness, false);

      // Background-work dots: independent of the in-flight-turn machinery below.
      // A session driving a background subagent between its own turns keeps the
      // dots on even though its main turn is idle (data.isProcessing false).
      setBackgroundWorking(out.backgroundWorking);

      // Authoritative liveness signal — a real reading resets the poll's
      // transient-false streak either way.
      healthFalseStreakRef.current = 0;

      // If the session is actively processing, ensure the loading indicator
      // (bouncing dots) is visible. Break the latch: if a transient false had
      // already committed this turn's partials to historyTranscript, re-strip
      // them so we return to dots instead of leaving the bubbles on screen.
      if (out.restripAt !== null) {
        const restripAt = out.restripAt;
        uiLog('warn', 'chat.health', 'latch-break re-strip (isProcessing true while not loading)', {
          sessionId: mySessionId,
          data: { startedAt: data.startedAt ?? null },
        });
        setHistoryTranscript(prev => stripInFlightPartials(prev, restripAt));
        setTranscriptLoading(true);
      }

      // If processing just ended, refresh transcript from JSONL — BUT NOT while
      // background work is still in flight (P1). A background task (Monitor / Bash /
      // subagent) posting a <task-notification> drives a NEW main turn moments after
      // this idle edge; committing the on-disk partials now, then having the imminent
      // reassert flip processing back on, paints a raw intermediary assistant bubble
      // for one frame before the reactive `latch-break re-strip` above removes it —
      // the visible flash. `backgroundActive` is precisely "a background turn is
      // imminent", so keep the partials stripped and the dots on until a REAL terminal
      // idle (background inactive) arrives; the next such idle commits the clean state.
      if (out.turnEnded) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
        // Stamp the turn-completion time so the sidebar's freshness leaf
        // counts the 5-min prompt-cache TTL from now (when the cache was
        // last refreshed) rather than the turn's start.
        setSessionActivity(prev => ({ ...prev, [mySessionId]: Date.now() }));
        // Drop the live overlay: the turn is done, so the archive (re-read just
        // below) becomes the source of truth again. SessionSidebar reads
        // `live?.tokens ?? metadata.contextTokens`, so an entry left here
        // outranks the archive for the life of the page — it can never be
        // superseded downward. That strands a stale-high reading after a rewind
        // (archived contextTokens drops; the overlay wouldn't), which is exactly
        // the feature this branch exists for.
        setLiveContext(prev => clearContextUsage(prev, mySessionId));
        fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
          .then(res => res.json())
          .then(refreshData => {
            // Bail if a new turn began streaming between this idle refetch being
            // issued and its resolution — routine now that background-task turns
            // re-assert processing (docs/ticket-background-task-notification-turns-
            // render-dark.md). The health latch-break may have already stripped
            // the new turn's partials and flipped loading back on; committing the
            // JSONL here would re-leak those partials as intermediary bubbles.
            // Skip (incl. the TTS below, which would otherwise announce a stale
            // intermediate turn) — the next completion refetch commits the clean
            // state once the turn ends. Matches the transcript-updated (:1033) and
            // reconnect (:1019) guards.
            if (refreshData.messages && shouldProcess() && !transcriptLoadingRef.current) {
              setHistoryTranscript(refreshData.messages);
              setTranscriptOverlayMessages([]);
              setOverlayInsertPoint(null);

              // TTS: speak the last chat bubble (the same turn grouping the
              // transcript renders); chimes instead when there's nothing to say
              // or speech fails, since the chime deferred to it.
              ttsAnnounce(() => lastClaudeBubble(refreshData.messages as SpeakableMsg[]));
            }
          })
          .catch(() => {});
      }
    };

    // Handle transcript:updated events (replaces transcript polling for external live sessions)
    on['transcript-updated'] = (data) => {
      if (!forMe(data)) return;
      // Legacy guard: don't refresh while a turn is in flight — the JSONL contains
      // partial assistant messages that would render as intermediary bubbles.
      //
      // UNDER THE PROJECTION with an open logical-task ENVELOPE, refreshing is
      // safe AND required: the DISPLAYED transcript is a pure function of
      // (historyTranscript, live) — everything committed at/after
      // live.envelopeStartedAt is sliced off at render, so raw mid-task commits
      // can't paint bubbles above the dots. And those commits are exactly what
      // feeds the dots-bubble modal's intermediate messages + badge count
      // (docs/ticket-subagent-notification-turns-intermediate-bubbles.md):
      // without this, completed notification turns never reach the client until
      // the task ends and the modal stays empty.
      if (transcriptLoadingRef.current) {
        const envelopeProjected =
          livenessDotsEnabledRef.current &&
          typeof liveRef.current?.envelopeStartedAt === 'number' &&
          liveRef.current.phase !== 'idle';
        if (!envelopeProjected) return;
      }

      fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
        .then(res => res.json())
        .then(data => {
          if (data.messages && shouldProcess()) {
            setHistoryTranscript(data.messages);
          }
        })
        .catch(() => {});
    };

    // Fallback health poll: if SSE drops or a session:health event is lost,
    // the UI can get stuck showing "processing" forever. Poll every 15s while
    // transcriptLoading OR background work is showing dots, to catch missed
    // completion events. Also skips when tab is hidden to avoid unnecessary
    // network requests.
    const healthPoll = setInterval(() => {
      if (!shouldProcess()) return;
      // Under the projection (flag on) the poll is also the fallback for a dead SSE
      // while `live.phase` is non-idle; otherwise the legacy gate is unchanged.
      const projNonIdle = livenessDotsEnabledRef.current && !!liveRef.current && liveRef.current.phase !== 'idle';
      if (!transcriptLoadingRef.current && !backgroundWorkingRef.current && !projNonIdle) return;
      fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(data => {
          if (!shouldProcess()) return;
          // SSOT: a PULL is an authoritative snapshot — apply it unconditionally.
          applyLiveness(data.liveness, true);
          // The rest is decided by reduceHealthPoll (lib/sessionEvents):
          //  - Under the projection, the PULL above IS this poll's whole job — the
          //    dead-SSE fallback that keeps `live` fresh. The legacy teardown is
          //    bypassed: the projection + heartbeat own liveness and the render-strip
          //    owns the partials (step 3). The machinery below stays intact as the
          //    flag-off / CLI-session fallback.
          //  - Keep the independent background-work dots in sync even if the SSE
          //    health event that would clear them was missed (fail toward not-live).
          //  - Never tear down an in-flight MAIN turn while background work is live
          //    (a task-notification turn may be imminent — Defect B / docs/ticket-
          //    dots-desync-subagent-heavy-session.md).
          //  - Require TWO consecutive isProcessing:false readings (~30s): a single
          //    false is untrustworthy (an HMR singleton swap can momentarily report
          //    a live SDK session as idle). Genuine completions are torn down
          //    instantly by the session-health SSE event; this only fires when that
          //    event never arrived.
          const out = reduceHealthPoll(data, {
            loading: transcriptLoadingRef.current,
            projectionOn: livenessDotsEnabledRef.current,
            falseStreak: healthFalseStreakRef.current,
          });
          if (out.backgroundWorking !== undefined) setBackgroundWorking(out.backgroundWorking);
          if (out.resetFromStreak !== undefined) {
            uiLog('debug', 'chat.healthPoll', 'false streak reset by live reading', {
              sessionId: mySessionId,
              data: { priorStreak: out.resetFromStreak },
            });
          }
          healthFalseStreakRef.current = out.falseStreak;
          // The inflight-partials trigger. Log EVERY false (the server log shows
          // whether isProcessing was really false or an HMR blip) and the teardown
          // separately, so the UI↔server loop is reconstructable from one file.
          if (out.falseReadingStreak !== undefined) {
            uiLog('warn', 'chat.healthPoll', 'isProcessing:false while loading', {
              sessionId: mySessionId,
              data: { streak: out.falseReadingStreak },
            });
          }
          if (!out.teardown) return;
          uiLog('warn', 'chat.healthPoll', 'teardown after 2 consecutive false', { sessionId: mySessionId });
          setTranscriptLoading(false);
          setTranscriptStreaming('');
          fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
            .then(res => res.json())
            .then(refreshData => {
              // Re-check loading: a real session:health event may have re-lit the
              // dots via the latch-break (:997) between this teardown and the refetch
              // resolving. If so the turn is live — let the live path own the
              // transcript instead of clobbering it here (mirrors the SSE completion
              // refetch guard at :1050). This IS a genuine improvement over the old
              // bare-shouldProcess() commit and is kept.
              if (refreshData.messages && shouldProcess() && !transcriptLoadingRef.current) {
                // Commit RAW. This poll teardown is the safety net for a GENUINE
                // completion whose SSE idle event was missed, so the on-disk messages
                // ARE the final answer — stripping on the turn's startedAt would delete
                // it, and the transcript-updated restore rides the same (dead) SSE that
                // forced the poll fallback in the first place (review-dots-desync-fix
                // Finding 2). The proper fix removes this whole teardown: the client
                // renders the single liveness projection and strips on
                // `liveness.startedAt` (null when idle) — see
                // docs/design-liveness-single-source-of-truth.md, step 2.
                setHistoryTranscript(refreshData.messages);
                setTranscriptOverlayMessages([]);
                setOverlayInsertPoint(null);
              }
            })
            .catch(() => {});
        })
        .catch(() => {});
    }, 15_000);

    const unsubscribe = subscribeAppEvents({
      on,
      watchSession: { sessionId: mySessionId, project: myProject },
      onWatching,
    });

    return () => {
      unsubscribe();
      clearInterval(healthPoll);
    };
    // sdkSessionsEnabled is read inside the handlers here (applyAskFromBuffer, the
    // AskUserQuestion routing guard); include it (P19) so toggling the setting at
    // runtime rebinds the handlers instead of leaving them capturing the stale value
    // until the next session switch. Everything after it is stable (or, for
    // applyAskFromBuffer, changes only with sdkSessionsEnabled) — listed for
    // completeness, never an extra reconnect.
  }, [
    viewingTranscriptId, historyTranscriptProject, sdkSessionsEnabled,
    applyLiveness, activeSessionRef, applyAskFromBuffer, openCliAsk, parkAsk, clearAsk,
    raiseLimit, setCurrentModel, ttsAnnounce,
  ]);

  // The catch-up below must use the CURRENT applyAskFromBuffer without re-running
  // when it changes (it changes with sdkSessionsEnabled — toggling the setting
  // must not fire a catch-up fetch of its own).
  const applyAskFromBufferNow = useEffectEvent(
    (bufData: Parameters<typeof applyAskFromBuffer>[0], issuedAt: number) => applyAskFromBuffer(bufData, issuedAt),
  );

  // --- Catch-up when tab becomes visible again ---
  // SSE events were skipped while hidden; re-fetch stream buffer + transcript
  // to sync state with what happened while the user was on another tab.
  useEffect(() => {
    if (!isActive || !viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    const bufIssuedAt = Date.now();
    fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
      .then(res => res.json())
      .then(bufData => {
        if (activeSessionRef.current !== mySessionId) return;

        // SSE was ignored while hidden, so a question asked in that window never
        // reached us — and Claude is still parked on it.
        applyAskFromBufferNow(bufData, bufIssuedAt);
        // Re-sync the durable failed-MCP banner on visibility catch-up (B4).
        setMcpFailedServers(Array.isArray(bufData.mcpFailed) ? bufData.mcpFailed : []);

        if (bufData.isProcessing || (bufData.hasBuffer && bufData.isActive)) {
          // Session is still processing — restore stream state
          if (bufData.accumulatedText) {
            setTranscriptStreaming(bufData.accumulatedText);
          }
          if (bufData.events) {
            setStreamEvents(bufData.events);
          }
          if (!transcriptLoadingRef.current) {
            setTranscriptLoading(true);
          }
        } else if (transcriptLoadingRef.current) {
          // Processing completed while we were hidden — refresh transcript
          setTranscriptLoading(false);
          setTranscriptStreaming('');
          fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
            .then(res => res.json())
            .then(refreshData => {
              if (refreshData.messages && activeSessionRef.current === mySessionId) {
                setHistoryTranscript(refreshData.messages);
                setTranscriptOverlayMessages([]);
                setOverlayInsertPoint(null);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [isActive, viewingTranscriptId, historyTranscriptProject, activeSessionRef]);

  const createNewSession = (path: string, model: string | null, resolvedModel: string | null = null) => {
    // Save current composer draft (text + attachments) before switching
    drafts.stash(viewingTranscriptId);

    const newId = generateUUID();
    // Go directly to transcript view for a new empty session. select() updates
    // activeSessionRef synchronously so any in-flight handler's isStillActive()
    // returns false.
    viewed.select(newId, path);

    setHistoryTranscript([]);
    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setTranscriptLoading(false);
    setBackgroundWorking(false);
    setTranscriptPartial(false);
    // Reflect the wizard's model in the status-bar label immediately, instead of
    // showing the provider default until the first turn's session:model init
    // event lands. formatModelName strips any [1m] suffix. resolvedModel carries
    // the CONCRETE wire id of the picked row — including for the default row,
    // where `model` stays null (no override) but the label still names the real
    // model. Only null when the catalog failed to load, which keeps the coarse
    // "Claude" fallback. currentModel wants the WIRE id, not the alias ('haiku'
    // would format to a bare "Claude").
    setCurrentModel(resolvedModel);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

    // Record the chosen model as a PENDING override before the first send.
    // sdkSessionManager.setModel persists it and startQuery() replays it into
    // the query options on the very first turn. Null = follow the default, so
    // no request is needed. Fire-and-forget: a failure just falls back to the
    // default, and the mid-session picker remains available to correct it.
    if (model) {
      fetch('/api/claude-sdk/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: newId, model }),
      }).catch(() => { /* non-fatal — first turn falls back to the default */ });
    }

    // Track this as a pending session so it persists in the sidebar
    setPendingNewSessions(prev => [...prev, { sessionId: newId, project: path, title: 'New Session', createdAt: Date.now() }]);

    // New session starts with an empty composer — restoreDraft on a fresh id
    // clears the editor AND the attachment chips (which previously leaked in).
    drafts.restore(newId);
  };

  const restorePendingSession = (pending: { sessionId: string; project: string; title: string }) => {
    // Save current composer draft (text + attachments) before switching
    drafts.stash(viewingTranscriptId);

    viewed.select(pending.sessionId, pending.project);

    setHistoryTranscript([]);
    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setTranscriptLoading(false);
    setBackgroundWorking(false);
    setTranscriptPartial(false);
    setIsStuck(false);
    setStuckReason(undefined);
    setHistoryTranscriptLoading(false);
    setCurrentModel(null);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

    // Restore composer draft (text + attachments) for this pending session
    drafts.restore(pending.sessionId);
  };

  const handleKillStuckSession = async () => {
    const mySessionId = viewingTranscriptId;
    if (!mySessionId) return;

    try {
      const res = sdkSessionsEnabled
        ? await fetch('/api/claude-sdk/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mySessionId }),
          })
        : await fetch('/api/health', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mySessionId, action: 'stop' }),
          });

      if (res.ok && activeSessionRef.current === mySessionId) {
        setIsStuck(false);
        setStuckReason(undefined);
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    } catch (error) {
      console.error('Failed to kill session:', error);
    }
  };

  const handleTranscriptSend = async (userMessage: string, imagesOverride?: AttachedImage[]) => {
    // `imagesOverride` is set only by the limit-recovery auto-resend, which replays
    // a prior turn's attachments verbatim (they were never in the composer's
    // staged state on this attempt).
    const isResend = imagesOverride !== undefined;
    if ((!userMessage && (imagesOverride ?? attachments.images).length === 0) || transcriptLoading || !viewingTranscriptId) return;

    // Snapshot + clear the staged attachments for this turn. A resend supplies its
    // own images and must not disturb (or be disturbed by) the live composer.
    const imagesToSend = imagesOverride ?? attachments.images;
    if (!isResend) attachments.clear();
    else attachments.clearError();
    const optimisticImages: TranscriptImagePart[] = imagesToSend.map(i => ({ dataUrl: i.dataUrl }));
    const apiImages = imagesToSend.map(i => ({ base64: i.base64, mediaType: i.mediaType }));

    // Stop any TTS playback so the user isn't talked over by the previous turn.
    tts.cleanup();

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    // Stash this turn's prompt + attachments so a terminal usage limit can resend
    // it on a different model without retyping. Overwritten each send.
    lastSendRef.current = { sessionId: mySessionId, prompt: userMessage, images: imagesToSend };

    // Clear the draft and remove from pending sessions since it's being submitted
    drafts.discard(mySessionId);
    setPendingNewSessions(prev => prev.filter(p => p.sessionId !== mySessionId));

    // If this session isn't in the history sidebar yet, add it optimistically
    if (!history.some(h => h.sessionId === mySessionId)) {
      setHistory(prev => [{
        display: userMessage
          ? (userMessage.length > 200 ? userMessage.substring(0, 200) + '...' : userMessage)
          : `📎 ${imagesToSend.length} image${imagesToSend.length === 1 ? '' : 's'}`,
        timestamp: Date.now(),
        project: myProject || '',
        sessionId: mySessionId,
        messageCount: 1,
      }, ...prev]);
    }

    // Optimistically mark this session as live so the badge renders immediately
    setLiveSessionIds(prev => {
      const next = new Set(prev);
      next.add(mySessionId);
      return next;
    });

    // Instant feedback — include the local thumbnails so the just-sent bubble
    // shows the attachment before the transcript round-trips (A6).
    setTranscriptOverlayMessages(prev => [...prev, {
      role: 'user' as const,
      content: userMessage,
      ...(optimisticImages.length > 0 ? { images: optimisticImages } : {}),
    }]);
    setTranscriptLoading(true);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setSessionError(null);
    setSubmitStartTime(Date.now());
    setSubmitEndTime(null);
    setTimeout(() => scrollTranscriptToBottom(), 50);
    uiLog('info', 'chat.send', 'submit', { sessionId: mySessionId, data: { promptChars: userMessage.length } });

    // Undo the optimistic in-flight UI when a send doesn't actually start — the
    // user backed out of a takeover. Pull the user bubble back off, drop the
    // spinner/live badge, and return the text to the composer so they can retry
    // or edit. (Genuine errors keep the existing assistant-error-bubble path.)
    const rollbackSend = () => {
      if (activeSessionRef.current !== mySessionId) return;
      setTranscriptLoading(false);
      setSubmitStartTime(null);
      setTranscriptOverlayMessages(prev => prev.slice(0, -1));
      setLiveSessionIds(prev => {
        const next = new Set(prev);
        next.delete(mySessionId);
        return next;
      });
      // Return the staged attachments + text to the composer so a backed-out
      // takeover can retry — but NOT for a resend, whose images/prompt were never
      // in the live composer (they'd clobber the user's in-progress draft).
      if (!isResend) {
        if (imagesToSend.length > 0) attachments.set(prev => prependImages(prev, imagesToSend));
        setTimeout(() => chatEditorRef.current?.setContent(userMessage), 50);
      }
    };

    // The POST, factored so the takeover-confirm path can replay it verbatim with
    // confirmTakeover set. A 409 {needsTakeoverConfirm} parks on a dialog instead
    // of erroring; the user's choice either replays this (confirm) or rolls back.
    const submitTurn = async (confirmTakeover: boolean): Promise<void> => {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          sessionId: mySessionId,
          projectPath: myProject,
          ...(apiImages.length > 0 ? { images: apiImages } : {}),
          ...(confirmTakeover ? { confirmTakeover: true } : {}),
        }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        if (data.needsTakeoverConfirm) {
          setTakeoverConfirm({
            owner: data.owner || {},
            onConfirm: () => {
              setTakeoverConfirm(null);
              submitTurn(true).catch(handleSendError);
            },
            onCancel: () => {
              setTakeoverConfirm(null);
              rollbackSend();
            },
          });
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Done. SSE delivers all stream events + session:health signals completion.
    };

    const handleSendError = (error: unknown) => {
      if (activeSessionRef.current === mySessionId) {
        setTranscriptOverlayMessages(prev => [...prev, {
          role: 'assistant' as const,
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }]);
        setTranscriptLoading(false);
        // Return the staged attachments so a retry re-sends them — without
        // this, a failed send silently discarded the pasted images and the
        // retry went out text-only (only the takeover-rollback path restored).
        // Skip for a resend: those images were never staged in the live composer,
        // so re-injecting them would disturb the user's current draft.
        if (!isResend && imagesToSend.length > 0) {
          attachments.set(prev => prependImages(prev, imagesToSend));
        }
      }
    };

    try {
      await submitTurn(false);
    } catch (error) {
      handleSendError(error);
    }
  };

  const handleRewind = async (request: RewindRequest, mode: 'conversation' | 'both') => {
    if (!viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;
    const rewindInfo = { ...request };
    const { turnIndex, fullMessage } = rewindInfo;

    // Immediately truncate the UI: remove all messages from the rewind point
    // onward. turnIndex counts TURNS (what the rewind button + server use), and
    // an AskUserQuestion answer is a user-role message that does NOT start a
    // turn — so it must be skipped, else an earlier turn is cut off too.
    const cutIdx = findRewindCutIndex(historyTranscript, turnIndex);
    if (cutIdx >= 0) {
      setHistoryTranscript(prev => prev.slice(0, cutIdx));
    }
    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptLoading(true);
    setTranscriptStreaming('');
    setStreamEvents([]);

    try {
      // Step 1: If "both", revert the code changes BEFORE truncating history.
      if (mode === 'both') {
        if (sdkSessionsEnabled) {
          // SDK path: native file-checkpoint revert. Deterministic (real
          // git-style rollback), no extra LLM turn. Targets the user message's
          // uuid — rewindFiles restores the working tree to that checkpoint.
          if (!rewindInfo.uuid) throw new Error('Rewind requires the message uuid (SDK path)');
          const rewindRes = await fetch('/api/claude-sdk/rewind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: mySessionId,
              messageUuid: rewindInfo.uuid,
              projectPath: myProject,
            }),
          });
          if (!rewindRes.ok) throw new Error(`SDK rewind failed: ${rewindRes.status}`);
        } else {
          // CLI path: prompt Claude to undo code changes BEFORE truncating
          // (so it still has context of what it did).
          const undoRes = await fetch('/api/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: `Undo all file changes you made starting from the message shown below. Restore every modified file to its state before that point. Do not explain, just revert the files.\n\nMessage to rewind to (${rewindInfo.timestamp ? new Date(rewindInfo.timestamp).toISOString() : 'unknown time'}):\n> ${rewindInfo.userMessage}`,
              sessionId: mySessionId,
              projectPath: myProject,
            }),
          });

          if (!undoRes.ok) throw new Error(`Undo request failed: ${undoRes.status}`);

          // Poll health until the undo processing finishes.
          // SSE delivers stream progress to the user during this time.
          await new Promise<void>((resolve) => {
            const poll = setInterval(async () => {
              try {
                const healthRes = await fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`);
                if (healthRes.ok) {
                  const healthData = await healthRes.json();
                  if (!healthData.isProcessing) {
                    clearInterval(poll);
                    resolve();
                  }
                }
              } catch { /* retry next interval */ }
            }, 2000);
          });
        }
      }

      // Step 2: Truncate the JSONL (removes original turns + the undo prompt)
      const res = await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: mySessionId,
          project: myProject,
          turnIndex,
          removeLastHistoryEntry: mode === 'both',
        }),
      });

      if (!res.ok) throw new Error(`Rewind failed: ${res.status}`);

      // Step 3: Reload transcript from the truncated JSONL
      const refreshRes = await fetch(
        `/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`
      );
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        if (refreshData.messages) {
          setHistoryTranscript(refreshData.messages);
          setTranscriptOverlayMessages([]);
          setOverlayInsertPoint(null);
        }
      }

      // Pre-fill the editor with the rewound message
      chatEditorRef.current?.setContent(fullMessage);
    } catch (error) {
      console.error('[App] Rewind failed:', error);
    } finally {
      if (activeSessionRef.current === mySessionId) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    }
  };

  const handleTranscriptStop = async () => {
    const mySessionId = viewingTranscriptId;
    if (!mySessionId) return;
    try {
      if (sdkSessionsEnabled) {
        // SDK path: interrupt the in-flight turn without tearing down the
        // persistent session (keeps the warm process + checkpoints alive).
        await fetch('/api/claude-sdk/interrupt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: mySessionId }),
        });
      } else {
        await fetch('/api/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: mySessionId, action: 'stop' }),
        });
      }
    } catch (error) {
      console.error('[App] Failed to stop session:', error);
    } finally {
      // Stopping kills the CLI, but everything generated up to this point was
      // cached — re-anchor the freshness window from now. (We clear
      // transcriptLoading here optimistically, so the session-health "just
      // ended" stamp won't fire; do it explicitly.)
      setSessionActivity(prev => ({ ...prev, [mySessionId]: Date.now() }));
      // Same reason: the health handler's turn-end branch is gated on
      // `transcriptLoadingRef.current`, which we're about to clear below, so it
      // will NOT drop the live context overlay for a stopped turn. Left behind,
      // the overlay outranks the archive via `??` for the life of the page (it
      // can never be superseded downward) — stranding a stale-high reading and
      // defeating rewind. Drop it here too.
      setLiveContext(prev => clearContextUsage(prev, mySessionId));
      if (activeSessionRef.current === mySessionId) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    }
  };

  const handleSessionArchived = (sessionId: string) => {
    if (viewingTranscriptId === sessionId) {
      viewed.clear();
      setHistoryTranscript([]);
      setTranscriptOverlayMessages([]);
      setTranscriptStreaming('');
      setTranscriptLoading(false);
    }
  };


  // CLI AskUserQuestion answer → a brand-new turn. The CLI was already killed
  // when the dialog opened, but defensively re-issue stop if loading is still
  // flagged (e.g. session-health hadn't arrived yet when the user answered
  // quickly) and clear local state so handleTranscriptSend's `transcriptLoading`
  // early-return doesn't trip.
  const sendProseAnswer = async (answer: string) => {
    const mySessionId = viewingTranscriptId;
    if (mySessionId && transcriptLoadingRef.current) {
      try {
        await fetch('/api/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: mySessionId, action: 'stop' }),
        });
      } catch (error) {
        console.error('Failed to stop in-flight session before sending answer:', error);
      }
      setTranscriptLoading(false);
      setTranscriptStreaming('');
    }
    handleTranscriptSend(answer);
  };

  return {
    // Transcript
    historyTranscript,
    historyTranscriptLoading,
    transcriptOverlayMessages,
    overlayInsertPoint,
    transcriptPartial,
    displayedTranscript,
    // Envelope (see lib/envelopeProjection)
    envelopeOpen,
    envelopeHidden,
    envelopeUserEcho,
    // In-flight turn
    transcriptStreaming,
    transcriptLoading,
    backgroundWorking,
    live,
    livenessDotsEnabled,
    streamEvents,
    submitStartTime,
    submitEndTime,
    isStuck,
    stuckReason,
    sessionError,
    mcpFailedServers,
    takeoverConfirm,
    // Sidebar
    sessionActivity,
    liveContext,
    pendingNewSessions,
    // Scroll anchors for the conversation pane
    transcriptEndRef,
    lastAssistantRef,
    // Actions
    openSession: fetchTranscript,
    startNewSession: createNewSession,
    restorePending: restorePendingSession,
    send: handleTranscriptSend,
    sendProseAnswer,
    stop: handleTranscriptStop,
    rewind: handleRewind,
    killStuck: handleKillStuckSession,
    onArchived: handleSessionArchived,
    showError: setSessionError,
  };
}
