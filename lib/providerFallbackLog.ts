/**
 * Append-only log of provider-switch events.
 *
 * Lives at ~/.fury/provider-fallback-log.jsonl (see lib/furyHome.ts). Each
 * line is a JSON object describing a single provider transition. The log
 * doubles as:
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
import { dirname } from 'path';
import { furyProviderFallbackLogPath } from './furyHome';

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
  return furyProviderFallbackLogPath();
}

async function ensureDir(): Promise<void> {
  const dir = dirname(getLogPath());
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Per-process write queue. Serializes all appends so concurrent async
 * callers within the same Node process cannot interleave bytes.
 *
 * This is necessary on Windows where `O_APPEND` does not guarantee
 * atomicity the way POSIX does. Cross-process atomicity would require
 * file locking, but within a single Fury server instance this queue
 * is sufficient.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Append a single entry. Each entry is written as one JSON line so the
 * file remains a valid JSONL stream even on partial writes.
 *
 * Writes are serialized via `writeQueue` to prevent interleaved bytes
 * on Windows. On macOS/Linux POSIX `O_APPEND` already guarantees this,
 * but the queue is harmless there and keeps behavior consistent.
 */
export async function appendFallbackLogEntry(
  entry: FallbackLogEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  const op = writeQueue.then(async () => {
    await ensureDir();
    await appendFile(getLogPath(), line, 'utf-8');
  });
  // Don't let a failed write block subsequent writes.
  writeQueue = op.catch(() => {});
  await op;
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
