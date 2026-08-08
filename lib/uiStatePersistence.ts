import fs from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from './atomicWrite';
import { recoverCorruptJsonFile } from './corruptState';

interface UIState {
  // NOTE: activeTab is intentionally absent. Fury always starts on the Chat
  // tab, so there's nothing to restore. Any activeTab left in an existing
  // state.json is ignored and dropped on the next write.
  activeWorkflowId: string | null;
  chatHorizontalLayout: number[] | null;
  chatVerticalLayout: number[] | null;
  canvasHorizontalLayout: number[] | null;
  // Stats tab view preferences — the last-used filters, restored on return so a
  // "$ / 30d / sorted by cost" view survives a reload. Each is null until the
  // user first touches that control; the Stats tab falls back to its own default
  // (all-time range, cost measure, sorted by date descending). Unlike activeTab
  // (deliberately not restored),
  // these ARE worth restoring: they're the analyst's working view, not a
  // navigation position.
  statsMeasure: 'cost' | 'tokens' | null;
  statsRange: 'all' | 'mtd' | '7d' | '30d' | '90d' | null;
  /** A sessions-table column key. Validated against the live column set on
   *  restore, so a renamed/removed column can't wedge sorting. */
  statsSortKey: string | null;
  statsSortDir: 1 | -1 | null;
  statsOnlyFlagged: boolean | null;
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
   * Load UI state. Returns null when there is nothing usable on disk.
   *
   * Unreadable state is treated exactly like absent state. This used to rethrow,
   * which was badly disproportionate for cosmetic layout data: saveState calls
   * loadState first, so a single corrupt byte wedged BOTH endpoints at HTTP 500
   * forever — the file could never be rewritten, and only deleting it by hand
   * recovered. Now a bad file is quarantined and the next save replaces it.
   */
  async loadState(): Promise<UIState | null> {
    let content: string;
    try {
      content = await fs.readFile(this.stateFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[UIStatePersistence] No UI state found');
        return null;
      }
      console.error('[UIStatePersistence] Failed to read UI state:', error);
      throw error; // a real I/O fault (EACCES, EISDIR) is worth surfacing
    }

    let parseError: unknown;
    try {
      const parsed = JSON.parse(content);
      // A non-object parses fine but is not state — treat it as corrupt rather
      // than handing callers a string/array/null to spread.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        console.log('[UIStatePersistence] Loaded UI state');
        return parsed as UIState;
      }
      parseError = new Error(`expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    } catch (error) {
      parseError = error;
    }

    // Shared with settingsPersistence so the two cannot drift: salvage the last
    // complete record if there is one (the layout survives), otherwise preserve
    // the bytes at state.json.corrupt and start clean.
    const recovered = await recoverCorruptJsonFile(
      this.stateFile, content, 'UIStatePersistence', parseError,
    );
    return (recovered as UIState | null) ?? null;
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
        activeWorkflowId: state.activeWorkflowId ?? existingState?.activeWorkflowId ?? null,
        chatHorizontalLayout: state.chatHorizontalLayout ?? existingState?.chatHorizontalLayout ?? null,
        chatVerticalLayout: state.chatVerticalLayout ?? existingState?.chatVerticalLayout ?? null,
        canvasHorizontalLayout: state.canvasHorizontalLayout ?? existingState?.canvasHorizontalLayout ?? null,
        // `??` (not `||`) so statsOnlyFlagged: false persists correctly rather
        // than collapsing to the existing value. Each field merges independently,
        // so a layout-only or workflow-only POST leaves these untouched.
        statsMeasure: state.statsMeasure ?? existingState?.statsMeasure ?? null,
        statsRange: state.statsRange ?? existingState?.statsRange ?? null,
        statsSortKey: state.statsSortKey ?? existingState?.statsSortKey ?? null,
        statsSortDir: state.statsSortDir ?? existingState?.statsSortDir ?? null,
        statsOnlyFlagged: state.statsOnlyFlagged ?? existingState?.statsOnlyFlagged ?? null,
        lastUpdated: Date.now(),
      };

      // Atomic: a plain writeFile truncates then writes, so two servers sharing a
      // cwd could splice one document onto the tail of a longer one — which is
      // exactly the corruption this file recovered from. See ./atomicWrite.
      await atomicWriteFile(this.stateFile, JSON.stringify(newState, null, 2));
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
