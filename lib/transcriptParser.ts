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
} {
  const messages: TranscriptMessage[] = [];
  const rawEntries: any[] = [];
  const rawLines = content.split('\n').filter(line => line.trim());

  let pendingAssistant: TranscriptMessage | null = null;
  let inInternalExchange = false;

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      rawEntries.push(entry);

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

        const textParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        if (textParts.length === 0) continue;

        const fullText = textParts.join('\n\n');
        if (!fullText.trim()) continue;

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

  return { messages, rawLines, rawEntries };
}
