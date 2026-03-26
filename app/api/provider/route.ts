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
    const switchBack = getSwitchBackScheduled();
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

    // Cancel any pending auto-switch-back when the user switches manually
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
