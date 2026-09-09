'use client';

import React, { useEffect, useRef } from 'react';
import hljs from 'highlight.js';
import { diffLines } from 'diff';

// Shared diff engine + side-by-side renderer, extracted from CodeViewerDialog
// so both the code viewer and the source-control dialog use one implementation.

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

export function highlightCode(code: string, fileName: string): string {
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
export interface DiffRow {
  leftNum: number | null;
  leftHtml: string;
  leftType: 'unchanged' | 'removed' | 'empty';
  rightNum: number | null;
  rightHtml: string;
  rightType: 'unchanged' | 'added' | 'empty';
}

export interface DiffResult {
  rows: DiffRow[];
  tooLarge?: boolean;
  stats?: { added: number; removed: number; unchanged: number };
}

function countLines(value: string): number {
  const v = value.endsWith('\n') ? value.slice(0, -1) : value;
  return v.split('\n').length;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function buildDiffRows(rawOriginal: string, rawCurrent: string, fileName: string): DiffResult {
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

// Side-by-side diff rendering, styled after GitKraken's diff view:
// neutral dark-gray canvas, compact 13px/20px type, desaturated red/green
// row highlights, and -/+ markers beside the line numbers.
export function DiffView({ rows }: { rows: DiffRow[] }) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const containerRef = useRef<HTMLDivElement>(null);

  // Dark canvas matches the global .hljs background override (globals.css)
  const CANVAS_BG = isDark ? '#171717' : '#ffffff';
  const GUTTER_BG = isDark ? '#171717' : '#f6f8fa';

  const ROW_BG: Record<string, string> = {
    removed: isDark ? 'rgb(56 36 39)' : '#fce8e8',
    added: isDark ? 'rgb(40 61 46)' : '#e6f6e8',
    empty: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
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
    <div ref={containerRef} className="hljs flex text-xs font-mono min-w-0 min-h-full" style={{ backgroundColor: CANVAS_BG }}>
      {/* Left side (original) */}
      <div className="flex flex-1 min-w-0 border-r border-border overflow-x-auto">
        {/* Line numbers */}
        <div className="select-none shrink-0 py-3 pl-3 pr-1.5 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0 z-10" style={{ backgroundColor: GUTTER_BG }}>
          {rows.map((row, i) => (
            <div key={i} className="leading-5 flex items-center justify-end" style={{ backgroundColor: ROW_BG[row.leftType] }}
              {...(i === firstDiffIndex ? { 'data-first-diff': true } : {})}
            >
              <span>{row.leftNum ?? ' '}</span>
              <span className={`w-3 text-center ${row.leftType === 'removed' ? 'text-red-400/90' : ''}`}>
                {row.leftType === 'removed' ? '-' : ' '}
              </span>
            </div>
          ))}
        </div>
        {/* Code */}
        <div className="shrink-0">
          <div className="py-3 px-3">
            {rows.map((row, i) => (
              <div
                key={i}
                className="leading-5 whitespace-pre"
                style={{ backgroundColor: ROW_BG[row.leftType] }}
              >
                {row.leftType === 'empty' ? (
                  <span className="opacity-0">.</span>
                ) : (
                  <span
                    className="hljs"
                    style={{ backgroundColor: 'transparent' }}
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
        <div className="select-none shrink-0 py-3 pl-3 pr-1.5 text-right text-muted-foreground/50 border-r border-border/50 sticky left-0 z-10" style={{ backgroundColor: GUTTER_BG }}>
          {rows.map((row, i) => (
            <div key={i} className="leading-5 flex items-center justify-end" style={{ backgroundColor: ROW_BG[row.rightType] }}>
              <span>{row.rightNum ?? ' '}</span>
              <span className={`w-3 text-center ${row.rightType === 'added' ? 'text-green-400/90' : ''}`}>
                {row.rightType === 'added' ? '+' : ' '}
              </span>
            </div>
          ))}
        </div>
        {/* Code */}
        <div className="shrink-0">
          <div className="py-3 px-3">
            {rows.map((row, i) => (
              <div
                key={i}
                className="leading-5 whitespace-pre"
                style={{ backgroundColor: ROW_BG[row.rightType] }}
              >
                {row.rightType === 'empty' ? (
                  <span className="opacity-0">.</span>
                ) : (
                  <span
                    className="hljs"
                    style={{ backgroundColor: 'transparent' }}
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
