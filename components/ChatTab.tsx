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
import { DirectoryPicker } from '@/components/DirectoryPicker';
import { getRecentDirectories } from '@/lib/recent-directories';
import type { Message, TranscriptMsg, HistoryEntry, PendingSession, AskUserQuestionState } from '@/lib/types';
import type { TurnMeta } from '@/lib/transcriptParser';

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
}

export default function ChatTab({
  chatHorizontalLayout,
  chatVerticalLayout,
  onHorizontalLayoutChange,
  onVerticalLayoutChange,
  isActive,
  promptSuggestionsEnabled,
  ttsEnabled,
}: ChatTabProps) {
  // --- State moved from page.tsx ---

  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

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
  // Per-session live cumulative output tokens (archived baseline + in-flight
  // turn), driven by session:usage SSE. Overlays archived metadata so the
  // sidebar count climbs as Claude streams; cleared once the archive catches up.
  const [liveTokens, setLiveTokens] = useState<Record<string, number>>({});
  // Pre-turn archived baseline, frozen at the first usage event of each run.
  // The server re-archives the live JSONL mid-turn (transcript:updated →
  // archiveSessionFromDisk), so the session's metadata.totalOutputTokens grows
  // during the run. Reading it per-event and adding the SSE tally would
  // double-count that growth (and the inflated overlay would never clear).
  // Freezing the baseline at run start keeps the math `P + R` correct.
  const baselineByRunRef = useRef<Record<string, number>>({});

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
  const [historyTranscript, setHistoryTranscript] = useState<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnMeta?: TurnMeta }[]>([]);
  const [viewingTranscriptId, setViewingTranscriptId] = useState<string | null>(null);
  const [historyTranscriptLoading, setHistoryTranscriptLoading] = useState(false);
  const [historyTranscriptProject, setHistoryTranscriptProject] = useState<string | null>(null);
  const [transcriptOverlayMessages, setTranscriptOverlayMessages] = useState<Message[]>([]);
  const [transcriptStreaming, setTranscriptStreaming] = useState('');
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [providerSource, setProviderSource] = useState<'Anthropic' | 'Bedrock' | null>(null);
  const [providerConfiguredModel, setProviderConfiguredModel] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const transcriptLoadingRef = useRef(false);
  const transcriptStreamingRef = useRef('');
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
  const [deleteConfirm, setDeleteConfirm] = useState<{
    sessionId: string; project: string; display: string; isLive: boolean;
  } | null>(null);
  const [labelEdit, setLabelEdit] = useState<{
    sessionId: string; currentLabel: string;
  } | null>(null);
  const [rewindConfirm, setRewindConfirm] = useState<{
    turnIndex: number; userMessage: string; fullMessage: string; timestamp: string;
  } | null>(null);
  const [intermediaryMessages, setIntermediaryMessages] = useState<TranscriptMsg[]>([]);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [codeViewerPath, setCodeViewerPath] = useState<string | null>(null);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message?: string } | null>(null);

  // --- Scroll helper ---
  const scrollTranscriptToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Pretty-print a Claude model id ("claude-opus-4-7" → "Claude Opus 4.7").
  // Returns null if the id doesn't match the expected shape so the caller
  // can fall back to a coarser label.
  const formatModelName = (raw: string | null): string | null => {
    if (!raw) return null;
    const match = raw.match(/claude-(\w+)-(\d+)-(\d+)/i);
    if (!match) return null;
    return `Claude ${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
  };

  // Compose the status-bar label. Prefer the per-session model (from the
  // CLI init event or the most recent assistant turn); fall back to the
  // ANTHROPIC_MODEL env var (set in Bedrock mode); finally fall back to
  // a generic "Claude".
  const modelLabel = formatModelName(currentModel) || formatModelName(providerConfiguredModel) || 'Claude';
  const providerLabel = providerSource ? `${modelLabel} (${providerSource})` : '';

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

  // Drop the live-token overlay for a session once its archived baseline has
  // caught up (i.e. the finished turn's tokens are now in metadata). The
  // server tally is a subset of the parser's, so baseline always reaches the
  // overlay — until then max(baseline, overlay) shows the live value with no
  // backward dip or double-count.
  useEffect(() => {
    setLiveTokens(prev => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        const baseline = (history.find(h => h.sessionId === id)?.metadata?.totalOutputTokens as number) || 0;
        if (baseline >= prev[id]) { delete next[id]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [history]);

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
    setTranscriptLoading(false);
    setTranscriptPartial(false);
    setSuggestedPrompt(null);
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
      let transcriptMessages: { role: 'user' | 'assistant'; content: string; timestamp: string }[] = [];
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
        if (data.pendingAskUserQuestion) {
          setAskUserQuestion({ input: data.pendingAskUserQuestion });
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
        const bufRes = await fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(sessionId)}`);
        if (bufRes.ok) {
          const bufData = await bufRes.json();
          if (bufData.hasBuffer && bufData.isActive) {
            // The JSONL contains partial assistant messages for the in-flight
            // turn that the stream buffer is handling. Strip the trailing
            // messages from the current turn so the chat shows bouncing dots
            // instead of intermediary assistant bubbles.
            setHistoryTranscript(prev => {
              const lastUserIdx = prev.findLastIndex(
                m => m.role === 'user' && m.content === bufData.userPrompt
              );
              if (lastUserIdx >= 0) {
                return prev.slice(0, lastUserIdx);
              }
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
                let cutIdx = lastIdx;
                while (cutIdx >= 0 && prev[cutIdx].role === 'assistant') {
                  cutIdx--;
                }
                if (cutIdx >= 0 && prev[cutIdx].role === 'user') {
                  return prev.slice(0, cutIdx);
                }
                return prev.slice(0, cutIdx + 1);
              }
              return prev;
            });

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
            // Session is processing but buffer is inactive or missing.
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

    // On SSE connect, re-fetch the stream buffer to close the gap between the
    // initial restore in fetchTranscript and when the EventSource connected.
    // Events emitted during that window would otherwise be lost.
    es.addEventListener('connected', () => {
      if (!shouldProcess()) return;

      fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(bufData => {
          if (!shouldProcess()) return;

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
                if (refreshData.messages && shouldProcess()) {
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
          if (tool.name === 'AskUserQuestion' && tool.input?.questions) {
            setAskUserQuestion({ input: tool.input });
          }
        }
      } else if (data.toolResult) {
        setStreamEvents(prev => [...prev, { type: 'tool_result' as const, preview: data.toolResult.preview, ts: Date.now() }]);
      } else if (data.error) {
        setStreamEvents(prev => [...prev, { type: 'error' as const, content: data.error, ts: Date.now() }]);
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

    // Live output-token tally for the in-flight turn. Add it to the session's
    // archived baseline (pre-turn total) to get the live cumulative the sidebar
    // counts toward. The cleanup effect drops the overlay once the archived
    // metadata catches up at turn end.
    es.addEventListener('session-usage', (e: MessageEvent) => {
      if (!shouldProcess()) return;
      const data = JSON.parse(e.data);
      if (typeof data.turnOutputTokens !== 'number') return;
      // Freeze the pre-turn baseline on the first event of this run; reuse it
      // for the rest so mid-turn metadata growth can't be double-counted.
      if (baselineByRunRef.current[mySessionId] === undefined) {
        baselineByRunRef.current[mySessionId] =
          (historyRef.current.find(h => h.sessionId === mySessionId)?.metadata?.totalOutputTokens as number) || 0;
      }
      const baseline = baselineByRunRef.current[mySessionId];
      setLiveTokens(prev => ({ ...prev, [mySessionId]: baseline + data.turnOutputTokens }));
    });

    // Handle session:health events (replaces health polling)
    es.addEventListener('session-health', (e: MessageEvent) => {
      if (!shouldProcess()) return;
      const data = JSON.parse(e.data);
      setIsStuck(data.isStuck);
      setStuckReason(data.stuckReason);

      // If the session is actively processing, ensure the loading indicator
      // (bouncing dots) is visible.
      if (data.isProcessing && !transcriptLoadingRef.current) {
        setTranscriptLoading(true);
      }

      // If processing just ended, refresh transcript from JSONL.
      if (!data.isProcessing && transcriptLoadingRef.current) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
        // Stamp the turn-completion time so the sidebar's freshness leaf
        // counts the 5-min prompt-cache TTL from now (when the cache was
        // last refreshed) rather than the turn's start.
        setSessionActivity(prev => ({ ...prev, [mySessionId]: Date.now() }));
        // Run ended — drop the frozen baseline so the next run re-captures it.
        delete baselineByRunRef.current[mySessionId];
        fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
          .then(res => res.json())
          .then(refreshData => {
            if (refreshData.messages && shouldProcess()) {
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
        // Also refresh transcript to pick up any missed messages
        fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
          .then(res => res.json())
          .then(data => {
            if (data.messages && shouldProcess()) {
              setHistoryTranscript(data.messages);
              if (!transcriptLoadingRef.current) {
                setTranscriptOverlayMessages([]);
                setOverlayInsertPoint(null);
              }
            }
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
    // transcriptLoading is true to catch missed completion events.
    // Also skips when tab is hidden to avoid unnecessary network requests.
    const healthPoll = setInterval(() => {
      if (!shouldProcess() || !transcriptLoadingRef.current) return;
      fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(data => {
          if (!shouldProcess()) return;
          if (!data.isProcessing && transcriptLoadingRef.current) {
            setTranscriptLoading(false);
            setTranscriptStreaming('');
            fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
              .then(res => res.json())
              .then(refreshData => {
                if (refreshData.messages && shouldProcess()) {
                  setHistoryTranscript(refreshData.messages);
                  setTranscriptOverlayMessages([]);
                  setOverlayInsertPoint(null);
                }
              })
              .catch(() => {});
          }
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
  }, [viewingTranscriptId, historyTranscriptProject]);

  // --- Catch-up when tab becomes visible again ---
  // SSE events were skipped while hidden; re-fetch stream buffer + transcript
  // to sync state with what happened while the user was on another tab.
  useEffect(() => {
    if (!isActive || !viewingTranscriptId || !historyTranscriptProject) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;

    fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
      .then(res => res.json())
      .then(bufData => {
        if (activeSessionRef.current !== mySessionId) return;

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

  const handleDirectorySelected = (path: string) => {
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
    setTranscriptPartial(false);
    setCurrentModel(null);
    setSubmitStartTime(null);
    setSubmitEndTime(null);

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
      const res = await fetch('/api/health', {
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

  const handleTranscriptSend = async (userMessage: string) => {
    if (!userMessage || transcriptLoading || !viewingTranscriptId) return;

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
        display: userMessage.length > 200 ? userMessage.substring(0, 200) + '...' : userMessage,
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

    // Instant feedback
    setTranscriptOverlayMessages(prev => [...prev, { role: 'user' as const, content: userMessage }]);
    setTranscriptLoading(true);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setSuggestedPrompt(null);
    setSubmitStartTime(Date.now());
    setSubmitEndTime(null);
    setTimeout(() => scrollTranscriptToBottom(), 50);

    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          sessionId: mySessionId,
          projectPath: myProject,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Done. SSE delivers all stream events + session:health signals completion.
    } catch (error) {
      if (activeSessionRef.current === mySessionId) {
        setTranscriptOverlayMessages(prev => [...prev, {
          role: 'assistant' as const,
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }]);
        setTranscriptLoading(false);
      }
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
      // Step 1: If "both", prompt Claude to undo code changes BEFORE truncating
      // (so it still has context of what it did)
      if (mode === 'both') {
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
      await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: mySessionId, action: 'stop' }),
      });
    } catch (error) {
      console.error('[App] Failed to stop session:', error);
    } finally {
      // Stopping kills the CLI, but everything generated up to this point was
      // cached — re-anchor the freshness window from now. (We clear
      // transcriptLoading here optimistically, so the session-health "just
      // ended" stamp won't fire; do it explicitly.)
      setSessionActivity(prev => ({ ...prev, [mySessionId]: Date.now() }));
      delete baselineByRunRef.current[mySessionId];
      if (activeSessionRef.current === mySessionId) {
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    }
  };

  const handleSessionDeleted = (sessionId: string) => {
    if (viewingTranscriptId === sessionId) {
      setViewingTranscriptId(null);
      setHistoryTranscript([]);
      setTranscriptOverlayMessages([]);
      setTranscriptStreaming('');
      setTranscriptLoading(false);
    }
  };

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

  const handleDeleteSession = async (sessionId: string, project: string) => {
    setDeleteConfirm(null);
    try {
      const res = await fetch(
        `/api/session?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({ title: 'Failed to delete session', message: data.error || `Server returned ${res.status}` });
        return;
      }
      handleSessionDeleted(sessionId);
      fetchHistory();
    } catch (error) {
      setErrorDialog({ title: 'Failed to delete session', message: error instanceof Error ? error.message : 'An unexpected error occurred' });
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
            liveTokens={liveTokens}
            viewingTranscriptId={viewingTranscriptId}
            transcriptLoading={transcriptLoading}
            isLoadingHistory={isLoadingHistory}
            historyHasMore={historyHasMore}
            isLoadingMoreHistory={isLoadingMoreHistory}
            onLoadMoreHistory={loadMoreHistory}
            onSelectSession={fetchTranscript}
            onRestorePending={restorePendingSession}
            onLabelEdit={(sessionId, currentLabel) => setLabelEdit({ sessionId, currentLabel })}
            onDeleteConfirm={setDeleteConfirm}
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
        <div className="h-full bg-card border-r border-border flex flex-col">
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
                            historyTranscript={historyTranscript}
                            transcriptOverlayMessages={transcriptOverlayMessages}
                            overlayInsertPoint={overlayInsertPoint}
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
                          {transcriptLoading && (
                            <div className="flex justify-start">
                              <button
                                onClick={() => setRightPanelView('stream')}
                                className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-muted text-foreground border border-border cursor-pointer hover:border-ring transition-colors text-left"
                                title="View live stream"
                              >
                                <div className="text-xs opacity-70 mb-1">Claude</div>
                                <div className="flex items-center gap-1 py-2">
                                  <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                  <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                  <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                </div>
                              </button>
                            </div>
                          )}
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
                        statusBar={providerLabel ? (
                          <div style={{ fontSize: '9px', fontWeight: 100, padding: '0 8px 1px' }} className="text-muted-foreground">
                            {providerLabel}
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
          {rightPanelView === 'mcp' && <McpPanel projectPath={historyTranscriptProject} />}
        </div>
      </Panel>
    </PanelGroup>

    {/* --- Dialogs (all owned by ChatTab) --- */}
    <IntermediaryMessagesDialog messages={intermediaryMessages} onClose={() => setIntermediaryMessages([])} />
    <CodeViewerDialog filePath={codeViewerPath} onClose={() => setCodeViewerPath(null)} />

    {askUserQuestion && (
      <AskUserQuestionDialog
        open={true}
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
        onSkip={handleAskUserQuestionSkip}
      />
    )}

    {contextMenu && (
      <SessionContextMenu
        {...contextMenu}
        onDelete={setDeleteConfirm}
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
      open={!!deleteConfirm}
      onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}
      title="Delete session?"
      message={<>
        {deleteConfirm?.isLive && (
          <>
            <span className="text-yellow-500 font-semibold">This session is currently live.</span> The running process will be terminated.
            <br /><br />
          </>
        )}
        This will permanently delete the session transcript and remove it from history. This action cannot be undone.
        <br /><br />
        <span className="text-xs font-mono break-all">{deleteConfirm?.display}</span>
      </>}
      confirmLabel="Delete"
      confirmVariant="destructive"
      onConfirm={() => { if (deleteConfirm) handleDeleteSession(deleteConfirm.sessionId, deleteConfirm.project); }}
      onCancel={() => setDeleteConfirm(null)}
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

    {/* Directory Picker Dialog */}
    <DirectoryPicker
      open={showDirectoryPicker}
      onOpenChange={setShowDirectoryPicker}
      onSelect={handleDirectorySelected}
      recentDirectories={recentDirectories}
    />
    </>
  );
}
