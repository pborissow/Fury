/**
 * Model-catalog cache status + manual refresh.
 *
 *   GET  /api/model-catalog  → cadence config, last/next refresh, and the cached
 *                              model list grouped by family (newest version first).
 *   POST /api/model-catalog  → refresh now (fetch GET /v1/models via the CLI's
 *                              OAuth token), then return the updated grouping.
 *
 * The picker's version dropdowns read from here; it re-fetches after a POST so a
 * manual refresh updates the list in place. The list is a cache — the OAuth token
 * never leaves the server.
 */

import { NextResponse } from 'next/server';
import { settingsPersistence } from '@/lib/settingsPersistence';
import {
  loadCatalog,
  groupByFamily,
  lastSuccessfulCheckAt,
  triggerModelCatalogCheck,
} from '@/lib/modelCatalog';

export const runtime = 'nodejs';

const DAY_MS = 86_400_000;

async function payload() {
  const settings = await settingsPersistence.loadSettings();
  const families = groupByFamily(await loadCatalog());
  const lastAt = await lastSuccessfulCheckAt();
  const intervalMs = Math.max(1, settings.modelCatalogPollIntervalDays) * DAY_MS;
  const nextAt = settings.modelCatalogPollEnabled ? (lastAt ? lastAt + intervalMs : Date.now()) : null;
  return {
    enabled: settings.modelCatalogPollEnabled,
    intervalDays: settings.modelCatalogPollIntervalDays,
    lastCheckedAt: lastAt,
    nextCheckAt: nextAt,
    families,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await payload());
  } catch (err) {
    console.error('[ModelCatalog API] GET error:', err);
    return NextResponse.json({ error: 'Failed to load model catalog' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await triggerModelCatalogCheck();
    // Return the refreshed grouping alongside the check outcome so the client can
    // update in one round trip. A failed refresh still returns 200 with the prior
    // (unchanged) cache and the failure note — the picker surfaces it rather than
    // erroring the whole dialog.
    return NextResponse.json({ ...result, ...(await payload()) });
  } catch (err) {
    console.error('[ModelCatalog API] POST error:', err);
    return NextResponse.json({ error: 'Model catalog refresh failed' }, { status: 500 });
  }
}
