/**
 * Subagent (sidechain) usage ingestion.
 *
 * When a session delegates to Agent/Task subagents, the SDK writes each subagent's
 * turns to a SEPARATE sidecar — `~/.claude/projects/<slug>/<sid>/subagents/agent-*.jsonl`
 * — which the main-transcript archiver never reads. Those tokens are billed to the
 * session but were absent from `usage_events`, so Stats undercounted a delegated
 * session by up to ~10x (docs/ticket-stats-undercount-subagent-tokens.md).
 *
 * This module parses those sidecars into usage events attributed to the PARENT
 * session, marked `is_sidechain` (cost counts them; context/window exclude them).
 * Kept out of transcriptParser.ts (which stays fs-free / client-safe) and out of
 * db.ts / transcriptArchiver.ts (avoids an import cycle) — both of those import here.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { parseTranscriptJsonl, type UsageEvent } from './transcriptParser';
import { projectPathToSlug } from './utils';

/** The subagents sidecar dir for a session: `<projects>/<slug>/<sid>/subagents`. */
export function subagentsDirFor(sessionId: string, project: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(homedir(), '.claude', 'projects', projectPathToSlug(project), sanitized, 'subagents');
}

/**
 * Cache of a subagent file's parsed usage events, keyed by absolute path and
 * invalidated on (mtime, size) change. archiveTranscript re-parses the WHOLE
 * sidecar set on every usage-bearing archive, so a heavily-delegated session
 * (dozens of large agent-*.jsonl) would otherwise re-read+re-parse all of them on
 * each main-turn completion. An append-only transcript's size grows, so size alone
 * would catch most changes; mtime covers a same-size rewrite. Soft-capped so a
 * long-lived server can't grow it without bound.
 */
const fileCache = new Map<string, { mtimeMs: number; size: number; events: UsageEvent[] }>();
const FILE_CACHE_MAX = 10_000;

/**
 * Parse a session's subagent sidecars into usage events billed to the PARENT
 * session. Each subagent file is parsed with the SAME usage logic as the main
 * transcript, then every event is:
 *   - forced `isSidechain: true` (billed → cost counts them; but they run their own
 *     context under a possibly different model → context/window must exclude them);
 *   - re-keyed `"<agentId>:<messageId>"` so two subagents can't collide on the
 *     `usage_events (session_id, message_id)` primary key, and re-archiving stays
 *     idempotent;
 *   - tagged with `agentId` for per-subagent drill-down.
 *
 * Returns [] when there is no sidecar dir (the common, non-delegated case).
 */
export async function parseSubagentUsageEvents(subagentsDir: string): Promise<UsageEvent[]> {
  let files: string[];
  try {
    files = await readdir(subagentsDir);
  } catch {
    return []; // no subagents/ dir → not a delegated session
  }
  const out: UsageEvent[] = [];
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
    const full = join(subagentsDir, f);

    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(full); } catch { continue; }
    if (!st.isFile()) continue;

    const cached = fileCache.get(full);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      out.push(...cached.events);
      continue;
    }

    const agentId = f.slice('agent-'.length, -'.jsonl'.length);
    let content: string;
    try {
      content = await readFile(full, 'utf-8');
    } catch {
      // Transient read failure: serve the last-known events for this file rather than
      // omitting them (a one-off token UNDERCOUNT). Self-heals on the next pass.
      if (cached) out.push(...cached.events);
      continue;
    }
    const events: UsageEvent[] = content.trim()
      ? parseTranscriptJsonl(content).usageEvents.map((u) => ({
          ...u, messageId: `${agentId}:${u.messageId}`, isSidechain: true, agentId,
        }))
      : [];
    if (fileCache.size >= FILE_CACHE_MAX) fileCache.clear();
    fileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, events });
    out.push(...events);
  }
  return out;
}
