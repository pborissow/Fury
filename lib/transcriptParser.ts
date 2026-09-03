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

// Single definition lives in lib/types.ts (the client imports it from there);
// re-exported here so parser consumers keep their existing import path.
export type { TranscriptImagePart } from './types';
import type { TranscriptImagePart } from './types';
import { IMAGE_REF_RE, isBareImagePlaceholder } from './imageRefs';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  turnMeta?: TurnMeta;
  /** JSONL entry uuid — surfaced for user messages so the UI can target a
   *  turn for the SDK's native rewindFiles(messageUuid). */
  uuid?: string;
  /** Image parts attached to this message (user pastes). Present only when the
   *  turn carried images (inline, scrubbed-persisted ref, or bare placeholder). */
  images?: TranscriptImagePart[];
}

/**
 * Split an array-form user message's content blocks into rendered text and
 * image parts. Handles inline base64 images (recent turns), fury-img://<hash>
 * ref placeholders (scrubbed + persisted), and bare placeholders (scrubbed +
 * ephemeral). tool_result blocks are ignored here — Read-tool images belong in
 * the tool UI, not the user bubble (rendered as a follow-up). Internal text
 * blocks (system reminders etc. the CLI attaches alongside real content) are
 * dropped, mirroring the string path's isInternalContent filter.
 */
export function extractUserContent(blocks: any[]): { text: string; images: TranscriptImagePart[] } {
  const textParts: string[] = [];
  const images: TranscriptImagePart[] = [];
  for (const block of blocks) {
    if (block?.type === 'image') {
      const src = block.source;
      if (src?.type === 'base64' && typeof src.data === 'string') {
        const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
        images.push({ dataUrl: `data:${mediaType};base64,${src.data}` });
      } else {
        images.push({ placeholder: true });
      }
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim();
      const refMatch = trimmed.match(IMAGE_REF_RE);
      if (refMatch) {
        images.push({ hash: refMatch[1] });
      } else if (isBareImagePlaceholder(trimmed)) {
        images.push({ placeholder: true });
      } else if (block.text && !isInternalContent(block.text)) {
        // Same filter the string path applies: CLI-attached system reminders,
        // command markers, interrupt notices etc. must not render as user text.
        textParts.push(block.text);
      }
    }
    // tool_result / tool_use / other blocks: skip for user-bubble rendering.
  }
  return { text: textParts.join('\n\n'), images };
}

/**
 * One billable usage record per unique assistant API message. Captures the
 * full token breakdown (not just output) plus the model and timestamp, so the
 * Stats tab can aggregate spend by day / project / model and compute cost.
 *
 * Streaming repeats the same message's cumulative usage across multiple JSONL
 * lines, so records are deduped by messageId (last value wins). Synthetic
 * CLI-injected messages (usage-limit notices, model `<synthetic>`) are excluded
 * — they are not billed API calls.
 */
export interface UsageEvent {
  /** Assistant API message id (msg.id), or the entry uuid as a fallback. */
  messageId: string;
  /** Model id from msg.model, e.g. "claude-opus-4-8". Null if absent. */
  model: string | null;
  /** ISO-8601 timestamp of the JSONL entry. Empty string if absent. */
  timestamp: string;
  /** Uncached input tokens (usage.input_tokens). */
  input: number;
  /** Generated output tokens (usage.output_tokens). */
  output: number;
  /** Total cache-creation input tokens (5m + 1h). Kept for token counts. */
  cacheWrite: number;
  /** 5-minute-TTL cache-creation tokens (cache_creation.ephemeral_5m_input_tokens). */
  cacheWrite5m: number;
  /** 1-hour-TTL cache-creation tokens (cache_creation.ephemeral_1h_input_tokens).
   *  When the split object is absent (older transcripts) the flat
   *  cache_creation_input_tokens total is attributed here — Claude Code writes
   *  1h cache by default (verified against the SDK's total_cost_usd). */
  cacheWrite1h: number;
  /** Cache-read input tokens (usage.cache_read_input_tokens). */
  cacheRead: number;
  /** True when this call belongs to a subagent (JSONL `isSidechain`). Its tokens
   *  are still billed — cost aggregation must keep them — but it runs its own
   *  context with its own (possibly different) model, so anything reasoning
   *  about the MAIN thread's context or window must exclude it. */
  isSidechain: boolean;
  /** The subagent id this event came from (the `agent-<id>.jsonl` sidecar), or
   *  null/undefined for a main-thread event. Set by parseSubagentUsageEvents;
   *  persisted to usage_events.agent_id for per-subagent cost drill-down. */
  agentId?: string | null;
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
  // CLI interrupt markers ("[Request interrupted by user]", "...for tool use]").
  // Written as ARRAY-form user entries, so they only became reachable when the
  // parser gained array-content support — without this they render as bubbles.
  if (trimmed.startsWith('[Request interrupted')) return true;
  if (/^\/[a-z]/.test(trimmed)) return true;
  return false;
}

