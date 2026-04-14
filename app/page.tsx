'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import ChatTab from '@/components/ChatTab';
import CanvasTab from '@/components/CanvasTab';
import { Sun, Moon, EllipsisVertical, CircleUserRound, LogOut } from 'lucide-react';
import Dialog from '@/components/Dialog';
import SettingsPanel, { type ServiceSettings } from '@/components/SettingsPanel';

export default function Home() {
  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Auth state (external users only)
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Check if current user is authenticated (external)
  useEffect(() => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/auth/whoami', true);
    xhr.setRequestHeader('Cache-Control', 'no-cache, no-transform');
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.username) setLoggedInUser(data.username);
        } catch {}
      }
    };
    xhr.send(null);
  }, []);

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [userMenuOpen]);

  const handleLogout = () => {
    setUserMenuOpen(false);
    // Step 1: GET /api/auth/logout?prompt=false (clear server-side, no WWW-Authenticate)
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/auth/logout?prompt=false', true);
    xhr.setRequestHeader('Cache-Control', 'no-cache, no-transform');
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        // Step 2: Overwrite browser's cached credentials with dummy ones
        const xhr2 = new XMLHttpRequest();
        xhr2.open('GET', '/', true, 'logout', 'logout');
        xhr2.setRequestHeader('Cache-Control', 'no-cache, no-transform');
        xhr2.onreadystatechange = () => {
          if (xhr2.readyState === 4) {
            window.location.replace('/login');
          }
        };
        xhr2.send('');
      }
    };
    xhr.send('');
  };

  // App settings (persisted to server)
  const [promptSuggestionsEnabled, setPromptSuggestionsEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [localhostOnly, setLocalhostOnly] = useState(true);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [authUsername, setAuthUsername] = useState('');
  const [services, setServices] = useState<ServiceSettings>({
    summarizerProvider: 'none',
    hasAnthropicApiKey: false,
    ollamaHost: '',
    ollamaPort: '11434',
    ttsProvider: 'local',
    ttsRemoteHost: '',
    ttsRemotePort: '5656',
  });
  const settingsLoaded = useRef(false);

  // Load settings on mount
  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      if (s.promptSuggestionsEnabled !== undefined) setPromptSuggestionsEnabled(s.promptSuggestionsEnabled);
      if (s.ttsEnabled !== undefined) setTtsEnabled(s.ttsEnabled);
      if (s.localhostOnly !== undefined) setLocalhostOnly(s.localhostOnly);
      if (s.hasCredentials !== undefined) setHasCredentials(s.hasCredentials);
      if (s.authUsername) setAuthUsername(s.authUsername);
      setServices(prev => ({
        ...prev,
        summarizerProvider: s.summarizerProvider ?? prev.summarizerProvider,
        hasAnthropicApiKey: s.hasAnthropicApiKey ?? prev.hasAnthropicApiKey,
        ollamaHost: s.ollamaHost ?? prev.ollamaHost,
        ollamaPort: s.ollamaPort ?? prev.ollamaPort,
        ttsProvider: s.ttsProvider ?? prev.ttsProvider,
        ttsRemoteHost: s.ttsRemoteHost ?? prev.ttsRemoteHost,
        ttsRemotePort: s.ttsRemotePort ?? prev.ttsRemotePort,
      }));
      settingsLoaded.current = true;
    }).catch(() => { settingsLoaded.current = true; });
  }, []);

  // Persist settings when they change
  const saveSettings = useCallback((updates: Record<string, unknown>) => {
    if (!settingsLoaded.current) return;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).catch(err => console.error('[Settings] Failed to save:', err));
  }, []);

  useEffect(() => {
    saveSettings({ promptSuggestionsEnabled });
  }, [promptSuggestionsEnabled, saveSettings]);

  useEffect(() => {
    saveSettings({ ttsEnabled });
  }, [ttsEnabled, saveSettings]);

  useEffect(() => {
    saveSettings({ localhostOnly });
  }, [localhostOnly, saveSettings]);

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
        {loggedInUser && (
          <div className="relative" ref={userMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              title={loggedInUser}
              className="h-8 w-8 p-0"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
            >
              <CircleUserRound className="h-4 w-4" />
            </Button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-border bg-card shadow-lg z-50">
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm font-medium truncate">{loggedInUser}</div>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="h-8 w-8 p-0"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" title="Settings" className="h-8 w-8 p-0" onClick={() => setSettingsOpen(true)}>
          <EllipsisVertical className="h-4 w-4" />
        </Button>
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Settings" noPadding>
          <SettingsPanel
            promptSuggestionsEnabled={promptSuggestionsEnabled}
            onPromptSuggestionsChange={setPromptSuggestionsEnabled}
            ttsEnabled={ttsEnabled}
            onTtsChange={setTtsEnabled}
            localhostOnly={localhostOnly}
            onLocalhostOnlyChange={setLocalhostOnly}
            hasCredentials={hasCredentials}
            authUsername={authUsername}
            onCredentialsSaved={(name) => { setHasCredentials(true); setAuthUsername(name); }}
            services={services}
            onServicesChanged={(updates) => setServices(prev => ({ ...prev, ...updates }))}
          />
        </Dialog>
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
            <div
              className="absolute inset-0"
              style={activeTab !== 'chat' ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
            >
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
                isActive={activeTab === 'chat'}
                promptSuggestionsEnabled={promptSuggestionsEnabled}
                ttsEnabled={ttsEnabled}
              />
            </div>
          )}

          {layoutsLoaded && mountedTabs.has('canvas') && (
            <div
              className="absolute inset-0"
              style={activeTab !== 'canvas' ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
            >
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
