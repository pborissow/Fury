'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, GitCompareArrows } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Dialog from '@/components/Dialog';
import { DiffView, buildDiffRows, highlightCode, normalizeLineEndings, isCodeFile } from '@/components/DiffView';

// Re-export so existing `import CodeViewerDialog, { isCodeFile }` consumers keep working.
export { isCodeFile };

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
  // Render the loading spinner only when the fetch is slow enough that the
  // user would otherwise see a blank dialog body. Fast local reads finish
  // before this flips to true, so the content just snaps in.
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  // Persisted size — loaded once, then passed as Dialog defaults. The
  // dialog manages its own size/position state internally; we only get
  // notified on resize/move-end to persist the new values.
  const [persistedSize, setPersistedSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const savePrefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileName = filePath ? filePath.replace(/\\/g, '/').split('/').pop() || '' : '';

  // Load saved dialog preferences once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ui-state');
        if (res.ok) {
          const { state } = await res.json();
          if (state?.codeViewerSize) setPersistedSize(state.codeViewerSize);
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
      setShowSpinner(false);
      if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current);
      spinnerTimerRef.current = setTimeout(() => setShowSpinner(true), 500);

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
        if (spinnerTimerRef.current) {
          clearTimeout(spinnerTimerRef.current);
          spinnerTimerRef.current = null;
        }
        setShowSpinner(false);
      }
    };

    fetchFile();

    return () => {
      if (spinnerTimerRef.current) {
        clearTimeout(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
    };
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

  const handleResizeEnd = useCallback((s: { width: number; height: number }) => {
    setPersistedSize(s);
    saveDialogPrefs({ codeViewerSize: s });
  }, [saveDialogPrefs]);

  const lines = content?.split('\n') || [];

  const title = (
    <span className="font-mono">
      {fileName}
      <span className="text-muted-foreground font-normal ml-3 text-xs">
        {filePath}
      </span>
    </span>
  );

  const headerActions = hasOriginal ? (
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
  ) : undefined;

  // Wait until persisted prefs are loaded so the Dialog mounts at the
  // correct initial size instead of flashing the hard-coded default.
  if (filePath === null || !prefsLoaded) return null;

  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={title}
      headerActions={headerActions}
      defaultWidth={persistedSize.width}
      defaultHeight={persistedSize.height}
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      resetOnOpen={false}
      onResizeEnd={handleResizeEnd}
      maximizable
      noPadding
    >
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
        {showSpinner && (
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
          // Metrics kept in sync with the shared DiffView (text-xs / leading-5 /
          // py-3) so the plain view and diff view read as one surface.
          <div className="flex text-xs font-mono min-h-full" style={{ backgroundColor: '#171717' }}>
            {/* Line numbers */}
            <div className="select-none shrink-0 py-3 pl-3 pr-2.5 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0" style={{ backgroundColor: '#171717' }}>
              {lines.map((_, i) => (
                <div key={i} className="leading-5">{i + 1}</div>
              ))}
            </div>

            {/* Code content */}
            <div className="flex-1 overflow-x-auto">
              <pre
                ref={codeRef}
                className="hljs py-3 px-3 m-0 bg-transparent leading-5"
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
    </Dialog>
  );
});
