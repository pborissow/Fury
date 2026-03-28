'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, XIcon, GitCompareArrows } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Resizable } from 're-resizable';
import hljs from 'highlight.js';
import { diffLines } from 'diff';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

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

function highlightCode(code: string, fileName: string): string {
  const lang = getLanguage(fileName);
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang }).value;
  }
  return hljs.highlightAuto(code).value;
}

// Highlight a full file and split into per-line HTML strings.
// hljs produces span tags that can wrap across lines, so we need to
// track open spans and re-open them on each new line.
function highlightLines(code: string, fileName: string): string[] {
  const html = highlightCode(code, fileName);
  return html.split('\n');
}

// Heuristic limits — based on what the diff actually produces, not raw file size
const MAX_DIFF_ROWS = 10000;    // max rows we'll render in the side-by-side view
const MAX_CHANGED_LINES = 3000; // max added+removed lines before we bail

// Build side-by-side diff rows from diff changes
interface DiffRow {
  leftNum: number | null;
  leftHtml: string;
  leftType: 'unchanged' | 'removed' | 'empty';
  rightNum: number | null;
  rightHtml: string;
  rightType: 'unchanged' | 'added' | 'empty';
}

interface DiffResult {
  rows: DiffRow[];
  tooLarge?: boolean;
  stats?: { added: number; removed: number; unchanged: number };
}

function countLines(value: string): number {
  const v = value.endsWith('\n') ? value.slice(0, -1) : value;
  return v.split('\n').length;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildDiffRows(rawOriginal: string, rawCurrent: string, fileName: string): DiffResult {
  // Normalize line endings so \r\n vs \n doesn't cause every line to diff
  const original = normalizeLineEndings(rawOriginal);
  const current = normalizeLineEndings(rawCurrent);

  // Step 1: compute the diff (this is cheap — just string comparison)
  const changes = diffLines(original, current);

  // Step 2: count what the diff would produce before doing any heavy work
  let changedLines = 0;
  let totalRows = 0;
  for (const change of changes) {
    const count = countLines(change.value);
    if (change.added || change.removed) {
      changedLines += count;
    }
    totalRows += count;
  }

  if (changedLines > MAX_CHANGED_LINES || totalRows > MAX_DIFF_ROWS) {
    return {
      rows: [],
      tooLarge: true,
      stats: { added: 0, removed: changedLines, unchanged: totalRows - changedLines },
    };
  }

  // Step 3: only now do the expensive highlighting
  const originalLines = highlightLines(original, fileName);
  const currentLines = highlightLines(current, fileName);

  // Step 4: build aligned rows
  const rows: DiffRow[] = [];
  let leftIdx = 0;
  let rightIdx = 0;

  for (const change of changes) {
    const count = countLines(change.value);

    if (!change.added && !change.removed) {
      for (let i = 0; i < count; i++) {
        rows.push({
          leftNum: leftIdx + 1,
          leftHtml: originalLines[leftIdx] || '',
          leftType: 'unchanged',
          rightNum: rightIdx + 1,
          rightHtml: currentLines[rightIdx] || '',
          rightType: 'unchanged',
        });
        leftIdx++;
        rightIdx++;
      }
    } else if (change.removed) {
      for (let i = 0; i < count; i++) {
        rows.push({
          leftNum: leftIdx + 1,
          leftHtml: originalLines[leftIdx] || '',
          leftType: 'removed',
          rightNum: null,
          rightHtml: '',
          rightType: 'empty',
        });
        leftIdx++;
      }
    } else if (change.added) {
      // Find the start of trailing empty right-side rows (from a preceding removed block)
      let fillStart = rows.length;
      while (fillStart > 0 && rows[fillStart - 1].rightType === 'empty') {
        fillStart--;
      }
      const emptyCount = rows.length - fillStart;
      let filled = 0;
      for (let i = 0; i < Math.min(count, emptyCount); i++) {
        const targetIdx = fillStart + i;
        rows[targetIdx].rightNum = rightIdx + 1;
        rows[targetIdx].rightHtml = currentLines[rightIdx] || '';
        rows[targetIdx].rightType = 'added';
        filled++;
        rightIdx++;
      }
      for (let i = filled; i < count; i++) {
        rows.push({
          leftNum: null,
          leftHtml: '',
          leftType: 'empty',
          rightNum: rightIdx + 1,
          rightHtml: currentLines[rightIdx] || '',
          rightType: 'added',
        });
        rightIdx++;
      }
    }
  }

  return { rows };
}

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

interface CodeViewerDialogProps {
  filePath: string | null;
  onClose: () => void;
}

function isMarkdownFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'md' || ext === 'mdx';
}

