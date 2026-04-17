import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { eventBus } from './eventBus';

const execFileAsync = promisify(execFile);

/**
 * Path separator variants for a project key. `.claude.json` stores project
 * keys with forward slashes on Windows but callers may pass either form, so
 * any lookup into `cfg.projects[...]` must try all variants.
 */
export function projectKeyCandidates(projectPath: string): string[] {
  return Array.from(new Set([
    projectPath,
    projectPath.replace(/\\/g, '/'),
    projectPath.replace(/\//g, '\\'),
  ]));
}

export interface McpServer {
  name: string;
  url: string;
  status: 'connected' | 'needs_auth' | 'error' | 'unknown';
  statusDetail: string;
  scope: 'project' | 'user' | 'unknown';
  transport: 'stdio' | 'http' | 'unknown';
}

interface CacheEntry {
  servers: McpServer[];
  error?: string;
  ts: number;
}

class McpCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<void>>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly REFRESH_INTERVAL = 30_000;
  private readonly FRESH_TTL = 20_000;

  start() {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.refreshAll(), this.REFRESH_INTERVAL);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Look up the scope of a named server from the cache for a projectPath. */
  peekScope(projectPath: string | null, name: string): 'user' | 'project' | null {
    const entry = this.cache.get(projectPath || '');
    const match = entry?.servers.find(s => s.name === name);
    if (!match) return null;
    return match.scope === 'project' ? 'project' : 'user';
  }

  /** Returns cached servers immediately. Triggers background refresh if stale. */
  async get(projectPath: string | null): Promise<{ servers: McpServer[]; error?: string }> {
    const key = projectPath || '';
    const entry = this.cache.get(key);
    const now = Date.now();

    if (entry && now - entry.ts < this.FRESH_TTL) {
      return { servers: entry.servers, error: entry.error };
    }

    if (entry) {
      // Stale: return cached, refresh in background
      this.refresh(projectPath).catch((err) => {
        console.error('[mcpCache] Stale-refresh failed:', err instanceof Error ? err.message : err);
      });
      return { servers: entry.servers, error: entry.error };
    }

    // Cold: fetch synchronously (first-time for this projectPath)
    await this.refresh(projectPath);
    const fresh = this.cache.get(key);
    return { servers: fresh?.servers || [], error: fresh?.error };
  }

  /**
   * Force invalidate and refetch. For user-scope changes, refreshes every
   * cached projectPath in parallel since user servers appear in all projects.
   */
  async invalidate(projectPath: string | null, scope: 'user' | 'project' = 'project'): Promise<void> {
    if (scope === 'user') {
      const keys = new Set(this.cache.keys());
      keys.add(projectPath || '');
      for (const k of keys) this.cache.delete(k);
      await Promise.all(
        Array.from(keys).map(k => this.refresh(k || null).catch(() => { /* logged in doRefresh */ }))
      );
      return;
    }
    this.cache.delete(projectPath || '');
    await this.refresh(projectPath);
  }

  /** Fetch fresh data, dedupe concurrent calls per-key. */
  async refresh(projectPath: string | null): Promise<void> {
    const key = projectPath || '';
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.doRefresh(projectPath).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async refreshAll() {
    const keys = Array.from(this.cache.keys());
    await Promise.all(
      keys.map(k => this.refresh(k || null).catch((err) => {
        console.error('[mcpCache] Background refresh failed:', err instanceof Error ? err.message : err);
      }))
    );
  }

  private async doRefresh(projectPath: string | null): Promise<void> {
    const key = projectPath || '';
    try {
      const servers = await this.fetchServers(projectPath);
      const prev = this.cache.get(key);
      this.cache.set(key, { servers, ts: Date.now() });

      if (!prev || !this.serversEqual(prev.servers, servers)) {
        eventBus.emitApp({
          type: 'mcp:updated',
          projectPath: projectPath || null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[mcpCache] Refresh failed:', message);
      const prev = this.cache.get(key);
      this.cache.set(key, {
        servers: prev?.servers || [],
        error: message,
        ts: Date.now(),
      });
      eventBus.emitApp({
        type: 'mcp:updated',
        projectPath: projectPath || null,
      });
    }
  }

  private async fetchServers(projectPath: string | null): Promise<McpServer[]> {
    const execOpts: { timeout: number; encoding: 'utf-8'; env: NodeJS.ProcessEnv; cwd?: string } = {
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: undefined },
    };
    if (projectPath) execOpts.cwd = projectPath;

    const { stdout, stderr } = await execFileAsync('claude', ['mcp', 'list'], execOpts);
    const output = (stdout || '') + (stderr || '');
    const servers: McpServer[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Checking')) continue;

      const match = trimmed.match(/^(.+?):\s+(.+?)\s+-\s+(.+)$/);
      if (!match) continue;

      const [, name, url, statusText] = match;
      let status: McpServer['status'] = 'unknown';
      if (/needs\s+auth/i.test(statusText)) status = 'needs_auth';
      else if (/connected|ok|running/i.test(statusText)) status = 'connected';
      else if (/error|fail/i.test(statusText)) status = 'error';

      servers.push({
        name: name.trim(),
        url: url.trim(),
        status,
        statusDetail: statusText.trim(),
        scope: 'unknown',
        transport: (url.trim().startsWith('http://') || url.trim().startsWith('https://')) ? 'http' : 'stdio',
      });
    }

    // Classify scope. Claude CLI has three underlying scopes:
    //   user   — ~/.claude.json top-level mcpServers (active everywhere)
    //   local  — ~/.claude.json projects[path].mcpServers (this user, this project)
    //   project— <projectPath>/.mcp.json (shared via git)
    // For display purposes we fold "local" into "project" (both are project-local
    // from the user's POV). Cross-project invalidation only triggers for 'user'.
    const projectLocalNames = new Set<string>();
    if (projectPath) {
      try {
        const raw = await readFile(join(projectPath, '.mcp.json'), 'utf-8');
        const mcpConfig = JSON.parse(raw);
        for (const n of Object.keys(mcpConfig?.mcpServers || {})) projectLocalNames.add(n);
      } catch { /* no .mcp.json */ }
      try {
        const raw = await readFile(join(homedir(), '.claude.json'), 'utf-8');
        const cfg = JSON.parse(raw);
        for (const candidate of projectKeyCandidates(projectPath)) {
          const localServers = cfg?.projects?.[candidate]?.mcpServers || {};
          for (const n of Object.keys(localServers)) projectLocalNames.add(n);
        }
      } catch { /* no ~/.claude.json */ }
    }
    for (const server of servers) {
      if (server.name.startsWith('claude.ai ')) server.scope = 'user';
      else if (projectLocalNames.has(server.name)) server.scope = 'project';
      else server.scope = 'user';
    }

    return servers;
  }

  private serversEqual(a: McpServer[], b: McpServer[]): boolean {
    if (a.length !== b.length) return false;
    const byName = new Map(a.map(s => [s.name, s]));
    for (const y of b) {
      const x = byName.get(y.name);
      if (!x) return false;
      if (x.url !== y.url || x.status !== y.status
        || x.statusDetail !== y.statusDetail || x.scope !== y.scope || x.transport !== y.transport) {
        return false;
      }
    }
    return true;
  }
}

const globalKey = '__fury_mcp_cache__';
export const mcpCache: McpCache =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new McpCache());
