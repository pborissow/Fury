'use client';

/** Render snippet text, translating the \u0001/\u0002 boundary markers into
 *  <mark>. Everything else is plain text — NEVER dangerouslySetInnerHTML. */
export default function Snippet({ text }: { text: string }) {
  // Merge marks separated only by whitespace ("image" "clipboard") into ONE
  // mark so a matched phrase reads as a phrase, not as chopped-up pills.
  const merged = text.replace(/\u0002(\s+)\u0001/g, '$1');
  const nodes: React.ReactNode[] = [];
  const opens = merged.split('\u0001');
  nodes.push(opens[0]);
  for (let i = 1; i < opens.length; i++) {
    const [marked, ...rest] = opens[i].split('\u0002');
    nodes.push(
      // --highlight tokens (globals.css): amber, the one hue not already
      // spoken for in the grayscale theme (blue = user, green = live). A gray
      // "highlight" is invisible — this is THE thing the eye scans for.
      <mark key={i} className="bg-highlight text-highlight-foreground font-medium rounded-[3px] px-0.5 -mx-px">
        {marked}
      </mark>,
    );
    nodes.push(rest.join(''));
  }
  // The snippet IS the content being scanned, so it gets near-full contrast at
  // rest (metadata stays muted); it still brightens on row hover as a
  // "this is clickable" cue.
  return <span className="text-sm text-foreground/85 group-hover/hit:text-foreground transition-colors leading-relaxed">{nodes}</span>;
}
