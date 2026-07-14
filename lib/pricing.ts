/**
 * Claude model pricing — the single source of truth for the Stats tab's cost
 * estimates.
 *
 * Rates are US dollars per million tokens. Base input/output prices come from
 * Anthropic's published pricing; the cache rates follow the documented
 * multipliers relative to the base input price:
 *   - cache write (5-minute TTL) = 1.25x input
 *   - cache write (1-hour TTL)   = 2.00x input
 *   - cache read                 = 0.10x input
 *
 * POINT-IN-TIME PRICING. Each model maps to a list of dated rate *periods*.
 * Cost for a usage event is computed with the rate in effect **on the day the
 * event happened** (see `costForUsage(model, usage, atDate)`), so changing a
 * price never re-prices history.
 *
 *   ‼️  To change a price: APPEND a new period with the date it takes effect —
 *       never edit an existing period. Editing a past period silently
 *       re-prices every event that fell in it.
 *
 * `effectiveFrom` is an ET "YYYY-MM-DD" string; `''` means "since the model
 * existed" (its original price). Periods are kept sorted ascending. A future
 * pricing poller appends periods the same way; the `pricing_log` table mirrors
 * the current rate per model for a DB-queryable audit trail.
 */

/** Date these rates were last verified (YYYY-MM-DD). Bump when reviewing. */
export const PRICING_AS_OF = '2026-07-13';

export interface ModelRates {
  /** $/Mtok, uncached input. */
  input: number;
  /** $/Mtok, output. */
  output: number;
  /** $/Mtok, cache write with 5-minute TTL (the Claude Code default). */
  cacheWrite5m: number;
  /** $/Mtok, cache write with 1-hour TTL. */
  cacheWrite1h: number;
  /** $/Mtok, cache read. */
  cacheRead: number;
}

