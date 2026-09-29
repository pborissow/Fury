'use client';

import { useEffect, useEffectEvent } from 'react';
import { scrollIntoViewY } from '@/lib/scrollIntoViewY';

export interface OpenSessionRequest {
  sessionId: string;
  project: string;
  display: string;
  /** Changes on every request, so re-opening the same session re-fires. */
  nonce: number;
  /** A Search hit's message index to scroll to (`data-msg-index`). */
  turnIndex?: number;
}

/**
 * Open a session requested by another tab (Stats → "open this session", a
 * Search result), then — for a search hit — scroll its bubble into view and
 * flash it.
 *
 * Keyed on the request's nonce alone: `openSession` is re-created every render,
 * so depending on it would re-open the session on every state change.
 */
export function useOpenSessionRequest(
  request: OpenSessionRequest | null | undefined,
  openSession: (sessionId: string, project: string) => Promise<void> | void,
) {
  const open = useEffectEvent((sessionId: string, project: string) => openSession(sessionId, project));

  useEffect(() => {
    if (!request) return;
    const { sessionId, project, turnIndex } = request;
    if (!sessionId || !project) return;
    const opened = open(sessionId, project);
    if (turnIndex == null) return;
    // Search-result anchor: once the transcript is in, scroll the hit's bubble
    // into view and flash it. The bubbles render a beat after the fetch
    // resolves (state → React commit), so poll briefly. Exact data-msg-index
    // first; else the nearest EARLIER bubble (intermediary assistant messages
    // collapse into their turn and lose their own index).
    Promise.resolve(opened).then(() => {
      let tries = 0;
      const tryScroll = () => {
        let el = document.querySelector(`[data-msg-index="${turnIndex}"]`);
        if (!el) {
          let best = -1;
          for (const cand of document.querySelectorAll('[data-msg-index]')) {
            const idx = Number(cand.getAttribute('data-msg-index'));
            if (idx <= turnIndex && idx > best) { best = idx; el = cand; }
          }
          // Bubbles exist but none at/below the target yet → still rendering.
          if (el && tries < 5) el = null;
        }
        if (el) {
          scrollIntoViewY(el, { block: 'center' });
          (el as HTMLElement).animate(
            [
              { boxShadow: '0 0 0 3px var(--primary, #3b82f6)', offset: 0 },
              { boxShadow: '0 0 0 3px var(--primary, #3b82f6)', offset: 0.6 },
              { boxShadow: '0 0 0 3px transparent', offset: 1 },
            ],
            { duration: 1800 },
          );
        } else if (++tries < 20) {
          setTimeout(tryScroll, 100);
        }
      };
      setTimeout(tryScroll, 100);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);
}
