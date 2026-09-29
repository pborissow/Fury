'use client';

import type { ComponentProps } from 'react';
import Dialog, { ConfirmDialog, AlertDialog } from '@/components/Dialog';
import ModelPickerDialog from '@/components/ModelPickerDialog';
import LimitReachedDialog, { type LimitReachedInfo } from '@/components/LimitReachedDialog';
import IntermediaryMessagesDialog from '@/components/IntermediaryMessagesDialog';
import AskUserQuestionDialog from '@/components/AskUserQuestionDialog';
import SessionContextMenu from '@/components/SessionContextMenu';
import LabelEditDialog from '@/components/LabelEditDialog';
import { DirectoryPicker } from '@/components/DirectoryPicker';
import NewSessionModelStep from '@/components/NewSessionModelStep';
import type { AskUserQuestionState, TranscriptMsg } from '@/lib/types';

type AskDialogProps = ComponentProps<typeof AskUserQuestionDialog>;

export interface SessionRef {
  sessionId: string; project: string; display: string; isLive: boolean;
}
export type ContextMenuState = SessionRef & { x: number; y: number };
export interface RewindRequest {
  turnIndex: number; userMessage: string; fullMessage: string; timestamp: string; uuid?: string;
}
export interface TakeoverRequest {
  owner: { pid?: number; name?: string; cwd?: string };
  onConfirm: () => void;
  onCancel: () => void;
}

export interface ChatDialogsProps {
  modelPicker: { open: boolean; onOpenChange: (open: boolean) => void; sessionId: string | null; activeModel: string | null };
  limit: {
    info: LimitReachedInfo | null;
    error: string | null;
    bedrockConfigured: boolean;
    /** "Not now" / backdrop / escape. */
    onDismiss: () => void;
    onSwitchAndRetry: ComponentProps<typeof LimitReachedDialog>['onSwitchAndRetry'];
    onUseBedrock: ComponentProps<typeof LimitReachedDialog>['onUseBedrock'];
  };
  /** A settled turn's intermediaries, opened from its "+N intermediary" chip. */
  intermediary: { messages: TranscriptMsg[]; onClose: () => void };
  /** An OPEN envelope's hidden updates, opened from the dots bubble. Empty = closed. */
  envelope: { messages: TranscriptMsg[]; onClose: () => void };
  ask: {
    question: AskUserQuestionState | null;
    portalContainer: HTMLElement | null;
    /** Only computed while a question is open. */
    context: string;
    /** Resolve the parked tool call in place (SDK, live tool call). */
    structured: boolean;
    onSubmit: AskDialogProps['onSubmit'];
    onSubmitStructured: NonNullable<AskDialogProps['onSubmitStructured']>;
    onSkip: () => void;
    onSkipStructured: () => void;
  };
  contextMenu: { state: ContextMenuState | null; onArchive: (s: SessionRef) => void; onClose: () => void };
  kill: { open: boolean; onOpenChange: (open: boolean) => void; reason: string | undefined; onConfirm: () => void };
  takeover: TakeoverRequest | null;
  rewind: { request: RewindRequest | null; onCancel: () => void; onConfirm: (mode: 'conversation' | 'both') => void };
  archive: { request: SessionRef | null; onCancel: () => void; onConfirm: (sessionId: string, project: string) => void };
  label: { request: { sessionId: string; currentLabel: string } | null; onSave: (label: string) => void; onCancel: () => void };
  error: { dialog: { title: string; message?: string } | null; onClose: () => void };
  wizard: {
    directoryPickerOpen: boolean;
    onDirectoryPickerOpenChange: (open: boolean) => void;
    onDirectoryNext: ComponentProps<typeof DirectoryPicker>['onSelect'];
    recentDirectories: string[];
    modelStepOpen: boolean;
    onModelStepClose: () => void;
    onModelStepBack: ComponentProps<typeof NewSessionModelStep>['onBack'];
    onModelStepCreate: ComponentProps<typeof NewSessionModelStep>['onCreate'];
    directory: string | null;
  };
}

