/**
 * Client helper: POST a per-session model override to the SDK manager.
 *
 * The single copy of this request — previously hand-rolled in three places
 * (new-session flow, ModelPickerDialog, and the usage-limit recovery dialog),
 * each with slightly different error handling. `fetch` only rejects on a network
 * error, so a 400 (SDK-rejected model id) or 409 (SDK sessions disabled) returns
 * an ok:false response callers MUST check — a silent success there relabels the
 * composer and lets the next turn run on the wrong (e.g. still-limited) model.
 *
 * `model: null` clears the override (follow the provider default).
 */
export async function setSessionModel(
  sessionId: string,
  model: string | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/claude-sdk/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, model }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
