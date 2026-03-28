'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import ChatTab from '@/components/ChatTab';
import CanvasTab from '@/components/CanvasTab';
import { Sun, Moon } from 'lucide-react';

export default function Home() {
  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Tab control state
  const [activeTab, setActiveTab] = useState<'chat' | 'canvas'>('chat');

  // Track which tabs have been mounted at least once (lazy mount + CSS hide)
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(new Set(['chat']));

  // When activeTab changes, mark it as mounted
  useEffect(() => {
    setMountedTabs(prev => {
      if (prev.has(activeTab)) return prev;
      return new Set(prev).add(activeTab);
    });
  }, [activeTab]);

  // Persisted workflow ID (loaded from UI state, saved on change)
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  // Panel layout state
  const [chatHorizontalLayout, setChatHorizontalLayout] = useState<number[]>([20, 45, 35]);
  const [chatVerticalLayout, setChatVerticalLayout] = useState<number[]>([70, 30]);
  const [canvasHorizontalLayout, setCanvasHorizontalLayout] = useState<number[]>([20, 80]);
  const [layoutsLoaded, setLayoutsLoaded] = useState(false);
  const layoutSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load UI state on mount
  useEffect(() => {
    const loadUIState = async () => {
      try {
        const res = await fetch('/api/ui-state');
        if (res.ok) {
          const { state } = await res.json();
          if (state) {
            if (state.activeTab) setActiveTab(state.activeTab);
            if (state.activeWorkflowId) setActiveWorkflowId(state.activeWorkflowId);
            if (state.chatHorizontalLayout) setChatHorizontalLayout(state.chatHorizontalLayout);
            if (state.chatVerticalLayout) setChatVerticalLayout(state.chatVerticalLayout);
            if (state.canvasHorizontalLayout) setCanvasHorizontalLayout(state.canvasHorizontalLayout);
          }
        }
      } catch (error) {
        console.error('[App] Failed to load UI state:', error);
      } finally {
        setLayoutsLoaded(true);
      }
    };
    loadUIState();
  }, []);

  // Save UI state when activeTab or activeWorkflowId changes
  useEffect(() => {
    const saveUIState = async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeTab, activeWorkflowId }),
        });
      } catch (error) {
        console.error('[App] Failed to save UI state:', error);
      }
    };
    saveUIState();
  }, [activeTab, activeWorkflowId]);

  // Debounced save for panel layout changes
  const saveLayoutState = useCallback((updates: Record<string, number[]>) => {
    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }
    layoutSaveTimerRef.current = setTimeout(async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
      } catch (error) {
        console.error('[App] Failed to save panel layout:', error);
      }
    }, 500);
  }, []);

  // Load theme preference on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme) setTheme(savedTheme);
  }, []);

  // Save theme preference and apply to document
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  return (
    <div className="h-screen w-screen bg-background flex flex-col">
      {/* Toolbar */}
      <div className="bg-card border-b border-border px-4 py-2 flex items-center justify-end gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="h-8 w-8 p-0"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>

      {/* Main Content with Tabs */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Primary Tabs */}
        <div className="border-b border-border px-4 flex items-center gap-6">
          <button
            onClick={() => setActiveTab('chat')}
            className={`relative py-3 text-sm font-medium transition-colors ${
              activeTab === 'chat' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Chat
            {activeTab === 'chat' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('canvas')}
            className={`relative py-3 text-sm font-medium transition-colors ${
              activeTab === 'canvas' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Canvas
            {activeTab === 'canvas' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        </div>

        {/* Tab Content — lazy mount, then CSS hide to preserve state */}
        <div className="flex-1 overflow-hidden relative">
          {layoutsLoaded && mountedTabs.has('chat') && (
            <div className="absolute inset-0" style={{ display: activeTab === 'chat' ? 'block' : 'none' }}>
              <ChatTab
                chatHorizontalLayout={chatHorizontalLayout}
                chatVerticalLayout={chatVerticalLayout}
                onHorizontalLayoutChange={(sizes) => {
                  setChatHorizontalLayout(sizes);
                  saveLayoutState({ chatHorizontalLayout: sizes });
                }}
                onVerticalLayoutChange={(sizes) => {
                  setChatVerticalLayout(sizes);
                  saveLayoutState({ chatVerticalLayout: sizes });
                }}
              />
            </div>
          )}

          {layoutsLoaded && mountedTabs.has('canvas') && (
            <div className="absolute inset-0" style={{ display: activeTab === 'canvas' ? 'block' : 'none' }}>
              <CanvasTab
                canvasHorizontalLayout={canvasHorizontalLayout}
                onLayoutChange={(sizes) => {
                  setCanvasHorizontalLayout(sizes);
                  saveLayoutState({ canvasHorizontalLayout: sizes });
                }}
                initialWorkflowId={activeWorkflowId}
                onWorkflowIdChange={setActiveWorkflowId}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
