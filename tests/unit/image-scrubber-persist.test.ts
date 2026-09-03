/**
 * lib/imageScrubber persist mode: older-turn image blocks are externalized to
 * the per-session store and replaced with a fury-img://<hash> ref placeholder,
 * while ephemeral mode collapses them to the bare placeholder and drops bytes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scrubImages } from '../../lib/imageScrubber';
import { hashBytes, hasImage } from '../../lib/imageStore';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fury-scrub-'));
beforeAll(() => { process.env.FURY_IMAGES_PATH = TEMP_ROOT; });
afterAll(() => { delete process.env.FURY_IMAGES_PATH; rmSync(TEMP_ROOT, { recursive: true, force: true }); });

// Distinct payloads so hashes differ per turn.
const B64_A = Buffer.from('image-alpha').toString('base64');
const B64_B = Buffer.from('image-bravo').toString('base64');

function userImageTurn(text: string, b64: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      ],
    },
  });
}

describe('scrubImages persist mode', () => {
  it('externalizes older-turn images to the store and leaves a fury-img ref', () => {
    const jsonl = [userImageTurn('first', B64_A), userImageTurn('second', B64_B)].join('\n');
    const res = scrubImages(jsonl, { keepRecentTurns: 1, persist: true, sessionId: 'sp1' });

    expect(res.scrubbed).toBe(1); // only the older turn
    expect(res.kept).toBe(1);     // newest turn kept inline

    // Old turn's base64 is gone; its ref is present and points at the stored hash.
    const hashA = hashBytes(Buffer.from(B64_A, 'base64'));
    expect(res.content).not.toContain(B64_A);
    expect(res.content).toContain(`fury-img://${hashA}`);
    expect(hasImage('sp1', hashA)).toBe(true);

    // Newest turn stays inline (true vision on resume).
    expect(res.content).toContain(B64_B);
  });

  it('ephemeral mode (default) uses the bare placeholder and writes no bytes', () => {
    const jsonl = [userImageTurn('first', B64_A), userImageTurn('second', B64_B)].join('\n');
    const res = scrubImages(jsonl, { keepRecentTurns: 1 });
    expect(res.content).toContain('[image previously analyzed]');
    expect(res.content).not.toContain('fury-img://');
    const hashA = hashBytes(Buffer.from(B64_A, 'base64'));
    expect(hasImage('sp-ephemeral', hashA)).toBe(false);
  });

  it('dedups identical images within a session (one file for repeats)', () => {
    // Two older turns with the SAME image; keepRecentTurns 0 scrubs everything.
    const jsonl = [userImageTurn('a', B64_A), userImageTurn('b', B64_A), userImageTurn('c', B64_B)].join('\n');
    const res = scrubImages(jsonl, { keepRecentTurns: 0, persist: true, sessionId: 'sp-dedup' });
    const hashA = hashBytes(Buffer.from(B64_A, 'base64'));
    // Both A-turns collapse to the same ref hash.
    const refCount = (res.content.match(new RegExp(`fury-img://${hashA}`, 'g')) || []).length;
    expect(refCount).toBe(2);
    expect(hasImage('sp-dedup', hashA)).toBe(true);
  });

  it('internal user entries do NOT count as turns for keepRecentTurns', () => {
    // Real image turn followed by CLI plumbing: a task-notification, a
    // command marker, and an isMeta reminder. The scrubber used to count each
    // as a fresh turn, sliding the keepRecentTurns=1 window past the real turn
    // and scrubbing the just-pasted image on its own turn's result event.
    const internal = (text: string) => JSON.stringify({
      type: 'user', message: { role: 'user', content: text },
    });
    const meta = JSON.stringify({
      type: 'user', isMeta: true, message: { role: 'user', content: 'reminder' },
    });
    const interrupted = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    const jsonl = [
      userImageTurn('real turn', B64_A),
      internal('<task-notification>done</task-notification>'),
      internal('<command-name>/foo</command-name>'),
      meta,
      interrupted,
    ].join('\n');

    const res = scrubImages(jsonl, { keepRecentTurns: 1 });
    // The image is in the MOST RECENT real turn — it must be kept inline.
    expect(res.scrubbed).toBe(0);
    expect(res.kept).toBe(1);
    expect(res.content).toContain(B64_A);
  });

  it('does not externalize non-accepted media types (no unreachable .bin refs)', () => {
    // image/bmp is outside the accepted set: the store would file it as .bin,
    // which getImagePath never probes — a ref that can never resolve. It must
    // collapse to the bare placeholder instead.
    const bmpTurn = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: B64_A } }],
      },
    });
    const res = scrubImages([bmpTurn, userImageTurn('next', B64_B)].join('\n'),
      { keepRecentTurns: 1, persist: true, sessionId: 'sp-bmp' });
    expect(res.scrubbed).toBe(1);
    expect(res.content).not.toContain(B64_A);
    expect(res.content).not.toContain('fury-img://');
    const hashA = hashBytes(Buffer.from(B64_A, 'base64'));
    expect(hasImage('sp-bmp', hashA)).toBe(false);
  });

  it('toolUseResult images get a resolvable ref in persist mode', () => {
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
      toolUseResult: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64_A } },
    });
    const res = scrubImages([toolResultLine, userImageTurn('next', B64_B)].join('\n'),
      { keepRecentTurns: 1, persist: true, sessionId: 'sp-tur' });
    const hashA = hashBytes(Buffer.from(B64_A, 'base64'));
    // Previously this site bypassed replacementFor and always wrote the bare
    // placeholder — persist mode lost the ref (and the tool-UI rendering
    // follow-up would find no hash to resolve).
    expect(res.content).toContain(`fury-img://${hashA}`);
    expect(hasImage('sp-tur', hashA)).toBe(true);
  });
});
