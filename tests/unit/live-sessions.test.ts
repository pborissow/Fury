import { describe, it, expect } from 'vitest';
import { computeLiveSessionIds } from '../../lib/liveSessions';

const base = { scannerIds: [], shippingActiveIds: [], sdkManagedIds: [], sdkActiveIds: [] };

describe('computeLiveSessionIds', () => {
  it('keeps a shipping session that is processing (scanner sees its process)', () => {
    expect(computeLiveSessionIds({ ...base, scannerIds: ['ship-1'] })).toEqual(['ship-1']);
  });

  it('adds a shipping session whose PID file carries a spawn-specific id', () => {
    // Scanner missed it (different id on disk); manager knows it's processing.
    expect(computeLiveSessionIds({ ...base, shippingActiveIds: ['ship-2'] })).toEqual(['ship-2']);
  });

  it('drops an idle-but-warm SDK session (in scanner + managed, not processing)', () => {
    expect(
      computeLiveSessionIds({ ...base, scannerIds: ['sdk-idle'], sdkManagedIds: ['sdk-idle'] }),
    ).toEqual([]);
  });

  it('keeps a warm SDK session that IS processing', () => {
    expect(
      computeLiveSessionIds({
        ...base,
        scannerIds: ['sdk-busy'],
        sdkManagedIds: ['sdk-busy'],
        sdkActiveIds: ['sdk-busy'],
      }),
    ).toEqual(['sdk-busy']);
  });

  it('marks a processing SDK session live even if the scanner has not caught it yet', () => {
    expect(
      computeLiveSessionIds({ ...base, sdkManagedIds: ['sdk-x'], sdkActiveIds: ['sdk-x'] }),
    ).toEqual(['sdk-x']);
  });

  it('leaves a non-Fury SDK/CLI process (in scanner, not managed) untouched', () => {
    // e.g. an external `claude` CLI session — Fury cannot read its isProcessing,
    // so we do not suppress it.
    expect(computeLiveSessionIds({ ...base, scannerIds: ['external-cli'] })).toEqual(['external-cli']);
  });

  it('handles a realistic mix and returns a sorted, deduped list', () => {
    const out = computeLiveSessionIds({
      scannerIds: ['sdk-idle', 'sdk-busy', 'external-cli', 'ship-1'],
      shippingActiveIds: ['ship-1', 'ship-2'],
      sdkManagedIds: ['sdk-idle', 'sdk-busy'],
      sdkActiveIds: ['sdk-busy'],
    });
    expect(out).toEqual(['external-cli', 'sdk-busy', 'ship-1', 'ship-2']);
    // sdk-idle suppressed; everything else present; sorted; no dupes.
    expect(out).not.toContain('sdk-idle');
  });
});
