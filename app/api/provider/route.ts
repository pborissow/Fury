import { NextRequest, NextResponse } from 'next/server';
import {
  getProviderStatus,
  switchToAnthropic,
  switchToBedrock,
  cancelScheduledSwitchBack,
  getSwitchBackScheduled,
} from '@/lib/providerSwitch';

export const runtime = 'nodejs';

/**
 * GET /api/provider — current provider status
 */
export async function GET() {
  try {
    const status = await getProviderStatus();
    const switchBack = await getSwitchBackScheduled();
    return NextResponse.json({ ...status, ...switchBack });
  } catch (error) {
    console.error('[Provider API] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to read provider status' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/provider — switch provider
 *
 * Body: { "provider": "anthropic" | "bedrock" }
 * Optional Bedrock overrides: { "awsProfile", "awsRegion", "model", "smallFastModel" }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider, ...bedrockOverrides } = body;

    if (provider !== 'anthropic' && provider !== 'bedrock') {
      return NextResponse.json(
        { error: 'provider must be "anthropic" or "bedrock"' },
        { status: 400 },
      );
    }

    const before = await getProviderStatus();
    if (before.current === provider) {
      // Redundant click on the current provider. Short-circuit:
      //  1. Don't cancel the in-memory auto-switch-back timer.
      //  2. Don't append a `switched-to-*` entry to the fallback log.
      // Either side-effect would mask a pending auto-failover return:
      // a manual `switched-to-bedrock` entry with no `scheduledReturnAt`
      // is the newest matching event for `getPendingSwitchBack()`,
      // which silently bails — auto-return then never fires, even
      // across server restarts.
      return NextResponse.json({
        previousProvider: before.current,
        newProvider: provider,
        backupPath: '',
        message: `Already on ${provider}; no change.`,
      });
    }

    // Genuine provider change: cancel any pending in-memory timer.
    // (The durable record is implicitly resolved by the new
    // switched-to-* log entry that switchTo* appends below.)
    cancelScheduledSwitchBack();

    const result =
      provider === 'anthropic'
        ? await switchToAnthropic()
        : await switchToBedrock(bedrockOverrides);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Provider API] POST error:', error);
    return NextResponse.json(
      { error: 'Failed to switch provider' },
      { status: 500 },
    );
  }
}