export default React.memo(function CodeViewerDialog({ filePath, onClose }: CodeViewerDialogProps) {
  const [content, setContent] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [hasOriginal, setHasOriginal] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [mdView, setMdView] = useState<'preview' | 'raw'>('preview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  // Persisted size & position
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const savePrefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileName = filePath ? filePath.replace(/\\/g, '/').split('/').pop() || '' : '';

  // Load saved dialog preferences once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ui-state');
        if (res.ok) {
          const { state } = await res.json();
          if (state?.codeViewerSize) setSize(state.codeViewerSize);
          if (state?.codeViewerPosition) setPosition(state.codeViewerPosition);
        }
      } catch { /* ignore */ }
      setPrefsLoaded(true);
    })();
  }, []);

  // Debounced save helper
  const saveDialogPrefs = useCallback((updates: Record<string, unknown>) => {
    if (savePrefTimer.current) clearTimeout(savePrefTimer.current);
    savePrefTimer.current = setTimeout(async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
      } catch { /* ignore */ }
    }, 500);
  }, []);

  const isMd = isMarkdownFile(fileName);

  // Reset view state when a new file is opened (but keep size/position)
  useEffect(() => {
    if (filePath) {
      setShowDiff(false);
      setMdView('preview');
    }
  }, [filePath]);

  // Fetch current file content
  useEffect(() => {
    if (!filePath) {
      setContent(null);
      setOriginalContent(null);
      setHasOriginal(false);
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);
      setContent(null);
      setOriginalContent(null);
      setHasOriginal(false);

      try {
        // Fetch current and original in parallel
        const [currentRes, originalRes] = await Promise.all([
          fetch(`/api/file?path=${encodeURIComponent(filePath)}`),
          fetch(`/api/file/original?path=${encodeURIComponent(filePath)}`),
        ]);

        const currentData = await currentRes.json();
        if (!currentRes.ok) {
          throw new Error(currentData.error || 'Failed to read file');
        }
        setContent(currentData.content);

        // Original is optional — file might not be in VCS or might be new
        if (originalRes.ok) {
          const originalData = await originalRes.json();
          // Normalize line endings before comparing — git returns LF but
          // the filesystem may use CRLF (Windows), causing false diffs.
          if (normalizeLineEndings(originalData.content) !== normalizeLineEndings(currentData.content)) {
            setOriginalContent(originalData.content);
            setHasOriginal(true);
          }
          // If original === current, there's no diff to show
        }
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
    return highlightCode(content, fileName);
  }, [content, fileName]);

  // Compute diff rows
  const diffResult = useMemo(() => {
    if (!showDiff || originalContent === null || content === null) return null;
    return buildDiffRows(originalContent, content, fileName);
  }, [showDiff, originalContent, content, fileName]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.PointerEvent) => {
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
    if (dragRef.current) {
      dragRef.current = null;
      setPosition(pos => {
        saveDialogPrefs({ codeViewerPosition: pos });
        return pos;
      });
    }
  }, [saveDialogPrefs]);

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
            size={size}
            onResizeStop={(_e, _dir, _ref, delta) => {
              const newSize = { width: size.width + delta.width, height: size.height + delta.height };
              setSize(newSize);
              saveDialogPrefs({ codeViewerSize: newSize });
            }}
            minWidth={MIN_WIDTH}
            minHeight={MIN_HEIGHT}
            maxWidth="95vw"
            maxHeight="95vh"
            className="bg-card rounded-lg border flex flex-col overflow-hidden"
            style={{ boxShadow: '0 8px 40px rgba(0, 0, 0, 0.8), 0 2px 12px rgba(0, 0, 0, 0.6)' }}
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
              className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 cursor-grab active:cursor-grabbing select-none"
              style={{ backgroundColor: '#313131' }}
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
            >
              <DialogPrimitive.Title className="font-mono text-sm font-semibold truncate flex-1">
                {fileName}
                <span className="text-muted-foreground font-normal ml-3 text-xs">
                  {filePath}
                </span>
              </DialogPrimitive.Title>

              {/* Diff toggle — hidden when no VCS changes, disabled during markdown preview */}
              {hasOriginal && (
                <button
                  onClick={() => setShowDiff(!showDiff)}
                  disabled={isMd && mdView === 'preview' && !showDiff}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    showDiff
                      ? 'bg-primary text-primary-foreground'
                      : isMd && mdView === 'preview'
                        ? 'bg-muted text-muted-foreground/40 cursor-not-allowed'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                  title={isMd && mdView === 'preview' && !showDiff ? 'Switch to Source tab to use diff view' : 'Toggle diff view'}
                >
                  <GitCompareArrows className="h-3.5 w-3.5" />
                  Diff
                </button>
              )}

              <DialogPrimitive.Close className="ring-offset-background focus:ring-ring rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
                <XIcon />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </div>

            {/* Markdown view tabs */}
            {isMd && !showDiff && (
              <div className="border-b border-border px-4 flex items-center gap-6 shrink-0" style={{ backgroundColor: '#1e1e1e' }}>
                <button
                  onClick={() => setMdView('preview')}
                  className={`
                    relative py-2 text-sm font-medium transition-colors
                    ${mdView === 'preview'
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                    }
                  `}
                >
                  Preview
                  {mdView === 'preview' && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                  )}
                </button>
                <button
                  onClick={() => setMdView('raw')}
                  className={`
                    relative py-2 text-sm font-medium transition-colors
                    ${mdView === 'raw'
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                    }
                  `}
                >
                  Source
                  {mdView === 'raw' && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                  )}
                </button>
              </div>
            )}

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

              {content !== null && !loading && !showDiff && isMd && mdView === 'preview' && (
                <div className="p-6 prose-chat text-foreground max-w-none overflow-auto h-full" style={{ backgroundColor: '#1b1b1b' }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      code({ className, children, ...props }) {
                        // rehype-highlight adds hljs + language-* classes to fenced blocks.
                        // Ensure the hljs class is always present so the theme applies.
                        const hasHljs = className?.includes('hljs');
                        const cls = hasHljs ? className : `hljs ${className || ''}`.trim();
                        return <code className={cls} {...props}>{children}</code>;
                      },
                    }}
                  >
                    {content}
                  </ReactMarkdown>
                </div>
              )}

              {content !== null && !loading && !showDiff && (!isMd || mdView === 'raw') && (
                <div className="flex text-sm font-mono">
                  {/* Line numbers */}
                  <div className="select-none shrink-0 py-4 pl-4 pr-3 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0" style={{ backgroundColor: '#0d1117' }}>
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

              {content !== null && !loading && showDiff && diffResult && (
                diffResult.tooLarge ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
                    Too many changes to display in diff view
                  </div>
                ) : (
                  <DiffView rows={diffResult.rows} />
                )
              )}
            </div>
          </Resizable>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});

