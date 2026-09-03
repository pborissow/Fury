'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { RotateCcw, Volume2, VolumeX, Loader2, ImageOff } from 'lucide-react';
import ChatBubble from '@/components/ChatBubble';
import CopyableCodeBlock from '@/components/CopyableCodeBlock';
import ImageViewerDialog from '@/components/ImageViewerDialog';
import type { TranscriptMsg, TranscriptImagePart } from '@/lib/types';

const ExternalLink = ({ node: _node, ...props }: any) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

const assistantMarkdownComponents = {
  pre: CopyableCodeBlock,
  a: ExternalLink,
};

/**
 * One attached image in a transcript bubble. Renders inline (dataUrl), from the
 * per-session store (hash → /api/images/<sessionId>/<hash>), or as a graceful
 * placeholder chip (ephemerally-scrubbed image, or a persisted image whose
 * bytes were purged on archive → 404). A store image that 404s falls back to
 * the same placeholder.
 */
/** Resolvable source for an image part, or null (placeholder / purged). */
function srcForPart(part: TranscriptImagePart, sessionId?: string): string | null {
  if (part.placeholder) return null;
  if (part.dataUrl) return part.dataUrl;
  if (part.hash && sessionId) {
    return `/api/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(part.hash)}`;
  }
  return null;
}

function ImageThumb({ part, sessionId, onOpen }: {
  part: TranscriptImagePart;
  sessionId?: string;
  /** Open the full-size viewer on this thumbnail (index handled by the parent). */
  onOpen?: () => void;
}) {
  const [errored, setErrored] = useState(false);

  const src = srcForPart(part, sessionId);

  if (!src || errored) {
    return (
      <div
        className="flex items-center gap-1.5 h-16 px-3 rounded border border-dashed border-border bg-background/40 text-xs text-muted-foreground"
        title="Image no longer available"
      >
        <ImageOff className="h-3.5 w-3.5" />
        <span>image</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen?.()}
      className="cursor-zoom-in rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:brightness-110 transition-[filter]"
      title="Click to view full size"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="attachment"
        className="max-h-64 max-w-[240px] rounded border border-border object-contain"
        onError={() => setErrored(true)}
      />
    </button>
  );
}

/** What a click on a bubble thumbnail opens: the bubble's resolvable sources
 *  (the viewer's carousel set) and which one was clicked. */
export interface ImageViewerTarget {
  sources: string[];
  index: number;
}

function ImageParts({ images, sessionId, onOpen }: {
  images?: TranscriptImagePart[];
  sessionId?: string;
  onOpen?: (target: ImageViewerTarget) => void;
}) {
  if (!images || images.length === 0) return null;
  // The carousel cycles this bubble's RESOLVABLE images; placeholder chips
  // (scrubbed/purged) render but aren't part of the set.
  const sources = images
    .map(part => srcForPart(part, sessionId))
    .filter((s): s is string => s !== null);
  return (
    <div className="flex flex-wrap gap-2 mt-2" data-testid="bubble-images">
      {images.map((part, idx) => {
        const src = srcForPart(part, sessionId);
        return (
          <ImageThumb
            key={idx}
            part={part}
            sessionId={sessionId}
            onOpen={src ? () => onOpen?.({ sources, index: sources.indexOf(src) }) : undefined}
          />
        );
      })}
    </div>
  );
}

interface TranscriptRendererProps {
  historyTranscript: TranscriptMsg[];
  transcriptOverlayMessages: { role: 'user' | 'assistant'; content: string; images?: TranscriptImagePart[] }[];
  overlayInsertPoint: number | null;
  /** Session in view — used to build /api/images/<sessionId>/<hash> URLs. */
  sessionId?: string;
  transcriptLoading: boolean;
  onRewindConfirm: (info: { turnIndex: number; userMessage: string; fullMessage: string; timestamp: string; uuid?: string }) => void;
  onIntermediaryView: (messages: TranscriptMsg[]) => void;
  ttsEnabled?: boolean;
  ttsPlaying?: 'loading' | 'playing' | 'paused' | 'idle';
  onTtsToggle?: () => void;
  onTtsCancel?: () => void;
  lastAssistantRef?: React.RefObject<HTMLDivElement | null>;
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
  lastAssistantRef,
  sessionId,
}: TranscriptRendererProps) {
  // Full-size viewer for a clicked thumbnail. One instance for the whole
  // transcript; holds the clicked bubble's resolvable sources (the carousel
  // set) and which one was clicked.
  const [viewerTarget, setViewerTarget] = useState<ImageViewerTarget | null>(null);

  // Merge overlay messages into transcript at the correct chronological position
  const overlayAsTranscript: TranscriptMsg[] = transcriptOverlayMessages.map(m => ({
    role: m.role, content: m.content, timestamp: '', images: m.images,
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
                  data-testid={`rewind-turn-${i}`}
                  onClick={() => onRewindConfirm({
                    turnIndex: i,
                    userMessage: turn.user!.content.length > 80
                      ? turn.user!.content.substring(0, 80) + '...'
                      : turn.user!.content,
                    fullMessage: turn.user!.content,
                    timestamp: turn.user!.timestamp,
                    uuid: turn.user!.uuid,
                  })}
                  className="opacity-0 group-hover/rewind:opacity-100 transition-opacity mr-2 p-1 rounded hover:bg-muted"
                  title="Rewind to before this message"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
              <ChatBubble label="You" className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-blue-900 text-white border-blue-700" rawContent={turn.user.content} isMarkdown>
                {turn.user.content && (
                  <div className="prose-chat prose-invert max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                      components={{ pre: CopyableCodeBlock }}
                    >
                      {turn.user.content}
                    </ReactMarkdown>
                  </div>
                )}
                <ImageParts images={turn.user.images} sessionId={sessionId} onOpen={setViewerTarget} />
              </ChatBubble>
            </div>
          )}
          {turn.assistant && (
            <div className="flex justify-start" data-testid="claude-turn" ref={i === lastAssistantTurnIndex ? lastAssistantRef : undefined}>
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
                    components={assistantMarkdownComponents}
                  >
                    {turn.assistant.content}
                  </ReactMarkdown>
                </div>
              </ChatBubble>
            </div>
          )}
        </div>
      ))}
      <ImageViewerDialog
        images={viewerTarget?.sources ?? null}
        initialIndex={viewerTarget?.index ?? 0}
        onClose={() => setViewerTarget(null)}
      />
    </>
  );
}
