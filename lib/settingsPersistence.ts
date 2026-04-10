import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';

export interface AppSettings {
  promptSuggestionsEnabled: boolean;
  localhostOnly: boolean;
}

const DEFAULTS: AppSettings = {
  promptSuggestionsEnabled: true,
  localhostOnly: true,
};

class SettingsPersistence {
  private stateFile: string;

  constructor() {
    this.stateFile = path.join(process.cwd(), '.claude-ui-state', 'settings.json');
  }

  private async ensureStorageDir(): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await fs.mkdir(dir, { recursive: true });
  }

  async loadSettings(): Promise<AppSettings> {
    try {
      const content = await fs.readFile(this.stateFile, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(content) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Synchronous read for use in middleware (Edge-compatible when file exists).
   */
  loadSettingsSync(): AppSettings {
    try {
      const content = readFileSync(this.stateFile, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(content) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async saveSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    await this.ensureStorageDir();
    const current = await this.loadSettings();
    const merged = { ...current, ...updates };
    await fs.writeFile(this.stateFile, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }
}

export const settingsPersistence = new SettingsPersistence();
