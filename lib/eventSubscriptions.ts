import { randomUUID } from 'crypto';
import { fileWatchers } from './fileWatchers';

/**
 * Per-connection state for `/api/events` streams: which sessions each open
 * stream is watching.
 *
 * WHY: a session's events (`session-stream`, `session-health`, …) used to need
 * their own `/api/events?sessionId=…` stream, one more permanent socket per
 * window. A browser has ~6 HTTP/1.1 connections per origin, shared by every tab,
 * window and PWA, so two windows ran out and every ordinary fetch hung. Now the
 * session is watched over the window's ONE shared stream instead: `connected`
 * returns a `subscriptionId`, and `POST /api/events` adds or removes watched
 * sessions for it (the same pattern as `/api/tree/watch`).
 *
 * Every watch holds one `fileWatchers.watchTranscript` reference, and `close()`
 * releases all of them, so a stream torn down by abort, cancel or the liveness
 * probe can't leave a transcript watcher behind.
 */

/** Claude session ids are UUIDs; accept any plain token, and reject anything
 *  path-like, since the id ends up in a watched file path. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROJECT_LEN = 4096;
/** A window watches the one session it views. Anything past this is a bug or abuse. */
const MAX_SESSIONS_PER_SUBSCRIPTION = 32;

export interface SessionWatch {
  sessionId: string;
  project: string;
}

interface Subscription {
  /** watched sessionId → project */
  sessions: Map<string, string>;
}

export function isValidSessionWatch(w: unknown): w is SessionWatch {
  if (!w || typeof w !== 'object') return false;
  const { sessionId, project } = w as Record<string, unknown>;
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)
    && typeof project === 'string' && project.length > 0 && project.length <= MAX_PROJECT_LEN;
}

export class EventSubscriptionRegistry {
  private subs = new Map<string, Subscription>();

  create(): string {
    const id = randomUUID();
    this.subs.set(id, { sessions: new Map() });
    return id;
  }

  has(id: string): boolean {
    return this.subs.has(id);
  }

  /** Start delivering `sessionId`'s events to this stream. Idempotent.
   *  `'full'` means the watch was NOT added (per-subscription cap); the caller
   *  must report it rather than let the client treat it as confirmed. */
  watch(id: string, sessionId: string, project: string): 'ok' | 'unknown' | 'full' {
    const sub = this.subs.get(id);
    if (!sub) return 'unknown';
    if (sub.sessions.has(sessionId)) return 'ok';
    if (sub.sessions.size >= MAX_SESSIONS_PER_SUBSCRIPTION) return 'full';
    sub.sessions.set(sessionId, project);
    fileWatchers.watchTranscript(sessionId, project);
    return 'ok';
  }

  /** Stop delivering `sessionId`'s events. Idempotent.
   *  Returns false if the subscription is gone. */
  unwatch(id: string, sessionId: string): boolean {
    const sub = this.subs.get(id);
    if (!sub) return false;
    if (sub.sessions.delete(sessionId)) fileWatchers.unwatchTranscript(sessionId);
    return true;
  }

  isWatching(id: string, sessionId: string): boolean {
    return this.subs.get(id)?.sessions.has(sessionId) ?? false;
  }

  /** Drop the subscription and release every transcript watch it held. */
  close(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    for (const sessionId of sub.sessions.keys()) fileWatchers.unwatchTranscript(sessionId);
    sub.sessions.clear();
  }

  stats(): Record<string, number> {
    let watched = 0;
    for (const sub of this.subs.values()) watched += sub.sessions.size;
    return { subscriptions: this.subs.size, watchedSessions: watched };
  }
}

// Survive Next.js HMR: the GET stream and the POST control channel must share
// the same live subscriptions.
const globalKey = '__fury_event_subscriptions__';
export const eventSubscriptions: EventSubscriptionRegistry =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new EventSubscriptionRegistry());

export function eventSubscriptionStats(): Record<string, number> {
  return eventSubscriptions.stats();
}
