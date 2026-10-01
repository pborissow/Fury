'use client';

import { Archive } from 'lucide-react';
import type { SearchPrefs } from './types';

/** Compact segmented control — replaces native <select>s in the filter row so
 *  the controls match the app's custom chrome (native selects are OS-styled).
 *  pointer-coarse: grows the buttons toward the 44pt touch floor without
 *  changing the desktop (mouse) density. */
function Segmented<T extends string>({ value, options, onChange, testid }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testid?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted p-0.5 shrink-0" data-testid={testid}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-2 py-0.5 pointer-coarse:px-3 pointer-coarse:py-2 rounded-[5px] text-xs cursor-pointer transition-colors ${
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface SearchFiltersProps {
  role: SearchPrefs['role'];
  onRoleChange: (r: SearchPrefs['role']) => void;
  includeArchived: boolean;
  onToggleArchived: () => void;
  project: string;
  onProjectChange: (p: string) => void;
  /** Corpus project list; the Project <select> renders only when > 1. */
  projects: string[];
  sort: SearchPrefs['sort'];
  onSortChange: (s: SearchPrefs['sort']) => void;
}

/** Filter row under the search box — segmented pills instead of native
 *  controls so the chrome matches the rest of the app. The Project filter
 *  stays a <select>: its option count is unbounded.
 *
 *  Desktop: a wrapping row with Sort pushed right. Phone (max-md): a single
 *  non-wrapping, horizontally scrollable chip rail (the standard mobile
 *  filter pattern) that bleeds to the screen edges via -mx/px so chips can
 *  scroll from under the column padding; the "Sort" label is dropped —
 *  Relevance|Recent is self-explanatory. */
export default function SearchFilters({
  role, onRoleChange,
  includeArchived, onToggleArchived,
  project, onProjectChange, projects,
  sort, onSortChange,
}: SearchFiltersProps) {
  return (
    <div className="sh-fade-in flex items-center gap-2 mt-3 text-xs text-muted-foreground md:flex-wrap max-md:overflow-x-auto max-md:-mx-4 max-md:px-4 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
      <Segmented
        value={role}
        onChange={onRoleChange}
        testid="search-role-toggle"
        options={[
          { value: 'all' as const, label: 'All' },
          { value: 'user' as const, label: 'You' },
          { value: 'assistant' as const, label: 'Claude' },
        ]}
      />
      <button
        onClick={onToggleArchived}
        aria-pressed={includeArchived}
        data-testid="search-archived-toggle"
        title={includeArchived ? 'Archived sessions included — click to exclude' : 'Archived sessions excluded — click to include'}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 pointer-coarse:px-3.5 pointer-coarse:py-2 shrink-0 cursor-pointer transition-colors ${
          includeArchived
            ? 'border-border bg-muted text-foreground'
            : 'border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground'
        }`}
      >
        <Archive className="h-3 w-3" />
        Archived
      </button>
      {projects.length > 1 && (
        <select
          value={project}
          onChange={e => onProjectChange(e.target.value)}
          aria-label="Project"
          className="bg-muted border border-border rounded-md px-2 py-1 pointer-coarse:py-2 text-xs max-w-56 truncate shrink-0 cursor-pointer"
        >
          <option value="all">All projects</option>
          {projects.map(p => (
            <option key={p} value={p}>{p.split(/[\\/]/).filter(Boolean).pop() || p}</option>
          ))}
        </select>
      )}
      <div className="md:ml-auto flex items-center gap-1.5 shrink-0">
        <span className="max-md:hidden">Sort</span>
        <Segmented
          value={sort}
          onChange={onSortChange}
          options={[
            { value: 'relevance' as const, label: 'Relevance' },
            { value: 'recent' as const, label: 'Recent' },
          ]}
        />
      </div>
    </div>
  );
}
