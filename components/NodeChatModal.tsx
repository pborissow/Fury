'use client';

import { useState, useRef, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Dialog from '@/components/Dialog';
import { Button } from '@/components/ui/button';
import RichTextEditor from '@/components/RichTextEditor';
import { DirectoryPicker } from '@/components/DirectoryPicker';
import { getRecentDirectories } from '@/lib/recent-directories';
import AskUserQuestionDialog from '@/components/AskUserQuestionDialog';
import type { Message } from '@/lib/types';

interface NodeChatSession {
  workingDirectory: string;
  messages: Message[];
}

interface NodeChatModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string | null;
  initialSession: NodeChatSession | null;
  onSessionUpdate: (nodeId: string, session: NodeChatSession) => void;
}

export default function NodeChatModal({
  open,
  onOpenChange,
  nodeId,
  initialSession,
  onSessionUpdate,
}: NodeChatModalProps) {
  const [session, setSession] = useState<NodeChatSession | null>(initialSession);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [toolActivity, setToolActivity] = useState<string>('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);
  const [askUserQuestion, setAskUserQuestion] = useState<{ questions: any[] } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userMessageRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Update session when initialSession changes
  useEffect(() => {
    setSession(initialSession);
  }, [initialSession]);

  // Load recent directories and show directory picker if no session exists
  useEffect(() => {
    const loadAndShowDirectoryPicker = async () => {
      if (!open) return;

      try {
        // Load sessions from localStorage (where projectPath is stored)
        const storedSessions = localStorage.getItem('claude-sessions');
        let sessions: any[] = [];
        if (storedSessions) {
          try {
            sessions = JSON.parse(storedSessions);
          } catch (e) {
            console.error('Failed to parse stored sessions:', e);
          }
        }

        // Load workflows
        const workflowsRes = await fetch('/api/workflows');
        const workflowsData = await workflowsRes.json();
        const workflows = workflowsData.workflows || [];

        // Extract and combine directories
        const directories = getRecentDirectories(sessions, workflows);
        setRecentDirectories(directories);

        console.log('[NodeChatModal] Loaded recent directories:', directories);

        // Show directory picker if no session exists (after loading directories)
        if (!session) {
          setShowDirectoryPicker(true);
        }
      } catch (error) {
        console.error('Failed to load recent directories:', error);
        // Show directory picker anyway even if loading failed
        if (!session) {
          setShowDirectoryPicker(true);
        }
      }
    };

    loadAndShowDirectoryPicker();
  }, [open, session]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const checkScrollPosition = () => {
    if (messagesContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      setIsNearBottom(distanceFromBottom < 100);
    }
  };

  useEffect(() => {
    if (streamingMessage && isNearBottom) {
      scrollToBottom();
    }
  }, [streamingMessage, isNearBottom]);

  const handleDirectorySelected = (path: string) => {
    const newSession: NodeChatSession = {
      workingDirectory: path,
      messages: [],
    };
    setSession(newSession);
    setShowDirectoryPicker(false);

    if (nodeId) {
      onSessionUpdate(nodeId, newSession);
    }
  };

  const handleStop = async () => {
    // Abort the client-side fetch stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Also kill the server-side Claude CLI process so it stops executing
    if (nodeId) {
      try {
        await fetch('/api/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: `node-${nodeId}`, action: 'stop' }),
        });
      } catch (error) {
        console.error('[NodeChatModal] Failed to stop server process:', error);
      }
    }
    setIsLoading(false);
    setToolActivity('');
    // Don't clear streamingMessage here — let the AbortError handler
    // in handleSend preserve the partial text
  };

  const handleSend = async (userMessage: string) => {
    if (!userMessage || isLoading || !session || !nodeId) return;

    // Add user message to session
    const updatedMessages = [...session.messages, { role: 'user' as const, content: userMessage }];
    const updatedSession = { ...session, messages: updatedMessages };
    setSession(updatedSession);

    // Scroll user message to top after a short delay
    setTimeout(() => {
      scrollToBottom();
    }, 100);

    setIsLoading(true);
    setStreamingMessage('');

    // Create new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Hoisted so the catch block can access partial text on abort
    let accumulatedText = '';

    try {
      // Generate a temporary session ID for this node
      const sessionId = `node-${nodeId}`;

      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: userMessage,
          sessionId,
          conversationHistory: session.messages,
          projectPath: session.workingDirectory,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No reader available');
      }

      let pendingAskUserQuestion: { questions: any[] } | null = null;

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
                setStreamingMessage(accumulatedText);
              } else if (data.error) {
                accumulatedText = `Error: ${data.error}`;
                setStreamingMessage(accumulatedText);
              } else if (data.tool_use) {
                const tool = data.tool_use;
                if (tool.status === 'starting') {
                  setToolActivity(`Using ${tool.name}...`);
                } else if (tool.status === 'complete') {
                  setToolActivity(`Used ${tool.name}`);

                  if (tool.name === 'AskUserQuestion' && tool.input?.questions) {
                    pendingAskUserQuestion = tool.input;
                  }
                }
              } else if (data.tool_result) {
                setToolActivity('');
              }
            } catch (e) {
              console.error('Failed to parse chunk:', e);
            }
          }
        }
      }

      // If AskUserQuestion was detected, save text and open the dialog
      if (pendingAskUserQuestion) {
        if (accumulatedText) {
          const finalMessages = [...updatedMessages, { role: 'assistant' as const, content: accumulatedText }];
          const finalSession = { ...session, messages: finalMessages };
          setSession(finalSession);
          setStreamingMessage('');
          if (nodeId) onSessionUpdate(nodeId, finalSession);
        }
        setAskUserQuestion(pendingAskUserQuestion);
        return; // finally block will clean up isLoading
      }

      // Add complete assistant message
      if (accumulatedText) {
        const finalMessages = [...updatedMessages, { role: 'assistant' as const, content: accumulatedText }];
        const finalSession = { ...session, messages: finalMessages };
        setSession(finalSession);
        setStreamingMessage('');

        // Save updated session
        if (nodeId) {
          onSessionUpdate(nodeId, finalSession);
        }

        setTimeout(() => {
          scrollToBottom();
        }, 100);
      }
    } catch (error) {
      // Check if the error is due to abort
      if (error instanceof Error && error.name === 'AbortError') {
        // Preserve any partial response that was streamed before the abort
        const partialText = accumulatedText || '';
        const stoppedContent = partialText
          ? partialText + '\n\n_— Processing stopped by user._'
          : '_Processing stopped by user._';
        const abortedMessages = [...updatedMessages, { role: 'assistant' as const, content: stoppedContent }];
        const abortedSession = { ...session, messages: abortedMessages };
        setSession(abortedSession);
        setStreamingMessage('');
        if (nodeId) {
          onSessionUpdate(nodeId, abortedSession);
        }
      } else {
        const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        const errorMessages = [...updatedMessages, { role: 'assistant' as const, content: errorMessage }];
        const errorSession = { ...session, messages: errorMessages };
        setSession(errorSession);
        if (nodeId) {
          onSessionUpdate(nodeId, errorSession);
        }
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleAskUserQuestionResponse = (answers: string) => {
    setAskUserQuestion(null);
    if (answers.trim()) handleSend(answers);
  };

  const handleClose = () => {
    handleStop();
    onOpenChange(false);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => { if (!o) handleClose(); }}
        title={
          <>
            Node Chat Session
            {session && (
              <span className="text-xs text-muted-foreground font-normal font-mono ml-3">
                {session.workingDirectory}
              </span>
            )}
          </>
        }
        defaultWidth={896}
        defaultHeight={600}
        minWidth={600}
        minHeight={400}
      >
        {/* Chat Interface */}
        {session && (
          <div className="flex-1 overflow-hidden">
            <PanelGroup direction="vertical">
              {/* Messages Area Panel */}
              <Panel defaultSize={70} minSize={30}>
                <div
                  ref={messagesContainerRef}
                  className="h-full overflow-y-auto p-4 space-y-4"
                  onScroll={checkScrollPosition}
                >
                  {session.messages.length === 0 && !streamingMessage && (
                    <div className="text-center text-muted-foreground mt-8">
                      Start a conversation with Claude
                    </div>
                  )}

                  {session.messages.map((message, index) => (
                    <div
                      key={index}
                      ref={index === session.messages.length - 1 && message.role === 'user' ? userMessageRef : null}
                      className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-lg pl-4 pr-2 py-2 border ${
                          message.role === 'user'
                            ? 'bg-blue-900 text-white border-blue-700'
                            : 'bg-muted text-foreground border-border'
                        }`}
                      >
                        <div className="text-xs opacity-70 mb-1">
                          {message.role === 'user' ? 'You' : 'Claude'}
                        </div>
                        {message.role === 'assistant' ? (
                          <div className="prose-chat max-w-none">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeHighlight]}
                            >
                              {message.content}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <div className="whitespace-pre-wrap break-words text-sm">
                            {message.content}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Streaming message */}
                  {streamingMessage && (
                    <div className="flex justify-start">
                      <div className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-muted text-foreground border border-border">
                        <div className="text-xs opacity-70 mb-1">Claude</div>
                        <div className="prose-chat max-w-none">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                          >
                            {streamingMessage}
                          </ReactMarkdown>
                        </div>
                        {toolActivity && (
                          <div className="text-xs text-primary mt-2 italic">
                            {toolActivity}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Loading indicator */}
                  {isLoading && !streamingMessage && (
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

                  <div ref={messagesEndRef} />
                </div>
              </Panel>

              <PanelResizeHandle className="h-2 bg-border hover:bg-primary transition-colors" />

              {/* Input Area Panel */}
              <Panel defaultSize={30} minSize={20}>
                <div className="h-full p-4 flex flex-col overflow-hidden">
                  <div className="flex-1 min-h-0">
                    <RichTextEditor
                      onSubmit={handleSend}
                      placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                      disabled={!session}
                      submitLabel={isLoading ? 'Sending...' : 'Send'}
                      isProcessing={isLoading}
                      onStop={handleStop}
                    />
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </div>
        )}
      </Dialog>

      {/* Directory Picker Dialog */}
      <DirectoryPicker
        open={showDirectoryPicker}
        onOpenChange={(open) => {
          setShowDirectoryPicker(open);
          // If directory picker is closed without selecting a directory and we have no session,
          // close the main modal too
          if (!open && !session) {
            onOpenChange(false);
          }
        }}
        onSelect={handleDirectorySelected}
        recentDirectories={recentDirectories}
      />

      {askUserQuestion && (
        <AskUserQuestionDialog
          open={true}
          questions={askUserQuestion.questions}
          onSubmit={handleAskUserQuestionResponse}
          onSkip={() => setAskUserQuestion(null)}
        />
      )}
    </>
  );
}
