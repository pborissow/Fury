'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Dialog from '@/components/Dialog';
import ChatBubble from '@/components/ChatBubble';
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
      maximizable
    >
      <div className="-mx-4 -mt-4 px-4 pt-2 pb-1 mb-4 text-sm text-muted-foreground border-b border-border">
        {messages.length} intermediary message{messages.length !== 1 ? 's' : ''}
      </div>
      <div className="space-y-4">
        {messages.map((msg, i) => {
          // A user's AskUserQuestion answer is surfaced here too — render it as a
          // right-aligned "You" bubble to match the main transcript, rather than
          // mislabeling every entry "Claude".
          const isUser = msg.role === 'user';
          // ChatBubble (same as the main transcript) supplies the header label and
          // the hover copy button; classes match TranscriptRenderer's bubbles.
          return (
            <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <ChatBubble
                label={isUser ? 'You' : 'Claude'}
                className={`max-w-[85%] rounded-lg pl-4 pr-2 py-2 border ${
                  isUser
                    ? 'bg-blue-900 text-white border-blue-700'
                    : 'bg-muted text-foreground border-border'
                }`}
                rawContent={msg.content}
                isMarkdown
              >
                <div className={`prose-chat max-w-none${isUser ? ' prose-invert' : ''}`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    components={{ pre: CopyableCodeBlock }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </ChatBubble>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
