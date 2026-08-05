/**
 * Recovery for a JSON state file that will not parse.
 *
 * Shared by the two `.claude-ui-state` persisters so their resilience cannot
 * drift apart — it already had: state.json got quarantine-and-self-heal while
 * settings.json, the higher-stakes file, still collapsed to DEFAULTS in a bare
 * `catch {}`. Atomic writes (./atomicWrite) stop Fury from CREATING new tears;
 * they do nothing for a file that is already torn — from the pre-fix race, an
 * external edit, or a half-written file from a killed process. This module is
 * the read-side counterpart.
 *
 * Two layers, in order:
 *
 *  1. SALVAGE. The corruption this actually produces is a complete JSON document
 *     with the tail of a longer one glued on (see ./atomicWrite for the
 *     interleaving). The leading document is intact and is exactly what one of
 *     the writers wrote — so it is recoverable in full, not merely diagnosable.
 *     Recovering it means a user does not lose their auth hash and API key.
 *
 *  2. QUARANTINE. Whatever happens, the original bytes are preserved at
 *     `<file>.corrupt` and the loss is announced. If salvage worked the file is
 *     repaired in place; if it did not, the file is moved aside so the caller's
 *     defaults apply and the next save starts clean.
 *
 * Both layers are best-effort: a failure to quarantine must never stop the app
 * from starting.
 */
import { writeFile, rename, rm } from 'fs/promises';
import { atomicWriteFile } from './atomicWrite';

/**
 * The leading complete JSON object in `content`, or null if there isn't one.
 *
 * String-aware: a brace inside a string value (settings hold shell commands —
 * `bedrockAuthRefreshCmd` can easily contain `{}`) must not move the depth
 * counter. Only a balanced object that starts at the first non-whitespace
 * character counts, so a file whose head is garbage is refused rather than
 * guessed at.
 *
 * A truncated file cannot fool this: depth only returns to 0 when the ROOT
 * object closes, so any match is a document some writer completed — possibly one
 * revision stale, never a fragment.
 */
export function salvageLeadingObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  if (start === -1 || content.slice(0, start).trim() !== '') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth > 0) continue;
      try {
        const parsed = JSON.parse(content.slice(start, i + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch { /* the leading object is itself malformed */ }
      return null;
    }
  }
  return null;
}

/**
 * Handle an unparseable state file: salvage what can be salvaged, preserve the
 * original at `<file>.corrupt`, and say so loudly.
 *
 * Returns the salvaged object, or null when nothing could be recovered (the
 * caller should then fall back to its defaults).
 *
 * Repairs the file in place on a successful salvage. That is a write from a read
 * path, deliberately: the original has just been moved to the quarantine
 * sidecar, so without the repair the very next load would see ENOENT and the
 * recovered credentials would be lost anyway. It runs once — the repaired file
 * parses cleanly from then on.
 */
export async function recoverCorruptJsonFile(
  filePath: string,
  content: string,
  label: string,
  parseError: unknown,
): Promise<Record<string, unknown> | null> {
  const quarantinePath = `${filePath}.corrupt`;
  const reason = parseError instanceof Error ? parseError.message : String(parseError);

  // Preserve the original bytes BEFORE touching anything.
  await rename(filePath, quarantinePath).catch(async () => {
    // Windows can refuse the rename if a reader holds the file; fall back to copy.
    await writeFile(quarantinePath, content, 'utf-8').catch(() => { /* best effort */ });
    await rm(filePath, { force: true }).catch(() => { /* best effort */ });
  });

  const salvaged = salvageLeadingObject(content);
  if (salvaged) {
    await atomicWriteFile(filePath, JSON.stringify(salvaged, null, 2)).catch(() => {
      /* the in-memory value is still returned; the next save rewrites the file */
    });
    console.warn(
      `[${label}] ${filePath} was corrupt (${reason}). Recovered the last complete ` +
      `record and repaired the file; the original is at ${quarantinePath}.`,
    );
    return salvaged;
  }

  console.error(
    `[${label}] ${filePath} was corrupt (${reason}) and could NOT be recovered. ` +
    `Falling back to defaults — the original is preserved at ${quarantinePath}.`,
  );
  return null;
}
