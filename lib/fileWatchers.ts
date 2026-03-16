import fs from 'fs';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { eventBus } from './eventBus';
import { projectPathToSlug } from './utils';

class FileWatchers {
  private historyWatcher: fs.FSWatcher | null = null;
  private transcriptWatchers = new Map<string, fs.FSWatcher>();
  private historyDebounce: NodeJS.Timeout | null = null;
  private transcriptDebounces = new Map<string, NodeJS.Timeout>();
  /** Reference count per sessionId — only unwatch when it drops to 0 */
  private transcriptRefCounts = new Map<string, number>();
  /** Directory watchers waiting for a JSONL file to appear */
  private pendingDirWatchers = new Map<string, fs.FSWatcher>();
  /** Track project per sessionId for emitting events from dir watchers */
  private sessionProjects = new Map<string, string>();

  /** Start watching ~/.claude/history.jsonl. Idempotent. */
  startHistoryWatcher() {
    if (this.historyWatcher) return;
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    try {
      this.historyWatcher = fs.watch(historyPath, () => {
        if (this.historyDebounce) clearTimeout(this.historyDebounce);
        this.historyDebounce = setTimeout(() => {
          eventBus.emitApp({ type: 'history-updated' });
        }, 500);
      });
      this.historyWatcher.on('error', () => {
        // File may have been deleted/recreated — close and retry
        this.historyWatcher?.close();
        this.historyWatcher = null;
        setTimeout(() => this.startHistoryWatcher(), 30_000);
      });
    } catch {
      // File doesn't exist yet — retry later
      setTimeout(() => this.startHistoryWatcher(), 30_000);
    }
  }

  /** Start watching a specific session's JSONL for transcript changes. Idempotent per sessionId with ref counting. */
  watchTranscript(sessionId: string, project: string) {
    this.sessionProjects.set(sessionId, project);

    // Bump ref count
    const refCount = (this.transcriptRefCounts.get(sessionId) || 0) + 1;
    this.transcriptRefCounts.set(sessionId, refCount);

    // Already watching — just bump the count
    if (this.transcriptWatchers.has(sessionId)) return;
    // Already waiting for file creation — just bump the count
    if (this.pendingDirWatchers.has(sessionId)) return;

    this.tryWatchFile(sessionId, project);
  }

  private tryWatchFile(sessionId: string, project: string) {
    const slug = projectPathToSlug(project);
    const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);

    if (existsSync(jsonlPath)) {
      this.attachFileWatcher(sessionId, project, jsonlPath);
    } else {
      // File doesn't exist yet — watch the parent directory for its creation
      this.watchDirForFile(sessionId, project, jsonlPath);
    }
  }

  private attachFileWatcher(sessionId: string, project: string, jsonlPath: string) {
    // Clean up any pending dir watcher
    const dirWatcher = this.pendingDirWatchers.get(sessionId);
    if (dirWatcher) {
      dirWatcher.close();
      this.pendingDirWatchers.delete(sessionId);
    }

    // Don't double-watch
    if (this.transcriptWatchers.has(sessionId)) return;

    try {
      const watcher = fs.watch(jsonlPath, () => {
        const existing = this.transcriptDebounces.get(sessionId);
        if (existing) clearTimeout(existing);
        this.transcriptDebounces.set(sessionId, setTimeout(() => {
          const proj = this.sessionProjects.get(sessionId) || project;
          eventBus.emitApp({
            type: 'transcript:updated',
            sessionId,
            project: proj,
          });
        }, 500));
      });
      watcher.on('error', () => {
        // File may have been deleted — clean up and fall back to dir watching
        this.transcriptWatchers.delete(sessionId);
        watcher.close();
        // If still referenced, try to re-watch
        if ((this.transcriptRefCounts.get(sessionId) || 0) > 0) {
          this.watchDirForFile(sessionId, project, jsonlPath);
        }
      });
      this.transcriptWatchers.set(sessionId, watcher);
    } catch {
      // Watch failed — fall back to dir watching
      this.watchDirForFile(sessionId, project, join(dirname(jsonlPath), `${sessionId}.jsonl`));
    }
  }

  private watchDirForFile(sessionId: string, project: string, jsonlPath: string) {
    // Already watching dir for this session
    if (this.pendingDirWatchers.has(sessionId)) return;

    const dir = dirname(jsonlPath);
    try {
      // Ensure the directory exists (it may not for brand-new projects)
      if (!existsSync(dir)) return;

      const dirWatcher = fs.watch(dir, (_eventType, filename) => {
        if (filename === `${sessionId}.jsonl` && existsSync(jsonlPath)) {
          // File has appeared — switch to file-level watching
          this.attachFileWatcher(sessionId, project, jsonlPath);
        }
      });
      dirWatcher.on('error', () => {
        dirWatcher.close();
        this.pendingDirWatchers.delete(sessionId);
      });
      this.pendingDirWatchers.set(sessionId, dirWatcher);
    } catch {
      // Directory doesn't exist or can't be watched — give up silently
    }
  }

  unwatchTranscript(sessionId: string) {
    if (!this.transcriptRefCounts.has(sessionId)) return;

    // Decrement ref count
    const refCount = (this.transcriptRefCounts.get(sessionId) || 0) - 1;
    if (refCount > 0) {
      this.transcriptRefCounts.set(sessionId, refCount);
      return; // Other clients still watching
    }

    // Ref count hit 0 — clean up everything
    this.transcriptRefCounts.delete(sessionId);
    this.sessionProjects.delete(sessionId);

    const watcher = this.transcriptWatchers.get(sessionId);
    if (watcher) {
      watcher.close();
      this.transcriptWatchers.delete(sessionId);
    }
    const dirWatcher = this.pendingDirWatchers.get(sessionId);
    if (dirWatcher) {
      dirWatcher.close();
      this.pendingDirWatchers.delete(sessionId);
    }
    const debounce = this.transcriptDebounces.get(sessionId);
    if (debounce) {
      clearTimeout(debounce);
      this.transcriptDebounces.delete(sessionId);
    }
  }

  stopAll() {
    if (this.historyWatcher) {
      this.historyWatcher.close();
      this.historyWatcher = null;
    }
    if (this.historyDebounce) {
      clearTimeout(this.historyDebounce);
      this.historyDebounce = null;
    }
    for (const id of [...this.transcriptWatchers.keys()]) {
      this.unwatchTranscript(id);
    }
    for (const [, watcher] of [...this.pendingDirWatchers.entries()]) {
      watcher.close();
    }
    this.pendingDirWatchers.clear();
    this.transcriptRefCounts.clear();
    this.sessionProjects.clear();
  }
}

// Singleton with globalThis protection for Next.js HMR
const globalKey = '__fury_file_watchers__';
export const fileWatchers: FileWatchers =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new FileWatchers());
