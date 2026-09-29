import type { TranscriptMsg } from './types';

/**
 * A conversation turn: one user prompt, its final assistant reply, and any
 * "intermediary" messages in between (earlier assistant texts + recovered
 * AskUserQuestion answers), surfaced via the "+N intermediary" chip.
 *
 * userIndex/assistantIndex are the messages' FLAT indices in the input array —
 * the same indexing the transcript archive stores as `turn_index` and a
 * Search-result deep link carries — emitted as data-msg-index for scroll-into-view.
 */
export interface Turn<M extends TranscriptMsg = TranscriptMsg> {
  user: M | null;
  assistant: M | null;
  intermediaries: M[];
  userIndex: number | null;
  assistantIndex: number | null;
}

/**
 * Group a flat message list into turns.
 *
 * - A normal user message starts a new turn.
 * - An `askAnswer` user message (a recovered AskUserQuestion answer) does NOT
 *   start a turn — it belongs inside the current one as an intermediary. The
 *   current assistant (the question preamble) is demoted FIRST so the list reads
 *   preamble → answer → continuation in chronological order.
 * - Assistant messages accumulate; the last is the visible bubble, earlier ones
 *   become intermediaries.
 *
 * - An `askQuestion` assistant message (the question half of an exchange) needs
 *   no special case in the loop: it becomes the current assistant, and the
 *   askAnswer that always follows it demotes it into intermediaries.
 *
 * Normalization pass: a turn whose assistant was cleared by an in-turn answer
 * with no later assistant text (the user stopped the turn, it errored, or the
 * continuation was tool-only) would otherwise render nothing — the chip only
 * exists on the assistant bubble. Promote the last non-question assistant
 * intermediary (Claude's preamble) back to the bubble so it stays visible.
 */
export function groupTurns<M extends TranscriptMsg>(messages: M[]): Turn<M>[] {
  const turns: Turn<M>[] = [];
  let currentTurn: Turn<M> = { user: null, assistant: null, intermediaries: [], userIndex: null, assistantIndex: null };
  const hasContent = (t: Turn<M>) => t.user || t.assistant || t.intermediaries.length;
  // Flat index of each message (by object identity), so a promoted intermediary
  // can recover its data-msg-index for Search scroll-into-view.
  const indexOf = new Map<M, number>();
  for (let i = 0; i < messages.length; i++) indexOf.set(messages[i], i);

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    if (msg.role === 'user' && msg.askAnswer) {
      if (currentTurn.assistant) {
        currentTurn.intermediaries.push(currentTurn.assistant);
        currentTurn.assistant = null;
        currentTurn.assistantIndex = null;
      }
      currentTurn.intermediaries.push(msg);
    } else if (msg.role === 'user') {
      if (hasContent(currentTurn)) turns.push(currentTurn);
      currentTurn = { user: msg, assistant: null, intermediaries: [], userIndex: msgIndex, assistantIndex: null };
    } else {
      if (currentTurn.assistant) currentTurn.intermediaries.push(currentTurn.assistant);
      currentTurn.assistant = msg;
      currentTurn.assistantIndex = msgIndex;
    }
  }
  if (hasContent(currentTurn)) turns.push(currentTurn);

  for (const t of turns) {
    if (!t.assistant && t.intermediaries.length) {
      for (let k = t.intermediaries.length - 1; k >= 0; k--) {
        // Skip question messages: promoting one would show a single question
        // out of its exchange. A text-less question turn instead keeps
        // assistant null and the renderer anchors the chip to the You bubble.
        if (t.intermediaries[k].role === 'assistant' && !t.intermediaries[k].askQuestion) {
          t.assistant = t.intermediaries[k];
          t.assistantIndex = indexOf.get(t.intermediaries[k]) ?? null;
          t.intermediaries.splice(k, 1);
          break;
        }
      }
    }
  }

  return turns;
}

/**
 * The flat index at which to cut the transcript to rewind to turn `turnIndex`
 * (the ordinal used by the rewind button and the server, which count TURNS).
 * Answers are user-role messages but don't start a turn, so they must be
 * excluded from the count — otherwise an earlier turn is cut off too. Returns
 * -1 when the turn isn't found.
 *
 * This matches the rewind button's `turnIndex` (both count non-answer user
 * messages). It does NOT perfectly match the server's `PATCH /api/session`,
 * which skips ALL array-form user entries — that includes image-paste turns,
 * not just tool_results — so it counts an image paste as a turn where this does
 * not. A transcript containing image-paste turns can therefore still rewind to
 * the wrong turn. That client/server mismatch predates the askAnswer work and is
 * tracked separately.
 */
export function findRewindCutIndex(messages: Pick<TranscriptMsg, 'role' | 'askAnswer'>[], turnIndex: number): number {
  let userCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || msg.askAnswer) continue;
    if (userCount === turnIndex) return i;
    userCount++;
  }
  return -1;
}
