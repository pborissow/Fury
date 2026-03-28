'use client';

import { useState, useRef } from 'react';
import { Copy, Check } from 'lucide-react';

// Convert plain text to HTML paragraphs so TipTap can parse line breaks
export const textToHtml = (text: string) =>
  text.split('\n').map(line => `<p>${line || '<br>'}</p>`).join('');

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

export default ChatBubble;
