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

  it('keeps an idle SDK session that has in-flight background work (orchestrator wait)', () => {
    // Main turn idle (not in sdkActiveIds) but a background subagent is running.
    // Without backgroundActiveIds this session would be dropped by the managed
    // subtract and read as dead during the whole background window.
    expect(
      computeLiveSessionIds({
        ...base,
        scannerIds: ['sdk-orch'],
        sdkManagedIds: ['sdk-orch'],
        backgroundActiveIds: ['sdk-orch'],
      }),
    ).toEqual(['sdk-orch']);
  });

  it('a session both processing AND background-active is listed once', () => {
    expect(
      computeLiveSessionIds({
        ...base,
        scannerIds: ['sdk-both'],
        sdkManagedIds: ['sdk-both'],
        sdkActiveIds: ['sdk-both'],
        backgroundActiveIds: ['sdk-both'],
      }),
    ).toEqual(['sdk-both']);
  });

  it('stale-LIVE repro: a warm Fury process orphaned from the map is STILL suppressed via furyWarmIds', () => {
    // The bug: the session dropped out of the managed map (sdkManagedIds=[]) while
    // its warm CLI process stays alive, so the scanner reports it. Keyed only on the
    // map, the subtract misses it → pinned live while idle.
    const buggy = computeLiveSessionIds({ ...base, scannerIds: ['warm-orphan'], sdkManagedIds: [] });
    expect(buggy, 'without furyWarmIds the orphaned warm process is (wrongly) live').toContain('warm-orphan');

    // The fix: the manager's durable pid record still knows it's Fury's warm process.
    const fixed = computeLiveSessionIds({
      ...base,
      scannerIds: ['warm-orphan'],
      sdkManagedIds: [],
      furyWarmIds: ['warm-orphan'],
    });
    expect(fixed, 'furyWarmIds suppresses a warm-but-idle Fury process').not.toContain('warm-orphan');
  });

  it('a warm Fury process that IS processing/background stays live despite furyWarmIds', () => {
    // furyWarmIds is subtracted BEFORE active/background are re-added, so real work
    // is never suppressed.
    expect(
      computeLiveSessionIds({ ...base, scannerIds: ['w'], furyWarmIds: ['w'], sdkActiveIds: ['w'] }),
    ).toContain('w');
    expect(
      computeLiveSessionIds({ ...base, scannerIds: ['w'], furyWarmIds: ['w'], backgroundActiveIds: ['w'] }),
    ).toContain('w');
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