/** A rate that took effect on `effectiveFrom` and holds until the next period. */
export interface RatePeriod extends ModelRates {
  /** ET "YYYY-MM-DD"; '' = since the model's inception. */
  effectiveFrom: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Build a full rate set from base input/output, deriving cache rates. */
function rates(input: number, output: number): ModelRates {
  return {
    input,
    output,
    cacheWrite5m: round(input * 1.25),
    cacheWrite1h: round(input * 2),
    cacheRead: round(input * 0.1),
  };
}

/** One dated pricing period. */
function period(effectiveFrom: string, input: number, output: number): RatePeriod {
  return { effectiveFrom, ...rates(input, output) };
}

/**
 * Canonical model id -> dated rate periods (ascending by effectiveFrom). Keys
 * are the normalized ids from {@link normalizeModelId}. Today every model has a
 * single `''` period (its price hasn't changed in our tracking window); when a
 * price changes, append a dated period — e.g.
 *   'claude-opus-4-8': [period('', 5, 25), period('2026-07-20', 10, 50)],
 * and events before 2026-07-20 stay at $5/$25 forever.
 */
export const PRICING: Record<string, RatePeriod[]> = {
  // Fable / Mythos tier
  'claude-fable-5': [period('', 10, 50)],
  'claude-mythos-5': [period('', 10, 50)],
  // Opus 4.x tier — $5 / $25
  'claude-opus-4-8': [period('', 5, 25)],
  'claude-opus-4-7': [period('', 5, 25)],
  'claude-opus-4-6': [period('', 5, 25)],
  'claude-opus-4-5': [period('', 5, 25)],
  'claude-opus-4-1': [period('', 15, 75)],
  'claude-opus-4-0': [period('', 15, 75)],
  // Sonnet tier — $3 / $15
  'claude-sonnet-5': [period('', 3, 15)],
  'claude-sonnet-4-6': [period('', 3, 15)],
  'claude-sonnet-4-5': [period('', 3, 15)],
  'claude-sonnet-4-0': [period('', 3, 15)],
  // Haiku tier
  'claude-haiku-4-5': [period('', 1, 5)],
  // Legacy 3.x (historical published rates — stable, retained for old sessions)
  'claude-3-opus': [period('', 15, 75)],
  'claude-3-5-sonnet': [period('', 3, 15)],
  'claude-3-5-haiku': [period('', 0.8, 4)],
  'claude-3-haiku': [period('', 0.25, 1.25)],
};

/**
 * Normalize a raw model id from the transcript to a canonical PRICING key.
 * Strips provider prefixes (Bedrock `anthropic.`), Vertex `@version` suffixes,
 * and dated snapshot suffixes (`-20251001`), then collapses to the alias.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/^anthropic\./, ''); // Bedrock prefix
  id = id.replace(/@\d+$/, ''); // Vertex @version
  id = id.replace(/-\d{8}$/, ''); // dated snapshot, e.g. -20251001
  if (PRICING[id]) return id;
  if (id.startsWith('claude-3-5-sonnet')) return 'claude-3-5-sonnet';
  if (id.startsWith('claude-3-5-haiku')) return 'claude-3-5-haiku';
  if (id.startsWith('claude-3-opus')) return 'claude-3-opus';
  if (id.startsWith('claude-3-haiku')) return 'claude-3-haiku';
  return id;
}

/**
 * Runtime-discovered rate periods (from the pricing poller), keyed by canonical
 * model id, merged ON TOP OF the code constant. The constant stays the
 * reviewed source of truth; overrides carry dated periods the poller found so
 * costs stay current automatically without a code change. Installed at boot and
 * after each successful poll via {@link setPricingOverrides}.
 */
let overrides: Record<string, RatePeriod[]> = {};

/** Replace the runtime pricing overrides (called by lib/pricingPoller). */
export function setPricingOverrides(map: Record<string, RatePeriod[]>): void {
  overrides = map;
}

/** Periods for a raw model id (base constant + runtime overrides), or null. */
function periodsFor(model: string | null | undefined): RatePeriod[] | null {
  if (!model) return null;
  const id = normalizeModelId(model);
  const base = PRICING[id];
  const ov = overrides[id];
  if (!base && !ov) return null;
  return [...(base ?? []), ...(ov ?? [])].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
}

/**
 * The rate in effect for `model` on `atDate` (ET "YYYY-MM-DD"). Picks the latest
 * period whose `effectiveFrom <= atDate`; falls back to the earliest period if
 * the date predates all of them. Null if the model is unpriced.
 */
export function rateFor(model: string | null | undefined, atDate: string): ModelRates | null {
  const periods = periodsFor(model);
  if (!periods || periods.length === 0) return null;
  let chosen: RatePeriod | null = null;
  for (const p of periods) {
    if (p.effectiveFrom <= atDate) chosen = p; // periods are ascending
    else break;
  }
  return chosen ?? periods[0];
}

/** The current (latest) rate for a model, or null. */
export function latestRate(model: string | null | undefined): ModelRates | null {
  const periods = periodsFor(model);
  return periods && periods.length ? periods[periods.length - 1] : null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface CostBreakdown {
  /** Total estimated cost in USD. 0 when the model is unpriced. */
  cost: number;
  /** True if we had pricing for the model; false means cost is a floor of 0. */
  priced: boolean;
}

/**
 * Estimate the USD cost of a usage record. When `atDate` (ET "YYYY-MM-DD") is
 * given, the event is priced at the rate in effect that day — so historical
 * cost is stable across price changes. Omit `atDate` to use the current rate.
 * Cache writes bill at the 5-minute rate (Claude Code's default cache TTL).
 * Unknown models yield `{ cost: 0, priced: false }` so callers can flag
 * unpriced spend rather than baking in a wrong number.
 */
export function costForUsage(
  model: string | null | undefined,
  usage: TokenUsage,
  atDate?: string,
): CostBreakdown {
  const r = atDate ? rateFor(model, atDate) : latestRate(model);
  if (!r) return { cost: 0, priced: false };
  const cost =
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheWrite * r.cacheWrite5m +
      usage.cacheRead * r.cacheRead) /
    1_000_000;
  return { cost, priced: true };
}
