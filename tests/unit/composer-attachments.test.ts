/**
 * The Composer's attachment logic (components/composer/attachments.ts), which
 * useComposerAttachments wires to React state. The rules moved verbatim out of
 * ChatTab (docs/ticket-chattab-refactor.md, Stage 1a); these lock them in:
 * the 8-image cap and which end survives it, surfaced paste failures, and
 * failed-send images returning in front of anything staged since.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ATTACHMENTS, appendImages, prependImages, removeImage, stageFiles,
} from '../../components/composer/attachments';
import type { AttachedImage } from '../../lib/clientImage';

const img = (id: string): AttachedImage => ({
  id, dataUrl: `data:image/png;base64,${id}`, base64: id, mediaType: 'image/png', width: 1, height: 1, bytes: 1,
});
const ids = (xs: AttachedImage[]) => xs.map(x => x.id);
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => img(`${prefix}${i}`));
const file = (name: string) => ({ name }) as unknown as File;

describe('appendImages', () => {
  it('appends after what is staged', () => {
    expect(ids(appendImages([img('a')], [img('b'), img('c')]))).toEqual(['a', 'b', 'c']);
  });

  it('caps at 8, keeping the earliest-staged images', () => {
    expect(MAX_ATTACHMENTS).toBe(8);
    const out = appendImages(many('old', 6), many('new', 5));
    expect(out).toHaveLength(8);
    expect(ids(out)).toEqual([...ids(many('old', 6)), 'new0', 'new1']);
  });
});

describe('prependImages (a failed send returning its images)', () => {
  it('puts the returned images in front of anything staged since', () => {
    expect(ids(prependImages([img('since')], [img('sent1'), img('sent2')]))).toEqual(['sent1', 'sent2', 'since']);
  });

  it('caps at 8, keeping the returned images', () => {
    const out = prependImages(many('since', 5), many('sent', 5));
    expect(ids(out)).toEqual([...ids(many('sent', 5)), 'since0', 'since1', 'since2']);
  });
});

describe('removeImage', () => {
  it('removes by id only', () => {
    expect(ids(removeImage([img('a'), img('b'), img('c')], 'b'))).toEqual(['a', 'c']);
    expect(ids(removeImage([img('a')], 'missing'))).toEqual(['a']);
  });
});

describe('stageFiles', () => {
  it('normalizes every file, in order, with no error when all succeed', async () => {
    const out = await stageFiles([file('x'), file('y')], async f => img(f.name));
    expect(ids(out.added)).toEqual(['x', 'y']);
    expect(out.error).toBeNull();
  });

  it('skips failures but surfaces every reason, joined', async () => {
    const out = await stageFiles([file('ok'), file('big'), file('bad')], async f => {
      if (f.name === 'big') throw new Error('over 5MB');
      if (f.name === 'bad') throw 'not an Error';
      return img(f.name);
    });
    expect(ids(out.added)).toEqual(['ok']);
    expect(out.error).toBe('over 5MB; unreadable image');
  });

  it('reports an error even when nothing could be added', async () => {
    const out = await stageFiles([file('bad')], async () => { throw new Error('unsupported type'); });
    expect(out.added).toEqual([]);
    expect(out.error).toBe('unsupported type');
  });
});
