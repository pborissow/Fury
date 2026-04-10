'use client';

import { Switch } from '@/components/ui/switch';

interface SettingsPanelProps {
  promptSuggestionsEnabled: boolean;
  onPromptSuggestionsChange: (enabled: boolean) => void;
  localhostOnly: boolean;
  onLocalhostOnlyChange: (enabled: boolean) => void;
}

export default function SettingsPanel({
  promptSuggestionsEnabled,
  onPromptSuggestionsChange,
  localhostOnly,
  onLocalhostOnlyChange,
}: SettingsPanelProps) {
  return (
    <div className="divide-y divide-border">
      <div className="flex items-center justify-between py-3">
        <div className="pr-4">
          <div className="text-sm font-medium">Allow external connections</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Allow connections from external IP addresses — when off, only localhost can access Fury
          </div>
        </div>
        <Switch
          checked={!localhostOnly}
          onCheckedChange={(checked) => onLocalhostOnlyChange(!checked)}
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
    </div>
  );
}
