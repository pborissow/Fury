'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Dialog from '@/components/Dialog';
import CopyableCodeBlock from '@/components/CopyableCodeBlock';
import type { TranscriptMsg } from '@/lib/types';

interface IntermediaryMessagesDialogProps {
  messages: TranscriptMsg[];
  onClose: () => void;
}

export default function IntermediaryMessagesDialog({ messages, onClose }: IntermediaryMessagesDialogProps) {
  return (
    <Dialog
      open={messages.length > 0}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Intermediary Messages"
      defaultWidth={720}
      defaultHeight={500}
      minWidth={400}
      minHeight={300}
    >
      <div className="-mx-4 -mt-4 px-4 pt-2 pb-1 mb-4 text-sm text-muted-foreground border-b border-border">
        {messages.length} intermediary response{messages.length !== 1 ? 's' : ''} before the final output
      </div>
      <div className="space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className="flex justify-start">
            <div className="max-w-[85%] rounded-lg pl-4 pr-2 py-2 border bg-muted text-foreground border-border">
              <div className="text-xs opacity-70 mb-1">Claude</div>
              <div className="prose-chat max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                  components={{ pre: CopyableCodeBlock }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
