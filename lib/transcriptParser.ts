/**
 * Shared JSONL transcript parsing logic.
 *
 * Used by both the /api/transcript route and the startup DB scanner
 * so parsing behavior is consistent everywhere.
 */

/**
 * Per-turn tool composition, attached to the final assistant text message
 * of each turn. Used by the TTS pipeline to pick a context-appropriate
 * summary strategy (e.g. an implementation report can be templated from
 * file counts rather than asking an LLM to re-derive them from prose).
 */
export interface TurnMeta {
  writeFileCount: number;
  firstWriteFile?: string;
  totalTools: number;
  toolCounts: Record<string, number>;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  turnMeta?: TurnMeta;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isInternalContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '') return true;
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<task-notification>')
  ) return true;
  if (/^\/[a-z]/.test(trimmed)) return true;
  return false;
}

/**
 * Parse raw JSONL transcript content into displayable messages.
 *
 * Returns both the parsed messages and the raw non-empty lines (for
 * full-fidelity archival and incomplete-response detection).
 */
export function parseTranscriptJsonl(content: string): {
  messages: TranscriptMessage[];
  rawLines: string[];
  rawEntries: any[];
  planSlug: string | null;
  /** Index into messages[] after which the plan bubble should be inserted */
  planInsertAfter: number | null;
  /** Number of context compaction events in the session */
  numCompactions: number;
  /** Input from the most recent AskUserQuestion tool_use that has not yet
   *  been answered by a subsequent real user prompt. The CLI auto-errors
   *  this tool in `--print` mode, so the dialog has to be synthesized from
   *  the JSONL — without persisting this, navigating away from a session
   *  while AskUserQuestion is in flight drops the dialog. */
  pendingAskUserQuestion: any | null;
  /** Model id (e.g. "claude-opus-4-7") from the most recent non-synthetic
   *  assistant message. Null if no real assistant message was emitted. */
  currentModel: string | null;
} {
  const messages: TranscriptMessage[] = [];
  const rawEntries: any[] = [];
  const rawLines = content.split('\n').filter(line => line.trim());

  let pendingAssistant: TranscriptMessage | null = null;
  let inInternalExchange = false;
  let planSlug: string | null = null;
  let planWriteTimestamp: string | null = null;
  let numCompactions = 0;
  let currentModel: string | null = null;

  // Accumulate tool_use across the current turn (between real user
  // messages). Snapshotted onto pendingAssistant.turnMeta at push time.
  let turnToolCounts: Record<string, number> = {};
  let turnWriteFiles = new Set<string>();
  let turnFirstWriteFile: string | undefined;
  let turnTotalTools = 0;
  const resetTurnTools = () => {
    turnToolCounts = {};
    turnWriteFiles = new Set<string>();
    turnFirstWriteFile = undefined;
    turnTotalTools = 0;
  };
  const snapshotTurnMeta = (): TurnMeta | undefined => {
    if (turnTotalTools === 0) return undefined;
    return {
      writeFileCount: turnWriteFiles.size,
      firstWriteFile: turnFirstWriteFile,
      totalTools: turnTotalTools,
      toolCounts: { ...turnToolCounts },
    };
  };
  // Track the latest AskUserQuestion input seen; cleared whenever a real
  // user-turn message comes after it (which means the user already answered).
  let pendingAskUserQuestion: any | null = null;

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      rawEntries.push(entry);

      // Detect plan mode slug (present on entries while in plan mode)
      if (entry.slug && !planSlug) {
        planSlug = entry.slug;
      }

      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      if (entry.isMeta) continue;

      const msg = entry.message;
      if (!msg) continue;

      if (entry.type === 'user') {
        const isToolResult = Array.isArray(msg.content);
        const isInternalString = typeof msg.content === 'string' && isInternalContent(msg.content);
        const isTaskNotification = typeof msg.content === 'string' &&
          msg.content.trim().startsWith('<task-notification>');

        if (isTaskNotification) {
          inInternalExchange = true;
          continue;
        }

        if (isInternalString) continue;

        // Tool results are arrays (never displayed as user messages) but must
        // still flow through so inInternalExchange gets cleared below.  The
        // old `if (isToolResult && inInternalExchange) continue;` caused the
        // flag to stick permanently after a <task-notification>, hiding every
        // subsequent message for the rest of the transcript.

        inInternalExchange = false;

        if (pendingAssistant) {
          pendingAssistant.turnMeta = snapshotTurnMeta();
          messages.push(pendingAssistant);
          pendingAssistant = null;
        }

        if (typeof msg.content === 'string') {
          // Detect and hide context compaction summary messages.
          // These are injected as user messages whose content starts with
          // the compaction preamble — use startsWith to avoid false positives
          // when the string merely appears quoted inside a normal message.
          if (msg.content.startsWith('This session is being continued from a previous conversation that ran out of context')) {
            numCompactions++;
            continue;
          }

          // A real user prompt resolves any pending AskUserQuestion.
          pendingAskUserQuestion = null;

          messages.push({
            role: 'user',
            content: msg.content,
            timestamp: entry.timestamp,
          });
          // New turn starting — drop any tool counts accumulated during
          // the previous turn.
          resetTurnTools();
        }
      } else if (entry.type === 'assistant') {
        if (inInternalExchange) continue;
        if (!Array.isArray(msg.content)) continue;

        // Track the most recent real model id for this session — skipping
        // synthetic messages (usage-limit notices, compaction stubs).
        if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') {
          currentModel = msg.model;
        }

        // Detect plan file write (Write tool targeting ~/.claude/plans/)
        // and capture the latest AskUserQuestion input. The CLI auto-errors
        // AskUserQuestion in --print mode, so the dialog has to be replayed
        // from the JSONL if the user wasn't viewing this session when the
        // tool fired.
        for (const block of msg.content) {
          if (planSlug && planWriteTimestamp === null &&
              block.type === 'tool_use' && block.name === 'Write' &&
              typeof block.input?.file_path === 'string' &&
              block.input.file_path.replace(/\\/g, '/').includes('.claude/plans/')) {
            planWriteTimestamp = entry.timestamp;
          }
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion' &&
              block.input?.questions?.length) {
            pendingAskUserQuestion = block.input;
          }
          // Accumulate tool composition for the current turn. Snapshotted
          // onto the next pendingAssistant push as TurnMeta.
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            turnToolCounts[block.name] = (turnToolCounts[block.name] || 0) + 1;
            turnTotalTools++;
            if (WRITE_TOOLS.has(block.name) && typeof block.input?.file_path === 'string') {
              const fp = block.input.file_path;
              if (!turnWriteFiles.has(fp)) {
                turnWriteFiles.add(fp);
                if (!turnFirstWriteFile) turnFirstWriteFile = fp;
              }
            }
          }
        }

        const textParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        if (textParts.length === 0) continue;

        const fullText = textParts.join('\n\n');
        if (!fullText.trim()) continue;

        // Filter out empty-acknowledgment messages (e.g. after ExitPlanMode errors)
        if (fullText.trim() === 'No response requested.') continue;

        pendingAssistant = {
          role: 'assistant',
          content: fullText,
          timestamp: entry.timestamp,
        };
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (pendingAssistant) {
    pendingAssistant.turnMeta = snapshotTurnMeta();
    messages.push(pendingAssistant);
  }

  // Find the message index after which the plan should be inserted.
  // This is the last assistant message at or before the plan Write timestamp.
  let planInsertAfter: number | null = null;
  if (planSlug && planWriteTimestamp) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].timestamp <= planWriteTimestamp) {
        planInsertAfter = i;
        break;
      }
    }
  }

  return { messages, rawLines, rawEntries, planSlug, planInsertAfter, numCompactions, pendingAskUserQuestion, currentModel };
}
