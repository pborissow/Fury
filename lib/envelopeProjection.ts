import type { Liveness } from './eventBus';
import { envelopeHiddenMessages, stripInFlightPartials } from './transcriptStrip';

/**
 * Logical-task ENVELOPE projection
 * (docs/ticket-subagent-notification-turns-intermediate-bubbles.md).
 *
 * Since Claude Code 2.1.26x one user send spans MANY result-terminated turns
 * (each background-task <task-notification> drives its own turn), so a
 * completed intermediate turn's assistant message is a REAL committed message —
 * the in-flight-partials strip must not (and does not) remove it. Per the agreed
 * product direction, while the envelope is open those messages are hidden from
 * the main flow (nothing may render above the bouncing dots) and surfaced via a
 * modal opened by clicking the dots bubble.
 *
 * Everything here is a pure function of (transcript, live, overlay), same as the
 * SSOT strip, so the Chat tab derives it on every render.
 */

type Msg = { role: string; timestamp?: string; askAnswer?: boolean; askQuestion?: boolean };
type Overlay = { content?: string; images?: unknown[] };

export interface EnvelopeProjectionInput<T extends Msg> {
  /** The committed transcript (raw — may hold the envelope's mid-task commits). */
  transcript: T[];
  /** The SSOT liveness level, or null before the first reading. */
  live: Liveness | null;
  /** The projection-driven dots are enabled (`fury.livenessDots`). */
  livenessDotsEnabled: boolean;
  /** Optimistic (not yet committed) messages — the echo defers to real ones. */
  overlay: Overlay[];
}

export interface EnvelopeProjection<T> {
  /** An envelope (logical task) is open: live, non-idle, anchored. */
  envelopeOpen: boolean;
  /** Where the main flow is cut: the envelope anchor when open, else the
   *  current turn's startedAt (in-flight partials only), else no cut. */
  displayCutAt: number | null;
  /** What the main flow renders. */
  displayedTranscript: T[];
  /** What the dots-bubble modal shows: the envelope's committed intermediate
   *  assistant messages (current turn's in-flight partials excluded). */
  envelopeHidden: T[];
  /** The envelope's committed user sends, resurfaced through the overlay slot
   *  when no overlay with real content covers them; null when not applicable. */
  envelopeUserEcho: T[] | null;
}

export function projectEnvelope<T extends Msg>({
  transcript, live, livenessDotsEnabled, overlay,
}: EnvelopeProjectionInput<T>): EnvelopeProjection<T> {
  const envelopeOpen =
    livenessDotsEnabled &&
    !!live &&
    live.phase !== 'idle' &&
    typeof live.envelopeStartedAt === 'number';

  // The envelope anchor is ≤ startedAt by construction, so when open it
  // subsumes the partials strip (it hides ALL of the task's turns).
  const displayCutAt = envelopeOpen
    ? (live!.envelopeStartedAt as number)
    : (livenessDotsEnabled && live && typeof live.startedAt === 'number' ? live.startedAt : null);

  const displayedTranscript =
    displayCutAt != null ? stripInFlightPartials(transcript, displayCutAt) : transcript;

  const envelopeHidden = envelopeOpen
    ? envelopeHiddenMessages(
        transcript,
        live!.envelopeStartedAt as number,
        typeof live!.startedAt === 'number' ? live!.startedAt : null,
      )
    : [];

  // The envelope slice removes the task's committed USER send(s) too (on the
  // send path the optimistic overlay covers the prompt — rendering both would
  // duplicate it). On a switch/restore mid-task there IS no overlay, so
  // resurface the committed user sends through the same overlay slot: the main
  // flow keeps reading "your prompt + dots" instead of the prompt vanishing
  // until the reveal. The echo defers only to an overlay with ACTUAL content —
  // a blank one (a notification turn's empty userPrompt) must not hide the real
  // prompt (2026-09-19 report).
  const overlayHasContent = overlay.some(
    (m) => (m.content && m.content.trim() !== '') || (m.images?.length ?? 0) > 0,
  );
  const envelopeUserEcho =
    envelopeOpen && !overlayHasContent
      ? transcript.filter((m) => {
          if (m.role !== 'user' || !m.timestamp) return false;
          // An AskUserQuestion answer is user-role but belongs INSIDE the turn
          // as an intermediary, not as a live "You" send — echoing it flashed a
          // spurious second top-level bubble until the turn settled.
          if (m.askAnswer) return false;
          const t = Date.parse(m.timestamp);
          return Number.isFinite(t) && t >= (live!.envelopeStartedAt as number);
        })
      : null;

  return { envelopeOpen, displayCutAt, displayedTranscript, envelopeHidden, envelopeUserEcho };
}
