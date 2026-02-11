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
import { Plus, AlertTriangle, Sun, Moon, FolderTree, FileText, Activity, Trash2, RotateCcw } from 'lucide-react';
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
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set());

  // Stream events for the right-panel Stream tab
  type StreamEvent =
    | { type: 'tool_start'; name: string; ts: number }
    | { type: 'tool_complete'; name: string; input?: any; ts: number }
    | { type: 'tool_result'; preview: string; ts: number }
    | { type: 'text'; content: string; ts: number }
    | { type: 'error'; content: string; ts: number };
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const streamEndRef = useRef<HTMLDivElement>(null);

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
  const transcriptAbortRef = useRef<AbortController | null>(null);
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
      const draft = chatEditorRef.current.getContent().trim();
      if (draft) {
        sessionDraftsRef.current.set(viewingTranscriptId, draft);
      } else {
        sessionDraftsRef.current.delete(viewingTranscriptId);
      }
    }

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
      }
      setHistoryTranscript(transcriptMessages);
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

  // Poll for live sessions and history updates when chat tab is active
  useEffect(() => {
    if (activeTab !== 'chat') return;

    const fetchLiveSessions = async () => {
      try {
        const res = await fetch('/api/live-sessions');
        if (res.ok) {
          const data = await res.json();
          setLiveSessionIds(new Set(data.liveSessionIds || []));
        }
      } catch (error) {
        console.error('Failed to fetch live sessions:', error);
      }
    };

    fetchLiveSessions();
    const liveInterval = setInterval(fetchLiveSessions, 10000);
    const historyInterval = setInterval(fetchHistory, 30000);
    return () => {
      clearInterval(liveInterval);
      clearInterval(historyInterval);
    };
  }, [activeTab]);

  // Auto-refresh transcript for live sessions
  useEffect(() => {
    if (!viewingTranscriptId || !historyTranscriptProject) return;

    // Check if this transcript's session is live
    if (!liveSessionIds.has(viewingTranscriptId)) return;

    const refreshTranscript = async () => {
      // Don't refresh while the user is sending a message from the transcript
      if (transcriptLoading) return;
      try {
        const res = await fetch(`/api/transcript?sessionId=${encodeURIComponent(viewingTranscriptId!)}&project=${encodeURIComponent(historyTranscriptProject!)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.messages) {
            setHistoryTranscript(data.messages);
          }
        }
      } catch (error) {
        console.error('Failed to refresh transcript:', error);
      }
    };

    const interval = setInterval(refreshTranscript, 5000);
    return () => clearInterval(interval);
  }, [viewingTranscriptId, historyTranscriptProject, liveSessionIds, transcriptLoading]);

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

  // Health check polling - check every 5 seconds when processing
  useEffect(() => {
    const checkHealth = async () => {
      if (!viewingTranscriptId || !transcriptLoading) {
        setIsStuck(false);
        setStuckReason(undefined);
        return;
      }

      try {
        const res = await fetch(`/api/health?sessionId=${viewingTranscriptId}`);
        if (res.ok) {
          const health = await res.json();
          setIsStuck(health.isStuck);
          setStuckReason(health.stuckReason);
        }
      } catch (error) {
        console.error('Health check failed:', error);
      }
    };

    if (transcriptLoading && viewingTranscriptId) {
      // Start health check polling
      healthCheckIntervalRef.current = setInterval(checkHealth, 5000);
      checkHealth(); // Check immediately
    } else {
      // Stop health check polling
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
      }
      setIsStuck(false);
      setStuckReason(undefined);
    }

    return () => {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
    };
  }, [transcriptLoading, viewingTranscriptId]);

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
      const draft = chatEditorRef.current.getContent().trim();
      if (draft) {
        sessionDraftsRef.current.set(viewingTranscriptId, draft);
      } else {
        sessionDraftsRef.current.delete(viewingTranscriptId);
      }
    }

    const newId = generateUUID();
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

    // New session starts with an empty editor
    setTimeout(() => chatEditorRef.current?.setContent(''), 50);
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
          action: 'kill',
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

    // Capture the session this handler belongs to. If the user switches sessions
    // while we're streaming, we skip state updates so we don't contaminate the
    // new session's display. The data still lands in JSONL via the CLI.
    const mySessionId = viewingTranscriptId;
    const myProject = historyTranscriptProject;
    const isStillActive = () => activeSessionRef.current === mySessionId;

    // Clear the draft for this session since the message is being sent
    sessionDraftsRef.current.delete(mySessionId);

    // If this session isn't in the history sidebar yet, add it optimistically
    // so it stays visible even if the user switches to another session.
    if (!history.some(h => h.sessionId === mySessionId)) {
      setHistory(prev => [{
        display: userMessage.length > 200 ? userMessage.substring(0, 200) + '...' : userMessage,
        timestamp: Date.now(),
        project: myProject || '',
        sessionId: mySessionId,
        messageCount: 1,
      }, ...prev]);
    }

    // Add user message to overlay immediately for instant feedback
    setTranscriptOverlayMessages(prev => [...prev, { role: 'user' as const, content: userMessage }]);
    setTimeout(() => scrollTranscriptToBottom(), 50);
    setTranscriptLoading(true);
    setTranscriptStreaming('');
    setStreamEvents([]);

    // Scroll to bottom after loading indicator renders so bouncing dots are visible
    setTimeout(() => scrollTranscriptToBottom(), 150);

    const abortController = new AbortController();
    transcriptAbortRef.current = abortController;

    try {
      // The CLI manages conversation context via --session-id/--resume
      // No need to send conversation history
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          sessionId: mySessionId,
          projectPath: myProject,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No reader available');

      let accumulatedText = '';
      let pendingAskUserQuestion: AskUserQuestionState['input'] | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) {
                accumulatedText += data.text;
                if (isStillActive()) {
                  setTranscriptStreaming(accumulatedText);
                  setStreamEvents(prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.type === 'text') {
                      return [...prev.slice(0, -1), { ...last, content: last.content + data.text }];
                    }
                    return [...prev, { type: 'text', content: data.text, ts: Date.now() }];
                  });
                }
              } else if (data.error) {
                accumulatedText = `Error: ${data.error}`;
                if (isStillActive()) {
                  setTranscriptStreaming(accumulatedText);
                  setStreamEvents(prev => [...prev, { type: 'error', content: data.error, ts: Date.now() }]);
                }
              } else if (data.tool_use) {
                const tool = data.tool_use;
                if (isStillActive()) {
                  if (tool.status === 'starting') {
                    setStreamEvents(prev => [...prev, { type: 'tool_start', name: tool.name, ts: Date.now() }]);
                  } else if (tool.status === 'complete') {
                    setStreamEvents(prev => [...prev, { type: 'tool_complete', name: tool.name, input: tool.input, ts: Date.now() }]);
                  }
                }
                // Capture AskUserQuestion regardless of active state
                if (tool.status === 'complete' && tool.name === 'AskUserQuestion' && tool.input?.questions) {
                  pendingAskUserQuestion = tool.input as AskUserQuestionState['input'];
                }
              } else if (data.tool_result) {
                if (isStillActive()) {
                  setStreamEvents(prev => [...prev, { type: 'tool_result', preview: data.tool_result.preview, ts: Date.now() }]);
                }
              }
            } catch (e) {
              // skip unparseable
            }
          }
        }
      }

      // If user switched away, skip all post-completion state updates.
      // The data is in JSONL — fetchTranscript will pick it up when they switch back.
      if (!isStillActive()) return;

      // If AskUserQuestion was detected, save text and open the dialog
      if (pendingAskUserQuestion) {
        if (accumulatedText) {
          setTranscriptOverlayMessages(prev => [...prev, { role: 'assistant' as const, content: accumulatedText }]);
          setTranscriptStreaming('');
        }
        setAskUserQuestion({ input: pendingAskUserQuestion });
        return; // finally block will clean up transcriptLoading
      }

      if (accumulatedText) {
        setTranscriptOverlayMessages(prev => [...prev, { role: 'assistant' as const, content: accumulatedText }]);
        setTranscriptStreaming('');

        // Re-fetch the transcript from JSONL to sync with CLI's authoritative record.
        // This clears overlay messages since they're now in the JSONL.
        try {
          const refreshRes = await fetch(
            `/api/transcript?sessionId=${encodeURIComponent(mySessionId)}&project=${encodeURIComponent(myProject || '')}`
          );
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.messages && refreshData.messages.length > 0 && isStillActive()) {
              setHistoryTranscript(refreshData.messages);
              setTranscriptOverlayMessages([]);
              setOverlayInsertPoint(null);
            }
          }
        } catch {
          // Overlay stays until next auto-refresh
        }
      }
    } catch (error) {
      if (isStillActive()) {
        if (error instanceof Error && error.name === 'AbortError') {
          setTranscriptOverlayMessages(prev => [...prev, { role: 'assistant' as const, content: '_Processing stopped by user._' }]);
        } else {
          const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
          setTranscriptOverlayMessages(prev => [...prev, { role: 'assistant' as const, content: errorMessage }]);
        }
      }
    } finally {
      if (isStillActive()) {
        setTranscriptLoading(false);
      }
      // Only clear the abort ref if it's still ours (not overwritten by a new session)
      if (transcriptAbortRef.current === abortController) {
        transcriptAbortRef.current = null;
      }
    }
  };

  const handleRewind = async (mode: 'conversation' | 'both') => {
    if (!viewingTranscriptId || !historyTranscriptProject || !rewindConfirm) return;

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

        const abortController = new AbortController();
        transcriptAbortRef.current = abortController;

        try {
          const res = await fetch('/api/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: `Undo all file changes you made starting from the message shown below. Restore every modified file to its state before that point. Do not explain, just revert the files.\n\nMessage to rewind to (${rewindConfirm.timestamp ? new Date(rewindConfirm.timestamp).toISOString() : 'unknown time'}):\n> ${rewindConfirm.userMessage}`,
              sessionId: viewingTranscriptId,
              projectPath: historyTranscriptProject,
            }),
            signal: abortController.signal,
          });

          if (res.ok) {
            const reader = res.body?.getReader();
            if (reader) {
              const decoder = new TextDecoder();
              let accumulatedText = '';
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                for (const line of chunk.split('\n')) {
                  if (line.startsWith('data: ')) {
                    try {
                      const data = JSON.parse(line.slice(6));
                      if (data.text) {
                        accumulatedText += data.text;
                        setTranscriptStreaming(accumulatedText);
                      } else if (data.tool_use) {
                        const tool = data.tool_use;
                        if (tool.status === 'starting') {
                          setStreamEvents(prev => [...prev, { type: 'tool_start', name: tool.name, ts: Date.now() }]);
                        } else if (tool.status === 'complete') {
                          setStreamEvents(prev => [...prev, { type: 'tool_complete', name: tool.name, input: tool.input, ts: Date.now() }]);
                        }
                      } else if (data.tool_result) {
                        setStreamEvents(prev => [...prev, { type: 'tool_result', preview: data.tool_result.preview, ts: Date.now() }]);
                      }
                    } catch { /* skip */ }
                  }
                }
              }
            }
          }
        } finally {
          transcriptAbortRef.current = null;
        }
      }

      // Step 2: Truncate the JSONL (removes original turns + the undo prompt)
      const res = await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: viewingTranscriptId,
          project: historyTranscriptProject,
          turnIndex,
          removeLastHistoryEntry: mode === 'both',
        }),
      });

      if (!res.ok) throw new Error(`Rewind failed: ${res.status}`);

      // Step 3: Reload transcript from the truncated JSONL
      const refreshRes = await fetch(
        `/api/transcript?sessionId=${encodeURIComponent(viewingTranscriptId)}&project=${encodeURIComponent(historyTranscriptProject)}`
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

  const handleTranscriptStop = () => {
    if (transcriptAbortRef.current) {
      transcriptAbortRef.current.abort();
      transcriptAbortRef.current = null;
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
                {/* New Session indicator (before it appears in history) */}
                {viewingTranscriptId && !history.some(h => h.sessionId === viewingTranscriptId) && (
                  <div className="mb-2 p-3 rounded border bg-primary/10 border-primary cursor-pointer">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm font-medium text-foreground">New Session</span>
                      {transcriptLoading && (
                        <div className="flex items-center gap-0.5 ml-1">
                          <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                          <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                          <div className="dot w-1.5 h-1.5 bg-primary rounded-full"></div>
                        </div>
                      )}
                    </div>
                    {historyTranscriptProject && (
                      <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={historyTranscriptProject}>
                        {historyTranscriptProject}
                      </div>
                    )}
                  </div>
                )}

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
                        <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
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
                                  <div className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-blue-900 text-white border-blue-700">
                                    <div className="text-xs opacity-70 mb-1">You</div>
                                    <div className="whitespace-pre-wrap break-words text-sm">
                                      {turn.user.content}
                                    </div>
                                  </div>
                                </div>
                              )}
                              {turn.assistant && (
                                <div className="flex justify-start">
                                  <div className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-muted text-foreground border-border transition-colors">
                                    <div className="text-xs opacity-70 mb-1 flex items-center gap-2">
                                      Claude
                                      {turn.intermediaries.length > 0 && (
                                        <span
                                          className="text-[10px] text-muted-foreground bg-background border border-border rounded px-1.5 py-0.5 cursor-pointer hover:border-ring hover:text-foreground transition-colors"
                                          onClick={() => setIntermediaryMessages(turn.intermediaries)}
                                        >
                                          +{turn.intermediaries.length} intermediary
                                        </span>
                                      )}
                                    </div>
                                    <div className="prose-chat max-w-none">
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        rehypePlugins={[rehypeHighlight]}
                                      >
                                        {turn.assistant.content}
                                      </ReactMarkdown>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ));
                        })()}

                        {/* Streaming message */}
                        {transcriptStreaming && (
                          <div className="flex justify-start">
                            <div className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-muted text-foreground border border-border">
                              <div className="text-xs opacity-70 mb-1">Claude</div>
                              <div className="prose-chat max-w-none">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                  {transcriptStreaming}
                                </ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Loading indicator */}
                        {transcriptLoading && !transcriptStreaming && (
                          <div className="flex justify-start">
                            <div className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-muted text-foreground border border-border">
                              <div className="text-xs opacity-70 mb-1">Claude</div>
                              <div className="flex items-center gap-1 py-2">
                                <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                                <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                              </div>
                            </div>
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

              {/* Files View */}
              {rightPanelView === 'files' && (
                <div className="flex-1 overflow-hidden">
                  <FileTree projectPath={historyTranscriptProject} onFileDoubleClick={handleFileDoubleClick} />
                </div>
              )}

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
                      return (
                        <div key={i} className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2">
                          <span className="text-yellow-500">{'▶'}</span>
                          <span className="text-primary font-semibold">{evt.name}</span>
                          <span className="text-muted-foreground">starting...</span>
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
      <CodeViewerDialog filePath={codeViewerPath} onClose={() => setCodeViewerPath(null)} />

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
                      rehypePlugins={[rehypeHighlight]}
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