// Side-by-side diff rendering
function DiffView({ rows }: { rows: DiffRow[] }) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const containerRef = useRef<HTMLDivElement>(null);

  const ROW_BG: Record<string, string> = {
    removed: isDark ? '#582a2b' : '#fce8e8',
    added: isDark ? '#304f35' : '#e6f6e8',
    empty: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
    unchanged: 'transparent',
  };

  const firstDiffIndex = rows.findIndex(r => r.leftType !== 'unchanged' || r.rightType !== 'unchanged');

  useEffect(() => {
    if (firstDiffIndex < 0) return;
    const el = containerRef.current?.querySelector('[data-first-diff]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
    }
  }, [firstDiffIndex]);

  return (
    <div ref={containerRef} className="hljs flex text-sm font-mono min-w-0">
      {/* Left side (original) */}
      <div className="flex flex-1 min-w-0 border-r border-border overflow-x-auto">
        {/* Line numbers */}
        <div className="select-none shrink-0 py-4 pl-4 pr-3 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0 z-10" style={{ backgroundColor: '#0d1117' }}>
          {rows.map((row, i) => (
            <div key={i} className="leading-6" style={{ backgroundColor: ROW_BG[row.leftType] }}
              {...(i === firstDiffIndex ? { 'data-first-diff': true } : {})}
            >
              {row.leftNum ?? ' '}
            </div>
          ))}
        </div>
        {/* Code */}
        <div className="shrink-0">
          <div className="py-4 px-4">
            {rows.map((row, i) => (
              <div
                key={i}
                className="leading-6 whitespace-pre"
                style={{ backgroundColor: ROW_BG[row.leftType] }}
              >
                {row.leftType === 'empty' ? (
                  <span className="opacity-0">.</span>
                ) : (
                  <span
                    className="hljs"
                    dangerouslySetInnerHTML={{ __html: row.leftHtml || '&nbsp;' }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right side (current) */}
      <div className="flex flex-1 min-w-0 overflow-x-auto">
        {/* Line numbers */}
        <div className="select-none shrink-0 py-4 pl-4 pr-3 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0 z-10" style={{ backgroundColor: '#0d1117' }}>
          {rows.map((row, i) => (
            <div key={i} className="leading-6" style={{ backgroundColor: ROW_BG[row.rightType] }}>
              {row.rightNum ?? ' '}
            </div>
          ))}
        </div>
        {/* Code */}
        <div className="shrink-0">
          <div className="py-4 px-4">
            {rows.map((row, i) => (
              <div
                key={i}
                className="leading-6 whitespace-pre"
                style={{ backgroundColor: ROW_BG[row.rightType] }}
              >
                {row.rightType === 'empty' ? (
                  <span className="opacity-0">.</span>
                ) : (
                  <span
                    className="hljs"
                    dangerouslySetInnerHTML={{ __html: row.rightHtml || '&nbsp;' }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
