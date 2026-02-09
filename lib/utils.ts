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
