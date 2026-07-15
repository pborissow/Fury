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
}): string[] {
  const live = new Set(args.scannerIds);
  // Persistent SDK processes appear in the scanner even at rest — drop every
  // Fury-managed SDK session, then add back only those actually processing.
  // Net: an SDK session is live iff isProcessing. (Non-Fury SDK/CLI processes
  // are not in sdkManagedIds, so they're left untouched.)
  for (const id of args.sdkManagedIds) live.delete(id);
  for (const id of args.sdkActiveIds) live.add(id);
  // Shipping sessions whose conversation id isn't what the PID file carries.
  for (const id of args.shippingActiveIds) live.add(id);
  return [...live].sort();
}
