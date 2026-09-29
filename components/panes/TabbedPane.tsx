'use client';

import { Fragment, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface TabbedPaneView {
  id: string;
  label: string;
  icon: ReactNode;
  /** Shown after the label, e.g. a live-activity dot. */
  badge?: ReactNode;
  /** Stay mounted (hidden via CSS) when not selected, preserving internal state
   *  such as a file tree's expansion. Other views mount only while selected. */
  keepMounted?: boolean;
  content: ReactNode;
}

interface SwitcherProps {
  views: TabbedPaneView[];
  value: string;
  onValueChange: (id: string) => void;
  /** Icon-only buttons with 44px touch targets, spread across the row (phones).
   *  The label moves to aria-label / title. */
  compact?: boolean;
}

/** The view-switcher button row. Separate from the content so an alternative
 *  (e.g. compact, icon-only) switcher can be swapped in. */
export function TabbedPaneSwitcher({ views, value, onValueChange, compact }: SwitcherProps) {
  if (compact) {
    return (
      <div className="px-2 py-1 border-b border-border flex items-center justify-around" role="tablist">
        {views.map(v => (
          <Button
            key={v.id}
            role="tab"
            aria-selected={value === v.id}
            aria-label={v.label}
            title={v.label}
            variant={value === v.id ? 'default' : 'ghost'}
            onClick={() => onValueChange(v.id)}
            className="relative h-11 w-11 p-0"
          >
            {v.icon}
            {v.badge && <span className="absolute top-1.5 right-1.5 flex">{v.badge}</span>}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div className="p-2 border-b border-border flex items-center gap-2">
      {views.map(v => (
        <Button
          key={v.id}
          variant={value === v.id ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onValueChange(v.id)}
          className="flex items-center gap-2"
        >
          {v.icon}
          {v.label}
          {v.badge}
        </Button>
      ))}
    </div>
  );
}

/**
 * The selected view's content. Keep-mounted views always render (hidden unless
 * selected) and come first; then the selected view if it mounts on select. A
 * mount-on-select view's content is rendered bare, so it supplies its own layout.
 */
export function TabbedPaneContent({ views, value }: Pick<SwitcherProps, 'views' | 'value'>) {
  const selected = views.find(v => v.id === value);
  return (
    <>
      {views.filter(v => v.keepMounted).map(v => (
        <div key={v.id} className={cn('flex-1 overflow-hidden', v.id !== value && 'hidden')}>
          {v.content}
        </div>
      ))}
      {/* Keyed by view id: two views sharing a component type must not reuse one
          instance (and its state) across a switch. */}
      {selected && !selected.keepMounted && <Fragment key={selected.id}>{selected.content}</Fragment>}
    </>
  );
}

interface TabbedPaneProps extends SwitcherProps {
  /** Extra classes for the root (always `h-full flex flex-col`). */
  className?: string;
}

/** A pane with a row of view buttons and the selected view below. Controlled:
 *  the owner holds `value`, so it can switch views programmatically. */
export default function TabbedPane({ views, value, onValueChange, className, compact }: TabbedPaneProps) {
  return (
    <div className={cn('h-full flex flex-col', className)}>
      <TabbedPaneSwitcher views={views} value={value} onValueChange={onValueChange} compact={compact} />
      <TabbedPaneContent views={views} value={value} />
    </div>
  );
}
