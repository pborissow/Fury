'use client';

import { useState, useRef } from 'react';
import { Copy, Check } from 'lucide-react';

const CopyableCodeBlock = ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = preRef.current?.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code block:', err);
    }
  };

  return (
    <div className="relative group/code">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity p-1 rounded bg-background/80 hover:bg-background border border-border"
        title="Copy code"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  );
};

export default CopyableCodeBlock;
