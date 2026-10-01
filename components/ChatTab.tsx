'use client';

import { useState, useRef, useEffect } from 'react';
import type { RichTextEditorHandle } from '@/components/RichTextEditor';
import Composer from '@/components/composer/Composer';
import { useComposerAttachments } from '@/components/composer/useComposerAttachments';
import { useNotes } from '@/components/notes/useNotes';
import { useViewedSession } from '@/components/chat/hooks/useViewedSession';
import { useTts } from '@/components/chat/hooks/useTts';
import { useProviderStatus } from '@/components/chat/hooks/useProviderStatus';
import { useSessionHistory } from '@/components/chat/hooks/useSessionHistory';
import { useSessionDrafts } from '@/components/chat/hooks/useSessionDrafts';
import { useAskUserQuestion } from '@/components/chat/hooks/useAskUserQuestion';
import { useLimitHandling } from '@/components/chat/hooks/useLimitHandling';
import { useSessionStream } from '@/components/chat/hooks/useSessionStream';
import { useNewSessionWizard } from '@/components/chat/hooks/useNewSessionWizard';
import { useOpenSessionRequest, type OpenSessionRequest } from '@/components/chat/hooks/useOpenSessionRequest';
import DesktopChatLayout from '@/components/chat/DesktopChatLayout';
import MobileChatLayout, { type MobilePane } from '@/components/chat/MobileChatLayout';
import { useIsMobile, useIsCoarsePointer } from '@/lib/useIsMobile';
import SessionsPane from '@/components/chat/SessionsPane';
import ConversationPane from '@/components/chat/ConversationPane';
import ChatSidePane, { type ChatSideView } from '@/components/chat/ChatSidePane';
import ChatDialogs, { type ContextMenuState, type RewindRequest, type SessionRef } from '@/components/chat/ChatDialogs';
import { lastClaudeBubble } from '@/lib/transcriptTurns';
import type { TranscriptMsg } from '@/lib/types';

interface ChatTabProps {
  chatHorizontalLayout: number[];
  chatVerticalLayout: number[];
  onHorizontalLayoutChange: (sizes: number[]) => void;
  onVerticalLayoutChange: (sizes: number[]) => void;
  isActive: boolean; // pause SSE processing when tab is hidden
  ttsEnabled: boolean;
  /** When on, stop/rewind route to the persistent SDK session endpoints
   *  (/api/claude-sdk/interrupt, /rewind) instead of the CLI kill + LLM-undo. */
  sdkSessionsEnabled: boolean;
  /** A request from another tab (Stats) to open a transcript here. `nonce`
   *  changes on every request so re-opening the same session re-fires; null
   *  when nothing is pending. */
  openSessionRequest?: OpenSessionRequest | null;
  /** Phone layout (docs/ticket-mobile-pwa.md): the carousel pane on screen.
   *  Controlled by page.tsx, whose header holds the pane indicator. */
  mobilePane?: MobilePane;
  onMobilePaneChange?: (pane: MobilePane) => void;
  /** What the phone header shows for the Chat tab: the viewed session's title,
   *  and whether Conversation has news (a turn finished while off screen). */
  onMobileStatus?: (status: MobileChatStatus) => void;
}

export interface MobileChatStatus {
  title: string;
  conversationBadge: boolean;
}

