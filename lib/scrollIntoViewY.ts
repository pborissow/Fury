/**
 * `el.scrollIntoView`, but only along the Y axis of the element's nearest
 * vertically scrollable ancestor.
 *
 * Native scrollIntoView scrolls EVERY scrollable ancestor on both axes. In the
 * phone layout the Chat panes sit in a horizontal carousel (MobileChatLayout),
 * so an auto-scroll inside an off-screen pane — the Stream log following new
 * events, the transcript following a reply — would yank that pane on screen.
 * Use this for auto-scrolls inside the Chat panes. On desktop the result is the
 * same as scrollIntoView (there's only one vertical scroller involved).
 */
export function scrollIntoViewY(
  el: Element | null | undefined,
  { behavior = 'auto', block = 'start' }: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition } = {},
): void {
  if (!el) return;
  const container = nearestScrollY(el);
  if (!container) return;
  const c = container.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  let delta = 0;
  switch (block) {
    case 'start': delta = e.top - c.top; break;
    case 'end': delta = e.bottom - c.bottom; break;
    case 'center': delta = (e.top + e.height / 2) - (c.top + container.clientHeight / 2); break;
    case 'nearest':
      if (e.top < c.top) delta = e.top - c.top;
      else if (e.bottom > c.bottom) delta = e.bottom - c.bottom;
      break;
  }
  if (delta !== 0) container.scrollBy({ top: delta, behavior });
}

function nearestScrollY(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && p.scrollHeight > p.clientHeight) {
      return p;
    }
  }
  return null;
}
