'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { RotateCcw, Volume2, VolumeX, Loader2 } from 'lucide-react';
import ChatBubble from '@/components/ChatBubble';
import CopyableCodeBlock from '@/components/CopyableCodeBlock';
import type { TranscriptMsg } from '@/lib/types';

interface TranscriptRendererProps {
  historyTranscript: TranscriptMsg[];
  transcriptOverlayMessages: { role: 'user' | 'assistant'; content: string }[];
  overlayInsertPoint: number | null;
  transcriptLoading: boolean;
  onRewindConfirm: (info: { turnIndex: number; userMessage: string; fullMessage: string; timestamp: string }) => void;
  onIntermediaryView: (messages: TranscriptMsg[]) => void;
  ttsEnabled?: boolean;
  ttsPlaying?: 'loading' | 'playing' | 'paused' | 'idle';
  onTtsToggle?: () => void;
  onTtsCancel?: () => void;
}

export default function TranscriptRenderer({
  historyTranscript,
  transcriptOverlayMessages,
  overlayInsertPoint,
  transcriptLoading,
  onRewindConfirm,
  onIntermediaryView,
  ttsEnabled,
  ttsPlaying,
  onTtsToggle,
  onTtsCancel,
}: TranscriptRendererProps) {
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

  // Find the last turn that has an assistant response (for TTS button placement)
  let lastAssistantTurnIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].assistant) { lastAssistantTurnIndex = i; break; }
  }

  return (
    <>
      {turns.map((turn, i) => (
        <div key={`turn-${i}`} className="space-y-3">
          {turn.user && (
            <div className="flex justify-end items-center group/rewind">
              {i > 0 && !transcriptLoading && (
                <button
                  onClick={() => onRewindConfirm({
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
              <ChatBubble label="You" className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-blue-900 text-white border-blue-700" rawContent={turn.user.content} isMarkdown>
                <div className="prose-chat prose-invert max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    components={{ pre: CopyableCodeBlock }}
                  >
                    {turn.user.content}
                  </ReactMarkdown>
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
                headerExtra={<>
                  {ttsEnabled && i === lastAssistantTurnIndex && (
                    ttsPlaying === 'loading' ? (
                      <button
                        onClick={onTtsCancel}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Cancel audio generation"
                      >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      </button>
                    ) : (
                      <button
                        onClick={onTtsToggle}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title={ttsPlaying === 'playing' ? 'Stop audio' : 'Play audio'}
                      >
                        {ttsPlaying === 'playing'
                          ? <Volume2 className="h-3.5 w-3.5" />
                          : <VolumeX className="h-3.5 w-3.5" />
                        }
                      </button>
                    )
                  )}
                  {turn.intermediaries.length > 0 && (
                    <span
                      className="text-[10px] text-muted-foreground bg-background border border-border rounded px-1.5 py-0.5 cursor-pointer hover:border-ring hover:text-foreground transition-colors"
                      onClick={() => onIntermediaryView(turn.intermediaries)}
                    >
                      +{turn.intermediaries.length} intermediary
                    </span>
                  )}
                </>}
              >
                <div className="prose-chat max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    components={{ pre: CopyableCodeBlock }}
                  >
                    {turn.assistant.content}
                  </ReactMarkdown>
                </div>
              </ChatBubble>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
