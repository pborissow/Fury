/**
 * Pure query builder for /api/search (docs/plan-search-tab.md §5 A2).
 *
 * Turns raw user input into (a) a SAFE FTS5 MATCH expression and (b) a LIKE
 * pattern for the substring fallback. Never pass raw input to MATCH: bare
 * tokens can hit FTS5 operators (`NEAR`, `AND`, `:`, `*`, unbalanced `"`) and
 * 500 the route. Everything here is quoted as phrases, which neutralizes the
 * entire operator syntax.
 *
 * Matching strategy (validated in the M0 spike against the real DB):
 * - The index tokenizer is `unicode61 tokenchars '-_.'`, so a file name like
 *   `plan-fury-home-migration.md` is ONE token and paths split only on `/`.
 * - Each whitespace-separated input term becomes a quoted phrase; a term
 *   containing `/` becomes a multi-token phrase of its path segments (they're
 *   adjacent tokens in the indexed text, so the phrase matches the full path).
 * - The FINAL term gets a `*` prefix suffix (phrase-prefix is valid FTS5) —
 *   search-as-you-type means the last word is usually still being typed. A
 *   trailing space in the raw input marks the word complete and skips the star.
 * - Terms are implicitly ANDed (FTS5 default for adjacent phrases).
 */

export interface SearchPlan {
  /** FTS5 MATCH expression — fully phrase-quoted, safe for arbitrary input. */
  match: string;
  /** `%…%` LIKE pattern with `\`-escaped wildcards (use `ESCAPE '\'`). */
  like: string;
  /** The raw whitespace-separated terms (for LIKE-mode highlighting). */
  terms: string[];
}

/** Build the two query forms for a raw search input. Null = nothing to search
 *  (empty/whitespace input, or input with no quotable content). */
export function buildSearchQuery(raw: string): SearchPlan | null {
  const input = raw.trim();
  if (!input) return null;

  const rawTerms = input.split(/\s+/).filter(Boolean);
  const phrases: string[] = [];
  for (const term of rawTerms) {
    // Path → adjacent-token phrase: "docs/plan-x.md" → "docs plan-x.md".
    // Doubling embedded quotes is FTS5's escape for `"` inside a phrase.
    const segments = term
      .split('/')
      .map(s => s.replace(/"/g, '""').trim())
      .filter(Boolean);
    if (segments.length === 0) continue; // e.g. the term was just "/"
    phrases.push(`"${segments.join(' ')}"`);
  }
  if (phrases.length === 0) return null;

  // Trailing whitespace in the RAW input = the user finished the word.
  if (!/\s$/.test(raw)) phrases[phrases.length - 1] += '*';

  return {
    match: phrases.join(' '),
    like: '%' + input.replace(/([\\%_])/g, '\\$1') + '%',
    terms: rawTerms,
  };
}

/** Snippet-boundary markers shared by the route (FTS `snippet()` arguments and
 *  the LIKE fallback's hand-built snippets) and the SearchTab renderer, which
 *  splits on them and emits <mark> — snippet text is NEVER trusted as HTML.
 *  Control chars can't survive in message prose, so they can't be spoofed. */
export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

/** Build a LIKE-mode snippet by hand: a ±`radius`-char window around the first
 *  case-insensitive occurrence of `needle`, with the match wrapped in the same
 *  markers `snippet()` uses. Falls back to the head of the text when the term
 *  only matched via normalization differences. */
export function buildLikeSnippet(content: string, needle: string, radius = 60): string {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) {
    const head = content.slice(0, radius * 2);
    return head + (content.length > head.length ? '…' : '');
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + needle.length + radius);
  return (
    (start > 0 ? '…' : '') +
    content.slice(start, idx) +
    MARK_OPEN + content.slice(idx, idx + needle.length) + MARK_CLOSE +
    content.slice(idx + needle.length, end) +
    (end < content.length ? '…' : '')
  );
}

/**
 * SQL predicate restricting message hits to what the Chat tab RENDERS by
 * default: every user bubble, plus only the FINAL assistant message of each
 * consecutive assistant run. The parser emits one assistant row per text
 * segment between tool batches; the renderer collapses all but the last
 * behind the "+N intermediary" affordance
 * (components/TranscriptRenderer.tsx ~168-180), so without this filter search
 * would surface text the user cannot see in the default transcript view.
 *
 * Requires the messages table aliased as `m`. turn_index is the contiguous
 * archive-array position (UNIQUE per session, no gaps — lib/transcriptArchiver
 * inserts i = 0..N-1), so "final of its run" ≡ "the next row is a user message
 * or doesn't exist". Pure predicate — no schema change, no reindex; the
 * intermediary rows STAY indexed for a future "include intermediary" toggle
 * (docs/plan-search-tab.md §8 / M3). The NOT EXISTS probe rides the
 * UNIQUE(session_id, turn_index) index: ~O(1) per candidate row.
 */
export const RENDERED_BUBBLES_FILTER = ` AND (m.role = 'user' OR NOT EXISTS (
    SELECT 1 FROM messages nxt
    WHERE nxt.session_id = m.session_id
      AND nxt.turn_index = m.turn_index + 1
      AND nxt.role = 'assistant'))`;
