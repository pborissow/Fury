/**
 * Keyword search or a question? (docs/ticket-ask-search.md §5)
 *
 * Pure and dependency-free: the Search tab runs it on every keystroke to decide
 * whether Enter means "search now" or "ask the Search agent", and the ask route
 * reuses questionResidue() for its keyword fallback.
 *
 * The cost asymmetry shapes the rules: a false "question" makes Enter spend a
 * model call (seconds, a fraction of a cent) on something the instant keyword
 * search would have handled, while a false "keyword" just means the user clicks
 * Ask instead. So the detector errs toward keyword:
 *
 *   ≤ 2 words, or one quoted phrase           → keyword  ("file tree", "\"tree*\"")
 *   ends with "?" and ≥ 3 words               → question ("what is bm25?")
 *   starts with a cue word and ≥ 4 words      → question ("find sessions about the file tree")
 *   ≥ 6 words, at least 40% of them filler    → question ("the one where we fixed renaming")
 *   anything else                             → keyword  ("what is bm25", "file tree watcher sse leak fix")
 */

/** Longest question the Search agent accepts (shared with lib/askSearch.ts). */
export const MAX_QUESTION_CHARS = 500;

/** Words that open a question or a request to find something. */
const CUES = new Set([
  'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'can', 'could', 'would', 'will', 'should', 'did', 'do', 'does', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'find', 'show', 'list', 'help', 'tell', 'give', 'search', 'look',
  'get', 'remind', 'locate', 'any', 'anything', 'please',
]);

/** Function words that make text read as prose rather than search terms. */
const FILLER = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'it', 'its', 'they', 'them',
  'that', 'this', 'these', 'those', 'there', 'here', 'one', 'ones', 'some', 'any',
  'in', 'on', 'of', 'for', 'to', 'from', 'with', 'about', 'at', 'by', 'into', 'over', 'up',
  'and', 'or', 'but', 'so', 'if', 'then', 'than', 'as', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'can', 'could', 'would', 'will', 'should', 'may', 'might', 'must',
  'what', 'where', 'when', 'which', 'who', 'why', 'how', 'just', 'also', 'again',
]);

/** Extra words a keyword fallback drops: question boilerplate, not subject. */
const BOILERPLATE = new Set([
  ...CUES, ...FILLER,
  'session', 'sessions', 'conversation', 'conversations', 'chat', 'chats', 'transcript', 'transcripts',
  'worked', 'work', 'working', 'talked', 'discussed', 'discuss', 'mentioned', 'did', 'made', 'make',
  'last', 'time', 'times', 'ago', 'yesterday', 'today', 'week', 'month', 'recently', 'earlier',
  'project', 'thing', 'things', 'stuff', 'something', 'like', 'please', 'thanks', 'need', 'want',
]);

/** Whitespace-split words with surrounding punctuation stripped; empties dropped. */
export function wordsOf(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_./\\-]+|[^\p{L}\p{N}_./\\-]+$/gu, ''))
    .filter(Boolean);
}

/** Does this input read as a natural-language question (see header)? */
export function isQuestion(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  if (/^(["'])[\s\S]*\1$/.test(t)) return false;            // one quoted phrase = exact search
  const words = wordsOf(t);
  const n = words.length;
  if (n <= 2) return false;
  if (/\?\s*$/.test(t)) return true;                    // n ≥ 3 here
  const first = words[0].toLowerCase();
  if (CUES.has(first) && n >= 4) return true;
  if (n >= 6) {
    const filler = words.filter((w) => FILLER.has(w.toLowerCase())).length;
    if (filler / n >= 0.4) return true;
  }
  return false;
}

/**
 * The keyword core of a question, for the fallback when the Search agent is
 * unavailable: boilerplate dropped, a word naming a known project turned into
 * a project filter. "can you help me find the sessions where we worked on the
 * file tree in fury?" → { terms: ['file', 'tree'], project: '/…/Fury' }.
 */
export function questionResidue(
  input: string,
  projects: string[] = [],
): { terms: string[]; project: string | null } {
  const byName = new Map<string, string>();
  for (const p of projects) {
    const name = p.split(/[\\/]/).filter(Boolean).pop();
    if (name) byName.set(name.toLowerCase(), p);
  }
  let project: string | null = null;
  const terms: string[] = [];
  for (const w of wordsOf(input)) {
    const lw = w.toLowerCase();
    if (!project && byName.has(lw)) { project = byName.get(lw)!; continue; }
    if (BOILERPLATE.has(lw) || lw.length < 2) continue;
    if (!terms.includes(w)) terms.push(w);
  }
  return { terms, project };
}
