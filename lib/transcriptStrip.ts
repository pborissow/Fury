/**
 * Strip an in-flight turn's partial assistant messages from a transcript.
 *
 * While a turn streams, its partial assistant messages are persisted to the JSONL
 * and would otherwise render as intermediary bubbles above the bouncing dots. The
 * client removes them until the turn completes and collapses cleanly.
 *
 * ANCHOR vs FALLBACK — this is the whole point of the `startedAt` argument:
 *
 *  - `startedAt > 0` (the anchor): slice off every message whose timestamp is
 *    at/after the turn's start. Precise — it removes ONLY this turn's partials and
 *    never touches an earlier completed turn.
 *
 *  - `startedAt === 0` (the fallback, no anchor available): drop the trailing run
 *    of assistant messages after the last user message. This is unsafe when a
 *    mid-turn prompt ("please continue") was folded by the CLI into the next
 *    `tool_result` — array content the parser never emits as a user message — so
 *    the walk-back crosses EVERY trailing assistant and cuts earlier completed
 *    turns too. Kept only for when no anchor exists; callers should pass the real
 *    `startedAt` (from the stream buffer / session:health event) whenever they can.
 *
 * Pure and generic so it can be unit-tested directly and shared by ChatTab's
 * initial-restore and latch-break paths.
 */
export function stripInFlightPartials<T extends { role: string; timestamp?: string }>(
  messages: T[],
  startedAt: number,
): T[] {
  if (startedAt > 0) {
    const cutIdx = messages.findIndex((m) => {
      if (!m.timestamp) return false;
      const t = Date.parse(m.timestamp);
      return Number.isFinite(t) && t >= startedAt;
    });
    return cutIdx >= 0 ? messages.slice(0, cutIdx) : messages;
  }
  // No anchor — drop the trailing assistant run after the last real user prompt.
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === 'assistant') end--;
  return messages.slice(0, end);
}

/**
 * The COMMITTED intermediate assistant messages of an open logical-task
 * ENVELOPE (docs/ticket-subagent-notification-turns-intermediate-bubbles.md).
 *
 * Since Claude Code 2.1.26x, one user send can span many result-terminated
 * turns (each background-task <task-notification> drives its own turn). While
 * the envelope is open the main transcript flow hides everything committed
 * at/after `envelopeStartedAt` (via stripInFlightPartials with that anchor);
 * THIS selects the subset the dots-bubble modal shows on demand:
 *
 *  - assistant messages only (the envelope's opening user send is represented
 *    by the overlay bubble; internal <task-notification> user strings never
 *    leave the parser);
 *  - committed at/after the envelope's opening turn start;
 *  - EXCLUDING the currently-streaming turn's own in-flight partials
 *    (timestamp ≥ `turnStartedAt`, when a main turn is active) — those are
 *    exactly what stripInFlightPartials has always kept off screen mid-turn,
 *    and they'd render as half-finished duplicates of the turn's final. Pass
 *    `turnStartedAt: null` outside the main-turn phase (liveness.startedAt is
 *    null there) so every committed message of the envelope is shown.
 *
 * Pure so it can be unit-tested and shared (same contract style as
 * stripInFlightPartials above).
 */
export function envelopeHiddenMessages<T extends { role: string; timestamp?: string }>(
  messages: T[],
  envelopeStartedAt: number,
  turnStartedAt: number | null,
): T[] {
  return messages.filter((m) => {
    if (m.role !== 'assistant' || !m.timestamp) return false;
    const t = Date.parse(m.timestamp);
    if (!Number.isFinite(t) || t < envelopeStartedAt) return false;
    if (typeof turnStartedAt === 'number' && t >= turnStartedAt) return false;
    return true;
  });
}
