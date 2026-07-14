/**
 * Pricing poller status + manual trigger.
 *
 *   GET  /api/pricing  → cadence config, last/next check, recent check log,
 *                        active overrides.
 *   POST /api/pricing  → run a check now (manual trigger).
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { settingsPersistence } from '@/lib/settingsPersistence';
import { triggerPricingCheck } from '@/lib/pricingPoller';

const DAY_MS = 86_400_000;

export async function GET() {
  try {
    const db = await getDb();
    const settings = await settingsPersistence.loadSettings();

    const checks = await db.execute(
      `SELECT checked_at, status, http_status, trigger, models_seen, changes, note
       FROM pricing_checks ORDER BY checked_at DESC LIMIT 20`,
    );
    const overrides = await db.execute(
      `SELECT model, effective_from, input, output, cache_write_5m, cache_write_1h, cache_read, discovered_at, source
       FROM pricing_overrides ORDER BY discovered_at DESC`,
    );

    const lastAt = checks.rows[0] ? Number(checks.rows[0].checked_at) : null;
    const intervalMs = Math.max(1, settings.pricingPollIntervalDays) * DAY_MS;
    const nextAt = settings.pricingPollEnabled ? (lastAt ? lastAt + intervalMs : Date.now()) : null;

    return NextResponse.json({
      enabled: settings.pricingPollEnabled,
      intervalDays: settings.pricingPollIntervalDays,
      lastCheckedAt: lastAt,
      nextCheckAt: nextAt,
      source: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
      checks: checks.rows,
      overrides: overrides.rows,
    });
  } catch (err) {
    console.error('[Pricing API] GET error:', err);
    return NextResponse.json({ error: 'Failed to load pricing status' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await triggerPricingCheck();
    return NextResponse.json(result);
  } catch (err) {
    console.error('[Pricing API] POST error:', err);
    return NextResponse.json({ error: 'Pricing check failed' }, { status: 500 });
  }
}
