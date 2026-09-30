'use client';

import { forwardRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TranscriptRenderer from '@/components/TranscriptRenderer';

/** The in-flight bubble under the transcript (thinking dots / waiting on the user). */
export interface ConversationActivity {
  /** Whether a turn (or background task) is running. */
  show: boolean;
  /** A question is on screen: the turn is blocked on the user, not Claude. */
  awaitingAnswer: boolean;
  /** Hidden progress updates of an open logical-task envelope (the "+N" chip). */
  envelopeCount: number;
  /** Click on the dots bubble: open the envelope modal, or show the Stream view. */
  onOpen: () => void;
}

interface ConversationPaneProps {
  /** A session is selected; otherwise the welcome screen shows. */
  hasSession: boolean;
  onCreateSession: () => void;
  stuck: boolean;
  onKillStuck: () => void;

  /** The transcript is loading from the server. */
  loading: boolean;
  /** Nothing to show yet (no transcript and no optimistic messages). */
  empty: boolean;
  /** When empty: the session exists in history but its transcript is gone. */
  unavailable: boolean;
  /** Only the user's prompts survived (reconstructed from history). */
  partial: boolean;
  transcript: ComponentProps<typeof TranscriptRenderer>;
  activity: ConversationActivity;
  sessionError: string | null;
  transcriptEndRef: Ref<HTMLDivElement>;

  composer: ReactNode;
  /** Transcript above a resizable composer (desktop). False: stacked, no split. */
  splitComposer: boolean;
  verticalLayout: number[];
  onVerticalLayoutChange: (sizes: number[]) => void;
}

/**
 * The conversation column: stuck banner, transcript (incl. the in-flight bubble
 * and error), composer — or the welcome screen. The forwarded ref is the root
 * element, the portal container that anchors the AskUserQuestion modal here.
 */
const ConversationPane = forwardRef<HTMLDivElement, ConversationPaneProps>(function ConversationPane({
  hasSession, onCreateSession, stuck, onKillStuck,
  loading, empty, unavailable, partial, transcript, activity, sessionError, transcriptEndRef,
  composer, splitComposer, verticalLayout, onVerticalLayoutChange,
}, ref) {
  const transcriptArea = (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {loading ? (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
            <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
            <span className="ml-2">Loading transcript...</span>
          </div>
        </div>
      ) : empty ? (
        <div className="text-center text-muted-foreground mt-8 space-y-2">
          {unavailable ? (
            <>
              <p>Transcript unavailable for this session.</p>
              <p className="text-xs">The session data may have been created before Claude CLI began persisting transcripts, or the files were removed.</p>
            </>
          ) : (
            <p>Send a message to start the conversation.</p>
          )}
        </div>
      ) : (
        <>
          {partial && (
            <div className="rounded-md border border-yellow-600/50 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200 mb-4">
              <p className="font-medium">Partial transcript</p>
              <p className="text-xs text-yellow-300/70 mt-1">
                Only your prompts are available for this session. Full conversation transcripts were not persisted by Claude CLI at the time this session was created.
              </p>
            </div>
          )}
          <TranscriptRenderer {...transcript} />
          {activity.show && (
            <div className="flex justify-start">
              {/*
                While parked on a question the turn IS live and
                isProcessing IS true — correct, but the thinking
                dots would spin for as long as the human takes
                and read as a hang. The turn is not blocked on
                Claude; it's blocked on the user. Say that.
                Waiting on the DIALOG (not just isAwaitingAnswer)
                so this only shows while the question is on screen
                to answer.
              */}
              {activity.awaitingAnswer ? (
                <div
                  data-testid="awaiting-answer"
                  className="max-w-[80%] rounded-lg px-4 py-2 bg-elevated text-foreground border border-border text-left"
                >
                  <div className="text-xs opacity-70 mb-1">Claude</div>
                  <div className="text-sm">Waiting for your answer…</div>
                </div>
              ) : (
                <button
                  // With hidden envelope updates, the bubble's click
                  // opens the intermediary-messages modal (agreed
                  // product direction, docs/ticket-subagent-
                  // notification-turns-intermediate-bubbles.md);
                  // otherwise it keeps the legacy behavior (live
                  // stream panel).
                  onClick={activity.onOpen}
                  className="max-w-[80%] rounded-lg pl-4 pr-2 py-2 bg-elevated text-foreground border border-border cursor-pointer hover:border-ring transition-colors text-left"
                  title={activity.envelopeCount > 0 ? 'View progress updates' : 'View live stream'}
                >
                  <div className="text-xs mb-1 flex items-center gap-2">
                    <span className="opacity-70">Claude</span>
                    {/* Same chip TranscriptRenderer puts on settled bubbles
                        ("+N intermediary"), minus the word — just "+N" (user
                        direction 2026-09-09; replaced the earlier full-width
                        "N updates — click to view" line). Count live-updates:
                        envelopeHidden derives per render as notification turns
                        commit. A span, not a nested button — the whole dots
                        bubble is already the click target that opens the
                        intermediary-messages modal when updates exist. */}
                    {activity.envelopeCount > 0 && (
                      <span
                        data-testid="envelope-updates-chip"
                        className="text-[10px] text-muted-foreground bg-background border border-border rounded px-1.5 py-0.5 cursor-pointer hover:border-ring hover:text-foreground transition-colors"
                      >
                        +{activity.envelopeCount}
                      </span>
                    )}
                  </div>
                  <div data-testid="processing-dots" className="flex items-center gap-1 py-2">
                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                    <div className="dot w-2 h-2 bg-foreground rounded-full"></div>
                  </div>
                </button>
              )}
            </div>
          )}
          {sessionError && (
            <div className="flex justify-start" data-testid="session-error">
              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-destructive/10 text-foreground border border-destructive/40 text-left">
                <div className="text-xs text-destructive mb-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Session error
                </div>
                <div className="text-sm whitespace-pre-wrap">{sessionError}</div>
              </div>
            </div>
          )}
          {/* MCP connection failures are intentionally NOT surfaced in the
              main chat panel — they read as a chat message about the user's
              work. The MCP side view is the home for server status. */}
          <div ref={transcriptEndRef} />
        </>
      )}
    </div>
  );

  return (
    <div ref={ref} className="relative h-full bg-card border-r border-border flex flex-col">
      {hasSession ? (
        <>
          {stuck && (
            <div className="p-2 border-b border-border flex justify-end">
              <Button variant="destructive" size="sm" className="flex items-center gap-2" onClick={onKillStuck}>
                <AlertTriangle className="h-4 w-4" />
                Process Stuck - Kill
              </Button>
            </div>
          )}
          {splitComposer ? (
            <div className="flex-1 overflow-hidden">
              <PanelGroup direction="vertical" onLayout={onVerticalLayoutChange}>
                <Panel defaultSize={verticalLayout[0]} minSize={30}>
                  {transcriptArea}
                </Panel>
                <PanelResizeHandle className="h-2 bg-border hover:bg-primary transition-colors" />
                <Panel defaultSize={verticalLayout[1]} minSize={20}>
                  <div className="h-full p-4">{composer}</div>
                </Panel>
              </PanelGroup>
            </div>
          ) : (
            // Stacked (no resizable split — the phone layout): transcript
            // fills, composer pinned below, growing with its content up to a
            // share of the visible viewport and then scrolling internally.
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0">{transcriptArea}</div>
              <div className="mobile-composer p-4 border-t border-border">
                <div className="composer-stack">{composer}</div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="h-full flex flex-col items-center text-center px-8 pt-[12vh]">
          <div className="text-muted-foreground space-y-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/fury-mark.svg" alt="" className="h-44 w-44 mx-auto select-none" draggable={false} />
            <h2 className="text-xl font-semibold text-foreground">Welcome to Fury</h2>
            <p className="text-sm max-w-md">
              Select a session from the list to view its conversation, or create a new session to start chatting with Claude.
            </p>
            <Button onClick={onCreateSession} variant="outline" className="mt-4">
              <Plus className="h-4 w-4 mr-2" />
              New Session
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});

export default ConversationPane;
