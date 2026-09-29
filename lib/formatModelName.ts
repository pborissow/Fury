/**
 * Pretty-print a Claude model id ("claude-opus-4-7" → "Claude Opus 4.7").
 * Returns null if the id doesn't match the expected shape so the caller can fall
 * back to a coarser label.
 *
 * Handles both version shapes the catalog ships: two-segment ("claude-opus-4-8"
 * → "Opus 4.8") and one-segment ("claude-sonnet-5" → "Sonnet 5"). The minor
 * segment MUST stay optional — Sonnet 5 and Fable 5 have none, and requiring it
 * silently degraded them to a bare "Claude". Context-window variants carry a
 * bracket suffix ("claude-opus-4-8[1m]") that isn't part of the name, so strip it
 * before matching.
 */
export function formatModelName(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.replace(/\[[^\]]*\]/g, '').match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!match) return null;
  const name = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `Claude ${name} ${version}`;
}
