'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export type MobilePane = 'sessions' | 'conversation' | 'side';
export const MOBILE_PANES: readonly MobilePane[] = ['sessions', 'conversation', 'side'];

interface MobileChatLayoutProps {
  sessions: ReactNode;
  conversation: ReactNode;
  side: ReactNode;
  /** Controlled: the pane to show. Changing it scrolls there. */
  pane: MobilePane;
  /** A swipe settled on a different pane. */
  onPaneChange: (pane: MobilePane) => void;
}

/**
 * The phone Chat tab (docs/ticket-mobile-pwa.md §5.3): the same three panes as
 * DesktopChatLayout, as full-width pages in a horizontal CSS scroll-snap
 * carousel. Native momentum and snapping, no gesture library; nested horizontal
 * scrollers (code blocks, tables) scroll first and only hand off at their edge.
 *
 * All three panes stay mounted, so transcript scroll, the file tree and the side
 * view keep their state while off screen.
 *
 * Never reads or writes /api/ui-state: the desktop panel sizes are server-wide
 * and shared by every device.
 */
export default function MobileChatLayout({ sessions, conversation, side, pane, onPaneChange }: MobileChatLayoutProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<MobilePane, HTMLElement | null>>({ sessions: null, conversation: null, side: null });
  // The pane the scroll position currently shows (as last reported/applied), so
  // prop changes that merely echo a swipe don't trigger another scroll. Starts
  // at the first page (scrollLeft 0), so a mount on another pane scrolls there.
  const shownRef = useRef<MobilePane>(MOBILE_PANES[0]);
  const mountedRef = useRef(false);
  // While a programmatic scroll is in flight, intersection reports are the
  // animation passing through panes, not a user choice — ignore them.
  const programmaticUntilRef = useRef(0);
  const onPaneChangeRef = useRef(onPaneChange);
  useEffect(() => { onPaneChangeRef.current = onPaneChange; });

  // Swipe → state: report the pane that settles in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new IntersectionObserver((entries) => {
      if (Date.now() < programmaticUntilRef.current) return;
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const id = (entry.target as HTMLElement).dataset.pane as MobilePane;
        if (id && id !== shownRef.current) {
          shownRef.current = id;
          onPaneChangeRef.current(id);
        }
      }
    }, { root: scroller, threshold: [0.6] });
    for (const id of MOBILE_PANES) {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  // State → scroll: indicator taps and automatic navigation.
  useEffect(() => {
    if (pane === shownRef.current) return;
    const scroller = scrollerRef.current;
    const target = sectionRefs.current[pane];
    if (!scroller || !target) return;
    shownRef.current = pane;
    // Jump on mount; animate afterwards.
    const smooth = mountedRef.current;
    programmaticUntilRef.current = Date.now() + (smooth ? 700 : 100);
    // Scroll the carousel itself (not scrollIntoView, which would also scroll
    // ancestors — and, on iOS, the page).
    scroller.scrollTo({ left: target.offsetLeft, behavior: smooth ? 'smooth' : 'instant' });
  }, [pane]);
  useEffect(() => { mountedRef.current = true; }, []);

  // Keep the shown pane aligned across viewport resizes (rotation, keyboard):
  // a resize changes page width, and snap may otherwise land mid-way.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const ro = new ResizeObserver(() => {
      const target = sectionRefs.current[shownRef.current];
      if (target && Math.abs(scroller.scrollLeft - target.offsetLeft) > 1) {
        programmaticUntilRef.current = Date.now() + 300;
        scroller.scrollTo({ left: target.offsetLeft, behavior: 'instant' });
      }
    });
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  const panes: Record<MobilePane, ReactNode> = { sessions, conversation, side };

  return (
    <div ref={scrollerRef} className="mobile-carousel h-full" data-testid="mobile-carousel">
      {MOBILE_PANES.map(id => (
        <section
          key={id}
          ref={(el) => { sectionRefs.current[id] = el; }}
          data-pane={id}
          data-testid={`mobile-pane-${id}`}
          aria-label={id}
          className="h-full min-w-0 overflow-hidden"
        >
          {panes[id]}
        </section>
      ))}
    </div>
  );
}
