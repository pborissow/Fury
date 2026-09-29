/**
 * projectEnvelope — the Chat tab's display projection, extracted from ChatTab
 * (docs/ticket-chattab-refactor.md, Stage 2). Pure function of (transcript,
 * live, livenessDotsEnabled, overlay): what the main flow shows, what the
 * dots-bubble modal shows, and which committed user sends are echoed.
 */
import { describe, it, expect } from 'vitest';
import { projectEnvelope } from '../../lib/envelopeProjection';
import type { Liveness } from '../../lib/eventBus';

const T0 = Date.parse('2026-09-29T12:00:00Z'); // envelope opens (user send)
const ts = (sec: number) => new Date(T0 + sec * 1000).toISOString();
type M = { role: 'user' | 'assistant'; content: string; timestamp: string; askAnswer?: boolean };
const u = (sec: number, content: string, extra: Partial<M> = {}): M => ({ role: 'user', content, timestamp: ts(sec), ...extra });
const a = (sec: number, content: string): M => ({ role: 'assistant', content, timestamp: ts(sec) });

const live = (over: Partial<Liveness>): Liveness => ({
  phase: 'main', startedAt: null, envelopeStartedAt: null, mainTurnActive: true, seq: 1,
  ...over,
} as Liveness);

const transcript: M[] = [
  u(-600, 'earlier prompt'),
  a(-590, 'earlier answer'),
  u(0, 'plan the rewrite'),          // envelope's opening send
  a(10, 'scouts dispatched'),         // notification turn 1 final
  a(60, 'got scout report'),          // notification turn 2 final
  a(200, 'writing the pl'),           // current turn's in-flight partial
];
const contents = (ms: M[] | null) => ms?.map(m => m.content) ?? null;

describe('projectEnvelope', () => {
  it('with no liveness reading, shows the transcript untouched', () => {
    const p = projectEnvelope({ transcript, live: null, livenessDotsEnabled: true, overlay: [] });
    expect(p.envelopeOpen).toBe(false);
    expect(p.displayCutAt).toBeNull();
    expect(p.displayedTranscript).toBe(transcript);
    expect(p.envelopeHidden).toEqual([]);
    expect(p.envelopeUserEcho).toBeNull();
  });

  it('open envelope: cuts the main flow at the anchor, hides committed updates, echoes the prompt', () => {
    const p = projectEnvelope({
      transcript, overlay: [], livenessDotsEnabled: true,
      live: live({ envelopeStartedAt: T0, startedAt: T0 + 190_000 }),
    });
    expect(p.envelopeOpen).toBe(true);
    expect(p.displayCutAt).toBe(T0);
    expect(contents(p.displayedTranscript)).toEqual(['earlier prompt', 'earlier answer']);
    // Committed intermediate updates, not the current turn's in-flight partial.
    expect(contents(p.envelopeHidden)).toEqual(['scouts dispatched', 'got scout report']);
    // No overlay on a restore mid-task → the committed prompt is resurfaced.
    expect(contents(p.envelopeUserEcho)).toEqual(['plan the rewrite']);
  });

  it('no envelope: strips only the current turn\'s in-flight partials', () => {
    const p = projectEnvelope({
      transcript, overlay: [], livenessDotsEnabled: true,
      live: live({ envelopeStartedAt: null, startedAt: T0 + 190_000 }),
    });
    expect(p.envelopeOpen).toBe(false);
    expect(p.displayCutAt).toBe(T0 + 190_000);
    expect(contents(p.displayedTranscript)).toEqual(transcript.slice(0, 5).map(m => m.content));
    expect(p.envelopeHidden).toEqual([]);
    expect(p.envelopeUserEcho).toBeNull();
  });

  it('idle phase closes the envelope even with a stale anchor', () => {
    const p = projectEnvelope({
      transcript, overlay: [], livenessDotsEnabled: true,
      live: live({ phase: 'idle', envelopeStartedAt: T0, startedAt: null }),
    });
    expect(p.envelopeOpen).toBe(false);
    expect(p.displayedTranscript).toBe(transcript);
  });

  it('flag off (legacy dots): never projects', () => {
    const p = projectEnvelope({
      transcript, overlay: [], livenessDotsEnabled: false,
      live: live({ envelopeStartedAt: T0, startedAt: T0 + 190_000 }),
    });
    expect(p.envelopeOpen).toBe(false);
    expect(p.displayCutAt).toBeNull();
    expect(p.displayedTranscript).toBe(transcript);
  });

  it('the echo defers to an overlay with real content, but not to a blank one', () => {
    const open = { transcript, livenessDotsEnabled: true, live: live({ envelopeStartedAt: T0, startedAt: T0 + 190_000 }) };
    expect(projectEnvelope({ ...open, overlay: [{ content: 'plan the rewrite' }] }).envelopeUserEcho).toBeNull();
    expect(projectEnvelope({ ...open, overlay: [{ content: '', images: ['x'] }] }).envelopeUserEcho).toBeNull();
    // A notification turn's empty userPrompt must not hide the real prompt (2026-09-19).
    expect(contents(projectEnvelope({ ...open, overlay: [{ content: '  ' }] }).envelopeUserEcho)).toEqual(['plan the rewrite']);
  });

  it('never echoes an AskUserQuestion answer as a live "You" send', () => {
    const withAnswer = [...transcript, u(30, '"Scope?"="Durable"', { askAnswer: true })];
    const p = projectEnvelope({
      transcript: withAnswer, overlay: [], livenessDotsEnabled: true,
      live: live({ envelopeStartedAt: T0, startedAt: T0 + 190_000 }),
    });
    expect(contents(p.envelopeUserEcho)).toEqual(['plan the rewrite']);
  });
});
