'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import RichTextEditor, { type RichTextEditorHandle } from '@/components/RichTextEditor';
import { DirectoryPicker } from '@/components/DirectoryPicker';
import FileTree from '@/components/FileTree';
import CodeViewerDialog, { isCodeFile } from '@/components/CodeViewerDialog';
import DrawflowCanvas from '@/components/DrawflowCanvas';
import WorkflowsPanel from '@/components/WorkflowsPanel';
import NodeChatModal from '@/components/NodeChatModal';
import AskUserQuestionDialog from '@/components/AskUserQuestionDialog';
import { Plus, AlertTriangle, Sun, Moon, FolderTree, FileText, Activity, Trash2, RotateCcw, Copy, Check } from 'lucide-react';
import { getRecentDirectories } from '@/lib/recent-directories';

// Client-side only timestamp component to avoid hydration mismatch
const HistoryTimestamp = ({ timestamp }: { timestamp: number }) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <span className="text-xs text-muted-foreground">Loading...</span>;
  }

  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });

  return (
    <span className="text-xs text-muted-foreground">
      {dateStr} {timeStr}
    </span>
  );
};

// Convert plain text to HTML paragraphs so TipTap can parse line breaks
const textToHtml = (text: string) =>
  text.split('\n').map(line => `<p>${line || '<br>'}</p>`).join('');

