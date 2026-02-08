import { NextResponse } from 'next/server';
import { uiStatePersistence } from '@/lib/uiStatePersistence';

// GET - Load UI state
export async function GET() {
  try {
    const state = await uiStatePersistence.loadState();
    return NextResponse.json({ state });
  } catch (error) {
    console.error('Failed to load UI state:', error);
    return NextResponse.json(
      { error: 'Failed to load UI state' },
      { status: 500 }
    );
  }
}

// POST - Save UI state
export async function POST(request: Request) {
  try {
    const state = await request.json();
    await uiStatePersistence.saveState(state);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to save UI state:', error);
    return NextResponse.json(
      { error: 'Failed to save UI state' },
      { status: 500 }
    );
  }
}
