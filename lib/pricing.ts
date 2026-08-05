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
  /**
   * $/Mtok, cache write with 5-minute TTL (1.25x input).
   *
   * NOT what Claude Code writes at — this comment used to claim it was, and a
   * caller believed it and under-quoted cache costs by 1.6x. Verified against
   * usage_events: of 1,026 events carrying a TTL split, 1,026 are 1h and 0 are
   * 5m. The db.ts migration agrees ("attribute a legacy total to 1h"). Price
   * observed usage from the per-event split; don't assume a TTL.
   */
  cacheWrite5m: number;
  /** $/Mtok, cache write with 1-hour TTL (2x input). This is what Claude Code
   *  writes at — see the note on cacheWrite5m. */
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
  // P9: Sonnet-5 has a published introductory rate ($2/$10 through 2026-08-31) below
  // this sticker ($3/$15). It is INTENTIONALLY left at sticker here and NOT hardcoded
  // as an intro period: the pricing poller (lib/pricingPoller.ts) owns runtime rate
  // updates, and it deliberately treats the intro-vs-standard rows as *ambiguous* and
  // skips them rather than guess which applies to this account (parsePricingMarkdown).
  // So this git-versioned constant stays the reviewed source of truth; if an account
  // is billed at intro, a human reconciles a dated override into this list. Do not
  // re-flag without confirming the account's actual billed rate.
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
 * Context window per model, in tokens, as published (see PRICING_AS_OF).
 *
 * This has to be a table: the SDK's ModelInfo carries no context window, and the
 * CLI catalog only mentions it in prose ("Opus 4.8 with 1M context") — which
 * Haiku's description ("Fastest for quick answers") omits entirely, i.e. it's
 * missing precisely for the one model whose window differs.
 *
 * Deliberately PARTIAL: only models with a published figure are listed, and
 * contextWindowFor() returns null for anything else. Callers must treat null as
 * "unknown" and stay silent — a confidently wrong window warning is worse than
 * no warning at all.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  // The odd one out — every current non-Haiku model is 1M.
  'claude-haiku-4-5': 200_000,
};

/**
 * Display order for model pickers: most capable first.
 *
 * Ranked by FAMILY, not by price. They happen to correlate today (fable $10 >
 * opus $5 > sonnet $3 > haiku $1) so sorting on rate would produce the same
 * list — but capability is what the ordering means, and the two would diverge
 * the moment a cheap-but-capable model ships. Unknown families sort last and
 * keep their relative catalog order (Array.sort is stable).
 */
const MODEL_FAMILY_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

/** Rank for MODEL_FAMILY_ORDER; lower sorts first. Unknown families sort last. */
export function modelTierRank(model: string | null | undefined): number {
  const id = normalizeModelId((model ?? '').replace(/\[[^\]]*\]/g, ''));
  const i = MODEL_FAMILY_ORDER.findIndex(family => id.includes(family));
  return i === -1 ? MODEL_FAMILY_ORDER.length : i;
}

/**
 * The context window for a model id, or null when we have no published figure.
 *
 * Strips the catalog's context-variant suffix ('claude-opus-4-8[1m]') first:
 * normalizeModelId doesn't handle brackets because it only ever sees bare ids
 * from the JSONL, but catalog ids carry them.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  return CONTEXT_WINDOWS[normalizeModelId(model.replace(/\[[^\]]*\]/g, ''))] ?? null;
}

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

/**
 * What it costs to re-process `tokens` of conversation on `model` after a model
 * switch invalidates the prompt cache (caches are per-model, and a model change
 * invalidates the tools, system AND messages tiers).
 *
 * Prices at the 1-HOUR write rate — 2x input, not the 5m rate's 1.25x. Claude
 * Code writes at the 1h TTL: every one of the 1,026 TTL-split rows in
 * usage_events is 1h, and pricing.test.ts already calls the 5m assumption "the
 * bug". This lives here, not in the caller, so that choice is unit-testable
 * instead of buried in a dialog.
 *
 * Returns null when the model has no published rate (e.g. a Bedrock `us.`-prefixed
 * id — see normalizeModelId) so callers omit the claim rather than quote $0.
 */
export function cacheRewriteCost(model: string | null | undefined, tokens: number): number | null {
  const r = latestRate(model);
  if (!r || !(tokens > 0)) return null;
  return (tokens / 1_000_000) * r.cacheWrite1h;
}

export interface TokenUsage {
  input: number;
  output: number;
  /** Cache-creation tokens with 5-minute TTL (bill at 1.25x input). */
  cacheWrite5m: number;
  /** Cache-creation tokens with 1-hour TTL (bill at 2x input). Claude Code's
   *  default cache TTL, so this is where most cache-write spend lands. */
  cacheWrite1h: number;
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
 * Cache writes are billed by their actual TTL: 5-minute at 1.25x input, 1-hour
 * at 2x. (Pricing all cache writes at the 5m rate underestimated ~36% on cache-
 * heavy sessions, since Claude Code writes 1h cache — verified against the SDK's
 * total_cost_usd.) Unknown models yield `{ cost: 0, priced: false }` so callers
 * can flag unpriced spend rather than baking in a wrong number.
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
      usage.cacheWrite5m * r.cacheWrite5m +
      usage.cacheWrite1h * r.cacheWrite1h +
      usage.cacheRead * r.cacheRead) /
    1_000_000;
  return { cost, priced: true };
}