// Chat bubble wrapper with hover-to-copy button
const ChatBubble = ({ label, children, headerExtra, className, rawContent, isMarkdown }: {
  label: string;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  className: string;
  rawContent: string;
  isMarkdown?: boolean;
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = contentRef.current;
    if (!el) return;

    // For markdown (assistant) bubbles, use the rendered HTML from the DOM.
    // For plain text (user) bubbles, convert newlines to <p> tags so TipTap
    // preserves line breaks on paste.
    const html = isMarkdown ? el.innerHTML : textToHtml(rawContent);
    const text = rawContent;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  };

  return (
    <div className={`group/bubble relative ${className}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs opacity-70 flex items-center gap-2">
          {label}
          {headerExtra}
        </div>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover/bubble:opacity-100 transition-opacity p-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 opacity-70" />
          )}
        </button>
      </div>
      <div ref={contentRef}>{children}</div>
    </div>
  );
};

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AskUserQuestionState {
  input: {
    questions: {
      question: string;
      header?: string;
      multiSelect: boolean;
      options: { label: string; description?: string }[];
    }[];
  };
}

interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  messageCount?: number;
}

// Generate a UUID v4
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export default function Home() {
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Health check state
  const [isStuck, setIsStuck] = useState(false);
  const [stuckReason, setStuckReason] = useState<string | undefined>();

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set());

  // New sessions that haven't been submitted yet — persisted in the sidebar so
  // the user can switch away and come back without losing them.
  const [pendingNewSessions, setPendingNewSessions] = useState<
    { sessionId: string; project: string; title: string; createdAt: number }[]
  >([]);

  // Stream events for the right-panel Stream tab
  type StreamEvent =
    | { type: 'tool_start'; name: string; ts: number }
    | { type: 'tool_complete'; name: string; input?: any; ts: number }
    | { type: 'tool_result'; preview: string; ts: number }
    | { type: 'text'; content: string; ts: number }
    | { type: 'error'; content: string; ts: number };
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const streamEndRef = useRef<HTMLDivElement>(null);

  // Smart prompt suggestion for incomplete responses
  const [suggestedPrompt, setSuggestedPrompt] = useState<{ text: string; context: string } | null>(null);

  // Right panel view state
  type RightPanelView = 'files' | 'notes' | 'stream';
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>('stream');

  // Code viewer state
  const [codeViewerPath, setCodeViewerPath] = useState<string | null>(null);

  const handleFileDoubleClick = useCallback((filePath: string) => {
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || '';
    if (isCodeFile(fileName)) {
      setCodeViewerPath(filePath);
    }
  }, []);

  const closeCodeViewer = useCallback(() => setCodeViewerPath(null), []);

  // Tab control state
  const [activeTab, setActiveTab] = useState<'chat' | 'canvas'>('chat');

  // Notes state
  const [notes, setNotes] = useState<string>('');
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);

  // Workflow state
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);
  const exportFlowDataRef = useRef<(() => any) | null>(null);
  const importFlowDataRef = useRef<((data: any, id?: string) => void) | null>(null);
  const updateNodeDataRef = useRef<((nodeId: string, chatSession: any) => void) | null>(null);

  // Panel layout state
  const [chatHorizontalLayout, setChatHorizontalLayout] = useState<number[]>([20, 45, 35]);
  const [chatVerticalLayout, setChatVerticalLayout] = useState<number[]>([70, 30]);
  const [canvasHorizontalLayout, setCanvasHorizontalLayout] = useState<number[]>([20, 80]);
  const [layoutsLoaded, setLayoutsLoaded] = useState(false);
  const layoutSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Node chat modal state
  const [nodeChatModalOpen, setNodeChatModalOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeSession, setSelectedNodeSession] = useState<any>(null);

  // History transcript viewer state (renders in center panel)
  const [historyTranscript, setHistoryTranscript] = useState<{ role: 'user' | 'assistant'; content: string; timestamp: string }[]>([]);
  const [viewingTranscriptId, setViewingTranscriptId] = useState<string | null>(null);
  const [historyTranscriptLoading, setHistoryTranscriptLoading] = useState(false);
  const [historyTranscriptTitle, setHistoryTranscriptTitle] = useState('');
  const [historyTranscriptProject, setHistoryTranscriptProject] = useState<string | null>(null);
  const [intermediaryMessages, setIntermediaryMessages] = useState<{ role: 'user' | 'assistant'; content: string; timestamp: string }[]>([]);
  const [transcriptOverlayMessages, setTranscriptOverlayMessages] = useState<Message[]>([]);
  const [transcriptStreaming, setTranscriptStreaming] = useState('');
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const transcriptLoadingRef = useRef(false);
  const transcriptStreamingRef = useRef('');
  const activeSessionRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatEditorRef = useRef<RichTextEditorHandle>(null);
  const sessionDraftsRef = useRef<Map<string, string>>(new Map());

  // When overlay messages are restored from a previous session, they belong at a
  // specific position in the transcript (not at the end). null = append at end (live sends).
  const [overlayInsertPoint, setOverlayInsertPoint] = useState<number | null>(null);

  // True when the transcript was reconstructed from history.jsonl (user prompts only, no responses)
  const [transcriptPartial, setTranscriptPartial] = useState(false);

  // AskUserQuestion dialog state
  const [askUserQuestion, setAskUserQuestion] = useState<AskUserQuestionState | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    project: string;
    display: string;
    isLive: boolean;
  } | null>(null);

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    sessionId: string;
    project: string;
    display: string;
    isLive: boolean;
  } | null>(null);

  // Rewind confirmation state
  const [rewindConfirm, setRewindConfirm] = useState<{
    turnIndex: number;
    userMessage: string;
    fullMessage: string;
    timestamp: string;
  } | null>(null);

  // Error dialog state
  const [errorDialog, setErrorDialog] = useState<{
    title: string;
    message: string;
  } | null>(null);

  const scrollTranscriptToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Auto-scroll stream panel when new events arrive
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamEvents]);

  // Load UI state (activeTab, activeWorkflowId) on mount
  useEffect(() => {
    const loadUIState = async () => {
      try {
        const res = await fetch('/api/ui-state');
        if (res.ok) {
          const { state } = await res.json();
          if (state) {
            if (state.activeTab) {
              setActiveTab(state.activeTab);
            }
            if (state.activeWorkflowId) {
              setActiveWorkflowId(state.activeWorkflowId);
            }
            if (state.chatHorizontalLayout) {
              setChatHorizontalLayout(state.chatHorizontalLayout);
            }
            if (state.chatVerticalLayout) {
              setChatVerticalLayout(state.chatVerticalLayout);
            }
            if (state.canvasHorizontalLayout) {
              setCanvasHorizontalLayout(state.canvasHorizontalLayout);
            }
            console.log('[App] Loaded UI state from server');
          }
        }
      } catch (error) {
        console.error('[App] Failed to load UI state:', error);
      } finally {
        setLayoutsLoaded(true);
      }
    };
    loadUIState();
  }, []);

  // Save UI state when activeTab or activeWorkflowId changes
  useEffect(() => {
    const saveUIState = async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            activeTab,
            activeWorkflowId,
          }),
        });
      } catch (error) {
        console.error('[App] Failed to save UI state:', error);
      }
    };
    saveUIState();
  }, [activeTab, activeWorkflowId]);

  // Debounced save for panel layout changes
  const saveLayoutState = useCallback((updates: Record<string, number[]>) => {
    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }
    layoutSaveTimerRef.current = setTimeout(async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
      } catch (error) {
        console.error('[App] Failed to save panel layout:', error);
      }
    }, 500);
  }, []);

  // Load theme preference on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  // Save theme preference and apply to document
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Track the currently-viewed session so in-flight SSE handlers can detect
  // when the user has switched away and skip state updates accordingly.
  useEffect(() => {
    activeSessionRef.current = viewingTranscriptId;
  }, [viewingTranscriptId]);

  // Keep refs in sync so SSE event handlers always see the current value
  useEffect(() => {
    transcriptLoadingRef.current = transcriptLoading;
  }, [transcriptLoading]);

  useEffect(() => {
    transcriptStreamingRef.current = transcriptStreaming;
  }, [transcriptStreaming]);

  // Auto-scroll transcript viewer during streaming
  useEffect(() => {
    if (transcriptStreaming) {
      scrollTranscriptToBottom();
    }
  }, [transcriptStreaming]);

  const fetchHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        setHistory(data.entries || []);
      }
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  };

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
    setHistoryTranscriptTitle(displayTitle);
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
            detectedProcessing = true;
          } else if (bufData.isProcessing) {
            // Session is processing but buffer is inactive or missing.
            setTranscriptLoading(true);
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

  useEffect(() => {
    fetchHistory();
  }, []);

  // Global SSE connection for live-sessions and history-updated events
  useEffect(() => {
    if (activeTab !== 'chat') return;

    // Fetch initial data immediately
    fetch('/api/live-sessions').then(res => res.json()).then(data => {
      setLiveSessionIds(new Set(data.liveSessionIds || []));
    }).catch(() => {});

    const es = new EventSource('/api/events');

    es.addEventListener('live-sessions', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setLiveSessionIds(new Set(data.liveSessionIds || []));
    });

    es.addEventListener('history-updated', () => {
      fetchHistory();
    });

    es.onerror = () => {
      // EventSource auto-reconnects; on reconnect re-fetch state to cover gap
      if (es.readyState === EventSource.CONNECTING) {
        fetch('/api/live-sessions').then(res => res.json()).then(data => {
          setLiveSessionIds(new Set(data.liveSessionIds || []));
        }).catch(() => {});
        fetchHistory();
      }
    };

    return () => es.close();
  }, [activeTab]);

  // Session-scoped SSE for stream, health, and transcript events
  const sessionEsRef = useRef<EventSource | null>(null);

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

    // On SSE connect, re-fetch the stream buffer to close the gap between the
    // initial restore in fetchTranscript and when the EventSource connected.
    // Events emitted during that window would otherwise be lost.
    es.addEventListener('connected', () => {
      if (!isStillActive()) return;

      fetch(`/api/stream-buffer?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(bufData => {
          if (!isStillActive()) return;

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
                if (refreshData.messages && isStillActive()) {
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

    // Track AskUserQuestion tool use across stream events
    let pendingAskUserQuestion: AskUserQuestionState['input'] | null = null;

    // Handle session:stream events — the single path for all stream data.
    // NOTE: These events only fire for sessions managed by Fury's sessionManager.
    // External CLI sessions rely on transcript-updated (file watcher) for updates.
    es.addEventListener('session-stream', (e: MessageEvent) => {
      if (!isStillActive()) return;

      const data = JSON.parse(e.data);

      // Ignore stream data that arrives after the user has stopped processing.
      // Without this guard, buffered events could overwrite the cleared state.
      if (!transcriptLoadingRef.current) return;

      if (data.text) {
        // If Claude streams more text after calling AskUserQuestion, the
        // question was already handled (e.g. the CLI responded with an error
        // and Claude continued). Clear the pending dialog so the normal
        // transcript-refresh completion path runs instead.
        if (pendingAskUserQuestion) {
          pendingAskUserQuestion = null;
        }
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
          // Capture AskUserQuestion for handling when processing completes
          if (tool.name === 'AskUserQuestion' && tool.input?.questions) {
            pendingAskUserQuestion = tool.input;
          }
        }
      } else if (data.toolResult) {
        setStreamEvents(prev => [...prev, { type: 'tool_result' as const, preview: data.toolResult.preview, ts: Date.now() }]);
      } else if (data.error) {
        setStreamEvents(prev => [...prev, { type: 'error' as const, content: data.error, ts: Date.now() }]);
      }
    });

    // Handle session:health events (replaces health polling)
    es.addEventListener('session-health', (e: MessageEvent) => {
      if (!isStillActive()) return;
      const data = JSON.parse(e.data);
      setIsStuck(data.isStuck);
      setStuckReason(data.stuckReason);

      // If the session is actively processing, ensure the loading indicator
      // (bouncing dots) is visible.
      if (data.isProcessing && !transcriptLoadingRef.current) {
        setTranscriptLoading(true);
      }

      // If processing just ended, handle completion.
      if (!data.isProcessing && transcriptLoadingRef.current) {
        // If AskUserQuestion was detected during this turn, save accumulated
        // text as an overlay message and open the dialog instead of refreshing.
        if (pendingAskUserQuestion) {
          const currentText = transcriptStreamingRef.current;
          if (currentText) {
            setTranscriptOverlayMessages(prev => [...prev, { role: 'assistant' as const, content: currentText }]);
          }
          setTranscriptStreaming('');
          setTranscriptLoading(false);
          setAskUserQuestion({ input: pendingAskUserQuestion });
          pendingAskUserQuestion = null;
          return;
        }

        // Normal completion: refresh transcript from JSONL.
        setTranscriptLoading(false);
        setTranscriptStreaming('');
        fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
          .then(res => res.json())
          .then(refreshData => {
            if (refreshData.messages && isStillActive()) {
              setHistoryTranscript(refreshData.messages);
              setTranscriptOverlayMessages([]);
              setOverlayInsertPoint(null);
            }
          })
          .catch(() => {});
      }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CONNECTING && isStillActive()) {
        // SSE reconnecting — check if session completed while disconnected
        fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`)
          .then(res => res.json())
          .then(data => {
            if (!isStillActive()) return;
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
            if (data.messages && isStillActive()) {
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
      if (!isStillActive()) return;
      // Don't refresh while any processing is in flight — the JSONL contains
      // partial assistant messages that would render as intermediary bubbles.
      if (transcriptLoadingRef.current) return;

      fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
        .then(res => res.json())
        .then(data => {
          if (data.messages && isStillActive()) {
            setHistoryTranscript(data.messages);
          }
        })
        .catch(() => {});
    });

    // Fallback health poll: if SSE drops or a session:health event is lost,
    // the UI can get stuck showing "processing" forever. Poll every 15s while
    // transcriptLoading is true to catch missed completion events.
    const healthPoll = setInterval(() => {
      if (!isStillActive() || !transcriptLoadingRef.current) return;
      fetch(`/api/health?sessionId=${encodeURIComponent(mySessionId)}`)
        .then(res => res.json())
        .then(data => {
          if (!isStillActive()) return;
          if (!data.isProcessing && transcriptLoadingRef.current) {
            setTranscriptLoading(false);
            setTranscriptStreaming('');
            fetch(`/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject)}`)
              .then(res => res.json())
              .then(refreshData => {
                if (refreshData.messages && isStillActive()) {
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

  // Load workflows and compute recent directories
  useEffect(() => {
    const loadWorkflowsAndDirectories = async () => {
      try {
        const res = await fetch('/api/workflows');
        if (res.ok) {
          const data = await res.json();
          const loadedWorkflows = data.workflows || [];
          setWorkflows(loadedWorkflows);

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

  const currentProjectPath = historyTranscriptProject;

  // Load notes when project path changes
  useEffect(() => {
    const loadNotes = async () => {
      if (!currentProjectPath) {
        setNotes('');
        return;
      }

      setIsLoadingNotes(true);
      try {
        const response = await fetch(`/api/notes?projectPath=${encodeURIComponent(currentProjectPath)}`);
        const data = await response.json();

        if (response.ok) {
          setNotes(data.notes || '');
        }
      } catch (error) {
        console.error('Error loading notes:', error);
      } finally {
        setIsLoadingNotes(false);
      }
    };

    loadNotes();
  }, [currentProjectPath]);

  // Auto-save notes (debouncing handled by RichTextEditor component)
  const handleNotesChange = async (content: string) => {
    if (!currentProjectPath) return;

    // Update local state so remounting the editor (e.g. after tab switch) preserves edits
    setNotes(content);

    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectPath: currentProjectPath,
          notes: content,
        }),
      });
    } catch (error) {
      console.error('Error saving notes:', error);
    }
  };

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
    setHistoryTranscriptTitle('New Session');
    setHistoryTranscript([]);
    setTranscriptOverlayMessages([]);
    setOverlayInsertPoint(null);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setTranscriptLoading(false);
    setTranscriptPartial(false);

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
    setHistoryTranscriptTitle(pending.title);
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

    // Restore draft for this pending session
    const savedDraft = sessionDraftsRef.current.get(pending.sessionId) || '';
    setTimeout(() => chatEditorRef.current?.setContent(savedDraft), 50);
  };

  const handleKillStuckSession = async () => {
    if (!viewingTranscriptId) return;

    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: viewingTranscriptId,
          action: 'stop',
        }),
      });

      if (res.ok) {
        setIsStuck(false);
        setStuckReason(undefined);
        setTranscriptLoading(false);
        setTranscriptStreaming('');
      }
    } catch (error) {
      console.error('Failed to kill session:', error);
    }
  };

  // Handle auto-save for workflows
  const handleWorkflowAutoSave = async (data: any, workflowId: string) => {
    if (!workflowId) return;

    try {
      await fetch('/api/workflows', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: workflowId,
          data,
        }),
      });
      console.log('[App] Workflow auto-saved:', workflowId);
    } catch (error) {
      console.error('[App] Failed to auto-save workflow:', error);
    }
  };

  // Handle node double-click
  const handleNodeDoubleClick = (nodeId: string, chatSession: any) => {
    console.log('[App] Node double-clicked:', nodeId, chatSession);
    console.log('[App] Current modal state - open:', nodeChatModalOpen, 'selectedNodeId:', selectedNodeId);

    // Always update the state, even if modal is already open
    setSelectedNodeId(nodeId);
    setSelectedNodeSession(chatSession);
    setNodeChatModalOpen(true);

    console.log('[App] After setState - will open modal for node:', nodeId);
  };

  // Handle node session update
  const handleNodeSessionUpdate = (nodeId: string, session: any) => {
    console.log('[App] Updating node session:', nodeId, session);

    // Update the node data in the canvas
    if (updateNodeDataRef.current) {
      updateNodeDataRef.current(nodeId, session);
    }

    // Update local state
    setSelectedNodeSession(session);
  };

  const handleTranscriptSend = async (userMessage: string) => {
    if (!userMessage || transcriptLoading || !viewingTranscriptId) return;

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

    // Instant feedback
    setTranscriptOverlayMessages(prev => [...prev, { role: 'user' as const, content: userMessage }]);
    setTranscriptLoading(true);
    setTranscriptStreaming('');
    setStreamEvents([]);
    setSuggestedPrompt(null);
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
    if (!viewingTranscriptId || !historyTranscriptProject || !rewindConfirm) return;

    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;
    const { turnIndex, fullMessage } = rewindConfirm;
    setRewindConfirm(null);

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
            prompt: `Undo all file changes you made starting from the message shown below. Restore every modified file to its state before that point. Do not explain, just revert the files.\n\nMessage to rewind to (${rewindConfirm.timestamp ? new Date(rewindConfirm.timestamp).toISOString() : 'unknown time'}):\n> ${rewindConfirm.userMessage}`,
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
      setTranscriptLoading(false);
      setTranscriptStreaming('');
    }
  };

  const handleTranscriptStop = async () => {
    if (!viewingTranscriptId) return;
    try {
      await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: viewingTranscriptId, action: 'stop' }),
      });
    } catch (error) {
      console.error('[App] Failed to stop session:', error);
    } finally {
      // Always reset UI state — the SSE health event should also fire,
      // but reset here too in case the fetch itself failed.
      setTranscriptLoading(false);
      setTranscriptStreaming('');
    }
  };

  const handleAskUserQuestionResponse = (answers: string) => {
    setAskUserQuestion(null);
    if (!answers.trim()) return;
    handleTranscriptSend(answers);
  };

  const handleAskUserQuestionSkip = () => {
    setAskUserQuestion(null);
  };

  // Close context menu on click-outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const handleDeleteSession = async (sessionId: string, project: string) => {
    setDeleteConfirm(null);
    try {
      const res = await fetch(
        `/api/session?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({
          title: 'Failed to delete session',
          message: data.error || `Server returned ${res.status}`,
        });
        return;
      }
      // If we're currently viewing this session, close it
      if (viewingTranscriptId === sessionId) {
        setViewingTranscriptId(null);
        setHistoryTranscript([]);
        setTranscriptOverlayMessages([]);
        setTranscriptStreaming('');
        setTranscriptLoading(false);
      }
      // Refresh history list
      fetchHistory();
    } catch (error) {
      setErrorDialog({
        title: 'Failed to delete session',
        message: error instanceof Error ? error.message : 'An unexpected error occurred',
      });
    }
  };

  return (
    <div className="h-screen w-screen bg-background flex flex-col">
      {/* Toolbar */}
      <div className="bg-card border-b border-border px-4 py-2 flex items-center justify-end gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="h-8 w-8 p-0"
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Main Content with Tabs */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Primary Tabs */}
        <div className="border-b border-border px-4 flex items-center gap-6">
          <button
            onClick={() => setActiveTab('chat')}
            className={`
              relative py-3 text-sm font-medium transition-colors
              ${activeTab === 'chat'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            Chat
            {activeTab === 'chat' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('canvas')}
            className={`
              relative py-3 text-sm font-medium transition-colors
              ${activeTab === 'canvas'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            Canvas
            {activeTab === 'canvas' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-hidden">
          {/* Chat Tab */}
          {activeTab === 'chat' && layoutsLoaded && (
        <PanelGroup direction="horizontal" onLayout={(sizes) => {
          setChatHorizontalLayout(sizes);
          saveLayoutState({ chatHorizontalLayout: sizes });
        }}>
          {/* Left Panel - Unified Session List */}
          <Panel defaultSize={chatHorizontalLayout[0]} minSize={15}>
            <div className="h-full bg-card border-r border-border flex flex-col">
              {/* Header */}
              <div className="p-4 border-b border-border flex justify-between items-center">
                <h2 className="text-foreground text-lg font-semibold">Sessions</h2>
                <Button
                  onClick={handleCreateSession}
                  variant="outline"
                  size="sm"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {/* Session List */}
              <div className="flex-1 overflow-y-auto p-2">
                <TooltipProvider>
                {/* Pending new sessions (not yet submitted) */}
                {pendingNewSessions.map((pending) => {
                  const isViewing = viewingTranscriptId === pending.sessionId;
                  return (
                    <div
                      key={`pending-${pending.sessionId}`}
                      className={`mb-2 p-3 rounded border cursor-pointer transition-colors ${
                        isViewing
                          ? 'bg-primary/10 border-primary'
                          : 'bg-muted border-dashed border-border hover:border-ring'
                      }`}
                      onClick={() => !isViewing && restorePendingSession(pending)}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-sm font-medium text-foreground">New Session</span>
                        {isViewing && transcriptLoading && (
                          <div className="flex items-center gap-0.5 ml-1">
                            <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                            <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                            <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                          </div>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={pending.project}>
                        {pending.project}
                      </div>
                    </div>
                  );
                })}

                {/* History Entries */}
                {(() => {
                  return history.map((entry, index) => {
                    const isLive = !!entry.sessionId && liveSessionIds.has(entry.sessionId);
                    const isClickable = !!entry.sessionId && !!entry.project;
                    const isViewing = viewingTranscriptId === entry.sessionId;
                    return (
                      <div
                        key={`history-${index}`}
                        className={`mb-2 p-3 rounded border transition-colors ${
                          isViewing
                            ? 'bg-primary/10 border-primary'
                            : isLive
                            ? 'border-green-600/50 hover:border-green-500'
                            : 'bg-muted border-border hover:border-ring'
                        } ${isClickable ? 'cursor-pointer' : ''}`}
                        onClick={isClickable ? () => fetchTranscript(entry.sessionId!, entry.project, entry.display) : undefined}
                        onContextMenu={entry.sessionId ? (e) => {
                          e.preventDefault();
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            sessionId: entry.sessionId!,
                            project: entry.project,
                            display: entry.display,
                            isLive,
                          });
                        } : undefined}
                      >
                        <div className="flex justify-between items-start mb-1">
                          <HistoryTimestamp timestamp={entry.timestamp} />
                          <div className="flex items-center gap-1.5">
                            {isViewing && transcriptLoading && (
                              <div className="flex items-center gap-0.5">
                                <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                                <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                                <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                              </div>
                            )}
                            {isLive && (
                              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-green-400 bg-green-950/60 border border-green-700/50 rounded px-1.5 py-0.5">
                                <span className="relative flex h-1.5 w-1.5">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400"></span>
                                </span>
                                Live
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-sm text-foreground break-words line-clamp-2">
                          {entry.display}
                        </div>
                        {entry.messageCount != null && (
                          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                            <span>
                              {entry.messageCount} message{entry.messageCount !== 1 ? 's' : ''}
                            </span>
                            {entry.messageCount >= 50 && (
                              <AlertTriangle className="h-3 w-3 text-yellow-500" />
                            )}
                          </div>
                        )}
                        <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={entry.project}>
                          {entry.project}
                        </div>
                      </div>
                    );
                  });
                })()}

                {history.length === 0 && !isLoadingHistory && (
                  <div className="text-center text-muted-foreground mt-8 text-sm">
                    No sessions found
                  </div>
                )}
                </TooltipProvider>
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

          {/* Middle Panel - Chat Interface / Transcript Viewer */}
          <Panel defaultSize={chatHorizontalLayout[1]} minSize={30}>
            <div className="h-full bg-card border-r border-border flex flex-col">

              {/* === Transcript View (interactive) === */}
              {viewingTranscriptId ? (
                <>
                  {/* Stuck process kill banner */}
                  {isStuck && (
                    <div className="p-2 border-b border-border flex justify-end">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="flex items-center gap-2"
                          >
                            <AlertTriangle className="h-4 w-4" />
                            Process Stuck - Kill
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Kill stuck process?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {stuckReason}<br /><br />
                              This will terminate the Claude CLI process. The current response will be lost.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleKillStuckSession}>
                              Kill Process
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}

                  {/* Transcript + Input with Vertical Resizer */}
                  <div className="flex-1 overflow-hidden">
                    <PanelGroup direction="vertical" onLayout={(sizes) => {
                      setChatVerticalLayout(sizes);
                      saveLayoutState({ chatVerticalLayout: sizes });
                    }}>
                      {/* Messages Area Panel */}
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
                        {/* Partial transcript warning */}
                        {transcriptPartial && (
                          <div className="rounded-md border border-yellow-600/50 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200 mb-4">
                            <p className="font-medium">Partial transcript</p>
                            <p className="text-xs text-yellow-300/70 mt-1">
                              Only your prompts are available for this session. Full conversation transcripts were not persisted by Claude CLI at the time this session was created.
                            </p>
                          </div>
                        )}

                        {/* Transcript turns with intermediary grouping, overlay merged at correct position */}
                        {(() => {
                          type TranscriptMsg = { role: 'user' | 'assistant'; content: string; timestamp: string };

                          // Merge overlay messages into transcript at the correct chronological position
                          const overlayAsTranscript: TranscriptMsg[] = transcriptOverlayMessages.map(m => ({
                            role: m.role, content: m.content, timestamp: '',
                          }));
                          let allMessages: TranscriptMsg[];
                          if (overlayInsertPoint != null && overlayAsTranscript.length > 0) {
                            allMessages = [
                              ...historyTranscript.slice(0, overlayInsertPoint),
                              ...overlayAsTranscript,
                              ...historyTranscript.slice(overlayInsertPoint),
                            ];
                          } else {
                            allMessages = [...historyTranscript, ...overlayAsTranscript];
                          }

                          const turns: { user: TranscriptMsg | null; assistant: TranscriptMsg | null; intermediaries: TranscriptMsg[] }[] = [];
                          let currentTurn: typeof turns[0] = { user: null, assistant: null, intermediaries: [] };

                          for (const msg of allMessages) {
                            if (msg.role === 'user') {
                              if (currentTurn.user || currentTurn.assistant) {
                                turns.push(currentTurn);
                              }
                              currentTurn = { user: msg, assistant: null, intermediaries: [] };
                            } else {
                              if (currentTurn.assistant) {
                                currentTurn.intermediaries.push(currentTurn.assistant);
                              }
                              currentTurn.assistant = msg;
                            }
                          }
                          if (currentTurn.user || currentTurn.assistant) {
                            turns.push(currentTurn);
                          }

                          return turns.map((turn, i) => (
                            <div key={`turn-${i}`} className="space-y-3">
                              {turn.user && (
                                <div className="flex justify-end items-center group/rewind">
                                  {i > 0 && !transcriptLoading && (
                                    <button
                                      onClick={() => setRewindConfirm({
                                        turnIndex: i,
                                        userMessage: turn.user!.content.length > 80
                                          ? turn.user!.content.substring(0, 80) + '...'
                                          : turn.user!.content,
                                        fullMessage: turn.user!.content,
                                        timestamp: turn.user!.timestamp,
                                      })}
                                      className="opacity-0 group-hover/rewind:opacity-100 transition-opacity mr-2 p-1 rounded hover:bg-muted"
                                      title="Rewind to before this message"
                                    >
                                      <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                                    </button>
                                  )}
                                  <ChatBubble label="You" className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-blue-900 text-white border-blue-700" rawContent={turn.user.content}>
                                    <div className="whitespace-pre-wrap break-words text-sm">
                                      {turn.user.content}
                                    </div>
                                  </ChatBubble>
                                </div>
                              )}
                              {turn.assistant && (
                                <div className="flex justify-start">
                                  <ChatBubble
                                    label="Claude"
                                    className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-muted text-foreground border-border transition-colors"
                                    rawContent={turn.assistant.content}
                                    isMarkdown
                                    headerExtra={turn.intermediaries.length > 0 ? (
                                      <span
                                        className="text-[10px] text-muted-foreground bg-background border border-border rounded px-1.5 py-0.5 cursor-pointer hover:border-ring hover:text-foreground transition-colors"
                                        onClick={() => setIntermediaryMessages(turn.intermediaries)}
                                      >
                                        +{turn.intermediaries.length} intermediary
                                      </span>
                                    ) : undefined}
                                  >
                                    <div className="prose-chat max-w-none">
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                                      >
                                        {turn.assistant.content}
                                      </ReactMarkdown>
                                    </div>
                                  </ChatBubble>
                                </div>
                              )}
                            </div>
                          ));
                        })()}

                        {/* Processing indicator - click to open Stream tab */}
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

                        {/* Smart continuation suggestion for incomplete responses */}
                        {suggestedPrompt && !transcriptLoading && (
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

                      {/* Input Area Panel */}
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
                          />
                        </div>
                      </Panel>
                    </PanelGroup>
                  </div>
                </>
              ) : (
                <>
                  {/* === No Session Selected === */}
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
                </>
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

          {/* Right Panel - Multi-View */}
          <Panel defaultSize={chatHorizontalLayout[2]} minSize={20}>
            <div className="h-full bg-card flex flex-col">
              {/* Toolbar */}
              <div className="p-2 border-b border-border flex items-center gap-2">
                <Button
                  variant={rightPanelView === 'stream' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setRightPanelView('stream')}
                  className="flex items-center gap-2"
                >
                  <Activity className="h-4 w-4" />
                  Stream
                  {transcriptLoading && (
                    <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  )}
                </Button>
                <Button
                  variant={rightPanelView === 'files' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setRightPanelView('files')}
                  className="flex items-center gap-2"
                >
                  <FolderTree className="h-4 w-4" />
                  Files
                </Button>
                <Button
                  variant={rightPanelView === 'notes' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setRightPanelView('notes')}
                  className="flex items-center gap-2"
                >
                  <FileText className="h-4 w-4" />
                  Notes
                </Button>
              </div>

              {/* Files View - always mounted to preserve watcher & expand state */}
              <div className={`flex-1 overflow-hidden ${rightPanelView === 'files' ? '' : 'hidden'}`}>
                <FileTree projectPath={historyTranscriptProject} onFileDoubleClick={handleFileDoubleClick} />
              </div>

              {/* Stream View */}
              {rightPanelView === 'stream' && (
                <div className="flex-1 overflow-y-auto font-mono text-xs">
                  {streamEvents.length === 0 && !transcriptLoading && (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      No stream activity. Send a message to see real-time events.
                    </div>
                  )}
                  {streamEvents.map((evt, i) => {
                    if (evt.type === 'tool_start') {
                      // Check if a matching tool_complete follows — if so, skip this
                      // start event since the complete event shows all the details.
                      const hasComplete = streamEvents.slice(i + 1).some(
                        e => e.type === 'tool_complete' && e.name === evt.name
                      );
                      if (hasComplete) return null;
                      // Unresolved tool_start — show as active if streaming, muted if not
                      return (
                        <div key={i} className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2">
                          {transcriptLoading ? (
                            <span className="text-yellow-500 animate-pulse">{'▶'}</span>
                          ) : (
                            <span className="text-muted-foreground">{'▶'}</span>
                          )}
                          <span className={transcriptLoading ? "text-primary font-semibold" : "text-muted-foreground font-semibold"}>{evt.name}</span>
                          {transcriptLoading && (
                            <span className="text-muted-foreground animate-pulse">running...</span>
                          )}
                        </div>
                      );
                    }
                    if (evt.type === 'tool_complete') {
                      const input = evt.input;
                      let detail = '';
                      if (evt.name === 'Edit' && input?.file_path) {
                        const fileName = input.file_path.split(/[/\\]/).pop();
                        detail = fileName || input.file_path;
                      } else if (evt.name === 'Write' && input?.file_path) {
                        const fileName = input.file_path.split(/[/\\]/).pop();
                        detail = fileName || input.file_path;
                      } else if (evt.name === 'Read' && input?.file_path) {
                        const fileName = input.file_path.split(/[/\\]/).pop();
                        detail = fileName || input.file_path;
                      } else if (evt.name === 'Bash' && input?.command) {
                        detail = input.command.length > 80 ? input.command.substring(0, 80) + '...' : input.command;
                      } else if (evt.name === 'Glob' && input?.pattern) {
                        detail = input.pattern;
                      } else if (evt.name === 'Grep' && input?.pattern) {
                        detail = `/${input.pattern}/`;
                      }
                      return (
                        <div key={i} className="px-3 py-1.5 border-b border-border/50">
                          <div className="flex items-center gap-2">
                            <span className="text-green-500">{'✓'}</span>
                            <span className="text-primary font-semibold">{evt.name}</span>
                            {detail && (
                              <span className="text-muted-foreground truncate">{detail}</span>
                            )}
                          </div>
                          {(evt.name === 'Edit' || evt.name === 'Write') && input?.file_path && (
                            <div className="mt-1 ml-5 text-muted-foreground truncate" title={input.file_path}>
                              {input.file_path}
                            </div>
                          )}
                          {evt.name === 'Edit' && input?.old_string && (
                            <div className="mt-1 ml-5 space-y-0.5">
                              <div className="bg-red-500/10 text-red-400 px-2 py-0.5 rounded whitespace-pre-wrap max-h-24 overflow-y-auto">
                                {input.old_string.length > 300 ? input.old_string.substring(0, 300) + '...' : input.old_string}
                              </div>
                              <div className="bg-green-500/10 text-green-400 px-2 py-0.5 rounded whitespace-pre-wrap max-h-24 overflow-y-auto">
                                {input.new_string.length > 300 ? input.new_string.substring(0, 300) + '...' : input.new_string}
                              </div>
                            </div>
                          )}
                          {evt.name === 'Bash' && input?.command && (
                            <div className="mt-1 ml-5 bg-muted/50 px-2 py-0.5 rounded text-foreground whitespace-pre-wrap max-h-16 overflow-y-auto">
                              $ {input.command}
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (evt.type === 'tool_result') {
                      return (
                        <div key={i} className="px-3 py-1 border-b border-border/50 text-muted-foreground ml-5 whitespace-pre-wrap max-h-16 overflow-y-auto">
                          {evt.preview}
                        </div>
                      );
                    }
                    if (evt.type === 'text') {
                      return (
                        <div key={i} className="px-3 py-1.5 border-b border-border/50 text-foreground whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {evt.content.length > 500 ? evt.content.substring(0, 500) + '...' : evt.content}
                        </div>
                      );
                    }
                    if (evt.type === 'error') {
                      return (
                        <div key={i} className="px-3 py-1.5 border-b border-border/50 text-red-400">
                          Error: {evt.content}
                        </div>
                      );
                    }
                    return null;
                  })}
                  {transcriptLoading && streamEvents.length > 0 && (
                    <div className="px-3 py-2 flex items-center gap-2 text-muted-foreground">
                      <span className="animate-pulse">{'●'}</span> Streaming...
                    </div>
                  )}
                  <div ref={streamEndRef} />
                </div>
              )}

              {/* Notes View */}
              {rightPanelView === 'notes' && (
                <div className="flex-1 overflow-hidden p-4">
                  {isLoadingNotes ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      Loading notes...
                    </div>
                  ) : (
                    <RichTextEditor
                      key={currentProjectPath || 'no-project'}
                      initialContent={notes}
                      onChange={handleNotesChange}
                      onSubmit={() => {}}
                      placeholder={currentProjectPath ? "Write your notes here... (notes are shared across all sessions in this directory)" : "Select a session with a project directory to use notes"}
                      disabled={!currentProjectPath}
                      persistContent={true}
                      showButtonBar={false}
                      debounceMs={2000}
                    />
                  )}
                </div>
              )}

            </div>
          </Panel>
        </PanelGroup>
          )}

          {/* Canvas Tab */}
          {activeTab === 'canvas' && layoutsLoaded && (
            <PanelGroup direction="horizontal" onLayout={(sizes) => {
              setCanvasHorizontalLayout(sizes);
              saveLayoutState({ canvasHorizontalLayout: sizes });
            }}>
              {/* Left Panel - Workflows */}
              <Panel defaultSize={canvasHorizontalLayout[0]} minSize={15}>
                <WorkflowsPanel
                  activeWorkflowId={activeWorkflowId}
                  onWorkflowSelect={setActiveWorkflowId}
                  onWorkflowLoad={(workflow) => {
                    if (importFlowDataRef.current) {
                      importFlowDataRef.current(workflow.data, workflow.id);
                    }
                  }}
                  onSaveWorkflow={(name, data) => {
                    console.log('Save workflow:', name, data);
                  }}
                  getCurrentFlowData={() => {
                    if (exportFlowDataRef.current) {
                      return exportFlowDataRef.current();
                    }
                    // Return empty Drawflow structure if editor not ready
                    return {
                      drawflow: {
                        Home: {
                          data: {}
                        }
                      }
                    };
                  }}
                />
              </Panel>

              <PanelResizeHandle className="w-2 bg-border hover:bg-primary transition-colors" />

              {/* Middle Panel - Canvas */}
              <Panel defaultSize={canvasHorizontalLayout[1]} minSize={50}>
                <DrawflowCanvas
                  className="h-full"
                  activeWorkflowId={activeWorkflowId}
                  onEditorReady={(exportFn, importFn, updateNodeDataFn) => {
                    exportFlowDataRef.current = exportFn;
                    importFlowDataRef.current = importFn;
                    updateNodeDataRef.current = updateNodeDataFn;
                  }}
                  onAutoSave={handleWorkflowAutoSave}
                  onNodeDoubleClick={handleNodeDoubleClick}
                />
              </Panel>
            </PanelGroup>
          )}
        </div>
      </div>

      {/* Node Chat Modal */}
      <NodeChatModal
        key={selectedNodeId || 'no-node'}
        open={nodeChatModalOpen}
        onOpenChange={(open) => {
          console.log('[App] NodeChatModal onOpenChange called with open:', open);
          console.log('[App] Current state - nodeChatModalOpen:', nodeChatModalOpen, 'selectedNodeId:', selectedNodeId);

          setNodeChatModalOpen(open);
          // Reset state when modal closes so it can be reopened properly
          if (!open) {
            console.log('[App] Resetting modal state to null');
            setSelectedNodeId(null);
            setSelectedNodeSession(null);
          }
        }}
        nodeId={selectedNodeId}
        initialSession={selectedNodeSession}
        onSessionUpdate={handleNodeSessionUpdate}
      />

      {/* Intermediary Messages Dialog */}
      {/* Code Viewer Dialog */}
      <CodeViewerDialog filePath={codeViewerPath} onClose={closeCodeViewer} />

      <Dialog open={intermediaryMessages.length > 0} onOpenChange={(open) => { if (!open) setIntermediaryMessages([]); }}>
        <DialogContent className="max-w-3xl h-[80vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
            <DialogTitle>Intermediary Messages</DialogTitle>
            <DialogDescription>
              {intermediaryMessages.length} intermediary response{intermediaryMessages.length !== 1 ? 's' : ''} before the final output
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
            {intermediaryMessages.map((msg, i) => (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-muted text-foreground border-border">
                  <div className="text-xs opacity-70 mb-1">Claude</div>
                  <div className="prose-chat max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Directory Picker Dialog */}
      <DirectoryPicker
        open={showDirectoryPicker}
        onOpenChange={setShowDirectoryPicker}
        onSelect={handleDirectorySelected}
        recentDirectories={recentDirectories}
      />

      {/* AskUserQuestion Dialog */}
      {askUserQuestion && (
        <AskUserQuestionDialog
          open={true}
          questions={askUserQuestion.input.questions}
          onSubmit={handleAskUserQuestionResponse}
          onSkip={handleAskUserQuestionSkip}
        />
      )}

      {/* Session Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] bg-popover border border-border rounded-md shadow-md py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-muted text-destructive"
            onClick={() => {
              setDeleteConfirm({
                sessionId: contextMenu.sessionId,
                project: contextMenu.project,
                display: contextMenu.display,
                isLive: contextMenu.isLive,
              });
              setContextMenu(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete Session
          </button>
        </div>
      )}

      {/* Rewind Confirmation */}
      <AlertDialog open={!!rewindConfirm} onOpenChange={(open) => { if (!open) setRewindConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rewind conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewind the conversation to before this message:
              <br /><br />
              <span className="text-muted-foreground text-xs font-mono break-all">&ldquo;{rewindConfirm?.userMessage}&rdquo;</span>
              {rewindConfirm?.timestamp && (
                <><br /><span className="text-muted-foreground text-xs">{new Date(rewindConfirm.timestamp).toLocaleString()}</span></>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-secondary text-secondary-foreground hover:bg-secondary/80" onClick={() => handleRewind('conversation')}>
              Conversation only
            </AlertDialogAction>
            <AlertDialogAction onClick={() => handleRewind('both')}>
              Conversation + Code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Session Confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.isLive && (
                <>
                  <span className="text-yellow-500 font-semibold">This session is currently live.</span> The running process will be terminated.
                  <br /><br />
                </>
              )}
              This will permanently delete the session transcript and remove it from history. This action cannot be undone.
              <br /><br />
              <span className="text-muted-foreground text-xs font-mono break-all">{deleteConfirm?.display}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirm) {
                  handleDeleteSession(deleteConfirm.sessionId, deleteConfirm.project);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Error Dialog */}
      <AlertDialog open={!!errorDialog} onOpenChange={(open) => { if (!open) setErrorDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{errorDialog?.title}</AlertDialogTitle>
            <AlertDialogDescription>{errorDialog?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setErrorDialog(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
