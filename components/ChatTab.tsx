'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Plus, AlertTriangle, FolderTree, FileText, Activity, Plug } from 'lucide-react';
import Dialog, { ConfirmDialog, AlertDialog } from '@/components/Dialog';
import { Button } from '@/components/ui/button';
import RichTextEditor, { type RichTextEditorHandle } from '@/components/RichTextEditor';
import FileTree from '@/components/FileTree';
import CodeViewerDialog, { isCodeFile } from '@/components/CodeViewerDialog';
import AskUserQuestionDialog from '@/components/AskUserQuestionDialog';
import StreamEventsPanel, { type StreamEvent } from '@/components/StreamEventsPanel';
import McpPanel from '@/components/McpPanel';
import SessionSidebar from '@/components/SessionSidebar';
import TranscriptRenderer from '@/components/TranscriptRenderer';
import IntermediaryMessagesDialog from '@/components/IntermediaryMessagesDialog';
import SessionContextMenu from '@/components/SessionContextMenu';
import LabelEditDialog from '@/components/LabelEditDialog';
import ModelPickerDialog from '@/components/ModelPickerDialog';
import NewSessionModelStep from '@/components/NewSessionModelStep';
import { DirectoryPicker } from '@/components/DirectoryPicker';
import { getRecentDirectories } from '@/lib/recent-directories';
import { uiLog } from '@/lib/clientTelemetry';
import { stripInFlightPartials } from '@/lib/transcriptStrip';
import type { Message, TranscriptMsg, HistoryEntry, PendingSession, AskUserQuestionState, TranscriptImagePart } from '@/lib/types';
import { normalizeImage, type AttachedImage } from '@/lib/clientImage';
import type { TurnMeta } from '@/lib/transcriptParser';
import type { Liveness } from '@/lib/eventBus';

// Generate a UUID v4
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

interface ChatTabProps {
  chatHorizontalLayout: number[];
  chatVerticalLayout: number[];
  onHorizontalLayoutChange: (sizes: number[]) => void;
  onVerticalLayoutChange: (sizes: number[]) => void;
  isActive: boolean; // pause SSE processing when tab is hidden
  promptSuggestionsEnabled: boolean;
  ttsEnabled: boolean;
  /** When on, stop/rewind route to the persistent SDK session endpoints
   *  (/api/claude-sdk/interrupt, /rewind) instead of the CLI kill + LLM-undo. */
  sdkSessionsEnabled: boolean;
  /** A request from another tab (Stats) to open a transcript here. `nonce`
   *  changes on every request so re-opening the same session re-fires; null
   *  when nothing is pending. */
  openSessionRequest?: { sessionId: string; project: string; display: string; nonce: number } | null;
}

// stripInFlightPartials moved to lib/transcriptStrip.ts (imported above) so its
// anchor-vs-fallback behavior can be unit-tested without pulling in this client
// component. See that file for the rationale on why the startedAt anchor matters.