/** Every dialog the Chat tab owns (except the Files view's, which it renders). */
export default function ChatDialogs({
  modelPicker, limit, intermediary, envelope, ask, contextMenu, kill, takeover, rewind, archive, label, error, wizard,
}: ChatDialogsProps) {
  return (
    <>
      <ModelPickerDialog
        open={modelPicker.open}
        onOpenChange={modelPicker.onOpenChange}
        sessionId={modelPicker.sessionId}
        activeModel={modelPicker.activeModel}
      />
      <LimitReachedDialog
        open={!!limit.info}
        onOpenChange={(o) => { if (!o) limit.onDismiss(); }}
        info={limit.info}
        bedrockConfigured={limit.bedrockConfigured}
        onSwitchAndRetry={limit.onSwitchAndRetry}
        onUseBedrock={limit.onUseBedrock}
        error={limit.error}
      />
      <IntermediaryMessagesDialog messages={intermediary.messages} onClose={intermediary.onClose} />
      {/* The dots-bubble modal for an OPEN logical-task envelope. Content is
          derived per render, so it live-updates as notification turns commit
          and empties (auto-closing: the dialog opens on messages.length > 0)
          when the envelope closes and the main flow reveals the committed
          history. Distinct instance from the settled-transcript dialog above. */}
      <IntermediaryMessagesDialog messages={envelope.messages} onClose={envelope.onClose} />

      {ask.question && (
        <AskUserQuestionDialog
          // Remount on question identity so an in-place question swap (server supersede
          // / applyPendingAskFromBuffer on reconnect) resets the selection state — else
          // question Y renders with question X's stale pre-checked answers.
          key={ask.question.toolUseID ?? 'cli'}
          open={true}
          // Draft identity: in-progress selections/text survive the unmount a
          // session switch causes (P17 clears askUserQuestion unconditionally)
          // and are restored when the question re-parks on switch-back. The CLI
          // path (null) falls back to a question-text signature inside.
          draftKey={ask.question.toolUseID}
          // Anchor the modal to the conversation column instead of the whole
          // viewport, so it dims/centers within it.
          portalContainer={ask.portalContainer}
          questions={ask.question.input.questions}
          context={ask.context}
          onSubmit={ask.onSubmit}
          // Only pass the structured path when there is a live tool call to
          // resolve. A CLI-sourced question has toolUseID null and MUST fall
          // through to the prose path, which re-sends the answer as a new turn.
          onSubmitStructured={ask.structured ? ask.onSubmitStructured : undefined}
          onSkip={ask.structured ? ask.onSkipStructured : ask.onSkip}
        />
      )}

      {contextMenu.state && (
        <SessionContextMenu
          {...contextMenu.state}
          onArchive={contextMenu.onArchive}
          onClose={contextMenu.onClose}
        />
      )}

      <ConfirmDialog
        open={kill.open}
        onOpenChange={kill.onOpenChange}
        title="Kill stuck process?"
        message={<>{kill.reason}<br /><br />This will terminate the Claude CLI process. The current response will be lost.</>}
        confirmLabel="Kill Process"
        confirmVariant="destructive"
        onConfirm={kill.onConfirm}
      />

      <ConfirmDialog
        open={!!takeover}
        onOpenChange={(open) => { if (!open) takeover?.onCancel(); }}
        title="Take over this session?"
        message={
          <>
            This session is currently live in a terminal
            {takeover?.owner?.name ? <> (<span className="font-mono">{takeover.owner.name}</span>)</> : ''}.
            <br /><br />
            Taking it over in Fury will end that terminal session so Fury can
            continue it here. Any unsaved context only in the terminal will be lost.
          </>
        }
        confirmLabel="Take Over"
        confirmVariant="destructive"
        cancelLabel="Cancel"
        onConfirm={() => takeover?.onConfirm()}
        onCancel={() => takeover?.onCancel()}
      />

      <Dialog
        open={!!rewind.request}
        onOpenChange={(open) => { if (!open) rewind.onCancel(); }}
        title="Rewind conversation?"
        defaultWidth={460}
        defaultHeight={280}
        minWidth={360}
        minHeight={220}
        resizable={false}
        buttons={[
          { label: 'Cancel', onClick: rewind.onCancel, variant: 'ghost' as const },
          { label: 'Conversation only', onClick: () => rewind.onConfirm('conversation'), variant: 'secondary' as const },
          { label: 'Conversation + Code', onClick: () => rewind.onConfirm('both') },
        ]}
      >
        <div className="text-sm text-muted-foreground">
          Rewind the conversation to before this message:
          <br /><br />
          <span className="text-xs font-mono break-all">&ldquo;{rewind.request?.userMessage}&rdquo;</span>
          {rewind.request?.timestamp && (
            <><br /><span className="text-xs">{new Date(rewind.request.timestamp).toLocaleString()}</span></>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!archive.request}
        onOpenChange={(open) => { if (!open) archive.onCancel(); }}
        title="Archive session?"
        message={<>
          {archive.request?.isLive && (
            <>
              <span className="text-yellow-500 font-semibold">This session is currently live.</span> The running process will be terminated.
              <br /><br />
            </>
          )}
          This removes the session from your list. Its usage history is preserved and it will still count in Stats.
        </>}
        confirmLabel="Archive"
        onConfirm={() => { if (archive.request) archive.onConfirm(archive.request.sessionId, archive.request.project); }}
        onCancel={archive.onCancel}
      />

      {label.request && (
        <LabelEditDialog
          initialValue={label.request.currentLabel}
          onSave={label.onSave}
          onCancel={label.onCancel}
        />
      )}

      <AlertDialog
        open={!!error.dialog}
        onOpenChange={(open) => { if (!open) error.onClose(); }}
        title={error.dialog?.title || 'Error'}
        message={error.dialog?.message}
      />

      {/* New-session wizard — step (a): choose a directory, then Next → model */}
      <DirectoryPicker
        open={wizard.directoryPickerOpen}
        onOpenChange={wizard.onDirectoryPickerOpenChange}
        onSelect={wizard.onDirectoryNext}
        recentDirectories={wizard.recentDirectories}
        confirmLabel="Next →"
      />

      {/* New-session wizard — step (b): choose the model, then create */}
      <NewSessionModelStep
        open={wizard.modelStepOpen}
        onOpenChange={(open) => { if (!open) wizard.onModelStepClose(); }}
        onBack={wizard.onModelStepBack}
        onCreate={wizard.onModelStepCreate}
        directory={wizard.directory ?? undefined}
      />
    </>
  );
}
