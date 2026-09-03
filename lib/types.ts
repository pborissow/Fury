export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A rendered image part attached to a transcript message. Exactly one source
 * is set: `dataUrl` for an inline (recent/unscrubbed) image, `hash` for a
 * scrubbed-but-persisted image served via /api/images/<sessionId>/<hash>, or
 * neither (placeholder) for an ephemerally-scrubbed image whose bytes are gone.
 */
export interface TranscriptImagePart {
  /** Inline data URL (data:<mediaType>;base64,<data>) for recent turns. */
  dataUrl?: string;
  /** Store hash for a persisted image (fury-img://<hash>). */
  hash?: string;
  /** True when the image was scrubbed with no recoverable bytes. */
  placeholder?: boolean;
}

export interface TranscriptMsg {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** JSONL entry uuid (user messages) — target for SDK rewindFiles. */
  uuid?: string;
  /** Image parts attached to this message (pastes / Read-tool images). */
  images?: TranscriptImagePart[];
}

/** An image attachment on an outgoing chat turn (client → /api/claude → SDK). */
export interface ImageAttachmentInput {
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string;
  /** Anthropic image media type: image/png|jpeg|gif|webp. */
  mediaType: string;
}

/**
 * The image media types Anthropic image blocks accept — the SINGLE source of
 * truth shared by the client normalizer (lib/clientImage.ts), the /api/claude
 * validator, and the scrubber's externalization gate (lib/imageScrubber.ts).
 * Keep lib/imageStore.ts's extension maps in sync when this changes.
 */
export const ACCEPTED_IMAGE_MEDIA_TYPES: readonly string[] =
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Approximate decoded byte size of a base64 payload (shared client/server so
 *  the composer's size accounting and the API caps can't drift apart). */
export function estimateBase64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

export interface SessionMetadata {
  label?: string;
  [key: string]: unknown;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  messageCount?: number;
  metadata?: SessionMetadata;
}

export interface PendingSession {
  sessionId: string;
  project: string;
  title: string;
  createdAt: number;
}

/**
 * A question the model is asking the user, awaiting an answer.
 *
 * `toolUseID` is REQUIRED by design, not an oversight. It is the SDK's own id
 * for the parked tool call (the correlation key /api/claude-sdk/answer matches
 * against), so a question without one is unanswerable. The JSONL transcript has
 * no toolUseID to give — which is exactly the point: a question replayed from
 * the transcript CANNOT be answered on the SDK path, and requiring the field
 * turns that into a compile error instead of a dialog that silently hangs.
 * See docs/ask-user-question-sdk.md §8 / TRAP #4.
 */
export interface AskUserQuestionState {
  /** The SDK's id for the parked tool call, or null on the CLI path, where no
   *  tool call is held open and the answer is re-sent as a fresh prose turn. */
  toolUseID: string | null;
  input: {
    questions: {
      question: string;
      header?: string;
      multiSelect: boolean;
      options: { label: string; description?: string }[];
    }[];
  };
}
