/**
 * envelopeHiddenMessages — the pure selector behind the dots-bubble modal
 * (docs/ticket-subagent-notification-turns-intermediate-bubbles.md).
 *
 * While a logical-task envelope is open, the main flow hides everything
 * committed at/after the envelope anchor (stripInFlightPartials with that
 * anchor); this helper picks the subset the modal shows: the envelope's
 * COMMITTED intermediate assistant messages, excluding the currently-streaming
 * turn's own in-flight partials.
 */
import { describe, it, expect } from 'vitest';
import { envelopeHiddenMessages, stripInFlightPartials } from '../../lib/transcriptStrip';

const T0 = Date.parse('2026-09-04T12:00:00Z'); // envelope opens (user send)
const ts = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const msg = (role: string, offsetSec: number | null, content = '') => ({
  role,
  content,
  timestamp: offsetSec == null ? undefined : ts(offsetSec),
});

describe('envelopeHiddenMessages', () => {
  const history = [
    msg('user', -600, 'earlier prompt'),
    msg('assistant', -590, 'earlier answer'),        // previous, settled task
    msg('user', 0, 'plan the rewrite'),              // envelope's opening send
    msg('assistant', 10, 'scouts dispatched, waiting…'), // turn 1 final
    msg('assistant', 60, 'got scout report #1'),     // notification turn 2 final
    msg('assistant', 120, 'got scout report #2'),    // notification turn 3 final
    msg('assistant', 200, 'writing the pl'),         // CURRENT turn's in-flight partial
  ];

  it('selects committed envelope assistant messages, excluding the current turn partials', () => {
    const hidden = envelopeHiddenMessages(history, T0, T0 + 190_000);
    expect(hidden.map((m) => m.content)).toEqual([
      'scouts dispatched, waiting…',
      'got scout report #1',
      'got scout report #2',
    ]);
  });

  it('with no main turn streaming (background phase, turnStartedAt null) shows every committed message', () => {
    const hidden = envelopeHiddenMessages(history, T0, null);
    expect(hidden.map((m) => m.content)).toEqual([
      'scouts dispatched, waiting…',
      'got scout report #1',
      'got scout report #2',
      'writing the pl',
    ]);
  });

  it('never reaches back before the envelope opened (a prior settled task is untouched)', () => {
    const hidden = envelopeHiddenMessages(history, T0, null);
    expect(hidden.some((m) => m.content === 'earlier answer')).toBe(false);
  });

  it('is empty during the envelope\'s FIRST turn (anchor == turn start: everything is a live partial)', () => {
    expect(envelopeHiddenMessages(history.slice(0, 4), T0, T0)).toEqual([]);
  });

  it('ignores user messages and entries without a parseable timestamp', () => {
    const weird = [
      msg('user', 5, 'internal-ish user string'),
      msg('assistant', null, 'no timestamp'),
      { role: 'assistant', content: 'bad ts', timestamp: 'not-a-date' },
      msg('assistant', 30, 'kept'),
    ];
    expect(envelopeHiddenMessages(weird, T0, null).map((m) => m.content)).toEqual(['kept']);
  });

  it('partitions with stripInFlightPartials: main flow + hidden = pre-envelope history + envelope commits', () => {
    // The render contract: the main flow slices at the envelope anchor, the modal
    // shows the committed remainder — nothing is lost, nothing double-renders.
    const shown = stripInFlightPartials(history, T0);
    const hidden = envelopeHiddenMessages(history, T0, T0 + 190_000);
    expect(shown.map((m) => m.content)).toEqual(['earlier prompt', 'earlier answer']);
    // shown ∩ hidden = ∅ and together they cover everything except the opening
    // user send (overlay bubble) and the current turn's partial (dots).
    expect(shown.filter((m) => hidden.includes(m))).toEqual([]);
    expect(shown.length + hidden.length).toBe(history.length - 2);
  });
});
