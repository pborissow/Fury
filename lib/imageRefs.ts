/**
 * The scrubbed-image placeholder WIRE FORMAT — single source of truth.
 *
 * lib/imageScrubber.ts (producer) writes these text blocks into the JSONL;
 * lib/transcriptParser.ts (consumer) detects them to render thumbnail/
 * placeholder chips. They previously each hard-coded the strings/regexes,
 * which is exactly how a wording tweak would silently break rendering.
 *
 * Two forms:
 *   - bare:  "[image previously analyzed]"                       (bytes gone)
 *   - ref:   "[image previously analyzed: fury-img://<sha256>]"  (bytes in the
 *            per-session store; hash resolves via /api/images/<sessionId>/<hash>)
 *
 * Both stay plain text blocks so API replay of a scrubbed transcript remains
 * valid — Claude just sees the marker on resume.
 */

/** Bare placeholder text (ephemeral scrub — bytes discarded). */
export const IMAGE_PLACEHOLDER_TEXT = '[image previously analyzed]';

/** Ref placeholder text carrying the store hash (persist scrub). */
export function imageRefText(hash: string): string {
  return `[image previously analyzed: fury-img://${hash}]`;
}

/** Matches a ref placeholder (trimmed, whole-string); group 1 = the sha256. */
export const IMAGE_REF_RE = /^\[image previously analyzed: fury-img:\/\/([a-f0-9]{64})\]$/;

/** True when a (trimmed) text is the bare placeholder. */
export function isBareImagePlaceholder(text: string): boolean {
  return text === IMAGE_PLACEHOLDER_TEXT;
}
