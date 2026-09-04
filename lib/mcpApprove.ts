import { readFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { atomicWriteFile as atomicWrite } from './atomicWrite';

/**
 * Approval store for project-scoped `.mcp.json` servers.
 *
 * HISTORY (docs/ticket-mcp-auto-approve-stale-trust-store.md): B2 originally
 * wrote the enable into `~/.claude.json → projects[<key>].enabledMcpjsonServers`.
 * The CLI has since moved per-server `.mcp.json` approval into the settings-file
 * system — canonical store `<project>/.claude/settings.local.json` →
 * `enabledMcpjsonServers` — and added a startup migration
 * (`migrateEnableAllProjectMcpServersToSettings`) that sweeps the legacy keys
 * out of `~/.claude.json`. The approval READ path iterates settings sources
 * only, so the legacy write became a no-op deposit that the CLI garbage-collects.
 *
 * P0 probe results (2026-09-04, recorded in the ticket) that shape this module:
 *  - Both CLIs in play (SDK-bundled 2.1.210 and global 2.1.251) READ the
 *    settings.local.json enable, even with `hasTrustDialogAccepted: false`,
 *    under Fury's spawn mode (`bypassPermissions`) — so no trust mutation is
 *    needed and this module never touches `hasTrustDialogAccepted`.
 *  - Under `bypassPermissions` the ONLY state that blocks a registered
 *    `.mcp.json` server from loading is an explicit entry in
 *    `disabledMcpjsonServers` in the settings store — so clearing the name from
 *    the disabled list HERE (not in the legacy store) is load-bearing.
 *  - 2.1.210 still honors the legacy location but immediately migrates it into
 *    settings.local.json, so a belt-and-suspenders legacy write is redundant;
 *    it was dropped rather than kept as compat.
 *
 * Why the per-server list and not `enableAllProjectMcpServers: true`: the flag
 * auto-trusts every FUTURE server someone commits to `.mcp.json`, which is
 * broader consent than the user gave by adding one named server through Fury.
 */

/** Shape of a settings file (settings.local.json). Unknown keys preserved. */
interface SettingsFile {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [k: string]: unknown;
}

// Serialize writes to a given file path WITHIN this process. Concurrent
// registrations (or a stress test) would otherwise race their atomic renames —
// on Windows, `rename` over a destination another handle holds throws EPERM.
// Cross-process contention (the Claude CLI writing the same file — its approval
// dialog and startup migration both write settings.local.json) is handled
// separately by the re-read + verify-retry loop below.
const writeChains = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous op's outcome
  writeChains.set(key, run.then(() => {}, () => {})); // tail never rejects
  return run;
}

/** The CLI's canonical per-project approval store. */
export function localSettingsPath(projectPath: string): string {
  return join(projectPath, '.claude', 'settings.local.json');
}

/** Does this settings file content approve `serverName`? */
function approves(cfg: unknown, serverName: string): boolean {
  const s = cfg as SettingsFile | null;
  return !!s
    && Array.isArray(s.enabledMcpjsonServers)
    && s.enabledMcpjsonServers.includes(serverName)
    && !(Array.isArray(s.disabledMcpjsonServers) && s.disabledMcpjsonServers.includes(serverName));
}

/**
 * Post-write self-check for the route (W3): re-read the EFFECTIVE store and
 * report whether the server is approved there. Kept separate from
 * `approveProjectServer`'s internal verify so the route's check stays honest
 * even if the writer's internals change — this is the early-warning system for
 * the next time the CLI moves its trust store.
 */
export async function isProjectServerApproved(projectPath: string, serverName: string): Promise<boolean> {
  try {
    const raw = await readFile(localSettingsPath(projectPath), 'utf-8');
    return approves(JSON.parse(raw), serverName);
  } catch {
    return false;
  }
}

/**
 * Overlay Fury's own approval knowledge onto a `claude mcp list`-derived server
 * list (the MCP panel's data source).
 *
 * WHY (observed 2026-09-04, MapServer): the CLI's non-interactive `mcp list`
 * evaluates approvals with two gates Fury's real sessions don't have — the
 * workspace-trust gate, and a git-provenance gate on settings.local.json that
 * FAILS CLOSED for non-git projects (indeterminate → treated as repo-tracked →
 * the file is skipped). So for an untrusted and/or non-git project, servers
 * Fury just approved show as "⏸ Pending approval (run `claude` to approve)" —
 * a false negative, with a detail string that tells the user to perform the
 * manual workaround the auto-approve exists to eliminate. Meanwhile an actual
 * session (bypassPermissions) loads them fine (P0, and re-proven live on
 * MapServer: all five javaxt servers `connected` in system:init).
 *
 * So: a project-scoped row the CLI calls `pending` that IS approved in the
 * effective store is upgraded to the same optimistic config-derived `connected`
 * the in-process code-search row uses, with an honest detail. Runtime health
 * for the active session still overrides in the panel (B4 `runtimeFailed`), so
 * a genuinely broken server is not painted green for long.
 *
 * Only `pending` rows are touched — `error`/`needs_auth`/`connected` verdicts
 * carry real information from the CLI's own connection attempt and are kept.
 */
