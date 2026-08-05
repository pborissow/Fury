import { readFile, writeFile, rename, rm } from 'fs/promises';

/** Shape of a per-project entry in ~/.claude.json we care about. */
interface ProjectEntry {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [k: string]: unknown;
}

// Serialize writes to a given config path WITHIN this process. Concurrent
// registrations (or a stress test) would otherwise race their atomic renames —
// on Windows, `rename` over a destination another handle holds throws EPERM.
// Cross-process contention (the Claude CLI writing the same file) is handled
// separately by the re-read + verify-retry loop below.
const writeChains = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous op's outcome
  writeChains.set(key, run.then(() => {}, () => {})); // tail never rejects
  return run;
}

let tmpCounter = 0;

/**
 * Write `data` to `cfgPath` atomically: temp file in the same dir, then rename
 * over the target. Retries EPERM/EACCES on the rename — on Windows a concurrent
 * writer holding the destination makes rename transiently fail even though the
 * swap is legal a moment later.
 */
async function atomicWrite(cfgPath: string, data: string): Promise<void> {
  const tmp = `${cfgPath}.fury-${process.pid}-${tmpCounter++}.tmp`;
  await writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, cfgPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES') && i < 10) {
        await new Promise(r => setTimeout(r, 5 * (i + 1)));
        continue;
      }
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

export function newProjectDefaults(): ProjectEntry {
  return {
    allowedTools: [] as string[], mcpContextUris: [] as string[], mcpServers: {},
    enabledMcpjsonServers: [] as string[], disabledMcpjsonServers: [] as string[],
    hasTrustDialogAccepted: false, projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

/**
 * Trust a project-scoped `.mcp.json` server so a non-interactive run loads it:
 * add `serverName` to `projects[<key>].enabledMcpjsonServers` in `cfgPath`
 * (normally ~/.claude.json).
 *
 * That file is written constantly by every Claude process (session metadata,
 * costs, history). The old unlocked read-modify-write lost this enable under
 * concurrent access (classic lost update) — on a fresh/untrusted project that
 * silently means "This project" never loads. (B2 in
 * docs/ticket-local-mcp-this-project-fails-first-use.md.)
 *
 * Hardened against the race: on each attempt RE-READ the latest file (so we
 * merge onto a concurrent writer's changes rather than reviving a stale
 * snapshot), write a sibling temp file + atomic rename, then VERIFY the enable
 * survived and RETRY if a racing writer clobbered us. Idempotent. Full file
 * locking would need a new dependency; re-read + atomic-rename + verify-retry
 * closes the practical window a lost update needs.
 *
 * `key` derivation matches the CLI's own project key (`projectPath` with
 * backslashes normalized to forward slashes).
 */
export async function approveProjectServer(
  cfgPath: string,
  projectPath: string,
  serverName: string,
  opts: { maxAttempts?: number; backoffMs?: number } = {},
): Promise<boolean> {
  const key = projectPath.replace(/\\/g, '/');
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 25;

  const persisted = (cfg: unknown): boolean => {
    const list = (cfg as { projects?: Record<string, ProjectEntry> })
      ?.projects?.[key]?.enabledMcpjsonServers;
    return Array.isArray(list) && list.includes(serverName);
  };

  return withLock(cfgPath, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Re-read the CURRENT file every attempt — never a cached snapshot, so a
        // concurrent (cross-process) writer's changes are merged, not reverted.
        let cfg: Record<string, unknown> = {};
        try {
          cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          cfg = {};
        }

        const projects = (cfg.projects ?? (cfg.projects = {})) as Record<string, ProjectEntry>;
        if (!projects[key]) projects[key] = newProjectDefaults();

        const enabled = projects[key].enabledMcpjsonServers || [];
        const disabled = projects[key].disabledMcpjsonServers || [];
        // Idempotent no-op: already enabled and not on the disabled list → nothing to
        // change. Return without rewriting the large, hot ~/.claude.json.
        if (enabled.includes(serverName) && !disabled.includes(serverName)) return true;
        if (!enabled.includes(serverName)) enabled.push(serverName);
        projects[key].enabledMcpjsonServers = enabled;
        projects[key].disabledMcpjsonServers = disabled.filter(n => n !== serverName);

        await atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));

        // Verify our enable actually landed (a cross-process writer could have
        // clobbered us between our read and our rename). If not, retry fresh.
        const check = JSON.parse(await readFile(cfgPath, 'utf-8'));
        if (persisted(check)) return true;
      } catch (err) {
        console.error(`[mcpApprove] attempt ${attempt} failed for`, serverName, err);
      }
      await new Promise(r => setTimeout(r, backoffMs * attempt));
    }
    console.error('[mcpApprove] could not persist enable after retries:', serverName);
    return false;
  });
}
