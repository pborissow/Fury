'use client';

/**
 * TEST-ONLY harness — reproduces the AskUserQuestion dialog's containment bug in
 * isolation, without needing a live Claude turn.
 *
 * The real dialog (components/Dialog.tsx) is `portalContainer`-anchored to the
 * Chat tab's middle panel (ChatTab.tsx: middlePanelRef). This page mounts that
 * same Dialog into a bounded, positioned panel that stands in for the middle
 * column — smaller than the viewport in both axes — so a Playwright test can
 * assert the dialog stays WITHIN the panel when maximized.
 *
 * Driven by tests/e2e/dialog-maximize-containment.spec.ts. Not linked from the
 * app; reachable only by its route path.
 */
import { useState } from 'react';
import { notFound } from 'next/navigation';
import Dialog from '@/components/Dialog';

export default function DialogHarness() {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);

  // Test-only. Keep it out of a production bundle's routing; Playwright drives it
  // against `npm run dev` (NODE_ENV=development), so this never blocks the test.
  // After the hooks so their call order never varies between environments.
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0b0b' }}>
      {/*
        Stand-in for the Chat tab's middle panel: positioned (so it's a valid
        portal container / containing block), narrower AND shorter than the
        1400x900 test viewport, and clipping — exactly the conditions under which
        a viewport-sized "maximize" escapes the panel and drags its own header +
        footer out of reach.
      */}
      <div
        ref={setPanel}
        data-testid="harness-panel"
        style={{
          position: 'absolute',
          left: 360,
          top: 70,
          width: 680,
          bottom: 60, // height ≈ 770 at 900px viewport
          background: '#181818',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: 16, color: '#888' }}>
          Chat panel content behind the dialog…
        </div>

        {panel && (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Harness Dialog"
            defaultWidth={520}
            defaultHeight={420}
            minWidth={360}
            minHeight={260}
            maximizable
            portalContainer={panel}
            buttons={[{ label: 'Submit', onClick: () => {} }]}
          >
            <div data-testid="harness-body" className="text-sm">
              Body content — double-click the header to maximize.
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}
