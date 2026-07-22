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
