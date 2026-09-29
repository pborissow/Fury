import type { AttachedImage } from '@/lib/clientImage';

/** Max staged attachments per send — matches the server-side cap. */
export const MAX_ATTACHMENTS = 8;

/** Append newly staged images, keeping the oldest when over the cap. */
export function appendImages(prev: AttachedImage[], added: AttachedImage[]): AttachedImage[] {
  return [...prev, ...added].slice(0, MAX_ATTACHMENTS);
}

/** Put images back IN FRONT of whatever is staged now (a failed/rolled-back
 *  send returning its attachments), keeping those when over the cap. */
export function prependImages(prev: AttachedImage[], images: AttachedImage[]): AttachedImage[] {
  return [...images, ...prev].slice(0, MAX_ATTACHMENTS);
}

export function removeImage(prev: AttachedImage[], id: string): AttachedImage[] {
  return prev.filter(img => img.id !== id);
}

/**
 * Normalize pasted/dropped files into attachments. A file that fails
 * (unsupported type, decode error, over the size cap) is skipped, but its
 * reason is SURFACED as `error` — a silent drop reads as "attached" to the user
 * who just pasted. `error` is null when every file succeeded, so a clean paste
 * also clears a previous error.
 */
export async function stageFiles(
  files: File[],
  normalize: (file: File) => Promise<AttachedImage>,
): Promise<{ added: AttachedImage[]; error: string | null }> {
  const failures: string[] = [];
  const results = await Promise.all(
    files.map(async f => {
      try {
        return await normalize(f);
      } catch (err) {
        console.warn('[Composer] Skipping image:', err);
        failures.push(err instanceof Error ? err.message : 'unreadable image');
        return null;
      }
    }),
  );
  return {
    added: results.filter((r): r is AttachedImage => r !== null),
    error: failures.length > 0 ? failures.join('; ') : null,
  };
}