export async function overlayLocalApprovals<
  T extends { name: string; scope: string; status: string; statusDetail?: string },
>(projectPath: string | null, servers: T[]): Promise<T[]> {
  if (!projectPath) return servers;
  return Promise.all(servers.map(async (s) => {
    if (s.scope !== 'project' || s.status !== 'pending') return s;
    if (!(await isProjectServerApproved(projectPath, s.name))) return s;
    return {
      ...s,
      status: 'connected',
      statusDetail: '✔ Approved (Fury, .claude/settings.local.json) — loads in sessions',
    };
  }));
}

/**
 * Trust a project-scoped `.mcp.json` server so any run — Fury's SDK sessions
 * AND an interactive `claude` start — loads it without a dialog: add
 * `serverName` to `enabledMcpjsonServers` and remove it from
 * `disabledMcpjsonServers` in `<project>/.claude/settings.local.json`.
 *
 * That file is SHARED with the CLI (its approval dialog writes enables/disables
 * here, its startup migration merges legacy keys here) and with the user (it
 * also holds `permissions` etc.), so the same hardening the legacy writer had
 * applies:
 *  - per-path in-process write lock (withLock) so our own concurrent
 *    registrations don't race their renames;
 *  - on each attempt RE-READ the latest file and mutate ONLY the two arrays —
 *    every other key rides along untouched (merge-not-clobber, never a
 *    template rewrite);
 *  - atomic temp+rename via lib/atomicWrite.ts;
 *  - VERIFY the enable survived and retry if a racing writer clobbered us.
 *
 * If the file exists but is NOT valid JSON we refuse to write (returning false
 * after retries) rather than clobber a user's hand-edited-but-broken settings —
 * mirroring the CLI's own defer-on-settings-error migration semantics.
 *
 * Creates `<project>/.claude/` if missing. Idempotent.
 */
export async function approveProjectServer(
  projectPath: string,
  serverName: string,
  opts: { maxAttempts?: number; backoffMs?: number } = {},
): Promise<boolean> {
  const settingsPath = localSettingsPath(projectPath);
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 25;

  return withLock(settingsPath, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Re-read the CURRENT file every attempt — never a cached snapshot, so a
        // concurrent (cross-process) writer's changes are merged, not reverted.
        let cfg: SettingsFile = {};
        let raw: string | null = null;
        try {
          raw = await readFile(settingsPath, 'utf-8');
        } catch {
          raw = null; // missing file → start fresh
        }
        if (raw !== null) {
          // A parse failure on an EXISTING file is not ours to fix: writing a
          // fresh template would destroy whatever the user (or a torn write)
          // left there. Retry — a torn concurrent write heals on re-read — and
          // give up (false) if it never parses.
          cfg = JSON.parse(raw) as SettingsFile;
          if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
            throw new Error('settings.local.json is not a JSON object');
          }
        }

        const enabled = Array.isArray(cfg.enabledMcpjsonServers) ? cfg.enabledMcpjsonServers : [];
        const disabled = Array.isArray(cfg.disabledMcpjsonServers) ? cfg.disabledMcpjsonServers : [];
        // Idempotent no-op: already enabled and not disabled → nothing to change.
        if (enabled.includes(serverName) && !disabled.includes(serverName)) return true;
        if (!enabled.includes(serverName)) enabled.push(serverName);
        cfg.enabledMcpjsonServers = enabled;
        // Load-bearing (P0 case g): an explicit disable is the one state that
        // blocks the server under Fury's bypassPermissions sessions.
        if (disabled.length) cfg.disabledMcpjsonServers = disabled.filter(n => n !== serverName);

        await mkdir(dirname(settingsPath), { recursive: true });
        await atomicWrite(settingsPath, JSON.stringify(cfg, null, 2));

        // Verify our enable actually landed (a cross-process writer could have
        // clobbered us between our read and our rename). If not, retry fresh.
        const check = JSON.parse(await readFile(settingsPath, 'utf-8'));
        if (approves(check, serverName)) return true;
      } catch (err) {
        console.error(`[mcpApprove] attempt ${attempt} failed for`, serverName, err);
      }
      await new Promise(r => setTimeout(r, backoffMs * attempt));
    }
    console.error('[mcpApprove] could not persist enable after retries:', serverName);
    return false;
  });
}