export default function ChatTab({
  chatHorizontalLayout,
  chatVerticalLayout,
  onHorizontalLayoutChange,
  onVerticalLayoutChange,
  isActive,
  promptSuggestionsEnabled,
  ttsEnabled,
  sdkSessionsEnabled,
  openSessionRequest,
}: ChatTabProps) {
  // --- State moved from page.tsx ---

  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  // New-session wizard step (b): model selection. `wizardPath` holds the
  // directory chosen in step (a) until the user commits or backs out.
  const [showModelStep, setShowModelStep] = useState(false);
  const [wizardPath, setWizardPath] = useState<string | null>(null);

  // Health check state
  const [isStuck, setIsStuck] = useState(false);
  const [stuckReason, setStuckReason] = useState<string | undefined>();

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const historyLengthRef = useRef(0);
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set());
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

  // Smart prompt suggestion for incomplete responses
  const [suggestedPrompt, setSuggestedPrompt] = useState<{ text: string; context: string } | null>(null);


  // History transcript viewer state (renders in center panel)
  const [historyTranscript, setHistoryTranscript] = useState<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnMeta?: TurnMeta; uuid?: string; images?: TranscriptImagePart[] }[]>([]);
  const [viewingTranscriptId, setViewingTranscriptId] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [historyTranscriptLoading, setHistoryTranscriptLoading] = useState(false);
  const [historyTranscriptProject, setHistoryTranscriptProject] = useState<string | null>(null);
  const [transcriptOverlayMessages, setTranscriptOverlayMessages] = useState<(Message & { images?: TranscriptImagePart[] })[]>([]);
  // Image attachments staged for the next send (paste/drop → normalize → chip).
  // Lives here (not in the editor) so it survives editor clears.
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  /** Why the last paste/drop was (partially) rejected — shown beside the chips. */
  const [attachError, setAttachError] = useState<string | null>(null);
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
  // Opt-in for the projection-driven dots (localStorage `fury.livenessDots`). Off by
  // default so the legacy path is untouched until this is proven in the app; flip it in
  // the browser console to verify. Step 3 makes it the default and deletes the legacy path.
  const [livenessDotsEnabled, setLivenessDotsEnabled] = useState(false);
  const livenessDotsEnabledRef = useRef(false);
  const [providerSource, setProviderSource] = useState<'Anthropic' | 'Bedrock' | null>(null);
  const [providerConfiguredModel, setProviderConfiguredModel] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
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
  const ttsEnabledRef = useRef(ttsEnabled);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsBlobUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const [ttsPlaying, setTtsPlaying] = useState<'loading' | 'playing' | 'paused' | 'idle'>('idle');
  const activeSessionRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const lastAssistantRef = useRef<HTMLDivElement>(null);
  const prevAssistantCountRef = useRef(0);
  const skipNextAssistantScrollRef = useRef(true);

  // Tracks the latest prompt-submission timing for the stream panel's
  // "Elapsed Time" indicator. submitEndTime stays null until the response
  // (or error) completes; once set, the timer freezes at the final value.
  const [submitStartTime, setSubmitStartTime] = useState<number | null>(null);
  const [submitEndTime, setSubmitEndTime] = useState<number | null>(null);
  const chatEditorRef = useRef<RichTextEditorHandle>(null);
  const sessionDraftsRef = useRef<Map<string, string>>(new Map());

  // When overlay messages are restored from a previous session, they belong at a
  // specific position in the transcript (not at the end). null = append at end (live sends).
  const [overlayInsertPoint, setOverlayInsertPoint] = useState<number | null>(null);

  // True when the transcript was reconstructed from history.jsonl (user prompts only, no responses)
  const [transcriptPartial, setTranscriptPartial] = useState(false);

  // AskUserQuestion dialog state
  const [askUserQuestion, setAskUserQuestion] = useState<AskUserQuestionState | null>(null);
  // The middle-panel container the AskUserQuestion modal anchors to, so the
  // question dialog appears within the Chat panel rather than over the whole app.
  const middlePanelRef = useRef<HTMLDivElement>(null);

  /** When a question last PARKED, via SSE. Guards the stale-close race below. */
  const lastAskEventAtRef = useRef(0);
  /** The last question the user ANSWERED and when. Guards the stale-RE-OPEN race
   *  (P18): a reconnect/visibility buffer fetch issued before the answer landed can
   *  still return the question as pending and flash the just-answered dialog back on. */
  const answeredAskRef = useRef<{ toolUseID: string; at: number } | null>(null);

  /**
   * Re-open (or close) the dialog from a /api/stream-buffer response.
   *
   * On the SDK path the server holds the pending question and Claude is parked
   * on it indefinitely, so this is what makes a browser refresh, a switch-back,
   * or a backgrounded tab survivable: without it the turn is stranded — the
   * process waits forever on a dialog that no longer exists on screen. Called
   * from every buffer restore site, since each is a moment the dialog could have
   * been lost.
   *
   * A null pendingAsk closes a stale SDK dialog (the question was answered
   * elsewhere — another tab, an abort). Guarded on toolUseID so it never closes
   * a CLI-sourced dialog, which the server has no record of.
   *
   * `issuedAt` is when the fetch was SENT, and the null branch needs it: the
   * response is a snapshot of the past with no ordering guarantee against SSE.
   * If a question parks after we asked but before the answer lands, that stale
   * null would close a dialog that had only just opened — and Claude would park
   * forever with nothing on screen to answer it. Narrow (fetches return in ms,
   * parks happen seconds in) but it's the failure this whole design exists to
   * prevent, so: never let a snapshot older than the last park close anything.
   */
  const applyPendingAskFromBuffer = (
    bufData: { pendingAsk?: { toolUseID?: string; questions?: unknown } | null },
    issuedAt: number,
  ) => {
    if (!sdkSessionsEnabled) return;
    const pending = bufData?.pendingAsk;
    if (pending?.toolUseID && Array.isArray(pending.questions)) {
      // P18: don't re-open a dialog the user already answered. In the small window
      // before the server resolves the answer, a stale buffer snapshot (issued
      // BEFORE the answer) can still carry this toolUseID as pending. If we answered
      // it at/after the snapshot was issued, that snapshot predates the answer —
      // ignore it. A fetch issued AFTER the answer that STILL shows pending is
      // genuinely unresolved (e.g. the answer POST failed), so let it re-open.
      const answered = answeredAskRef.current;
      if (answered && answered.toolUseID === pending.toolUseID && answered.at >= issuedAt) return;
      lastAskEventAtRef.current = Date.now();
      setAskUserQuestion({
        toolUseID: pending.toolUseID,
        input: { questions: pending.questions as AskUserQuestionState['input']['questions'] },
      });
    } else if (pending === null) {
      // >= not >: a park stamped in the same millisecond the fetch was issued is
      // unordered with respect to it, so treat it as newer. Ties fail toward
      // KEEPING the dialog — the safe direction, since the cost of a wrong close
      // is a turn parked forever with nothing on screen, and the cost of a wrong
      // keep is a stale dialog whose answer gets a harmless 409.
      if (lastAskEventAtRef.current >= issuedAt) return; // snapshot predates the park
      setAskUserQuestion(prev => (prev?.toolUseID ? null : prev));
    }
  };

  // Session-scoped SSE ref
  const sessionEsRef = useRef<EventSource | null>(null);

  // Recent directories (computed from history)
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);

  // Right panel view state
  type RightPanelView = 'files' | 'notes' | 'stream' | 'mcp';
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>('stream');

  // Notes state
  const [notes, setNotes] = useState<string>('');
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);

  // Dialog/confirmation states (all local to ChatTab)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; sessionId: string; project: string; display: string; isLive: boolean;
  } | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    sessionId: string; project: string; display: string; isLive: boolean;
  } | null>(null);
  const [labelEdit, setLabelEdit] = useState<{
    sessionId: string; currentLabel: string;
  } | null>(null);
  const [rewindConfirm, setRewindConfirm] = useState<{
    turnIndex: number; userMessage: string; fullMessage: string; timestamp: string; uuid?: string;
  } | null>(null);
  const [intermediaryMessages, setIntermediaryMessages] = useState<TranscriptMsg[]>([]);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  // Parked when a send hits a session that's live in an external terminal. The
  // backend answers with a 409 {needsTakeoverConfirm}; this holds the owner info
  // plus the confirm/cancel continuations so the user decides whether to take it
  // over (which ends the terminal) or back out. See handleTranscriptSend.
  const [takeoverConfirm, setTakeoverConfirm] = useState<{
    owner: { pid?: number; name?: string; cwd?: string };
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const [codeViewerPath, setCodeViewerPath] = useState<string | null>(null);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message?: string } | null>(null);
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
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Pretty-print a Claude model id ("claude-opus-4-7" → "Claude Opus 4.7").
  // Returns null if the id doesn't match the expected shape so the caller
  // can fall back to a coarser label.
  //
  // Handles both version shapes the catalog actually ships: two-segment
  // ("claude-opus-4-8" → "Opus 4.8") and one-segment ("claude-sonnet-5" →
  // "Sonnet 5"). The minor segment MUST stay optional — Sonnet 5 and Fable 5
  // have none, and requiring it silently degraded them to a bare "Claude".
  // Context-window variants carry a bracket suffix ("claude-opus-4-8[1m]")
  // that isn't part of the name, so strip it before matching.
  const formatModelName = (raw: string | null): string | null => {
    if (!raw) return null;
    const match = raw.replace(/\[[^\]]*\]/g, '').match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
    if (!match) return null;
    const name = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `Claude ${name} ${version}`;
  };

  // Compose the status-bar label. Prefer the per-session model (from the
  // CLI init event or the most recent assistant turn); fall back to the
  // ANTHROPIC_MODEL env var (set in Bedrock mode); finally fall back to
  // a generic "Claude".
  const modelLabel = formatModelName(currentModel) || formatModelName(providerConfiguredModel) || 'Claude';
  const providerLabel = providerSource ? `${modelLabel} (${providerSource})` : '';

  // The model picker is an SDK-backend-only affordance — see the status bar.
  const modelPickerAvailable = !!viewingTranscriptId && sdkSessionsEnabled;

  // --- Ref sync effects ---

  // Track whether this tab is visible so SSE handlers can skip work when hidden.
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  /** Stop any in-flight TTS fetch and playing audio, revoke blob URL. */
  const ttsCleanup = useCallback(() => {
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    if (ttsBlobUrlRef.current) {
      URL.revokeObjectURL(ttsBlobUrlRef.current);
      ttsBlobUrlRef.current = null;
    }
    setTtsPlaying('idle');
  }, []);

  // Track the currently-viewed session so in-flight SSE handlers can detect
  // when the user has switched away and skip state updates accordingly.
  useEffect(() => {
    activeSessionRef.current = viewingTranscriptId;
    // Stop TTS and dictation when switching sessions
    ttsCleanup();
    chatEditorRef.current?.stopRecording();
  }, [viewingTranscriptId, ttsCleanup]);

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

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

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
  useEffect(() => {
    if (historyTranscriptLoading) {
      skipNextAssistantScrollRef.current = true;
      prevAssistantCountRef.current = 0;
      return;
    }
    const assistantCount = historyTranscript.reduce(
      (n, m) => (m.role === 'assistant' ? n + 1 : n),
      0,
    );
    if (assistantCount > prevAssistantCountRef.current && !skipNextAssistantScrollRef.current) {
      requestAnimationFrame(() => {
        lastAssistantRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    prevAssistantCountRef.current = assistantCount;
    skipNextAssistantScrollRef.current = false;
  }, [historyTranscript, historyTranscriptLoading]);

  const HISTORY_PAGE_SIZE = 25;

  // --- fetchHistory ---
  // A non-append refresh (the default) is fired on `history-updated` SSE,
  // SSE reconnect, mount, and after deletes — events that arrive often while
  // chatting. To avoid collapsing previously-loaded pages back to the first
  // 25, ask the API for at least as many entries as we already display.
  const fetchHistory = async (opts?: { append?: boolean }) => {
    const append = opts?.append === true;
    const offset = append ? historyLengthRef.current : 0;
    const limit = append
      ? HISTORY_PAGE_SIZE
      : Math.max(HISTORY_PAGE_SIZE, historyLengthRef.current);
    if (append) setIsLoadingMoreHistory(true); else setIsLoadingHistory(true);
    try {
      const res = await fetch(`/api/history?limit=${limit}&offset=${offset}`);
      if (res.ok) {
        const data = await res.json();
        const incoming: HistoryEntry[] = data.entries || [];
        if (append) {
          setHistory(prev => {
            const seen = new Set(prev.map(e => e.sessionId).filter(Boolean) as string[]);
            const merged = [...prev];
            for (const e of incoming) {
              if (e.sessionId && seen.has(e.sessionId)) continue;
              merged.push(e);
            }
            historyLengthRef.current = merged.length;
            return merged;
          });
        } else {
          setHistory(incoming);
          historyLengthRef.current = incoming.length;
        }
        setHistoryHasMore(!!data.hasMore);
      }
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      if (append) setIsLoadingMoreHistory(false); else setIsLoadingHistory(false);
    }
  };

  const loadMoreHistory = useCallback(() => {
    fetchHistory({ append: true });
  }, []);

  // Fetch history on mount
  useEffect(() => {
    fetchHistory();
  }, []);

  // Keep ref in sync with history length so loadMore uses an accurate offset
  // even when entries are added/removed outside of fetchHistory (e.g. prepend
  // on submit, delete-session).
  useEffect(() => {
    historyLengthRef.current = history.length;
  }, [history.length]);

  // Mirror history into a ref so the per-session SSE handler can read the
  // current archived baseline without re-subscribing on every history change.
  const historyRef = useRef<HistoryEntry[]>([]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // NOTE: the live-token overlay used to need a reconciliation effect here to
  // drop it once the archived baseline caught up. The context overlay needs no
  // such thing — it's an absolute level that the archive converges to on its
  // own, so a stale overlay can only ever be superseded, never double-counted.

  // --- fetchTranscript ---
  const fetchTranscript = async (sessionId: string, project: string, displayTitle: string) => {
    // Save current editor draft before switching
    if (viewingTranscriptId && chatEditorRef.current) {
      const draft = chatEditorRef.current.getContent();
      if (chatEditorRef.current.getPlainText?.()?.trim?.() || draft.replace(/<[^>]*>/g, '').trim()) {
        sessionDraftsRef.current.set(viewingTranscriptId, draft);
      } else {
        sessionDraftsRef.current.delete(viewingTranscriptId);
      }
    }

    // Update the active session ref synchronously so SSE handlers for the
    // previous session's isStillActive() return false immediately.
    activeSessionRef.current = sessionId;

    setHistoryTranscriptLoading(true);
    setHistoryTranscript([]);

    setHistoryTranscriptProject(project);
    setViewingTranscriptId(sessionId);
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
    setSuggestedPrompt(null);
    // Clear any parked question on switch, UNCONDITIONALLY (P17). The SDK path
    // self-heals (its restore returns pendingAsk:null), but the CLI path never
    // clears a stale dialog — so answering a question carried over from session A
    // while viewing B would post the answer as a new turn against B (wrong session).
    // The target session's own restore below re-sets it from /api/stream-buffer.
    setAskUserQuestion(null);
    setIsStuck(false);
    setStuckReason(undefined);
    setCurrentModel(null);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

    // Restore draft for the target session (or clear)
    const savedDraft = sessionDraftsRef.current.get(sessionId) || '';
    setTimeout(() => chatEditorRef.current?.setContent(savedDraft), 50);
    try {
      const res = await fetch(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`);
      let transcriptMessages: { role: 'user' | 'assistant'; content: string; timestamp: string; images?: TranscriptImagePart[] }[] = [];
      if (res.ok) {
        const data = await res.json();
        transcriptMessages = data.messages || [];
        setTranscriptPartial(!!data.partial);
        setSuggestedPrompt(data.suggestedPrompt || null);

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
          setAskUserQuestion({
            // null, not an id: the CLI path cannot answer a tool call — the
            // answer is re-sent as a fresh prose turn — so there is nothing to
            // correlate with. The type says so out loud.
            toolUseID: null,
            input: data.pendingAskUserQuestion,
          });
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
          applyPendingAskFromBuffer(bufData, bufIssuedAt);
          // Restore the durable failed-MCP banner for this session (B4).
          setMcpFailedServers(Array.isArray(bufData.mcpFailed) ? bufData.mcpFailed : []);
          // Show the background-work dots immediately when opening a session whose
          // main turn is idle but which is still driving a background subagent.
          setBackgroundWorking(!!bufData.backgroundActive);
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

            setTranscriptOverlayMessages([{ role: 'user' as const, content: bufData.userPrompt }]);
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

  // Open a transcript requested by another tab (Stats → "open this session").
  //
  // Keyed on the request's nonce alone, NOT on fetchTranscript: that's a plain
  // arrow re-created every render, so depending on it would re-open the session
  // on every state change. The ref keeps the effect pinned to the nonce while
  // still calling the current closure.
  const fetchTranscriptRef = useRef(fetchTranscript);
  fetchTranscriptRef.current = fetchTranscript;
  useEffect(() => {
    if (!openSessionRequest) return;
    const { sessionId, project, display } = openSessionRequest;
    if (!sessionId || !project) return;
    fetchTranscriptRef.current(sessionId, project, display);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionRequest?.nonce]);

  // --- Global SSE connection for live-sessions and history-updated events ---
  // Connects when the tab becomes active, disconnects when hidden to save resources.
  // On reconnect (tab re-shown), re-fetches state to cover the gap.
  useEffect(() => {
    if (!isActive) return;

    // Fetch initial / catch-up data
    fetch('/api/live-sessions').then(res => res.json()).then(data => {
      setLiveSessionIds(new Set(data.liveSessionIds || []));
    }).catch(() => {});
    fetchHistory();

    // Fetch current provider status. Source (Anthropic/Bedrock) and the
    // configured model (if any) are tracked separately so we can override
    // the model portion with the per-session value once we know it.
    const applyProviderStatus = (data: { current: string; bedrockEnv?: Record<string, string> }) => {
      setProviderSource(data.current === 'bedrock' ? 'Bedrock' : 'Anthropic');
      setProviderConfiguredModel(data.bedrockEnv?.ANTHROPIC_MODEL || null);
    };
    fetch('/api/provider').then(res => res.json()).then(applyProviderStatus).catch(() => {
      setProviderSource(null);
      setProviderConfiguredModel(null);
    });

    const es = new EventSource('/api/events');

    es.addEventListener('live-sessions', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setLiveSessionIds(new Set(data.liveSessionIds || []));
    });

    es.addEventListener('history-updated', () => {
      fetchHistory();
    });

    es.addEventListener('provider-switched', () => {
      fetch('/api/provider').then(res => res.json()).then(applyProviderStatus).catch(() => {});
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CONNECTING) {
        // Re-fetch state to cover any events we missed while the SSE
        // connection was dropped (e.g. provider switch-back fired during
        // a server restart).
        fetch('/api/live-sessions').then(res => res.json()).then(data => {
          setLiveSessionIds(new Set(data.liveSessionIds || []));
        }).catch(() => {});
        fetchHistory();
        fetch('/api/provider').then(res => res.json()).then(applyProviderStatus).catch(() => {});
      }
    };

    return () => es.close();
  }, [isActive]);

  // --- Session-scoped SSE for stream, health, and transcript events ---
  useEffect(() => {
    // Close previous session-scoped connection
    if (sessionEsRef.current) {
      sessionEsRef.current.close();
      sessionEsRef.current = null;
    }

    if (!viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    const es = new EventSource(
      `/api/events?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`
    );
    sessionEsRef.current = es;

    const isStillActive = () => activeSessionRef.current === mySessionId;
    // Skip expensive state updates when the tab is hidden; catch-up happens
    // when isActive flips back to true (see effect below).
    const shouldProcess = () => isStillActive() && isActiveRef.current;

    // --- SSOT liveness projection (step 2b) ---
    // Reset on session switch so a prior session's phase can't leak into this view.
    setLive(null);
    liveRef.current = null;
    // Apply an incoming liveness LEVEL. An SSE beat (PUSH) advances state only when its
    // seq is NEWER — a late/duplicate beat can't move the level backward. A PULL
    // (/api/health, reconnect/poll) is an authoritative snapshot applied
    // UNCONDITIONALLY: state can move without a push (a wedge self-heal), so a fresh
    // pull may legitimately carry the SAME seq as the last push (design §3 seq contract).
    const applyLiveness = (next: Liveness | undefined | null, fromPull: boolean) => {
      if (!next || typeof next.seq !== 'number') return;
      const cur = liveRef.current;
      if (!fromPull && cur && next.seq <= cur.seq) return;
      liveRef.current = next;
      setLive(next);
    };

    // On SSE connect, re-fetch the stream buffer to close the gap between the
    // initial restore in fetchTranscript and when the EventSource connected.
    // Events emitted during that window would otherwise be lost.
    es.addEventListener('connected', () => {
      if (!shouldProcess()) return;

      const bufIssuedAt = Date.now();
      fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(bufData => {
          if (!shouldProcess()) return;

          // A question could have been asked in the gap between the initial
          // restore and this connect — that emit would have had no listener.
          applyPendingAskFromBuffer(bufData, bufIssuedAt);
          // Re-sync the durable failed-MCP banner on connect (B4).
          setMcpFailedServers(Array.isArray(bufData.mcpFailed) ? bufData.mcpFailed : []);

          // Sync background-work dots on connect (SSE may have missed the change).
          setBackgroundWorking(!!bufData.backgroundActive);

          if (bufData.hasBuffer) {
            // Only update if the buffer has more data than what we currently have
            const currentLen = transcriptStreamingRef.current?.length || 0;
            if ((bufData.accumulatedText || '').length > currentLen) {
              setTranscriptStreaming(bufData.accumulatedText || '');
              setStreamEvents(bufData.events || []);
            }
          }

          // Sync loading state — use isProcessing (session-level) not just
          // isActive (buffer-level) to avoid false negatives during queue processing.
          const isProcessing = bufData.isProcessing || (bufData.hasBuffer && bufData.isActive);
          if (isProcessing && !transcriptLoadingRef.current) {
            setTranscriptLoading(true);
          } else if (!isProcessing && transcriptLoadingRef.current) {
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
          }
        })
        .catch(() => {});
    });

    // Handle session:stream events — the single path for all stream data.
    // NOTE: These events only fire for sessions managed by Fury's sessionManager.
    // External CLI sessions rely on transcript-updated (file watcher) for updates.
    es.addEventListener('session-stream', (e: MessageEvent) => {
      if (!shouldProcess()) return;

      const data = JSON.parse(e.data);

      // MCP status signal (B4) — handled BEFORE the loading guard: this is a
      // one-shot init signal, not turn stream data. The server sends only
      // genuinely FAILED servers (benign needs-auth/pending are log-only, so this
      // never fires for an un-authed claude.ai connector), and an EMPTY array is
      // a recovery/clear. We store it in durable per-session state (not
      // streamEvents) so the banner survives turn resets and clears on recovery.
      if (Array.isArray(data.mcpServers)) {
        setMcpFailedServers(data.mcpServers);
        if (data.mcpServers.length > 0) {
          uiLog('warn', 'chat.mcp', 'mcp server(s) failed to connect', {
            sessionId: mySessionId,
            data: { servers: data.mcpServers },
          });
        }
        return;
      }

      // Ignore stream data that arrives after the user has stopped processing.
      // Without this guard, buffered events could overwrite the cleared state.
      if (!transcriptLoadingRef.current) return;

      if (data.text) {
        setTranscriptStreaming(prev => prev + data.text);
        setStreamEvents(prev => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'text') {
            return [...prev.slice(0, -1), { ...last, content: (last as any).content + data.text }];
          }
          return [...prev, { type: 'text' as const, content: data.text, ts: Date.now() }];
        });
      } else if (data.toolUse) {
        const tool = data.toolUse;
        if (tool.status === 'starting') {
          setStreamEvents(prev => [...prev, { type: 'tool_start' as const, name: tool.name, ts: Date.now() }]);
        } else if (tool.status === 'complete') {
          setStreamEvents(prev => [...prev, { type: 'tool_complete' as const, name: tool.name, input: tool.input, ts: Date.now() }]);
          // Surface AskUserQuestion immediately. SessionManager fires the
          // CLI kill on the server side when it parses the same tool_use
          // block, so we don't need to issue the stop here — that's
          // necessary so the kill still happens when the user is viewing
          // a different session at the moment the tool fires.
          //
          // CLI PATH ONLY. This event carries no toolUseID (see
          // SessionStreamEvent.toolUse), so a dialog opened from it could never
          // resolve the parked tool call. The SDK backend emits its own
          // `askUserQuestion` event WITH the id — handled below — and this event
          // fires for SDK sessions too, so without this guard both would race to
          // open the dialog and the id-less one could win.
          if (!sdkSessionsEnabled && tool.name === 'AskUserQuestion' && tool.input?.questions) {
            setAskUserQuestion({ toolUseID: null, input: tool.input });
          }
        }
      } else if (data.askUserQuestion) {
        // The SDK backend is parked in canUseTool awaiting this answer. Unlike
        // the toolUse event above, this one carries the toolUseID that
        // /api/claude-sdk/answer needs to resolve the right tool call.
        // `cleared` = someone else settled it (abort, another tab, teardown), so
        // close the dialog rather than leave the user answering a dead question.
        if (data.askUserQuestion.cleared) {
          setAskUserQuestion(null);
        } else if (data.askUserQuestion.questions) {
          // Stamp the park so an in-flight buffer fetch, issued before this and
          // answering `pendingAsk: null`, can't close the dialog we just opened.
          lastAskEventAtRef.current = Date.now();
          setAskUserQuestion({
            toolUseID: data.askUserQuestion.toolUseID,
            input: { questions: data.askUserQuestion.questions },
          });
        }
      } else if (data.toolResult) {
        setStreamEvents(prev => [...prev, { type: 'tool_result' as const, preview: data.toolResult.preview, ts: Date.now() }]);
      } else if (data.error) {
        setStreamEvents(prev => [...prev, { type: 'error' as const, content: data.error, ts: Date.now() }]);
        // Persist it in the center panel too — the parser drops the SDK's
        // synthetic error message, so this is the only durable surface.
        setSessionError(data.error);
        uiLog('error', 'chat.stream', 'error surfaced', {
          sessionId: mySessionId,
          data: { error: String(data.error).slice(0, 300) },
        });
      }
    });

    // The CLI tells us which model it spun up in its `system.init` line —
    // capture it so the status bar can show the real model name even when
    // ANTHROPIC_MODEL isn't set (the direct-Anthropic case).
    es.addEventListener('session-model', (e: MessageEvent) => {
      if (!shouldProcess()) return;
      const data = JSON.parse(e.data);
      if (data.model) setCurrentModel(data.model);
    });

    // Live context occupancy for the in-flight turn. An absolute level, so it
    // replaces rather than accumulates — no baseline, no arithmetic.
    es.addEventListener('session-usage', (e: MessageEvent) => {
      if (!shouldProcess()) return;
      const data = JSON.parse(e.data);
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
      setLiveContext(prev => {
        const prior = prev[mySessionId];
        // The window only arrives once the turn's `result` lands, and later
        // events in the same turn report 0 until then. Keep the last known
        // non-zero value so the fill bar doesn't blink out mid-turn.
        const window = data.contextWindow > 0 ? data.contextWindow : (prior?.window ?? 0);
        if (prior?.tokens === data.contextTokens && prior?.window === window) return prev;
        return { ...prev, [mySessionId]: { tokens: data.contextTokens, window } };
      });
    });

    // Handle session:health events (replaces health polling)
    es.addEventListener('session-health', (e: MessageEvent) => {
      if (!shouldProcess()) return;
      const data = JSON.parse(e.data);
      setIsStuck(data.isStuck);
      setStuckReason(data.stuckReason);

      // SSOT: adopt the pushed liveness level (seq-gated). The heartbeat re-sends this
      // every few seconds while non-idle, so `live.phase` is self-correcting.
      applyLiveness(data.liveness, false);

      // Background-work dots: independent of the in-flight-turn machinery below.
      // A session driving a background subagent between its own turns keeps the
      // dots on even though its main turn is idle (data.isProcessing false).
      setBackgroundWorking(!!data.backgroundActive);

      // Authoritative liveness signal — a real reading resets the poll's
      // transient-false streak either way.
      healthFalseStreakRef.current = 0;

      // If the session is actively processing, ensure the loading indicator
      // (bouncing dots) is visible. Break the latch: if a transient false had
      // already committed this turn's partials to historyTranscript, re-strip
      // them so we return to dots instead of leaving the bubbles on screen.
      if (data.isProcessing && !transcriptLoadingRef.current) {
        uiLog('warn', 'chat.health', 'latch-break re-strip (isProcessing true while not loading)', {
          sessionId: mySessionId,
          data: { startedAt: data.startedAt ?? null },
        });
        setHistoryTranscript(prev =>
          stripInFlightPartials(prev, typeof data.startedAt === 'number' ? data.startedAt : 0),
        );
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
      if (!data.isProcessing && !data.backgroundActive && transcriptLoadingRef.current) {
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
        setLiveContext(prev => {
          if (!(mySessionId in prev)) return prev;
          const next = { ...prev };
          delete next[mySessionId];
          return next;
        });
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

              // TTS: speak the last chat bubble using the same turn-grouping
              // logic as TranscriptRenderer — within the last turn, the final
              // assistant message is the rendered bubble; earlier ones are intermediaries.
              if (ttsEnabledRef.current) {
                const msgs = refreshData.messages as { role: string; content: string; turnMeta?: TurnMeta }[];
                let turnBubble: { content: string; turnMeta?: TurnMeta } | null = null;
                let lastTurnBubble: { content: string; turnMeta?: TurnMeta } | null = null;
                for (const msg of msgs) {
                  if (msg.role === 'user') {
                    // New turn — commit previous turn's bubble
                    if (turnBubble) lastTurnBubble = turnBubble;
                    turnBubble = null;
                  } else if (msg.role === 'assistant') {
                    turnBubble = msg;
                  }
                }
                // The last turn's bubble is either the open turn or the last committed one
                const bubble = turnBubble || lastTurnBubble;
                if (bubble?.content) {
                  ttsCleanup();
                  const abort = new AbortController();
                  ttsAbortRef.current = abort;
                  setTtsPlaying('loading');
                  fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: bubble.content, turnMeta: bubble.turnMeta }),
                    signal: abort.signal,
                  })
                    .then(res => {
                      if (ttsAbortRef.current !== abort) return; // superseded
                      if (!res.ok) throw new Error('TTS failed');
                      return res.blob();
                    })
                    .then(blob => {
                      if (!blob || ttsAbortRef.current !== abort) return; // superseded
                      const url = URL.createObjectURL(blob);
                      ttsBlobUrlRef.current = url;
                      const audio = new Audio(url);
                      ttsAudioRef.current = audio;
                      audio.onended = () => setTtsPlaying('idle');
                      audio.play().catch(err => {
                        console.error('[TTS] playback failed:', err);
                        setTtsPlaying('idle');
                      });
                      setTtsPlaying('playing');
                    })
                    .catch(err => {
                      if (ttsAbortRef.current !== abort) return; // superseded
                      if (err.name !== 'AbortError') console.error('[TTS]', err);
                      setTtsPlaying('idle');
                    });
                }
              }
            }
          })
          .catch(() => {});
      }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CONNECTING && shouldProcess()) {
        uiLog('warn', 'chat.sse', 'reconnecting', {
          sessionId: mySessionId,
          data: { loading: transcriptLoadingRef.current },
        });
        // SSE reconnecting — check if session completed while disconnected
        fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`)
          .then(res => res.json())
          .then(data => {
            if (!shouldProcess()) return;
            if (!data.isProcessing && transcriptLoadingRef.current) {
              setTranscriptLoading(false);
              setTranscriptStreaming('');
            }
          })
          .catch(() => {});
        // Also refresh transcript to pick up any missed messages — but never
        // while a turn is in flight: the JSONL holds that turn's partial
        // assistant messages, which would render as intermediary bubbles above
        // the bouncing dots. Same guard as the transcript-updated handler below.
        // (Re-checked inside .then(), since loading can flip while in flight.)
        fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
          .then(res => res.json())
          .then(data => {
            if (!data.messages || !shouldProcess()) return;
            if (transcriptLoadingRef.current) return;
            setHistoryTranscript(data.messages);
            setTranscriptOverlayMessages([]);
            setOverlayInsertPoint(null);
          })
          .catch(() => {});
      }
    };

    // Handle transcript:updated events (replaces transcript polling for external live sessions)
    es.addEventListener('transcript-updated', () => {
      if (!shouldProcess()) return;
      // Don't refresh while any processing is in flight — the JSONL contains
      // partial assistant messages that would render as intermediary bubbles.
      if (transcriptLoadingRef.current) return;

      fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
        .then(res => res.json())
        .then(data => {
          if (data.messages && shouldProcess()) {
            setHistoryTranscript(data.messages);
          }
        })
        .catch(() => {});
    });

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
          // Under the projection, the PULL above IS this poll's whole job — it is the
          // dead-SSE fallback that keeps `live` fresh. The legacy teardown / 2-strike
          // debounce / raw-commit below is bypassed: the projection + heartbeat own
          // liveness and the render-strip owns the partials, so inventing "done" from a
          // bare isProcessing:false here is exactly the drift we're removing (step 3).
          // The machinery stays intact as the flag-off / CLI-session fallback.
          if (livenessDotsEnabledRef.current) return;
          // Keep the independent background-work dots in sync even if the SSE
          // health event that would clear them was missed (fail toward not-live).
          setBackgroundWorking(!!data.backgroundActive);
          // The in-flight-turn teardown below only applies while a MAIN turn is
          // loading; a background-only poll (loading false) stops here.
          if (!transcriptLoadingRef.current) return;
          if (data.isProcessing) {
            // Live — reset the streak so an earlier isolated false is forgotten.
            if (healthFalseStreakRef.current > 0) {
              uiLog('debug', 'chat.healthPoll', 'false streak reset by live reading', {
                sessionId: mySessionId,
                data: { priorStreak: healthFalseStreakRef.current },
              });
            }
            healthFalseStreakRef.current = 0;
            return;
          }
          if (!transcriptLoadingRef.current) return;
          // Never tear down an in-flight MAIN turn while background work is still
          // live. `backgroundActive` means a background task (subagent / Monitor /
          // Bash) is running and a task-notification turn may be imminent — the same
          // guard the SSE idle-commit uses at :1017. Committing the on-disk partials
          // now would drop the dots mid-turn and paint an intermediary bubble over a
          // turn that is not actually finished (Defect B / docs/ticket-dots-desync-
          // subagent-heavy-session.md). Reset the streak so a transient main-turn
          // idle during background work doesn't accrue toward the 2-strike teardown.
          if (data.backgroundActive) {
            healthFalseStreakRef.current = 0;
            return;
          }
          // Debounce: this poll is only a safety net for a dead SSE stream. A
          // single false is untrustworthy (HMR singleton swap can momentarily
          // report a live SDK session as idle), so require TWO consecutive false
          // readings (~30s) before tearing down the in-flight view. Genuine
          // completions are torn down instantly by the session-health SSE event;
          // this only fires when that event never arrived.
          healthFalseStreakRef.current += 1;
          // This is the inflight-partials trigger. Log EVERY false (the server
          // log will show whether isProcessing was really false or an HMR blip)
          // and the teardown separately, so the loop between UI and server is
          // reconstructable from one file.
          uiLog('warn', 'chat.healthPoll', 'isProcessing:false while loading', {
            sessionId: mySessionId,
            data: { streak: healthFalseStreakRef.current },
          });
          if (healthFalseStreakRef.current < 2) return;
          healthFalseStreakRef.current = 0;
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

    return () => {
      es.close();
      clearInterval(healthPoll);
      if (sessionEsRef.current === es) {
        sessionEsRef.current = null;
      }
    };
    // sdkSessionsEnabled is read inside the handlers here (applyPendingAskFromBuffer,
    // the AskUserQuestion routing guard); include it (P19) so toggling the setting at
    // runtime rebinds the handlers instead of leaving them capturing the stale value
    // until the next session switch.
  }, [viewingTranscriptId, historyTranscriptProject, sdkSessionsEnabled]);

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
        applyPendingAskFromBuffer(bufData, bufIssuedAt);
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
  }, [isActive, viewingTranscriptId, historyTranscriptProject]);

  // --- Load workflows + compute recentDirectories ---
  useEffect(() => {
    const loadWorkflowsAndDirectories = async () => {
      try {
        const res = await fetch('/api/workflows');
        if (res.ok) {
          const data = await res.json();
          const loadedWorkflows = data.workflows || [];

          // Compute recent directories from history and workflows
          const directories = getRecentDirectories(history, loadedWorkflows);
          setRecentDirectories(directories);
        }
      } catch (error) {
        console.error('Failed to load workflows:', error);
      }
    };

    loadWorkflowsAndDirectories();
  }, [history]);

  // --- Notes ---
  useEffect(() => {
    const loadNotes = async () => {
      if (!historyTranscriptProject) { setNotes(''); return; }
      setIsLoadingNotes(true);
      try {
        const response = await fetch(`/api/notes?projectPath=${encodeURIComponent(historyTranscriptProject)}`);
        const data = await response.json();
        if (response.ok) setNotes(data.notes || '');
      } catch (error) {
        console.error('Error loading notes:', error);
      } finally {
        setIsLoadingNotes(false);
      }
    };
    loadNotes();
  }, [historyTranscriptProject]);

  const handleNotesChange = useCallback(async (content: string) => {
    if (!historyTranscriptProject) return;
    setNotes(content);
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: historyTranscriptProject, notes: content }),
      });
    } catch (error) {
      console.error('Error saving notes:', error);
    }
  }, [historyTranscriptProject]);

  // --- Handlers ---

  const handleCreateSession = () => {
    setShowDirectoryPicker(true);
  };

  // Step (a) → (b) of the new-session wizard: stash the chosen directory and
  // advance to the model step. The session isn't created until the user commits
  // a model (or backs out), so nothing is minted here.
  const handleDirectoryNext = (path: string) => {
    setShowDirectoryPicker(false);
    // Model selection only means anything on the SDK backend (same gate as the
    // mid-session picker). With it off, skip step (b) and create straight away
    // on the default model rather than showing a step that can't take effect.
    if (!sdkSessionsEnabled) {
      createNewSession(path, null);
      return;
    }
    setWizardPath(path);
    setShowModelStep(true);
  };

  // Step (b) → (a): return to the directory picker, preserving no model choice.
  const handleModelStepBack = () => {
    setShowModelStep(false);
    setShowDirectoryPicker(true);
  };

  // Step (b) commit: create the session on the chosen directory + model.
  // `model` is null to follow the provider default (no override); `resolvedModel`
  // is the picked model's wire id, used to update the status-bar label at once.
  const handleModelStepCreate = (model: string | null, resolvedModel: string | null) => {
    setShowModelStep(false);
    const path = wizardPath;
    setWizardPath(null);
    if (path) createNewSession(path, model, resolvedModel);
  };

  const createNewSession = (path: string, model: string | null, resolvedModel: string | null = null) => {
    // Save current editor draft before switching
    if (viewingTranscriptId && chatEditorRef.current) {
      const draft = chatEditorRef.current.getContent();
      if (chatEditorRef.current.getPlainText?.()?.trim?.() || draft.replace(/<[^>]*>/g, '').trim()) {
        sessionDraftsRef.current.set(viewingTranscriptId, draft);
      } else {
        sessionDraftsRef.current.delete(viewingTranscriptId);
      }
    }

    const newId = generateUUID();
    // Update ref synchronously so any in-flight handler's isStillActive() returns false
    activeSessionRef.current = newId;
    // Go directly to transcript view for a new empty session
    setViewingTranscriptId(newId);
    setHistoryTranscriptProject(path);

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

    // New session starts with an empty editor
    setTimeout(() => chatEditorRef.current?.setContent(''), 50);
  };

  const restorePendingSession = (pending: { sessionId: string; project: string; title: string }) => {
    // Save current editor draft before switching
    if (viewingTranscriptId && chatEditorRef.current) {
      const draft = chatEditorRef.current.getContent();
      if (chatEditorRef.current.getPlainText?.()?.trim?.() || draft.replace(/<[^>]*>/g, '').trim()) {
        sessionDraftsRef.current.set(viewingTranscriptId, draft);
      } else {
        sessionDraftsRef.current.delete(viewingTranscriptId);
      }
    }

    activeSessionRef.current = pending.sessionId;
    setViewingTranscriptId(pending.sessionId);
    setHistoryTranscriptProject(pending.project);

    setHistoryTranscript([]);
    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setTranscriptLoading(false);
    setBackgroundWorking(false);
    setTranscriptPartial(false);
    setSuggestedPrompt(null);
    setIsStuck(false);
    setStuckReason(undefined);
    setHistoryTranscriptLoading(false);
    setCurrentModel(null);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

    // Restore draft for this pending session
    const savedDraft = sessionDraftsRef.current.get(pending.sessionId) || '';
    setTimeout(() => chatEditorRef.current?.setContent(savedDraft), 50);
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

  // Paste/drop → normalize+downscale each file → stage as an attachment chip.
  // Normalization failures (unsupported type, decode error, over the 5MB cap)
  // skip that file but SURFACE the reason next to the chips — a silent drop
  // reads as "attached" to the user who just pasted.
  const handleImagesAdded = async (files: File[]) => {
    const failures: string[] = [];
    const results = await Promise.all(
      files.map(async f => {
        try {
          return await normalizeImage(f);
        } catch (err) {
          console.warn('[ChatTab] Skipping image:', err);
          failures.push(err instanceof Error ? err.message : 'unreadable image');
          return null;
        }
      }),
    );
    setAttachError(failures.length > 0 ? failures.join('; ') : null);
    const added = results.filter((r): r is AttachedImage => r !== null);
    if (added.length === 0) return;
    // Cap total staged attachments at 8 (matches the server-side cap).
    setAttachedImages(prev => [...prev, ...added].slice(0, 8));
  };

  const handleRemoveImage = (id: string) => {
    setAttachedImages(prev => prev.filter(img => img.id !== id));
  };

  const handleTranscriptSend = async (userMessage: string) => {
    if ((!userMessage && attachedImages.length === 0) || transcriptLoading || !viewingTranscriptId) return;

    // Snapshot + clear the staged attachments for this turn.
    const imagesToSend = attachedImages;
    setAttachedImages([]);
    setAttachError(null);
    const optimisticImages: TranscriptImagePart[] = imagesToSend.map(i => ({ dataUrl: i.dataUrl }));
    const apiImages = imagesToSend.map(i => ({ base64: i.base64, mediaType: i.mediaType }));

    // Stop any TTS playback so the user isn't talked over by the previous turn.
    ttsCleanup();

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    // Clear the draft and remove from pending sessions since it's being submitted
    sessionDraftsRef.current.delete(mySessionId);
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
    setSuggestedPrompt(null);
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
      // Return the staged attachments too, so a backed-out takeover can retry.
      if (imagesToSend.length > 0) setAttachedImages(prev => [...imagesToSend, ...prev].slice(0, 8));
      setTimeout(() => chatEditorRef.current?.setContent(userMessage), 50);
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
        if (imagesToSend.length > 0) {
          setAttachedImages(prev => [...imagesToSend, ...prev].slice(0, 8));
        }
      }
    };

    try {
      await submitTurn(false);
    } catch (error) {
      handleSendError(error);
    }
  };

  const handleRewind = async (mode: 'conversation' | 'both') => {
    if (!rewindConfirm) return;
    if (!viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;
    const rewindInfo = { ...rewindConfirm };
    const { turnIndex, fullMessage } = rewindInfo;

    // Immediately truncate the UI: remove all messages from the rewind point onward
    let userCount = 0;
    const cutIdx = historyTranscript.findIndex(msg => {
      if (msg.role === 'user') {
        if (userCount === turnIndex) return true;
        userCount++;
      }
      return false;
    });
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
      setLiveContext(prev => {
        if (!(mySessionId in prev)) return prev;
        const next = { ...prev };
        delete next[mySessionId];
        return next;
      });
      if (activeSessionRef.current === mySessionId) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    }
  };

  const handleSessionArchived = (sessionId: string) => {
    if (viewingTranscriptId === sessionId) {
      setViewingTranscriptId(null);
      setHistoryTranscript([]);
      setTranscriptOverlayMessages([]);
      setTranscriptStreaming('');
      setTranscriptLoading(false);
    }
  };

  /**
   * SDK path: resolve the parked tool call in place. No kill, no re-prompt, no
   * new turn — Claude is still sitting in canUseTool waiting on this promise, so
   * the answer lands as the tool's own result and the SAME turn continues.
   */
  /**
   * POST an answer (or a skip) for the parked question, closing the dialog
   * optimistically and putting it BACK if the post didn't land.
   *
   * The optimistic close keeps the common path instant. But if the request fails,
   * the server is still parked: isProcessing stays true, so the composer stays
   * locked and the user is left staring at a spinner with no dialog and no error
   * — the exact stranded turn this design exists to prevent. Restoring the dialog
   * is the only thing that gives them a retry.
   *
   * NOT restored on 409: that means the question was legitimately settled by
   * someone else (another tab, an abort, a superseding ask). Re-opening it would
   * put an unanswerable dialog back on screen.
   */
  const postAskAnswer = async (
    body: Record<string, unknown>,
    label: string,
  ) => {
    const current = askUserQuestion;
    const toolUseID = current?.toolUseID;
    const mySessionId = viewingTranscriptId;
    setAskUserQuestion(null);
    if (!toolUseID || !mySessionId) return;
    // Record the answer so a stale still-pending buffer read can't re-open this
    // dialog before the server resolves it (P18).
    answeredAskRef.current = { toolUseID, at: Date.now() };

    // Only restore if nothing newer took the slot and we're still on the same
    // session — a plain set would clobber a question that parked while we waited.
    const restore = () => {
      if (activeSessionRef.current !== mySessionId) return;
      setAskUserQuestion(prev => prev ?? current);
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
        // A 409 with code 'no_pending' means the question really is already settled
        // (answered/superseded) — don't restore. But a 409 'sdk_disabled' means the
        // answer never landed and the turn is still parked, so restore the dialog so
        // the user isn't stranded with a locked composer and no dialog. Any other
        // status also restores.
        if (res.status !== 409 || data.code === 'sdk_disabled') restore();
      }
    } catch (error) {
      // Network failure — the server never heard us, so it is definitely still parked.
      console.error(`Failed to ${label} question:`, error);
      restore();
    }
  };

  /** SDK path: resolve the parked tool call in place. */
  const handleAskUserQuestionStructured = (result: {
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  }) => postAskAnswer(result, 'answer');

  /** SDK path: dismissal denies the tool, which the model handles gracefully. */
  const handleAskUserQuestionSkipSdk = () => postAskAnswer({ skip: true }, 'skip');

  const handleAskUserQuestionResponse = async (answers: string) => {
    setAskUserQuestion(null);
    if (!answers.trim()) return;

    // The CLI was already killed when the dialog opened, but defensively
    // re-issue stop if loading is still flagged (e.g. session-health hadn't
    // arrived yet when the user answered quickly) and clear local state so
    // handleTranscriptSend's `transcriptLoading` early-return doesn't trip.
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

    handleTranscriptSend(answers);
  };

  const handleAskUserQuestionSkip = () => {
    setAskUserQuestion(null);
  };

  const handleFileDoubleClick = useCallback((filePath: string) => {
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || '';
    if (isCodeFile(fileName)) setCodeViewerPath(filePath);
  }, []);

  // Archives (soft-deletes) the session: DELETE /api/session kills the process,
  // marks the row 'archived' in SQLite, and removes the on-disk JSONL + history
  // entries. The transcript and its usage_events are preserved. See
  // docs/delete-to-archive.md.
  const handleArchiveSession = async (sessionId: string, project: string) => {
    setArchiveConfirm(null);
    try {
      const res = await fetch(
        `/api/session?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({ title: 'Failed to archive session', message: data.error || `Server returned ${res.status}` });
        return;
      }
      handleSessionArchived(sessionId);
      fetchHistory();
    } catch (error) {
      setErrorDialog({ title: 'Failed to archive session', message: error instanceof Error ? error.message : 'An unexpected error occurred' });
    }
  };

  const handleSaveLabel = async (value: string) => {
    if (!labelEdit) return;
    const { sessionId } = labelEdit;
    const label = value.trim();
    setLabelEdit(null);
    try {
      const res = await fetch('/api/session', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, metadata: { label: label || null } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({ title: 'Failed to update label', message: data.error || `Server returned ${res.status}` });
        return;
      }
      setHistory(prev => prev.map(h => {
        if (h.sessionId !== sessionId) return h;
        const metadata = { ...h.metadata };
        if (label) { metadata.label = label; } else { delete metadata.label; }
        return { ...h, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
      }));
    } catch (error) {
      setErrorDialog({ title: 'Failed to update label', message: error instanceof Error ? error.message : 'An unexpected error occurred' });
    }
  };

  const handleRewindConfirmed = (mode: 'conversation' | 'both') => {
    if (!rewindConfirm) return;
    setRewindConfirm(null);
    handleRewind(mode);
  };

  return (
    <>
    <PanelGroup direction="horizontal" onLayout={onHorizontalLayoutChange}>
      {/* Left Panel - Unified Session List */}
      <Panel defaultSize={chatHorizontalLayout[0]} minSize={15}>
        <div className="h-full bg-card border-r border-border flex flex-col">
          <div className="p-4 border-b border-border flex justify-between items-center">
            <h2 className="text-foreground text-lg font-semibold">Sessions</h2>
            <Button onClick={handleCreateSession} variant="outline" size="sm">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <SessionSidebar
            pendingNewSessions={pendingNewSessions}
            history={history}
            liveSessionIds={liveSessionIds}
            sessionActivity={sessionActivity}
            liveContext={liveContext}
            viewingTranscriptId={viewingTranscriptId}
            transcriptLoading={transcriptLoading}
            isLoadingHistory={isLoadingHistory}
            historyHasMore={historyHasMore}
            isLoadingMoreHistory={isLoadingMoreHistory}
            onLoadMoreHistory={loadMoreHistory}
            onSelectSession={fetchTranscript}
            onRestorePending={restorePendingSession}
            onLabelEdit={(sessionId, currentLabel) => setLabelEdit({ sessionId, currentLabel })}
            onArchiveConfirm={setArchiveConfirm}
            onContextMenu={(e, entry) => {
              setContextMenu({
                x: e.clientX, y: e.clientY,
                sessionId: entry.sessionId!, project: entry.project, display: entry.display, isLive: entry.isLive,
              });
            }}
          />
        </div>
      </Panel>

      <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

      {/* Middle Panel - Chat Interface / Transcript Viewer */}
      <Panel defaultSize={chatHorizontalLayout[1]} minSize={30}>
        <div ref={middlePanelRef} className="relative h-full bg-card border-r border-border flex flex-col">
          {viewingTranscriptId ? (
            <>
              {isStuck && (
                <div className="p-2 border-b border-border flex justify-end">
                  <Button variant="destructive" size="sm" className="flex items-center gap-2" onClick={() => setShowKillConfirm(true)}>
                    <AlertTriangle className="h-4 w-4" />
                    Process Stuck - Kill
                  </Button>
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                <PanelGroup direction="vertical" onLayout={onVerticalLayoutChange}>
                  <Panel defaultSize={chatVerticalLayout[0]} minSize={30}>
                    <div className="h-full overflow-y-auto p-4 space-y-4">
                      {historyTranscriptLoading ? (
                        <div className="flex items-center justify-center h-full text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                            <span className="ml-2">Loading transcript...</span>
                          </div>
                        </div>
                      ) : historyTranscript.length === 0 && transcriptOverlayMessages.length === 0 ? (
                        <div className="text-center text-muted-foreground mt-8 space-y-2">
                          {history.some(h => h.sessionId === viewingTranscriptId) ? (
                            <>
                              <p>Transcript unavailable for this session.</p>
                              <p className="text-xs">The session data may have been created before Claude CLI began persisting transcripts, or the files were removed.</p>
                            </>
                          ) : (
                            <p>Send a message to start the conversation.</p>
                          )}
                        </div>
                      ) : (
                        <>
                          {transcriptPartial && (
                            <div className="rounded-md border border-yellow-600/50 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200 mb-4">
                              <p className="font-medium">Partial transcript</p>
                              <p className="text-xs text-yellow-300/70 mt-1">
                                Only your prompts are available for this session. Full conversation transcripts were not persisted by Claude CLI at the time this session was created.
                              </p>
                            </div>
                          )}
                          <TranscriptRenderer
                            // SSOT strip (step 3): under the flag, the DISPLAYED
                            // transcript is a pure function of (historyTranscript, live)
                            // — while the main turn streams (`live.startedAt` set), slice
                            // off this turn's in-flight partials so a raw-committed
                            // partial can't render as a bubble above the dots (scenario
                            // 1). Non-main-turn (startedAt null) shows the raw final
                            // answer. This anchors on the SAME `live.startedAt` the design
                            // built in step 1 (null unless main-turn), replacing the
                            // legacy latch/teardown strip for the projection path.
                            historyTranscript={
                              (livenessDotsEnabled && live && typeof live.startedAt === 'number')
                                ? stripInFlightPartials(historyTranscript, live.startedAt)
                                : historyTranscript
                            }
                            transcriptOverlayMessages={transcriptOverlayMessages}
                            overlayInsertPoint={overlayInsertPoint}
                            sessionId={viewingTranscriptId ?? undefined}
                            transcriptLoading={transcriptLoading}
                            onRewindConfirm={setRewindConfirm}
                            onIntermediaryView={setIntermediaryMessages}
                            lastAssistantRef={lastAssistantRef}
                            ttsEnabled={ttsEnabled}
                            ttsPlaying={ttsPlaying}
                            onTtsToggle={() => {
                              const audio = ttsAudioRef.current;
                              if (audio) {
                                if (audio.paused) {
                                  audio.currentTime = 0;
                                  audio.play().catch(err => {
                                    console.error('[TTS] playback failed:', err);
                                    setTtsPlaying('idle');
                                  });
                                  setTtsPlaying('playing');
                                } else {
                                  audio.pause();
                                  setTtsPlaying('paused');
                                }
                              } else {
                                // Replay: re-generate from last bubble (same turn logic as TranscriptRenderer)
                                let turnBubble: { content: string; turnMeta?: TurnMeta } | null = null;
                                let lastTurnBubble: { content: string; turnMeta?: TurnMeta } | null = null;
                                for (const msg of historyTranscript) {
                                  if (msg.role === 'user') {
                                    if (turnBubble) lastTurnBubble = turnBubble;
                                    turnBubble = null;
                                  } else if (msg.role === 'assistant') {
                                    turnBubble = msg;
                                  }
                                }
                                const bubble = turnBubble || lastTurnBubble;
                                if (!bubble?.content) return;
                                ttsCleanup();
                                const abort = new AbortController();
                                ttsAbortRef.current = abort;
                                setTtsPlaying('loading');
                                fetch('/api/tts', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ text: bubble.content, turnMeta: bubble.turnMeta }),
                                  signal: abort.signal,
                                })
                                  .then(res => {
                                    if (ttsAbortRef.current !== abort) return;
                                    if (!res.ok) throw new Error('TTS failed');
                                    return res.blob();
                                  })
                                  .then(blob => {
                                    if (!blob || ttsAbortRef.current !== abort) return;
                                    const url = URL.createObjectURL(blob);
                                    ttsBlobUrlRef.current = url;
                                    const a = new Audio(url);
                                    ttsAudioRef.current = a;
                                    a.onended = () => setTtsPlaying('idle');
                                    a.play().catch(err => {
                                      console.error('[TTS] playback failed:', err);
                                      setTtsPlaying('idle');
                                    });
                                    setTtsPlaying('playing');
                                  })
                                  .catch(err => {
                                    if (ttsAbortRef.current !== abort) return;
                                    if (err.name !== 'AbortError') console.error('[TTS]', err);
                                    setTtsPlaying('idle');
                                  });
                              }
                            }}
                            onTtsCancel={() => ttsCleanup()}
                          />
                          {/* SSOT dots (step 2b): when opted in and the projection has
                              arrived, the dots track `live.phase` (self-corrected by the
                              heartbeat) instead of the legacy OR-of-proxies. Falls back to
                              legacy while `live` is null or the flag is off. */}
                          {((livenessDotsEnabled && live)
                            ? live.phase !== 'idle'
                            : (transcriptLoading || backgroundWorking)) && (
                            <div className="flex justify-start">
                              {/*
                                While parked on a question the turn IS live and
                                isProcessing IS true — correct, but the thinking
                                dots would spin for as long as the human takes
                                and read as a hang. The turn is not blocked on
                                Claude; it's blocked on the user. Say that.
                                Waiting on the DIALOG (not just isAwaitingAnswer)
                                so this only shows while the question is on screen
                                to answer.
                              */}
                              {askUserQuestion ? (
                                <div
                                  data-testid="awaiting-answer"
                                  className="max-w-[80%] rounded-lg px-4 py-2 bg-muted text-foreground border border-border text-left"
                                >
                                  <div className="text-xs opacity-70 mb-1">Claude</div>
                                  <div className="text-sm">Waiting for your answer…</div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setRightPanelView('stream')}
                                  className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-muted text-foreground border border-border cursor-pointer hover:border-ring transition-colors text-left"
                                  title="View live stream"
                                >
                                  <div className="text-xs opacity-70 mb-1">Claude</div>
                                  <div data-testid="processing-dots" className="flex items-center gap-1 py-2">
                                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                  </div>
                                </button>
                              )}
                            </div>
                          )}
                          {sessionError && (
                            <div className="flex justify-start" data-testid="session-error">
                              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-destructive/10 text-foreground border border-destructive/40 text-left">
                                <div className="text-xs text-destructive mb-1 flex items-center gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  Session error
                                </div>
                                <div className="text-sm whitespace-pre-wrap">{sessionError}</div>
                              </div>
                            </div>
                          )}
                          {/* MCP connection failures are intentionally NOT surfaced in the
                              main chat panel — they read as a chat message about the user's
                              work. The MCP panel is the home for server status: `mcpFailedServers`
                              still flows to <McpPanel runtimeFailed=… /> below, which flags the
                              failed row there. (Removed the in-transcript banner per product
                              direction; the state is retained purely to drive the panel.) */}
                          {suggestedPrompt && !transcriptLoading && promptSuggestionsEnabled && (
                            <div className="flex justify-start">
                              <button
                                onClick={() => chatEditorRef.current?.setContent(suggestedPrompt.text)}
                                className="max-w-[80%] rounded-lg px-4 py-2 bg-muted border border-amber-600/40 text-sm hover:border-amber-500 transition-colors text-left"
                                title="Click to fill editor with this prompt"
                              >
                                <div className="text-xs text-amber-500 mb-1">{suggestedPrompt.context}</div>
                                <div className="text-foreground">{suggestedPrompt.text}</div>
                              </button>
                            </div>
                          )}
                          <div ref={transcriptEndRef} />
                        </>
                      )}
                    </div>
                  </Panel>
                  <PanelResizeHandle className="h-2 bg-border hover:bg-primary transition-colors" />
                  <Panel defaultSize={chatVerticalLayout[1]} minSize={20}>
                    <div className="h-full p-4">
                      <RichTextEditor
                        ref={chatEditorRef}
                        onSubmit={handleTranscriptSend}
                        placeholder="Continue this conversation... (Enter to send, Shift+Enter for new line)"
                        disabled={historyTranscriptLoading}
                        submitLabel={transcriptLoading ? 'Sending...' : 'Send'}
                        isProcessing={transcriptLoading}
                        onStop={handleTranscriptStop}
                        // Paste/drop image capture — SDK backend only (the CLI
                        // `--print` path can't carry image blocks).
                        onImagesAdded={sdkSessionsEnabled ? handleImagesAdded : undefined}
                        hasAttachments={attachedImages.length > 0}
                        statusBar={(attachedImages.length > 0 || attachError || providerLabel) ? (
                          <div>
                            {attachedImages.length > 0 && (
                              <div className="flex flex-wrap gap-2 px-2 pt-2" data-testid="image-attachments">
                                {attachedImages.map(img => (
                                  <div key={img.id} className="relative group/attach">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={img.dataUrl}
                                      alt="attachment"
                                      className="h-14 w-14 object-cover rounded border border-border"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveImage(img.id)}
                                      className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-black/70 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover/attach:opacity-100 transition-opacity"
                                      title="Remove attachment"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            {attachError && (
                              <div
                                data-testid="attach-error"
                                className="px-2 pt-1 text-[11px] text-red-500"
                              >
                                ⚠ {attachError}
                              </div>
                            )}
                            {providerLabel && (
                          // Style is deliberately unchanged from the read-only
                          // label — the only affordance is the pointer cursor.
                          //
                          // Clickable only with a session in view AND the SDK
                          // backend on. The picker drives sdkSessionManager; with
                          // sdkSessionsEnabled off, /api/claude routes turns to the
                          // CLI sessionManager, which has no per-session model —
                          // the switch would report success and change nothing.
                          <div
                            data-testid="model-label"
                            style={{ fontSize: '9px', fontWeight: 100, padding: '0 8px 1px', cursor: modelPickerAvailable ? 'pointer' : 'default' }}
                            className="text-muted-foreground"
                            onClick={modelPickerAvailable ? () => setModelPickerOpen(true) : undefined}
                            title={modelPickerAvailable ? 'Click to change model' : undefined}
                          >
                            {providerLabel}
                          </div>
                            )}
                          </div>
                        ) : undefined}
                      />
                    </div>
                  </Panel>
                </PanelGroup>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <div className="text-muted-foreground space-y-4">
                <h2 className="text-xl font-semibold text-foreground">Welcome to Fury</h2>
                <p className="text-sm max-w-md">
                  Select a session from the list to view its conversation, or create a new session to start chatting with Claude.
                </p>
                <Button onClick={handleCreateSession} variant="outline" className="mt-4">
                  <Plus className="h-4 w-4 mr-2" />
                  New Session
                </Button>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

      {/* Right Panel - Multi-View */}
      <Panel defaultSize={chatHorizontalLayout[2]} minSize={20}>
        <div className="h-full bg-card flex flex-col">
          <div className="p-2 border-b border-border flex items-center gap-2">
            <Button variant={rightPanelView === 'stream' ? 'default' : 'ghost'} size="sm" onClick={() => setRightPanelView('stream')} className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Stream
              {transcriptLoading && <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />}
            </Button>
            <Button variant={rightPanelView === 'files' ? 'default' : 'ghost'} size="sm" onClick={() => setRightPanelView('files')} className="flex items-center gap-2">
              <FolderTree className="h-4 w-4" />
              Files
            </Button>
            <Button variant={rightPanelView === 'notes' ? 'default' : 'ghost'} size="sm" onClick={() => setRightPanelView('notes')} className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Notes
            </Button>
            <Button variant={rightPanelView === 'mcp' ? 'default' : 'ghost'} size="sm" onClick={() => setRightPanelView('mcp')} className="flex items-center gap-2">
              <Plug className="h-4 w-4" />
              MCP
            </Button>
          </div>
          <div className={`flex-1 overflow-hidden ${rightPanelView === 'files' ? '' : 'hidden'}`}>
            <FileTree projectPath={historyTranscriptProject} onFileDoubleClick={handleFileDoubleClick} />
          </div>
          {rightPanelView === 'stream' && (
            <StreamEventsPanel
              streamEvents={streamEvents}
              transcriptLoading={transcriptLoading}
              submitStartTime={submitStartTime}
              submitEndTime={submitEndTime}
            />
          )}
          {rightPanelView === 'notes' && (
            <div className="flex-1 overflow-hidden p-4">
              {isLoadingNotes ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">Loading notes...</div>
              ) : (
                <RichTextEditor
                  key={historyTranscriptProject || 'no-project'}
                  initialContent={notes}
                  onChange={handleNotesChange}
                  onSubmit={() => {}}
                  placeholder={historyTranscriptProject ? "Write your notes here..." : "Select a session with a project directory to use notes"}
                  disabled={!historyTranscriptProject}
                  persistContent={true}
                  showButtonBar={false}
                  debounceMs={2000}
                />
              )}
            </div>
          )}
          {rightPanelView === 'mcp' && <McpPanel projectPath={historyTranscriptProject} runtimeFailed={mcpFailedServers} />}
        </div>
      </Panel>
    </PanelGroup>

    {/* --- Dialogs (all owned by ChatTab) --- */}
    <ModelPickerDialog
      open={modelPickerOpen}
      onOpenChange={setModelPickerOpen}
      sessionId={viewingTranscriptId}
      activeModel={currentModel}
    />
    <IntermediaryMessagesDialog messages={intermediaryMessages} onClose={() => setIntermediaryMessages([])} />
    <CodeViewerDialog filePath={codeViewerPath} onClose={() => setCodeViewerPath(null)} />

    {askUserQuestion && (
      <AskUserQuestionDialog
        // Remount on question identity so an in-place question swap (server supersede
        // / applyPendingAskFromBuffer on reconnect) resets the selection state — else
        // question Y renders with question X's stale pre-checked answers.
        key={askUserQuestion.toolUseID ?? 'cli'}
        open={true}
        // Draft identity: in-progress selections/text survive the unmount a
        // session switch causes (P17 clears askUserQuestion unconditionally)
        // and are restored when the question re-parks on switch-back. The CLI
        // path (null) falls back to a question-text signature inside.
        draftKey={askUserQuestion.toolUseID}
        // Anchor the modal to the Chat tab's middle panel instead of the
        // whole viewport, so it dims/centers within the conversation column.
        portalContainer={middlePanelRef.current}
        questions={askUserQuestion.input.questions}
        context={
          // The text Claude wrote leading up to the question — the same
          // content rendered in the chat panel, surfaced here because the
          // modal obstructs it and the panel can't scroll while it's open.
          // The AskUserQuestion tool_use lands in its own (text-less)
          // assistant message, so the preamble is the last assistant text:
          // mid-turn it lives in the streaming buffer; once the turn ends
          // (the CLI is killed when the tool fires) it's the last assistant
          // bubble in the refreshed transcript.
          transcriptStreaming.trim() ||
          [...historyTranscript].reverse().find(m => m.role === 'assistant')?.content ||
          ''
        }
        onSubmit={handleAskUserQuestionResponse}
        // Only pass the structured path when there is a live tool call to
        // resolve. A CLI-sourced question has toolUseID null and MUST fall
        // through to the prose path, which re-sends the answer as a new turn.
        onSubmitStructured={
          sdkSessionsEnabled && askUserQuestion.toolUseID
            ? handleAskUserQuestionStructured
            : undefined
        }
        onSkip={
          sdkSessionsEnabled && askUserQuestion.toolUseID
            ? handleAskUserQuestionSkipSdk
            : handleAskUserQuestionSkip
        }
      />
    )}

    {contextMenu && (
      <SessionContextMenu
        {...contextMenu}
        onArchive={setArchiveConfirm}
        onClose={() => setContextMenu(null)}
      />
    )}

    <ConfirmDialog
      open={showKillConfirm}
      onOpenChange={setShowKillConfirm}
      title="Kill stuck process?"
      message={<>{stuckReason}<br /><br />This will terminate the Claude CLI process. The current response will be lost.</>}
      confirmLabel="Kill Process"
      confirmVariant="destructive"
      onConfirm={() => { setShowKillConfirm(false); handleKillStuckSession(); }}
    />

    <ConfirmDialog
      open={!!takeoverConfirm}
      onOpenChange={(open) => { if (!open) takeoverConfirm?.onCancel(); }}
      title="Take over this session?"
      message={
        <>
          This session is currently live in a terminal
          {takeoverConfirm?.owner?.name ? <> (<span className="font-mono">{takeoverConfirm.owner.name}</span>)</> : ''}.
          <br /><br />
          Taking it over in Fury will end that terminal session so Fury can
          continue it here. Any unsaved context only in the terminal will be lost.
        </>
      }
      confirmLabel="Take Over"
      confirmVariant="destructive"
      cancelLabel="Cancel"
      onConfirm={() => takeoverConfirm?.onConfirm()}
      onCancel={() => takeoverConfirm?.onCancel()}
    />

    <Dialog
      open={!!rewindConfirm}
      onOpenChange={(open) => { if (!open) setRewindConfirm(null); }}
      title="Rewind conversation?"
      defaultWidth={460}
      defaultHeight={280}
      minWidth={360}
      minHeight={220}
      resizable={false}
      buttons={[
        { label: 'Cancel', onClick: () => setRewindConfirm(null), variant: 'ghost' as const },
        { label: 'Conversation only', onClick: () => handleRewindConfirmed('conversation'), variant: 'secondary' as const },
        { label: 'Conversation + Code', onClick: () => handleRewindConfirmed('both') },
      ]}
    >
      <div className="text-sm text-muted-foreground">
        Rewind the conversation to before this message:
        <br /><br />
        <span className="text-xs font-mono break-all">&ldquo;{rewindConfirm?.userMessage}&rdquo;</span>
        {rewindConfirm?.timestamp && (
          <><br /><span className="text-xs">{new Date(rewindConfirm.timestamp).toLocaleString()}</span></>
        )}
      </div>
    </Dialog>

    <ConfirmDialog
      open={!!archiveConfirm}
      onOpenChange={(open) => { if (!open) setArchiveConfirm(null); }}
      title="Archive session?"
      message={<>
        {archiveConfirm?.isLive && (
          <>
            <span className="text-yellow-500 font-semibold">This session is currently live.</span> The running process will be terminated.
            <br /><br />
          </>
        )}
        This removes the session from your list. Its usage history is preserved and it will still count in Stats.
      </>}
      confirmLabel="Archive"
      onConfirm={() => { if (archiveConfirm) handleArchiveSession(archiveConfirm.sessionId, archiveConfirm.project); }}
      onCancel={() => setArchiveConfirm(null)}
    />

    {labelEdit && (
      <LabelEditDialog
        initialValue={labelEdit.currentLabel}
        onSave={handleSaveLabel}
        onCancel={() => setLabelEdit(null)}
      />
    )}

    <AlertDialog
      open={!!errorDialog}
      onOpenChange={(open) => { if (!open) setErrorDialog(null); }}
      title={errorDialog?.title || 'Error'}
      message={errorDialog?.message}
    />

    {/* New-session wizard — step (a): choose a directory, then Next → model */}
    <DirectoryPicker
      open={showDirectoryPicker}
      onOpenChange={setShowDirectoryPicker}
      onSelect={handleDirectoryNext}
      recentDirectories={recentDirectories}
      confirmLabel="Next →"
    />

    {/* New-session wizard — step (b): choose the model, then create */}
    <NewSessionModelStep
      open={showModelStep}
      onOpenChange={(open) => { if (!open) { setShowModelStep(false); setWizardPath(null); } }}
      onBack={handleModelStepBack}
      onCreate={handleModelStepCreate}
      directory={wizardPath ?? undefined}
    />
    </>
  );
}