/**
 * Is this JSONL entry a REAL user turn — one the user originated — as opposed
 * to CLI plumbing (tool_result deliveries, isMeta reminders, slash-command
 * markers, task-notifications, interrupt notices)?
 *
 * SINGLE source of truth for turn boundaries, shared by this parser (which
 * message entries render as user bubbles) and lib/imageScrubber.ts (how
 * keepRecentTurns counts turns). The two previously used different rules, so
 * the scrubber counted internal entries as turns and scrubbed the *current*
 * turn's image the moment a task-notification landed mid-turn.
 */
export function isRealUserTurnEntry(entry: any): boolean {
  if (entry?.type !== 'user' || entry?.isMeta) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return !isInternalContent(content);
  if (Array.isArray(content)) {
    // Real if any block carries user-originated content: an image, or a text
    // block that isn't internal plumbing. (Scrubbed-image placeholders are NOT
    // internal — a scrubbed paste turn is still a real turn.)
    return content.some((b: any) =>
      b?.type === 'image' ||
      (b?.type === 'text' && typeof b.text === 'string' && !isInternalContent(b.text)),
    );
  }
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
  /** Cumulative output tokens generated across the session, summed once per
   *  unique assistant message id (streaming repeats the same message's usage
   *  on multiple JSONL lines, so we dedupe to avoid over-counting). */
  totalOutputTokens: number;
  /** Full per-message usage breakdown (input/output/cache) with model and
   *  timestamp, deduped by message id. Feeds the Stats tab's cost analytics.
   *  See {@link UsageEvent}. */
  usageEvents: UsageEvent[];
  /** Size of the conversation's CURRENT context window occupancy, in tokens:
   *  the prompt size of the most recent main-thread assistant call
   *  (input + cache write + cache read; output is not part of the next prompt).
   *
   *  This is deliberately NOT cumulative. Summing usage across a session counts
   *  the same carried context once per API call — a 600k-context session over
   *  200 calls totals ~90M, which is real for billing but ~150x what a user
   *  means by "how big is this conversation". Sidechain (subagent) calls are
   *  excluded: they run in their own throwaway context and never occupy the
   *  main thread's window. 0 when no real assistant call was made. */
  contextTokens: number;
} {
  const messages: TranscriptMessage[] = [];
  const rawEntries: any[] = [];
  const rawLines = content.split('\n').filter(line => line.trim());

  let pendingAssistant: TranscriptMessage | null = null;
  let planSlug: string | null = null;
  let planWriteTimestamp: string | null = null;
  let numCompactions = 0;
  // Prompt size of the most recent main-thread assistant call. See the
  // contextTokens field doc on the return type.
  let contextTokens = 0;
  // Output tokens per unique assistant message id. Streaming writes the same
  // API message's cumulative usage on multiple JSONL lines, so we key by id
  // (last value wins = the final usage for that message) and sum at the end.
  const outputTokensByMsgId = new Map<string, number>();
  // Full usage breakdown per unique assistant message id (last value wins),
  // for the Stats tab. Kept separate from outputTokensByMsgId so the existing
  // token-counter behavior is unchanged.
  const usageByMsgId = new Map<string, UsageEvent>();
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
        const isInternalString = typeof msg.content === 'string' && isInternalContent(msg.content);

        // Internal user strings — slash-command markers, system reminders, and
        // the synthetic <task-notification> injected when a background task
        // finishes — are hidden and must NOT act as a turn boundary. A
        // task-notification is a mid-turn internal event, not a new prompt: the
        // assistant's real reply to it flows through the pendingAssistant path
        // below and renders as the turn's completion, exactly like any other
        // assistant message. (Any synthetic stub it emits — e.g. "No response
        // requested." — is dropped by provenance in the assistant branch.)
        if (isInternalString) continue;

        // Tool results are arrays (never displayed as user messages) but must
        // still flow through to flush the pending assistant turn below.
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
            uuid: entry.uuid,
          });
          // New turn starting — drop any tool counts accumulated during
          // the previous turn.
          resetTurnTools();
        } else if (Array.isArray(msg.content)) {
          // Array-form user turn. Historically this fell through and rendered as
          // NOTHING (constraint 6) — a text+image paste dropped even the typed
          // text. isRealUserTurnEntry excludes pure tool_result deliveries AND
          // internal array-form plumbing ("[Request interrupted by user]",
          // attached system reminders) — the same filtering the string path
          // gets from isInternalContent, and the same rule the image scrubber
          // uses to count turns.
          if (!isRealUserTurnEntry(entry)) continue;

          const { text, images } = extractUserContent(msg.content);
          // A real user prompt resolves any pending AskUserQuestion.
          pendingAskUserQuestion = null;

          messages.push({
            role: 'user',
            content: text,
            timestamp: entry.timestamp,
            uuid: entry.uuid,
            ...(images.length > 0 ? { images } : {}),
          });
          resetTurnTools();
        }
      } else if (entry.type === 'assistant') {
        // Accumulate output tokens (deduped by message id) before any
        // filtering, so internal-exchange and tool-only turns still count
        // toward the session's billed output.
        if (typeof msg?.usage?.output_tokens === 'number') {
          const id = msg.id || entry.uuid;
          if (id) outputTokensByMsgId.set(id, msg.usage.output_tokens);
        }
        // Capture the full usage breakdown for the Stats tab. Skip synthetic
        // CLI-injected messages (not billed API calls). Keyed by the API message
        // id so streaming's repeated cumulative usage collapses to one final
        // record. Real assistant messages always carry msg.id; the entry.uuid
        // fallback only applies when it's absent, and in that rare case a
        // message split across multiple JSONL lines can't be deduped (each line
        // gets a distinct uuid and sums). Matches the totalOutputTokens counter.
        if (msg?.usage && typeof msg.usage === 'object' && msg.model !== '<synthetic>') {
          const id = msg.id || entry.uuid;
          if (id) {
            const u = msg.usage;
            const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
            // Split cache writes by TTL for accurate pricing (5m = 1.25x input,
            // 1h = 2x). The CLI emits the breakdown in cache_creation; older
            // transcripts have only the flat cache_creation_input_tokens, which
            // we attribute to 1h (Claude Code's default TTL).
            const cc = u.cache_creation;
            const hasSplit = cc && (typeof cc.ephemeral_5m_input_tokens === 'number' ||
              typeof cc.ephemeral_1h_input_tokens === 'number');
            const cwFlat = num(u.cache_creation_input_tokens);
            const cw5m = hasSplit ? num(cc.ephemeral_5m_input_tokens) : 0;
            const cw1h = hasSplit ? num(cc.ephemeral_1h_input_tokens) : cwFlat;
            usageByMsgId.set(id, {
              messageId: id,
              model: typeof msg.model === 'string' ? msg.model : null,
              timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
              input: num(u.input_tokens),
              output: num(u.output_tokens),
              cacheWrite: hasSplit ? cw5m + cw1h : cwFlat,
              cacheWrite5m: cw5m,
              cacheWrite1h: cw1h,
              cacheRead: num(u.cache_read_input_tokens),
              isSidechain: !!entry.isSidechain,
            });
            // Current context occupancy = this call's prompt size. Last main-
            // thread call wins, so after the loop this holds the live context.
            // Sidechains (subagents) get their own context and are skipped.
            if (!entry.isSidechain) {
              contextTokens =
                num(u.input_tokens) +
                (hasSplit ? cw5m + cw1h : cwFlat) +
                num(u.cache_read_input_tokens);
            }
          }
        }
        // Suppress by provenance, not by a post-notification window: only
        // synthetic CLI-injected assistant messages (e.g. the "No response
        // requested." stub emitted when a <task-notification> needs no reply,
        // usage-limit notices, compaction stubs) are hidden. Real assistant
        // text — including a terminal answer synthesized in reply to a
        // task-notification — must render. (Belt-and-suspenders: the
        // "No response requested." text guard below also catches the stub.)
        if (msg.model === '<synthetic>') continue;
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

  let totalOutputTokens = 0;
  for (const v of outputTokensByMsgId.values()) totalOutputTokens += v;

  const usageEvents = Array.from(usageByMsgId.values());

  return { messages, rawLines, rawEntries, planSlug, planInsertAfter, numCompactions, pendingAskUserQuestion, currentModel, totalOutputTokens, usageEvents, contextTokens };
}
