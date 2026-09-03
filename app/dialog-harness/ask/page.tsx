'use client';

/**
 * TEST-ONLY harness — reproduces the AskUserQuestion draft-loss bug in
 * isolation, without needing a live Claude turn.
 *
 * In the real app the dialog is only modal within the chat panel; the session
 * list stays clickable, and switching sessions UNMOUNTS the dialog (ChatTab
 * clears askUserQuestion unconditionally on switch), then re-parks the question
 * on a fresh mount when the user switches back. This page simulates that cycle
 * with mount/unmount buttons so a Playwright test can assert that selections
 * and typed "Other" text survive (the askDrafts store in
 * components/AskUserQuestionDialog.tsx).
 *
 * Not linked from the app; reachable only by its route path.
 */
import { useState } from 'react';
import { notFound } from 'next/navigation';
import AskUserQuestionDialog from '@/components/AskUserQuestionDialog';
import type { AskQuestion } from '@/lib/askUserQuestion';

const QUESTIONS: AskQuestion[] = [
  {
    question: 'Which approach should we take?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Option A', description: 'The first approach' },
      { label: 'Option B', description: 'The second approach' },
    ],
  },
];

export default function AskDialogHarness() {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  // Simulates ChatTab's askUserQuestion state: null = switched away (dialog
  // unmounted), non-null = question parked on the viewed session.
  const [mounted, setMounted] = useState(true);
  const [lastResult, setLastResult] = useState('');

  // Test-only. Keep it out of a production bundle's routing; Playwright drives it
  // against `npm run dev` (NODE_ENV=development), so this never blocks the test.
  // After the hooks so their call order never varies between environments.
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0b0b' }}>
      {/* Stand-ins for the session list: clickable while the dialog is up. */}
      <div style={{ position: 'absolute', left: 16, top: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button data-testid="switch-away" onClick={() => setMounted(false)} style={{ color: '#ccc' }}>
          Switch away (unmount)
        </button>
        <button data-testid="switch-back" onClick={() => setMounted(true)} style={{ color: '#ccc' }}>
          Switch back (remount)
        </button>
        <div data-testid="last-result" style={{ color: '#888', maxWidth: 300, fontSize: 12 }}>
          {lastResult}
        </div>
      </div>

      {/* Stand-in for the Chat tab's middle panel (the portal container). */}
      <div
        ref={setPanel}
        data-testid="harness-panel"
        style={{
          position: 'absolute',
          left: 360,
          top: 40,
          width: 720,
          bottom: 40,
          background: '#181818',
          overflow: 'hidden',
        }}
      >
        {panel && mounted && (
          <AskUserQuestionDialog
            open={true}
            questions={QUESTIONS}
            portalContainer={panel}
            draftKey="harness-tool-use-1"
            onSubmit={(answer) => setLastResult(`submitted: ${answer}`)}
            onSkip={() => setLastResult('skipped')}
          />
        )}
      </div>
    </div>
  );
}
