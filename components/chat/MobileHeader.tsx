'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Menu, X, List, MessageSquare, PanelRight, Sun, Moon, Settings, LogOut, CircleUserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MobilePane } from '@/components/chat/MobileChatLayout';

export type AppTab = 'chat' | 'canvas' | 'stats' | 'search';

const TABS: { id: AppTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'stats', label: 'Stats' },
  { id: 'search', label: 'Search' },
];

const PANES: { id: MobilePane; label: string; icon: ReactNode }[] = [
  { id: 'sessions', label: 'Sessions', icon: <List className="h-5 w-5" /> },
  { id: 'conversation', label: 'Conversation', icon: <MessageSquare className="h-5 w-5" /> },
  { id: 'side', label: 'Side views', icon: <PanelRight className="h-5 w-5" /> },
];

interface MobileHeaderProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  /** Shown in the bar: the viewed session on Chat, else the tab name. */
  title: string;
  pane: MobilePane;
  onPaneChange: (pane: MobilePane) => void;
  /** Conversation has news (a turn finished while it was off screen). */
  conversationBadge: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  /** Signed-in remote user, or null (localhost). */
  user: string | null;
  onSignOut: () => void;
}

/**
 * The phone header (docs/ticket-mobile-pwa.md §5.2): one 48px bar replacing
 * both desktop rows — `☰ | title | pane indicator`. The hamburger opens a drawer
 * with the four tabs, theme, settings and sign-out. Stateless apart from the
 * drawer; every action is page.tsx's existing handler.
 */
export default function MobileHeader({
  activeTab, onTabChange, title, pane, onPaneChange, conversationBadge,
  theme, onToggleTheme, onOpenSettings, user, onSignOut,
}: MobileHeaderProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  /** Run a drawer action, then close the drawer. */
  const pick = (action: () => void) => () => { action(); setDrawerOpen(false); };

  const itemClass = 'w-full flex items-center gap-3 px-4 min-h-11 text-sm text-left hover:bg-muted transition-colors';

  return (
    <>
      <header className="mobile-header bg-card border-b border-border shrink-0" data-testid="mobile-header">
        <div className="h-12 flex items-center gap-1 px-1">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="h-11 w-11 flex items-center justify-center rounded-md hover:bg-muted"
            data-testid="mobile-menu-button"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="flex-1 min-w-0 truncate text-sm font-semibold" data-testid="mobile-title">{title}</h1>
          {activeTab === 'chat' && (
            <nav aria-label="Chat panes" className="flex items-center" data-testid="mobile-pane-indicator">
              {PANES.map(p => (
                <button
                  key={p.id}
                  type="button"
                  aria-label={p.label}
                  aria-current={pane === p.id ? 'page' : undefined}
                  title={p.label}
                  onClick={() => onPaneChange(p.id)}
                  data-testid={`mobile-pane-button-${p.id}`}
                  className={cn(
                    'relative h-11 w-11 flex items-center justify-center rounded-md transition-colors',
                    pane === p.id ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p.icon}
                  {p.id === 'conversation' && conversationBadge && pane !== 'conversation' && (
                    <span
                      className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary"
                      data-testid="mobile-conversation-badge"
                    />
                  )}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>

      {drawerOpen && (
        <div className="fixed inset-0 z-50" data-testid="mobile-drawer">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawerOpen(false)} aria-hidden />
          <aside
            role="dialog"
            aria-label="Menu"
            className="mobile-header absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-card border-r border-border shadow-xl flex flex-col"
            style={{ paddingLeft: 'env(safe-area-inset-left)', paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="h-12 flex items-center justify-between pl-4 pr-1 border-b border-border">
              <span className="flex items-center gap-2 select-none">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/fury-mark-xs.svg" alt="" className="h-7 w-7" draggable={false} />
                <span className="text-xl leading-none" style={{ fontFamily: 'var(--font-kaushan)' }}>Fury</span>
              </span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="h-11 w-11 flex items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="py-2 border-b border-border">
              {TABS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={pick(() => onTabChange(t.id))}
                  aria-current={activeTab === t.id ? 'page' : undefined}
                  data-testid={`mobile-tab-${t.id}`}
                  className={cn(itemClass, activeTab === t.id ? 'text-foreground font-medium' : 'text-muted-foreground')}
                >
                  <span className={cn('h-4 w-0.5 rounded-full', activeTab === t.id ? 'bg-primary' : 'bg-transparent')} />
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="py-2">
              <button type="button" onClick={pick(onToggleTheme)} className={cn(itemClass, 'text-muted-foreground')}>
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <button type="button" onClick={pick(onOpenSettings)} className={cn(itemClass, 'text-muted-foreground')}>
                <Settings className="h-4 w-4" />
                Settings
              </button>
            </div>
            {user && (
              <div className="mt-auto py-2 border-t border-border">
                <div className="px-4 min-h-11 flex items-center gap-3 text-sm">
                  <CircleUserRound className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{user}</span>
                </div>
                <button type="button" onClick={pick(onSignOut)} className={cn(itemClass, 'text-muted-foreground')}>
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
