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

    const html = isMarkdown ? el.innerHTML : textToHtml(rawContent);

    // Ctrl+Click: copy rendered HTML (for apps that don't support markdown)
    // Normal click: copy markdown as plain text + HTML for TipTap paste
    const copyHtmlOnly = e.ctrlKey || e.metaKey;
    const text = copyHtmlOnly ? html : rawContent;

    // Try the modern Clipboard API first (requires secure context: https or localhost)
    if (navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Fall through to legacy approach
      }
    }

    // Legacy fallback: works on insecure origins (plain HTTP over LAN, etc.)
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
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
          title="Copy to clipboard (Ctrl+Click for HTML)"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 opacity-70" />
          )}
        </button>
      </div>
      <div ref={contentRef} className="overflow-x-auto">{children}</div>
    </div>
  );
};

export default ChatBubble;
