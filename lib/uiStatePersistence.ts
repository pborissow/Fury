import fs from 'fs/promises';
import path from 'path';

interface UIState {
  activeTab: 'chat' | 'canvas';
  activeWorkflowId: string | null;
  lastUpdated: number;
}

class UIStatePersistence {
  private stateFile: string;

  constructor() {
    // Store UI state in .claude-ui-state directory
    this.stateFile = path.join(process.cwd(), '.claude-ui-state', 'state.json');
  }

  /**
   * Initialize storage directory
   */
  private async ensureStorageDir(): Promise<void> {
    try {
      const dir = path.dirname(this.stateFile);
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error('Failed to create UI state storage directory:', error);
      throw error;
    }
  }

  /**
   * Load UI state
   */
  async loadState(): Promise<UIState | null> {
    try {
      const content = await fs.readFile(this.stateFile, 'utf-8');
      const state: UIState = JSON.parse(content);
      console.log('[UIStatePersistence] Loaded UI state');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[UIStatePersistence] No UI state found');
        return null;
      }
      console.error('[UIStatePersistence] Failed to load UI state:', error);
      throw error;
    }
  }

  /**
   * Save UI state
   */
  async saveState(state: Partial<UIState>): Promise<void> {
    try {
      await this.ensureStorageDir();

      // Load existing state and merge with new state
      const existingState = await this.loadState();
      const newState: UIState = {
        activeTab: state.activeTab ?? existingState?.activeTab ?? 'chat',
        activeWorkflowId: state.activeWorkflowId ?? existingState?.activeWorkflowId ?? null,
        lastUpdated: Date.now(),
      };

      await fs.writeFile(this.stateFile, JSON.stringify(newState, null, 2), 'utf-8');
      console.log('[UIStatePersistence] Saved UI state');
    } catch (error) {
      console.error('[UIStatePersistence] Failed to save UI state:', error);
      throw error;
    }
  }
}

// Singleton instance
export const uiStatePersistence = new UIStatePersistence();
export type { UIState };
