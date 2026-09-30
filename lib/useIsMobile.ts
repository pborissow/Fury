'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * The phone layout (docs/ticket-mobile-pwa.md §5.1).
 *
 * - `(max-width: 767px)`: phones in portrait, and narrow desktop windows.
 * - `(pointer: coarse) and (max-height: 500px)`: phones in LANDSCAPE, which are
 *   wider than 767px (iPhone 14: 844px) but short. Tablets are ≥ ~744px tall in
 *   either orientation, so they stay on the desktop layout.
 *
 * Rotating a phone must never switch layouts — both clauses together cover both
 * orientations.
 */
export const MOBILE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';

/** Touch as the primary input — drives touch affordances and Enter-for-newline,
 *  independently of width (a touch laptop wants visible row actions; a narrow
 *  desktop window keeps Enter-to-send). */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

// One stable subscribe function per query: useSyncExternalStore resubscribes
// whenever it receives a new function identity.
const subscribers = new Map<string, (onChange: () => void) => () => void>();
function subscribeTo(query: string) {
  let sub = subscribers.get(query);
  if (!sub) {
    sub = (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    };
    subscribers.set(query, sub);
  }
  return sub;
}

/**
 * A media query as React state. Server snapshot is `false` (desktop), so a
 * server-rendered component may render desktop first and switch after
 * hydration; client-only components (ChatTab) get the real value on first render.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribeTo(query),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Launched from an install (Chrome/Edge app window, Android/iOS home screen)
 *  rather than a browser tab. The OS window then carries the app's icon and
 *  name, so page.tsx drops its own header. */
export const PWA_QUERY = '(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)';
export function useIsPwa(): boolean {
  return useMediaQuery(PWA_QUERY);
}

/**
 * Whether the phone layout applies.
 *
 * `onBeforeChange` runs synchronously inside the media-query listener, BEFORE
 * the new value is committed — i.e. while the outgoing layout is still mounted.
 * ChatTab uses it to stash the composer draft, which lives in the editor and
 * would otherwise be lost when the layout swap remounts the panes. (With
 * useSyncExternalStore alone there is no such hook: React may re-render in a
 * microtask between two listeners of the same event.) Client-only: call it
 * only from components that never server-render.
 */
export function useIsMobile(onBeforeChange?: (next: boolean) => void): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const beforeRef = useRef(onBeforeChange);
  useEffect(() => { beforeRef.current = onBeforeChange; });

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      beforeRef.current?.(mql.matches);
      setIsMobile(mql.matches);
    };
    // The value may have changed between the initial render and this effect.
    if (mql.matches !== isMobile) onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once
  }, []);

  return isMobile;
}

/** SSR-safe variant for server-rendered components (page.tsx's header). */
export function useIsMobileSsr(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** Whether touch is the primary input (SSR-safe; `false` on the server). */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
