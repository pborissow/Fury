/**
 * Compute the set of "live" session ids for the Live badge.
 *
 * Definition: a session is live from when a prompt is submitted until the final
 * turn for that prompt is processed — i.e. it is *actively processing*, not
 * merely "has a warm process".
 *
 * The wrinkle both session models create:
 *  - Shipping CLI sessions spawn a fresh `claude --print` per turn that exits
 *    at end of turn, so PID-file existence (liveSessionScanner) already
 *    coincides with "processing". (They also need a manager merge because on
 *    CLI v2.1.144+ the per-spawn PID file carries a spawn-specific id, not the
 *    conversation id — see sessionManager.getActiveSessionIds.)
 *  - Persistent SDK sessions keep ONE warm process alive across turns, so its
 *    PID file lingers in the scanner even at rest. Process existence no longer
 *    means "processing". For these we ignore the scanner and use the manager's
 *    isProcessing instead.
 */
export function computeLiveSessionIds(args: {
  /** Session ids the PID scanner reports as having a live `claude` process. */
  scannerIds: string[];
  /** Shipping sessions currently processing (sessionManager.getActiveSessionIds). */
  shippingActiveIds: string[];
  /** SDK sessions with a warm persistent process, processing or not. */
  sdkManagedIds: string[];
  /** SDK sessions currently processing (sdkSessionManager.getActiveSessionIds). */
  sdkActiveIds: string[];
  /** SDK sessions with in-flight BACKGROUND work but an idle main turn
   *  (sdkSessionManager.getBackgroundActiveSessionIds). Optional so older callers
   *  keep compiling; treated as empty when absent. */
  backgroundActiveIds?: string[];
  /** SDK sessions Fury has a live WARM process for, from the manager-level pid
   *  record (sdkSessionManager.getFuryWarmSessionIds) — independent of the sessions
   *  map. Subtracted alongside sdkManagedIds so a warm-but-idle Fury process is
   *  never counted as live off the scanner even when the session dropped out of the
   *  map (the stale-LIVE-while-idle bug). Optional for back-compat. */
  furyWarmIds?: string[];
}): string[] {
  const live = new Set(args.scannerIds);
  // Persistent SDK processes appear in the scanner even at rest — drop every
  // Fury-managed SDK session, then add back only those actually processing.
  // Net: an SDK session is live iff isProcessing. (Non-Fury SDK/CLI processes
  // are not in sdkManagedIds, so they're left untouched.)
  for (const id of args.sdkManagedIds) live.delete(id);
  // Also drop any session Fury has a warm process for even if it's NOT in the
  // managed map right now (a map<->scanner desync). Keyed on the manager's durable
  // pid record, so an idle warm process can't stay green off the scanner alone.
  for (const id of args.furyWarmIds ?? []) live.delete(id);
  for (const id of args.sdkActiveIds) live.add(id);
  // Re-add SDK sessions whose main turn is idle but which are still driving a
  // background subagent — otherwise the orchestrator reads as dead during the
  // (often multi-minute) wait between its turns. A session is live iff
  // isProcessing OR has in-flight background work. See
  // docs/ticket-live-badge-dark-during-background-subagent.md.
  for (const id of args.backgroundActiveIds ?? []) live.add(id);
  // Shipping sessions whose conversation id isn't what the PID file carries.
  for (const id of args.shippingActiveIds) live.add(id);
  return [...live].sort();
}
