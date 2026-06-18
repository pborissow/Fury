import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Convert an absolute project path to the slug used in ~/.claude/projects/
 * e.g. /Users/peter/myproject -> -Users-peter-myproject
 * e.g. U:\petya\Documents    -> U--petya-Documents
 */
export function projectPathToSlug(projectPath: string): string {
  return projectPath.replace(/[:\\/\s]/g, '-');
}

/**
 * Shorten a filesystem path to its last N segments, preserving the original
 * separator style (\ on Windows-style paths, / elsewhere).
 *   U:\petya\Documents\JavaScript\Fury -> JavaScript\Fury
 *   /Users/peter/code/foo              -> code/foo
 */
export function shortenPath(fullPath: string, segments = 2): string {
  if (!fullPath) return '';
  const isWindows = /\\/.test(fullPath) || /^[A-Za-z]:/.test(fullPath);
  const sep = isWindows ? '\\' : '/';
  const parts = fullPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length <= segments) return fullPath;
  return parts.slice(-segments).join(sep);
}
