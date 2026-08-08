import { NextResponse } from 'next/server';
import { getPricingTable, hasPricingOverrides, PRICING_AS_OF } from '@/lib/pricing';
import { loadPricingOverrides } from '@/lib/pricingPoller';
import { baseWindowFor } from '@/lib/modelWindows';

export const runtime = 'nodejs';

/**
 * GET /api/pricing/table — the model pricing reference behind the Stats tab's
 * cost estimates. Read by the shared PricingDialog (Stats header + the
 * model-catalog "Refresh model list" dialog).
 *
 * Sibling of /api/pricing, which is the poller's status/trigger endpoint; this
 * one is the human-readable rate card. Returns the SAME rates costForUsage
 * charges from — the git-versioned constant plus any dated overrides the poller
 * has discovered — so the displayed table can never disagree with the numbers
 * on the page.
 */
export async function GET() {
  try {
    // Overrides are installed at boot, but re-load here so the endpoint is
    // self-sufficient regardless of boot ordering. One small query, hit only
    // when a user opens the dialog.
    await loadPricingOverrides().catch(() => { /* fall back to the constant */ });

    // Enrich each rate row with its empirically-learned base window (from
    // lib/model-windows.json — probe-seeded + runtime-confirmed). Joined here
    // rather than inside getPricingTable to keep pricing.ts free of a dependency
    // on modelWindows (which imports from pricing.ts — would be circular).
    // null base = unknown (never probed / not accessible) → the UI leaves it blank.
    const models = getPricingTable().map(m => ({ ...m, baseWindow: baseWindowFor(m.id) }));

    return NextResponse.json({
      asOf: PRICING_AS_OF,
      hasOverrides: hasPricingOverrides(),
      models,
    });
  } catch (err) {
    console.error('[Pricing table API] Failed to build pricing table:', err);
    return NextResponse.json({ error: 'Failed to load pricing' }, { status: 500 });
  }
}
