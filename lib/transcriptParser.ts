/**
 * Shared JSONL transcript parsing logic.
 *
 * Used by both the /api/transcript route and the startup DB scanner
 * so parsing behavior is consistent everywhere.
 */

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

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
} {
  const messages: TranscriptMessage[] = [];
  const rawEntries: any[] = [];
  const rawLines = content.split('\n').filter(line => line.trim());

  let pendingAssistant: TranscriptMessage | null = null;
  let inInternalExchange = false;
  let planSlug: string | null = null;
  let planWriteTimestamp: string | null = null;

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
          messages.push(pendingAssistant);
          pendingAssistant = null;
        }

        if (typeof msg.content === 'string') {
          messages.push({
            role: 'user',
            content: msg.content,
            timestamp: entry.timestamp,
          });
        }
      } else if (entry.type === 'assistant') {
        if (inInternalExchange) continue;
        if (!Array.isArray(msg.content)) continue;

        // Detect plan file write (Write tool targeting ~/.claude/plans/)
        if (planSlug && planWriteTimestamp === null) {
          for (const block of msg.content) {
            if (block.type === 'tool_use' && block.name === 'Write' &&
                typeof block.input?.file_path === 'string' &&
                block.input.file_path.replace(/\\/g, '/').includes('.claude/plans/')) {
              planWriteTimestamp = entry.timestamp;
              break;
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

  return { messages, rawLines, rawEntries, planSlug, planInsertAfter };
}
