'use client';

import type { AttachedImage } from '@/lib/clientImage';

interface AttachmentStripProps {
  images: AttachedImage[];
  error?: string | null;
  onRemove: (id: string) => void;
}

/** Staged image thumbnails (hover to reveal remove) plus the paste/drop error
 *  line. Renders nothing when there are neither. */
export default function AttachmentStrip({ images, error, onRemove }: AttachmentStripProps) {
  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pt-2" data-testid="image-attachments">
          {images.map(img => (
            <div key={img.id} className="relative group/attach">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt="attachment"
                className="h-14 w-14 object-cover rounded border border-border"
              />
              <button
                type="button"
                onClick={() => onRemove(img.id)}
                className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-black/70 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover/attach:opacity-100 transition-opacity"
                title="Remove attachment"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div
          data-testid="attach-error"
          className="px-2 pt-1 text-[11px] text-red-500"
        >
          ⚠ {error}
        </div>
      )}
    </>
  );
}
