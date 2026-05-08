/**
 * Append-only log of provider-switch events.
 *
 * Lives at ~/.claude/provider-fallback-log.jsonl. Each line is a JSON
 * object describing a single provider transition. The log doubles as:
 *
 *  1. A durable record of "is there a pending switch-back to Anthropic?"
 *     so the auto-failover survives server restarts.
 *  2. An audit trail of when and why we toggled providers.
 *
 * To find the current pending switch-back, walk the log from newest to
 * oldest and return the most recent `switched-to-bedrock` event that
 * carries a `scheduledReturnAt`, *unless* a later `switched-to-anthropic`
 * event resolved it.
 */

import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude');
const FALLBACK_LOG_PATH = join(CLAUDE_DIR, 'provider-fallback-log.jsonl');

export type FallbackLogEventType =
  | 'switched-to-bedrock'
  | 'switched-to-anthropic';

export type SwitchTrigger =
  | 'manual'
  | 'auto-failover'
  | 'scheduled'
  /** Boot rehydration found a past-due failover and switched back. */
  | 'rehydrated-past-due'
  /**
   * Boot rehydration found a pending failover record but the provider
   * was already on Anthropic, so the entry is just a bookkeeping
   * resolution — no actual switch happened.
   */
  | 'rehydrated-already-resolved';

export interface FallbackLogEntry {
  type: FallbackLogEventType;
  ts: number;
  trigger?: SwitchTrigger;
  /** Raw reset-time string captured from the CLI message, if any. */
  rawResetTime?: string;
  /**
   * Epoch-ms moment at which we should switch back to Anthropic. Only
   * present on `switched-to-bedrock` events triggered by auto-failover
   * with a parseable reset time. Includes any safety buffer the
   * scheduler chose (currently +2 minutes).
   */
  scheduledReturnAt?: number;
  reason?: string;
  note?: string;
}

export interface PendingSwitchBack {
  /** ts of the originating `switched-to-bedrock` event. */
  triggeredAt: number;
  scheduledReturnAt: number;
  rawResetTime?: string;
}

function getLogPath(): string {
  return FALLBACK_LOG_PATH;
}

async function ensureDir(): Promise<void> {
  const dir = dirname(getLogPath());
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Append a single entry. Each entry is written as one JSON line so the
 * file remains a valid JSONL stream even on partial writes.
 *
 * Concurrency note: relies on POSIX `O_APPEND` atomicity for line-sized
 * writes — safe on macOS/Linux. On Windows the OS does not guarantee
 * append atomicity, so two concurrent failover events from different
 * Claude sessions could interleave bytes. If/when this ships on
 * Windows, replace with a per-process serialization queue.
 */
export async function appendFallbackLogEntry(
  entry: FallbackLogEntry,
): Promise<void> {
  await ensureDir();
  const line = JSON.stringify(entry) + '\n';
  await appendFile(getLogPath(), line, 'utf-8');
}

/**
 * Read all entries from the log. Tolerates corrupt/partial lines by
 * skipping them. Returns entries in file order (oldest → newest).
 */
export async function readFallbackLog(): Promise<FallbackLogEntry[]> {
  if (!existsSync(getLogPath())) return [];
  const raw = await readFile(getLogPath(), 'utf-8');
  const lines = raw.split('\n');
  const out: FallbackLogEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FallbackLogEntry;
      if (
        parsed &&
        typeof parsed.ts === 'number' &&
        (parsed.type === 'switched-to-bedrock' ||
          parsed.type === 'switched-to-anthropic')
      ) {
        out.push(parsed);
      }
    } catch {
      // Skip malformed lines silently — append-only log; a partial
      // write should not break the whole file.
    }
  }
  return out;
}

/**
 * Walk the log backwards to find the most recent unresolved
 * Bedrock failover that has a scheduled return time.
 *
 * Returns null if:
 *  - the log is empty,
 *  - the latest switch event is `switched-to-anthropic` (already resolved),
 *  - the latest `switched-to-bedrock` event has no `scheduledReturnAt`
 *    (manual switch, no auto-return planned).
 */
export async function getPendingSwitchBack(): Promise<PendingSwitchBack | null> {
  const entries = await readFallbackLog();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'switched-to-anthropic') {
      // Most recent transition is back to Anthropic — nothing pending.
      return null;
    }
    if (e.type === 'switched-to-bedrock') {
      if (typeof e.scheduledReturnAt === 'number') {
        return {
          triggeredAt: e.ts,
          scheduledReturnAt: e.scheduledReturnAt,
          rawResetTime: e.rawResetTime,
        };
      }
      // Manual Bedrock switch with no scheduled return — nothing
      // pending. Stop walking; older Bedrock entries are irrelevant.
      return null;
    }
  }
  return null;
}
