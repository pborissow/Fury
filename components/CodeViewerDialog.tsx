'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, GripHorizontal, XIcon } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Resizable } from 're-resizable';
import hljs from 'highlight.js';

// File extensions that should open in the code viewer
const CODE_EXTENSIONS = new Set([
  // JavaScript / TypeScript
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  // Python
  'py', 'pyw',
  // Java / JVM
  'java', 'kt', 'kts', 'scala', 'groovy',
  // C / C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  // C#
  'cs',
  // Go
  'go',
  // Rust
  'rs',
  // Ruby
  'rb',
  // PHP
  'php',
  // Swift / Objective-C
  'swift', 'm',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Config / Data
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  // Markup / Docs
  'md', 'mdx', 'rst', 'tex',
  // Database
  'sql',
  // DevOps / Infra
  'dockerfile', 'tf', 'hcl',
  // Other
  'r', 'lua', 'vim', 'el', 'ex', 'exs', 'erl', 'hs',
  'ml', 'clj', 'cljs', 'dart', 'zig', 'nim', 'v',
  'graphql', 'gql', 'proto', 'prisma',
  'env', 'gitignore', 'editorconfig',
  'csv', 'tsv', 'log', 'txt',
  'makefile',
]);

// Special filenames (no extension) that count as code
const CODE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'Vagrantfile', 'Gemfile',
  'Rakefile', 'Procfile', '.gitignore', '.dockerignore',
  '.editorconfig', '.env', '.env.local', '.env.example',
]);

// Map extensions to highlight.js language names where they differ
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  'js': 'javascript',
  'jsx': 'javascript',
  'ts': 'typescript',
  'tsx': 'typescript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'py': 'python',
  'pyw': 'python',
  'rb': 'ruby',
  'rs': 'rust',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'sh': 'bash',
  'zsh': 'bash',
  'fish': 'bash',
  'ps1': 'powershell',
  'bat': 'dos',
  'cmd': 'dos',
  'yml': 'yaml',
  'htm': 'html',
  'md': 'markdown',
  'mdx': 'markdown',
  'ex': 'elixir',
  'exs': 'elixir',
  'erl': 'erlang',
  'hs': 'haskell',
  'ml': 'ocaml',
  'clj': 'clojure',
  'cljs': 'clojure',
  'tf': 'hcl',
  'gql': 'graphql',
  'txt': 'plaintext',
  'log': 'plaintext',
  'csv': 'plaintext',
  'tsv': 'plaintext',
};

export function isCodeFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  if (CODE_FILENAMES.has(fileName)) return true;
  const ext = lowerName.split('.').pop();
  if (ext && CODE_EXTENSIONS.has(ext)) return true;
  return false;
}

function getLanguage(fileName: string): string | undefined {
  const ext = fileName.toLowerCase().split('.').pop();
  if (!ext) return undefined;
  return EXTENSION_TO_LANGUAGE[ext] || ext;
}

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

interface CodeViewerDialogProps {
  filePath: string | null;
  onClose: () => void;
}

export default function CodeViewerDialog({ filePath, onClose }: CodeViewerDialogProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  // Drag state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const fileName = filePath ? filePath.replace(/\\/g, '/').split('/').pop() || '' : '';

  // Reset position when a new file is opened
  useEffect(() => {
    if (filePath) {
      setPosition({ x: 0, y: 0 });
    }
  }, [filePath]);

  useEffect(() => {
    if (!filePath) {
      setContent(null);
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);
      setContent(null);

      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to read file');
        }

        setContent(data.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  }, [filePath]);

  // Highlight content using the programmatic API
  const highlightedHtml = useMemo(() => {
    if (content === null) return '';
    const lang = getLanguage(fileName);
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    return hljs.highlightAuto(content).value;
  }, [content, fileName]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    // Only drag from the header area itself, not buttons
    if ((e.target as HTMLElement).closest('button')) return;

    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
  }, [position]);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition({
      x: dragRef.current.originX + dx,
      y: dragRef.current.originY + dy,
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const lines = content?.split('\n') || [];

  return (
    <DialogPrimitive.Root open={filePath !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed z-50 focus:outline-none"
          style={{
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Resizable
            defaultSize={{ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }}
            minWidth={MIN_WIDTH}
            minHeight={MIN_HEIGHT}
            maxWidth="95vw"
            maxHeight="95vh"
            className="bg-background rounded-lg border shadow-lg flex flex-col overflow-hidden"
            handleStyles={{
              right: { cursor: 'ew-resize' },
              bottom: { cursor: 'ns-resize' },
              bottomRight: { cursor: 'nwse-resize' },
            }}
            enable={{
              top: false,
              topRight: false,
              topLeft: false,
              left: false,
              right: true,
              bottom: true,
              bottomRight: true,
              bottomLeft: false,
            }}
          >
            {/* Draggable header */}
            <div
              className="flex items-center gap-2 px-4 py-3 border-b shrink-0 cursor-grab active:cursor-grabbing select-none"
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
            >
              <GripHorizontal className="h-4 w-4 text-muted-foreground/50 shrink-0" />
              <DialogPrimitive.Title className="font-mono text-sm font-semibold truncate flex-1">
                {fileName}
                <span className="text-muted-foreground font-normal ml-3 text-xs">
                  {filePath}
                </span>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="ring-offset-background focus:ring-ring rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
                <XIcon />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-auto min-h-0">
              {loading && (
                <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>Loading file...</span>
                </div>
              )}

              {error && (
                <div className="flex items-center justify-center h-full text-destructive text-sm p-4">
                  {error}
                </div>
              )}

              {content !== null && !loading && (
                <div className="flex text-sm font-mono">
                  {/* Line numbers */}
                  <div className="select-none shrink-0 py-4 pl-4 pr-3 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0 bg-background">
                    {lines.map((_, i) => (
                      <div key={i} className="leading-6">{i + 1}</div>
                    ))}
                  </div>

                  {/* Code content */}
                  <div className="flex-1 overflow-x-auto">
                    <pre
                      ref={codeRef}
                      className="hljs p-4 m-0 bg-transparent leading-6"
                      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                    />
                  </div>
                </div>
              )}
            </div>
          </Resizable>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
