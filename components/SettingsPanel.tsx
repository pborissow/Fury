'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import Dialog from '@/components/Dialog';

interface SettingsPanelProps {
  promptSuggestionsEnabled: boolean;
  onPromptSuggestionsChange: (enabled: boolean) => void;
  localhostOnly: boolean;
  onLocalhostOnlyChange: (enabled: boolean) => void;
  hasCredentials: boolean;
  authUsername: string;
  onCredentialsSaved: (username: string) => void;
}

export default function SettingsPanel({
  promptSuggestionsEnabled,
  onPromptSuggestionsChange,
  localhostOnly,
  onLocalhostOnlyChange,
  hasCredentials,
  authUsername,
  onCredentialsSaved,
}: SettingsPanelProps) {
  const [showCredentialDialog, setShowCredentialDialog] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  // Track whether the dialog was opened via the toggle (vs Edit link)
  const [isNewEnable, setIsNewEnable] = useState(false);

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
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUsername: username.trim(),
          authPassword: password,
          ...(isNewEnable ? { localhostOnly: false } : {}),
        }),
      });
      onCredentialsSaved(username.trim());
      if (isNewEnable) onLocalhostOnlyChange(false);
      setShowCredentialDialog(false);
      setUsername('');
      setPassword('');
    } catch (err) {
      console.error('[Settings] Failed to save credentials:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCloseDialog = (open: boolean) => {
    if (!open) {
      setShowCredentialDialog(false);
      setUsername('');
      setPassword('');
      setShowPassword(false);
    }
  };

  return (
    <div className="divide-y divide-border">
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

      <Dialog
        open={showCredentialDialog}
        onOpenChange={handleCloseDialog}
        title="External Access Credentials"
        defaultWidth={400}
        defaultHeight={280}
        minWidth={340}
        minHeight={240}
        resizable={false}
        buttons={[
          { label: 'Cancel', onClick: () => handleCloseDialog(false), variant: 'ghost' },
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
                type={showPassword ? 'text' : 'password'}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCredentials(); }}
                className="pr-9"
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
    </div>
  );
}
