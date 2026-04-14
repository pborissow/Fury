'use client';

import { useState } from 'react';
import { Eye, EyeOff, ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import Dialog from '@/components/Dialog';

export interface ServiceSettings {
  summarizerProvider: 'none' | 'haiku' | 'ollama';
  hasAnthropicApiKey: boolean;
  ollamaHost: string;
  ollamaPort: string;
  ttsProvider: 'local' | 'remote';
  ttsRemoteHost: string;
  ttsRemotePort: string;
}

interface SettingsPanelProps {
  promptSuggestionsEnabled: boolean;
  onPromptSuggestionsChange: (enabled: boolean) => void;
  ttsEnabled: boolean;
  onTtsChange: (enabled: boolean) => void;
  localhostOnly: boolean;
  onLocalhostOnlyChange: (enabled: boolean) => void;
  hasCredentials: boolean;
  authUsername: string;
  onCredentialsSaved: (username: string) => void;
  services: ServiceSettings;
  onServicesChanged: (updates: Partial<ServiceSettings>) => void;
}

export default function SettingsPanel({
  promptSuggestionsEnabled,
  onPromptSuggestionsChange,
  ttsEnabled,
  onTtsChange,
  localhostOnly,
  onLocalhostOnlyChange,
  hasCredentials,
  authUsername,
  onCredentialsSaved,
  services,
  onServicesChanged,
}: SettingsPanelProps) {
  // Credential dialog state
  const [showCredentialDialog, setShowCredentialDialog] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isNewEnable, setIsNewEnable] = useState(false);

  // Service editor dialog state
  const [serviceDialog, setServiceDialog] = useState<'summarizer' | 'tts' | null>(null);
  const [savingService, setSavingService] = useState(false);

  // Summarizer editor form state
  const [editSummarizerProvider, setEditSummarizerProvider] = useState<'none' | 'haiku' | 'ollama'>('none');
  const [editApiKey, setEditApiKey] = useState('');
  const [editShowApiKey, setEditShowApiKey] = useState(false);
  const [editOllamaHost, setEditOllamaHost] = useState('');
  const [editOllamaPort, setEditOllamaPort] = useState('');

  // TTS editor form state
  const [editTtsProvider, setEditTtsProvider] = useState<'local' | 'remote'>('local');
  const [editTtsHost, setEditTtsHost] = useState('');
  const [editTtsPort, setEditTtsPort] = useState('');

  // --- Credential dialog handlers ---

  const openCredentialDialog = (isNew: boolean) => {
    setIsNewEnable(isNew);
    setUsername(authUsername);
    setPassword('');
    setShowPassword(false);
    setShowCredentialDialog(true);
  };

  const handleExternalToggle = (checked: boolean) => {
    if (checked) {
      openCredentialDialog(true);
    } else {
      onLocalhostOnlyChange(true);
    }
  };

  const handleSaveCredentials = async () => {
    if (!username.trim() || !password.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUsername: username.trim(),
          authPassword: password,
          ...(isNewEnable ? { localhostOnly: false } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onCredentialsSaved(username.trim());
      if (isNewEnable) onLocalhostOnlyChange(false);
      setShowCredentialDialog(false);
    } catch (err) {
      console.error('[Settings] Failed to save credentials:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCloseCredentialDialog = (open: boolean) => {
    if (!open) {
      setShowCredentialDialog(false);
      setUsername('');
      setPassword('');
      setShowPassword(false);
    }
  };

  // --- Service editor handlers ---

  const openSummarizerEditor = () => {
    setEditSummarizerProvider(services.summarizerProvider);
    setEditApiKey('');
    setEditShowApiKey(false);
    setEditOllamaHost(services.ollamaHost);
    setEditOllamaPort(services.ollamaPort);
    setServiceDialog('summarizer');
  };

  const openTtsEditor = () => {
    setEditTtsProvider(services.ttsProvider);
    setEditTtsHost(services.ttsRemoteHost);
    setEditTtsPort(services.ttsRemotePort);
    setServiceDialog('tts');
  };

  const handleSaveSummarizer = async () => {
    setSavingService(true);
    try {
      const body: Record<string, unknown> = {
        summarizerProvider: editSummarizerProvider,
      };
      if (editSummarizerProvider === 'haiku' && editApiKey.trim()) {
        body.anthropicApiKey = editApiKey.trim();
      }
      if (editSummarizerProvider === 'ollama') {
        body.ollamaHost = editOllamaHost.trim();
        body.ollamaPort = editOllamaPort.trim();
      }
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      onServicesChanged({
        summarizerProvider: updated.summarizerProvider,
        hasAnthropicApiKey: updated.hasAnthropicApiKey,
        ollamaHost: updated.ollamaHost,
        ollamaPort: updated.ollamaPort,
      });
      setServiceDialog(null);
    } catch (err) {
      console.error('[Settings] Failed to save summarizer:', err);
    } finally {
      setSavingService(false);
    }
  };

  const handleSaveTts = async () => {
    setSavingService(true);
    try {
      const body: Record<string, unknown> = {
        ttsProvider: editTtsProvider,
      };
      if (editTtsProvider === 'remote') {
        body.ttsRemoteHost = editTtsHost.trim();
        body.ttsRemotePort = editTtsPort.trim();
      }
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      onServicesChanged({
        ttsProvider: updated.ttsProvider,
        ttsRemoteHost: updated.ttsRemoteHost,
        ttsRemotePort: updated.ttsRemotePort,
      });
      setServiceDialog(null);
    } catch (err) {
      console.error('[Settings] Failed to save TTS:', err);
    } finally {
      setSavingService(false);
    }
  };

  // --- Service status labels ---

  const summarizerLabel = services.summarizerProvider === 'none'
    ? 'Not configured'
    : services.summarizerProvider === 'haiku'
      ? (services.hasAnthropicApiKey ? 'Haiku' : 'Haiku (no key)')
      : (services.ollamaHost ? `Ollama @ ${services.ollamaHost}:${services.ollamaPort}` : 'Ollama (not configured)');

  const ttsLabel = services.ttsProvider === 'local'
    ? 'Local'
    : (services.ttsRemoteHost ? `Remote @ ${services.ttsRemoteHost}:${services.ttsRemotePort}` : 'Remote (not configured)');

  // --- Validation ---

  const summarizerValid = editSummarizerProvider === 'none'
    || (editSummarizerProvider === 'haiku' && (services.hasAnthropicApiKey || !!editApiKey.trim()))
    || (editSummarizerProvider === 'ollama' && !!editOllamaHost.trim());

  const ttsValid = editTtsProvider === 'local' || !!editTtsHost.trim();

  const [settingsTab, setSettingsTab] = useState<'features' | 'services'>('features');

  return (
    <>
      <div className="border-b border-border flex items-center gap-6 px-4">
        <button
          onClick={() => setSettingsTab('features')}
          className={`relative py-2 text-sm font-medium transition-colors ${settingsTab === 'features' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Features
          {settingsTab === 'features' && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />}
        </button>
        <button
          onClick={() => setSettingsTab('services')}
          className={`relative py-2 text-sm font-medium transition-colors ${settingsTab === 'services' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Services
          {settingsTab === 'services' && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />}
        </button>
      </div>

      {settingsTab === 'features' && (
        <div className="divide-y divide-border px-4">
            <div className="flex items-center justify-between py-3">
              <div className="pr-4">
                <div className="text-sm font-medium">Allow external connections</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Allow connections from external IP addresses — when off, only localhost can access Fury
                  {!localhostOnly && hasCredentials && (
                    <>
                      {' · '}
                      <button
                        onClick={() => openCredentialDialog(false)}
                        className="text-blue-500 dark:text-blue-400 hover:underline"
                      >
                        Edit credentials
                      </button>
                    </>
                  )}
                </div>
              </div>
              <Switch
                checked={!localhostOnly}
                onCheckedChange={handleExternalToggle}
              />
            </div>
            <div className="flex items-center justify-between py-3">
              <div className="pr-4">
                <div className="text-sm font-medium">Prompt suggestions</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Suggest follow-up prompts for stale or idle sessions with incomplete responses
                </div>
              </div>
              <Switch
                checked={promptSuggestionsEnabled}
                onCheckedChange={onPromptSuggestionsChange}
              />
            </div>
            <div className="flex items-center justify-between py-3">
              <div className="pr-4">
                <div className="text-sm font-medium">Enable voice summary</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Read assistant responses aloud after each reply
                </div>
              </div>
              <Switch
                checked={ttsEnabled}
                onCheckedChange={onTtsChange}
              />
            </div>
          </div>
      )}

      {settingsTab === 'services' && (
        <div className="divide-y divide-border px-4">
            <button
              onClick={openSummarizerEditor}
              className="w-full flex items-center justify-between py-3 text-left hover:bg-muted/50 transition-colors -mx-1 px-1 rounded"
            >
              <div className="pr-4">
                <div className="text-sm font-medium">AI Summarizer</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {summarizerLabel}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
            <button
              onClick={openTtsEditor}
              className="w-full flex items-center justify-between py-3 text-left hover:bg-muted/50 transition-colors -mx-1 px-1 rounded"
            >
              <div className="pr-4">
                <div className="text-sm font-medium">Text to Speech</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {ttsLabel}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          </div>
      )}

      {/* Credential dialog */}
      <Dialog
        open={showCredentialDialog}
        onOpenChange={handleCloseCredentialDialog}
        title="External Access Credentials"
        defaultWidth={400}
        defaultHeight={280}
        minWidth={340}
        minHeight={240}
        resizable={false}
        buttons={[
          { label: 'Cancel', onClick: () => handleCloseCredentialDialog(false), variant: 'ghost' },
          {
            label: saving ? 'Saving...' : 'Save',
            onClick: handleSaveCredentials,
            disabled: !username.trim() || !password.trim() || saving,
          },
        ]}
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Set credentials to authorize external access
          </div>
          <div className="space-y-2">
            <Input
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <div className="relative">
              <Input
                type="text"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCredentials(); }}
                className="pr-9"
                style={showPassword ? undefined : { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </Dialog>

      {/* AI Summarizer editor */}
      <Dialog
        open={serviceDialog === 'summarizer'}
        onOpenChange={(open) => { if (!open) setServiceDialog(null); }}
        title="AI Summarizer"
        defaultWidth={420}
        defaultHeight={400}
        minWidth={360}
        minHeight={340}
        resizable={false}
        buttons={[
          { label: 'Cancel', onClick: () => setServiceDialog(null), variant: 'ghost' },
          {
            label: savingService ? 'Saving...' : 'Save',
            onClick: handleSaveSummarizer,
            disabled: !summarizerValid || savingService,
          },
        ]}
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Select a service to use to summarize text
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="summarizer"
                checked={editSummarizerProvider === 'haiku'}
                onChange={() => setEditSummarizerProvider('haiku')}
                className="accent-blue-500"
              />
              <span className="text-sm">Haiku</span>
            </label>
            <div className="ml-6 text-xs text-muted-foreground mt-0.5">State-of-the-art large language model from Anthropic</div>
            {editSummarizerProvider === 'haiku' && (
              <div className="ml-6 mt-2 relative">
                <Input
                  type="text"
                  placeholder={services.hasAnthropicApiKey ? '(key saved)' : 'API key'}
                  value={editApiKey}
                  onChange={(e) => setEditApiKey(e.target.value)}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  className="pr-9 text-sm"
                  style={editShowApiKey ? undefined : { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={() => setEditShowApiKey(!editShowApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {editShowApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="summarizer"
                checked={editSummarizerProvider === 'ollama'}
                onChange={() => setEditSummarizerProvider('ollama')}
                className="accent-blue-500"
              />
              <span className="text-sm">Ollama</span>
            </label>
            <div className="ml-6 text-xs text-muted-foreground mt-0.5">Custom server used to run large language models</div>
            {editSummarizerProvider === 'ollama' && (
              <div className="ml-6 mt-2 flex gap-2">
                <Input
                  placeholder="Host"
                  value={editOllamaHost}
                  onChange={(e) => setEditOllamaHost(e.target.value)}
                  autoComplete="new-password"
                  className="text-sm flex-1"
                />
                <Input
                  placeholder="Port"
                  value={editOllamaPort}
                  onChange={(e) => setEditOllamaPort(e.target.value)}
                  autoComplete="new-password"
                  className="text-sm w-20"
                />
              </div>
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="summarizer"
                checked={editSummarizerProvider === 'none'}
                onChange={() => setEditSummarizerProvider('none')}
                className="accent-blue-500"
              />
              <span className="text-sm">None</span>
            </label>
            <div className="ml-6 text-xs text-muted-foreground mt-0.5">Disable text summarization</div>
          </div>
        </div>
      </Dialog>

      {/* Text to Speech editor */}
      <Dialog
        open={serviceDialog === 'tts'}
        onOpenChange={(open) => { if (!open) setServiceDialog(null); }}
        title="Text to Speech"
        defaultWidth={420}
        defaultHeight={280}
        minWidth={360}
        minHeight={240}
        resizable={false}
        buttons={[
          { label: 'Cancel', onClick: () => setServiceDialog(null), variant: 'ghost' },
          {
            label: savingService ? 'Saving...' : 'Save',
            onClick: handleSaveTts,
            disabled: !ttsValid || savingService,
          },
        ]}
      >
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground">
            Select the text-to-speech engine for audio generation
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="tts"
                checked={editTtsProvider === 'local'}
                onChange={() => setEditTtsProvider('local')}
                className="accent-blue-500"
              />
              <span className="text-sm">Local</span>
            </label>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="tts"
                checked={editTtsProvider === 'remote'}
                onChange={() => setEditTtsProvider('remote')}
                className="accent-blue-500"
              />
              <span className="text-sm">Remote</span>
            </label>
            {editTtsProvider === 'remote' && (
              <div className="ml-6 flex gap-2">
                <Input
                  placeholder="Host"
                  value={editTtsHost}
                  onChange={(e) => setEditTtsHost(e.target.value)}
                  autoComplete="new-password"
                  className="text-sm flex-1"
                />
                <Input
                  placeholder="Port"
                  value={editTtsPort}
                  onChange={(e) => setEditTtsPort(e.target.value)}
                  autoComplete="new-password"
                  className="text-sm w-20"
                />
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