export default function ChatTab({
  chatHorizontalLayout,
  chatVerticalLayout,
  onHorizontalLayoutChange,
  onVerticalLayoutChange,
  isActive,
  ttsEnabled,
  sdkSessionsEnabled,
  openSessionRequest,
  mobilePane = 'sessions',
  onMobilePaneChange,
  onMobileStatus,
}: ChatTabProps) {
  // Which session is on screen (+ its project), and a ref for async guards.
  const viewed = useViewedSession();
  const viewingTranscriptId = viewed.id;
  const historyTranscriptProject = viewed.project;

  // Image attachments staged for the next send (paste/drop → normalize → chip).
  // Lives here (not in the editor) so it survives editor clears and travels
  // with per-session drafts and the limit auto-resend.
  const attachments = useComposerAttachments();

  // Voice summary + turn-complete chime (see useTts for the ownership rule).
  const tts = useTts(ttsEnabled);

  // Provider (Anthropic / Bedrock) + the viewed session's model — status label,
  // limit dialog's Bedrock button.
  const {
    label: providerLabel, currentModel, setCurrentModel, failoverConfigured,
    refresh: refreshProviderStatus, load: loadProviderStatus,
  } = useProviderStatus();

  // Session list (cursor-paged) + live-session ids, kept current by the global
  // /api/events stream while the tab is active.
  const sessionHistory = useSessionHistory(isActive, {
    // A turn finished somewhere: chime — EXCEPT for the session in view with
    // voice summary on, where TTS is the notification (its failure paths chime
    // instead). One chime per event, even if several sessions finished at once.
    onTurnsFinished: (ids) => {
      if (ids.some(id => !(id === viewed.idRef.current && tts.enabledRef.current))) tts.playChime();
    },
    // Source (Anthropic/Bedrock) and the configured model are tracked separately
    // so the per-session model can override the model portion once known.
    onProviderStale: (reason) => (reason === 'activate' ? loadProviderStatus() : refreshProviderStatus()),
  });
  const { history, setHistory, isLoadingHistory, historyHasMore, isLoadingMoreHistory, fetchHistory, loadMoreHistory, ensureSessionLoaded, liveSessionIds } = sessionHistory;

  const chatEditorRef = useRef<RichTextEditorHandle>(null);
  // Per-session unsent composer (text + attachments); stash/restore as a pair
  // on every navigation.
  const drafts = useSessionDrafts(chatEditorRef, attachments);

  // Phone vs desktop layout. Crossing the breakpoint (resizing a desktop window —
  // rotation never switches, see MOBILE_QUERY) remounts the panes, and the
  // unsent composer text lives in the editor: stash it while the outgoing
  // layout is still mounted, restore it once the new one is.
  const isMobile = useIsMobile(() => drafts.stash(viewed.idRef.current));
  const layoutSwitched = useRef(false);
  useEffect(() => {
    if (!layoutSwitched.current) { layoutSwitched.current = true; return; }
    if (viewed.idRef.current) drafts.restore(viewed.idRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a switch
  }, [isMobile]);
  // Touch keyboards: Enter is a new line, the Send button sends.
  const isCoarsePointer = useIsCoarsePointer();
  /** Phone: bring a pane on screen (no-op on desktop, where all are visible). */
  const showPane = (pane: MobilePane) => {
    if (isMobile) onMobilePaneChange?.(pane);
  };

  // AskUserQuestion dialog (SDK: parked tool call; CLI: answered as a new turn).
  // `stream` is declared below; these callbacks only run on user action.
  const ask = useAskUserQuestion({
    sdkSessionsEnabled,
    sessionId: viewingTranscriptId,
    activeSessionRef: viewed.activeSessionRef,
    onProseAnswer: (answer) => stream.sendProseAnswer(answer),
  });

  // Terminal usage/rate limit (server `session:limit`): the recovery dialog —
  // switch model or fail over to Bedrock, then auto-resend the limited prompt.
  const limits = useLimitHandling({
    activeSessionRef: viewed.activeSessionRef,
    projectPath: historyTranscriptProject,
    send: (prompt, images) => stream.send(prompt, images),
    onError: (message) => stream.showError(message),
    refreshProvider: refreshProviderStatus,
    setCurrentModel,
    bedrockConfigured: failoverConfigured,
  });

  // The viewed session's conversation, in-flight turn, and session SSE.
  const stream = useSessionStream({
    viewed, isActive, sdkSessionsEnabled, chatEditorRef, attachments, drafts, tts, setCurrentModel,
    history: sessionHistory, ask, limits,
  });
  const {
    historyTranscript, historyTranscriptLoading, transcriptOverlayMessages, overlayInsertPoint, transcriptPartial,
    displayedTranscript, envelopeOpen, envelopeHidden, envelopeUserEcho,
    transcriptStreaming, transcriptLoading, backgroundWorking, live, livenessDotsEnabled, streamEvents,
    submitStartTime, submitEndTime, isStuck, stuckReason, sessionError, mcpFailedServers, takeoverConfirm,
    sessionActivity, liveContext, pendingNewSessions, transcriptEndRef, lastAssistantRef,
  } = stream;

  // New Session wizard: directory → model → create.
  const wizard = useNewSessionWizard({
    history, sdkSessionsEnabled,
    onCreate: (...args: Parameters<typeof stream.startNewSession>) => {
      showPane('conversation');
      return stream.startNewSession(...args);
    },
  });

  // Notes for the viewed session's project. Held here (always mounted), not in
  // NotesView (mounted only while selected) — see useNotes.
  const notes = useNotes(historyTranscriptProject);

  // The conversation column the AskUserQuestion modal anchors to, so the
  // question dialog appears within it rather than over the whole app. Held in
  // state via a callback ref (not read from a ref during render), so the dialog
  // re-renders with the element once it's attached.
  const [conversationEl, setConversationEl] = useState<HTMLDivElement | null>(null);

  // --- UI state (panels, dialogs) ---
  const [rightPanelView, setRightPanelView] = useState<ChatSideView>('stream');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Whether the dots-bubble's intermediary-messages modal is open (the agreed
  // product direction in docs/ticket-subagent-notification-turns-intermediate-
  // bubbles.md: intermediate turn output is hidden from the main flow while the
  // logical-task envelope is open, and reachable by clicking the dots bubble).
  // The modal's CONTENT is derived at render time from (historyTranscript, live),
  // so it live-updates while open and empties (closing itself) when the envelope
  // closes and the main flow reveals the committed history.
  //
  // Held as the anchor of the envelope it was opened for, not a boolean: it's
  // open only while THAT envelope is, so the next task's first update can't
  // silently re-open a dialog nobody asked for (derived — no reset effect).
  const [envelopeModalFor, setEnvelopeModalFor] = useState<number | null>(null);
  const envelopeModalOpen =
    envelopeOpen && envelopeModalFor !== null && envelopeModalFor === live?.envelopeStartedAt;
  // Dialog/confirmation states (all local to ChatTab)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<SessionRef | null>(null);
  const [labelEdit, setLabelEdit] = useState<{ sessionId: string; currentLabel: string } | null>(null);
  const [rewindConfirm, setRewindConfirm] = useState<RewindRequest | null>(null);
  const [intermediaryMessages, setIntermediaryMessages] = useState<TranscriptMsg[]>([]);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message?: string } | null>(null);
  // The model picker is an SDK-backend-only affordance — see the status bar.
  const modelPickerAvailable = !!viewingTranscriptId && sdkSessionsEnabled;

  // Open a session requested by another tab (Stats, Search). Alongside opening
  // the transcript, make sure the session's SIDEBAR entry is loaded (it may sit
  // pages beyond the cursor) — the sidebar's `reveal` prop then scrolls it into
  // view. Fire-and-forget: the reveal is a nicety, the open must not wait.
  useOpenSessionRequest(openSessionRequest, (sessionId, project) => {
    showPane('conversation');
    void ensureSessionLoaded(sessionId);
    return stream.openSession(sessionId, project);
  });

  // --- Phone: automatic navigation + header status ---

  // A question arriving while Conversation is off screen would be invisible —
  // its dialog is portaled into the conversation column. Go there.
  const hasQuestion = !!ask.question;
  useEffect(() => {
    if (hasQuestion) showPane('conversation');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival only
  }, [hasQuestion]);

  // Badge the Conversation segment when the viewed session's turn finishes
  // while another pane is showing; cleared on arrival.
  const [conversationBadge, setConversationBadge] = useState(false);
  const wasLoading = useRef(transcriptLoading);
  useEffect(() => {
    if (wasLoading.current && !transcriptLoading && isMobile && mobilePane !== 'conversation') {
      setConversationBadge(true);
    }
    wasLoading.current = transcriptLoading;
  }, [transcriptLoading, isMobile, mobilePane]);
  useEffect(() => {
    if (mobilePane === 'conversation') setConversationBadge(false);
  }, [mobilePane]);

  const viewedEntry = viewingTranscriptId
    ? history.find(h => h.sessionId === viewingTranscriptId)
      ?? pendingNewSessions.find(p => p.sessionId === viewingTranscriptId)
    : undefined;
  const mobileTitle = !viewedEntry
    ? 'Sessions'
    : 'display' in viewedEntry
      ? (viewedEntry.metadata?.label || viewedEntry.display)
      : viewedEntry.title;
  useEffect(() => {
    onMobileStatus?.({ title: mobileTitle, conversationBadge });
  }, [mobileTitle, conversationBadge, onMobileStatus]);

  // --- Handlers ---

  // Archives (soft-deletes) the session: DELETE /api/session kills the process,
  // marks the row 'archived' in SQLite, and removes the on-disk JSONL + history
  // entries. The transcript and its usage_events are preserved. See
  // docs/delete-to-archive.md.
  const handleArchiveSession = async (sessionId: string, project: string) => {
    setArchiveConfirm(null);
    try {
      const res = await fetch(
        `/api/session?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({ title: 'Failed to archive session', message: data.error || `Server returned ${res.status}` });
        return;
      }
      stream.onArchived(sessionId);
      fetchHistory();
    } catch (error) {
      setErrorDialog({ title: 'Failed to archive session', message: error instanceof Error ? error.message : 'An unexpected error occurred' });
    }
  };

  const handleSaveLabel = async (value: string) => {
    if (!labelEdit) return;
    const { sessionId } = labelEdit;
    const label = value.trim();
    setLabelEdit(null);
    try {
      const res = await fetch('/api/session', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, metadata: { label: label || null } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDialog({ title: 'Failed to update label', message: data.error || `Server returned ${res.status}` });
        return;
      }
      setHistory(prev => prev.map(h => {
        if (h.sessionId !== sessionId) return h;
        const metadata = { ...h.metadata };
        if (label) { metadata.label = label; } else { delete metadata.label; }
        return { ...h, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
      }));
    } catch (error) {
      setErrorDialog({ title: 'Failed to update label', message: error instanceof Error ? error.message : 'An unexpected error occurred' });
    }
  };

  const handleRewindConfirmed = (mode: 'conversation' | 'both') => {
    if (!rewindConfirm) return;
    setRewindConfirm(null);
    stream.rewind(rewindConfirm, mode);
  };

  const sessions = (
    <SessionsPane
      onCreateSession={wizard.open}
      pendingNewSessions={pendingNewSessions}
      history={history}
      liveSessionIds={liveSessionIds}
      sessionActivity={sessionActivity}
      liveContext={liveContext}
      viewingTranscriptId={viewingTranscriptId}
      transcriptLoading={transcriptLoading}
      isLoadingHistory={isLoadingHistory}
      historyHasMore={historyHasMore}
      isLoadingMoreHistory={isLoadingMoreHistory}
      onLoadMoreHistory={loadMoreHistory}
      reveal={openSessionRequest ? { sessionId: openSessionRequest.sessionId, nonce: openSessionRequest.nonce } : null}
      onSelectSession={(sessionId, project) => { showPane('conversation'); return stream.openSession(sessionId, project); }}
      onRestorePending={(...args) => { showPane('conversation'); return stream.restorePending(...args); }}
      onLabelEdit={(sessionId, currentLabel) => setLabelEdit({ sessionId, currentLabel })}
      onArchiveConfirm={setArchiveConfirm}
      onContextMenu={(e, entry) => {
        setContextMenu({
          x: e.clientX, y: e.clientY,
          sessionId: entry.sessionId!, project: entry.project, display: entry.display, isLive: entry.isLive,
        });
      }}
    />
  );

  const composer = (
    <Composer
      ref={chatEditorRef}
      onSubmit={stream.send}
      placeholder="Continue this conversation..."
      submitOnEnter={!isCoarsePointer}
      disabled={historyTranscriptLoading}
      submitLabel={transcriptLoading ? 'Sending...' : 'Send'}
      isProcessing={transcriptLoading}
      onStop={stream.stop}
      attachments={attachments}
      // Paste/drop image capture — SDK backend only (the CLI
      // `--print` path can't carry image blocks).
      acceptImages={sdkSessionsEnabled}
      footer={providerLabel ? (
        // Style is deliberately unchanged from the read-only
        // label — the only affordance is the pointer cursor.
        //
        // Clickable only with a session in view AND the SDK
        // backend on. The picker drives sdkSessionManager; with
        // sdkSessionsEnabled off, /api/claude routes turns to the
        // CLI sessionManager, which has no per-session model —
        // the switch would report success and change nothing.
        <div
          data-testid="model-label"
          style={{ fontSize: '9px', fontWeight: 100, padding: '0 8px 1px', cursor: modelPickerAvailable ? 'pointer' : 'default' }}
          className="text-muted-foreground"
          onClick={modelPickerAvailable ? () => setModelPickerOpen(true) : undefined}
          title={modelPickerAvailable ? 'Click to change model' : undefined}
        >
          {providerLabel}
        </div>
      ) : undefined}
    />
  );

  const conversation = (
    <ConversationPane
      ref={setConversationEl}
      hasSession={!!viewingTranscriptId}
      onCreateSession={wizard.open}
      stuck={isStuck}
      onKillStuck={() => setShowKillConfirm(true)}
      loading={historyTranscriptLoading}
      empty={historyTranscript.length === 0 && transcriptOverlayMessages.length === 0}
      unavailable={history.some(h => h.sessionId === viewingTranscriptId)}
      partial={transcriptPartial}
      transcript={{
        // SSOT strip (step 3) + logical-task ENVELOPE: the DISPLAYED
        // transcript is a pure function of (historyTranscript, live),
        // computed above the return. While the envelope is open the
        // slice anchors on `live.envelopeStartedAt` — hiding the
        // task's committed intermediate turns AND the current turn's
        // in-flight partials, so nothing can render above the dots
        // (docs/ticket-subagent-notification-turns-intermediate-
        // bubbles.md); with no envelope it falls back to the
        // per-turn `live.startedAt` partials strip (step-1 anchor).
        historyTranscript: displayedTranscript,
        transcriptOverlayMessages: envelopeUserEcho ?? transcriptOverlayMessages,
        // The echo is chronologically LAST in the displayed flow by
        // construction (its messages postdate the envelope cut), so it
        // must always append at the end — never at overlayInsertPoint,
        // which was computed against a different (unsliced) transcript
        // for the rewind overlay and would splice the prompt into a
        // stale index if it were ever non-null here.
        overlayInsertPoint: envelopeUserEcho ? null : overlayInsertPoint,
        sessionId: viewingTranscriptId ?? undefined,
        transcriptLoading,
        onRewindConfirm: setRewindConfirm,
        onIntermediaryView: setIntermediaryMessages,
        lastAssistantRef,
        ttsEnabled,
        ttsPlaying: tts.playing,
        onTtsToggle: () => tts.toggle(() => lastClaudeBubble(historyTranscript)),
        onTtsCancel: () => tts.cleanup(),
      }}
      activity={{
        // SSOT dots (step 2b): when opted in and the projection has
        // arrived, the dots track `live.phase` (self-corrected by the
        // heartbeat) instead of the legacy OR-of-proxies. Falls back to
        // legacy while `live` is null or the flag is off.
        show: (livenessDotsEnabled && live)
          ? live.phase !== 'idle'
          : (transcriptLoading || backgroundWorking),
        awaitingAnswer: !!ask.question,
        envelopeCount: envelopeHidden.length,
        onOpen: () => {
          if (envelopeHidden.length > 0) setEnvelopeModalFor(live?.envelopeStartedAt ?? null);
          else { setRightPanelView('stream'); showPane('side'); }
        },
      }}
      sessionError={sessionError}
      transcriptEndRef={transcriptEndRef}
      composer={composer}
      splitComposer={!isMobile}
      verticalLayout={chatVerticalLayout}
      onVerticalLayoutChange={onVerticalLayoutChange}
    />
  );

  const side = (
    <ChatSidePane
      projectPath={historyTranscriptProject}
      view={rightPanelView}
      onViewChange={setRightPanelView}
      stream={{ streamEvents, transcriptLoading, submitStartTime, submitEndTime }}
      notes={notes}
      mcpFailedServers={mcpFailedServers}
      compact={isMobile}
    />
  );

  return (
    <>
      {isMobile ? (
        <MobileChatLayout
          sessions={sessions}
          conversation={conversation}
          side={side}
          pane={mobilePane}
          onPaneChange={(pane) => onMobilePaneChange?.(pane)}
        />
      ) : (
        <DesktopChatLayout
          sessions={sessions}
          conversation={conversation}
          side={side}
          horizontalLayout={chatHorizontalLayout}
          onHorizontalLayoutChange={onHorizontalLayoutChange}
        />
      )}
      <ChatDialogs
        modelPicker={{ open: modelPickerOpen, onOpenChange: setModelPickerOpen, sessionId: viewingTranscriptId, activeModel: currentModel }}
        limit={limits.dialog}
        intermediary={{ messages: intermediaryMessages, onClose: () => setIntermediaryMessages([]) }}
        envelope={{ messages: envelopeModalOpen ? envelopeHidden : [], onClose: () => setEnvelopeModalFor(null) }}
        ask={{
          question: ask.question,
          portalContainer: conversationEl,
          // The text Claude wrote leading up to the question — the same
          // content rendered in the chat panel, surfaced here because the
          // modal obstructs it and the panel can't scroll while it's open.
          // The AskUserQuestion tool_use lands in its own (text-less)
          // assistant message, so the preamble is the last assistant text:
          // mid-turn it lives in the streaming buffer; once the turn ends
          // (the CLI is killed when the tool fires) it's the last assistant
          // bubble in the refreshed transcript. Only computed while open.
          context: ask.question
            ? (transcriptStreaming.trim() ||
              // (skipping an earlier exchange's question messages, which aren't prose)
              [...historyTranscript].reverse().find(m => m.role === 'assistant' && !m.askQuestion)?.content ||
              '')
            : '',
          ...ask.handlers,
        }}
        contextMenu={{ state: contextMenu, onArchive: setArchiveConfirm, onClose: () => setContextMenu(null) }}
        kill={{
          open: showKillConfirm,
          onOpenChange: setShowKillConfirm,
          reason: stuckReason,
          onConfirm: () => { setShowKillConfirm(false); stream.killStuck(); },
        }}
        takeover={takeoverConfirm}
        rewind={{ request: rewindConfirm, onCancel: () => setRewindConfirm(null), onConfirm: handleRewindConfirmed }}
        archive={{ request: archiveConfirm, onCancel: () => setArchiveConfirm(null), onConfirm: handleArchiveSession }}
        label={{ request: labelEdit, onSave: handleSaveLabel, onCancel: () => setLabelEdit(null) }}
        error={{ dialog: errorDialog, onClose: () => setErrorDialog(null) }}
        wizard={wizard.dialogs}
      />
    </>
  );
}
