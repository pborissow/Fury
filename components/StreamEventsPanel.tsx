'use client';

import { useRef, useEffect } from 'react';

export type StreamEvent =
  | { type: 'tool_start'; name: string; ts: number }
  | { type: 'tool_complete'; name: string; input?: any; ts: number }
  | { type: 'tool_result'; preview: string; ts: number }
  | { type: 'text'; content: string; ts: number }
  | { type: 'error'; content: string; ts: number };

interface StreamEventsPanelProps {
  streamEvents: StreamEvent[];
  transcriptLoading: boolean;
}

export default function StreamEventsPanel({ streamEvents, transcriptLoading }: StreamEventsPanelProps) {
  const streamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamEvents]);

  return (
    <div className="flex-1 overflow-y-auto font-mono text-xs">
      {streamEvents.length === 0 && !transcriptLoading && (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          No stream activity. Send a message to see real-time events.
        </div>
      )}
      {streamEvents.map((evt, i) => {
        if (evt.type === 'tool_start') {
          const hasComplete = streamEvents.slice(i + 1).some(
            e => e.type === 'tool_complete' && e.name === evt.name
          );
          if (hasComplete) return null;
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
  );
}
