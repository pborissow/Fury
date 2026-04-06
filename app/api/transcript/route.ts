import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { realpath } from 'fs/promises';
import { projectPathToSlug } from '@/lib/utils';
import { parseTranscriptJsonl, type TranscriptMessage } from '@/lib/transcriptParser';
import { archiveTranscript, loadTranscript } from '@/lib/transcriptArchiver';

export const runtime = 'nodejs';

// How long (ms) since the JSONL was last modified before we consider
// the response "stale" and eligible for an incomplete-response suggestion.
// Claude API delays and conversation compaction can cause gaps of 1+ min.
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

interface SuggestedPrompt {
  text: string;
  context: string;
}

function generateToolSuggestion(toolName: string, input: any): string {
  const fileName = input?.file_path?.split(/[/\\]/).pop();
  switch (toolName) {
    case 'Edit':
      return `Please continue — you were about to edit ${fileName || 'a file'}.`;
    case 'Write':
      return `Please continue — you were about to create ${fileName || 'a file'}.`;
    case 'Read':
      return `Please continue — you were about to read ${fileName || 'a file'}.`;
    case 'Bash': {
      const cmd = input?.command;
      const preview = cmd
        ? ` (${cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd})`
        : '';
      return `Please continue — you were about to run a command${preview}.`;
    }
    case 'Glob':
    case 'Grep':
      return `Please continue — you were about to search the codebase.`;
    default:
      return `Please continue — you were about to use the ${toolName} tool.`;
  }
}

function detectIntentLanguage(text: string): string | null {
  // Only look at the LAST paragraph — intent phrases deeper in the text
  // (e.g. "First null check" in a bullet list) are normal prose, not
  // signals that the response was interrupted.
  const paragraphs = text.split(/\n\n/);
  const lastPara = (paragraphs[paragraphs.length - 1] || '').trim();
  if (!lastPara) return null;

  // Intent phrases that signal Claude was about to do something.
  // "Now" + modal (I'll, let me, etc.) is a strong signal.
  // "Now" + bare verb is allowed but we exclude "Now" followed by
  // articles/pronouns/determiners which indicate explanatory prose
  // (e.g. "Now the service handles…" vs "Now slim down the method").
  // "First" / "Next" ALWAYS require a modal — they appear too often in content.
  const intentPattern =
    /(?:^|\n)(?:Now (?:I'll |I will |let me |let's |(?!the |this |that |it |we |they |there |here |our |my |your |its |a |an |is |was |are |has |have |had ))|Let me (?:now )?|Next,? (?:I'll |I will |let me )|I'll (?:now )?|First,? (?:I'll |let me ))(.{10,120}?)(?:\.|$)/im;
  const match = lastPara.match(intentPattern);
  if (match) {
    const intent = match[1].trim().replace(/\.$/, '');
    return `Please continue — ${intent}.`;
  }

  // Check if text ends mid-sentence.  Only flag when it clearly looks
  // truncated — e.g. trailing comma, conjunction, article, or preposition.
  // Markdown lists / code blocks commonly end without terminal punctuation
  // and should NOT be flagged.
  if (
    lastPara.length > 50 &&
    /(?:,|:|\band\b|\bor\b|\bbut\b|\bthe\b|\ba\b|\ban\b|\bto\b|\bfor\b|\bin\b|\bof\b|\bwith\b|\bthat\b|\bwhich\b|\bwhere\b|\bwhen\b)\s*$/i.test(lastPara)
  ) {
    return 'Please continue — your response appears to have been cut short.';
  }

  return null;
}

// Cache parsed history.jsonl keyed by file mtime to avoid re-reading
// the entire file on every /api/transcript request.
let historyCache: {
  mtimeMs: number;
  bySession: Map<string, TranscriptMessage[]>;
} | null = null;

/**
 * When no JSONL transcript exists (pre-persistence sessions), extract
 * whatever user prompts were saved in history.jsonl for this session.
 */
async function getHistoryPrompts(sessionId: string): Promise<TranscriptMessage[]> {
  try {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const fileStat = await fs.stat(historyPath);

    if (!historyCache || historyCache.mtimeMs !== fileStat.mtimeMs) {
      const content = await fs.readFile(historyPath, 'utf-8');
      const lines = content.trim().split('\n');
      const bySession = new Map<string, TranscriptMessage[]>();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!entry.sessionId || !entry.display || !entry.display.trim()) continue;
          const trimmed = entry.display.trim();
          if (/^\/[a-z]/i.test(trimmed)) continue;
          if (trimmed.toLowerCase() === 'exit') continue;

          let arr = bySession.get(entry.sessionId);
          if (!arr) {
            arr = [];
            bySession.set(entry.sessionId, arr);
          }
          arr.push({
            role: 'user',
            content: entry.display,
            timestamp: typeof entry.timestamp === 'number'
              ? new Date(entry.timestamp).toISOString()
              : entry.timestamp,
          });
        } catch {
          // Skip unparseable lines
        }
      }

      historyCache = { mtimeMs: fileStat.mtimeMs, bySession };
    }

    return historyCache.bySession.get(sessionId) || [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const project = searchParams.get('project');

    if (!sessionId || !project) {
      return NextResponse.json(
        { error: 'sessionId and project are required' },
        { status: 400 }
      );
    }

    // Sanitize sessionId to prevent path traversal
    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');

    const projectsBase = join(homedir(), '.claude', 'projects');
    const slug = projectPathToSlug(project);
    const jsonlPath = join(projectsBase, slug, `${sanitizedSessionId}.jsonl`);

    let content = '';
    let resolvedJsonlPath = jsonlPath;
    try {
      content = await fs.readFile(jsonlPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The project path may be a symlink or mapped drive that resolves to a
        // different real path. Try the resolved path before giving up.
        try {
          const resolvedProject = await realpath(project);
          if (resolvedProject !== project) {
            const altSlug = projectPathToSlug(resolvedProject);
            if (altSlug !== slug) {
              const altPath = join(projectsBase, altSlug, `${sanitizedSessionId}.jsonl`);
              content = await fs.readFile(altPath, 'utf-8');
              resolvedJsonlPath = altPath;
            } else {
              throw error; // same slug, won't help
            }
          } else {
            // realpath didn't change it — try scanning project dirs for the file
            const dirs = await fs.readdir(projectsBase);
            let found = false;
            for (const dir of dirs) {
              try {
                const candidate = join(projectsBase, dir, `${sanitizedSessionId}.jsonl`);
                content = await fs.readFile(candidate, 'utf-8');
                resolvedJsonlPath = candidate;
                found = true;
                break;
              } catch { /* try next */ }
            }
            if (!found) throw error;
          }
        } catch {
          // All JSONL attempts failed — try SQLite archive, then history.jsonl
          try {
            const archived = await loadTranscript(sanitizedSessionId);
            if (archived && archived.messages.length > 0) {
              return NextResponse.json({
                messages: archived.messages,
                fromArchive: true,
              });
            }
          } catch (archiveErr) {
            console.error('[Transcript API] Archive fallback error:', archiveErr);
          }

          const historyMessages = await getHistoryPrompts(sanitizedSessionId);
          return NextResponse.json({
            messages: historyMessages,
            partial: true,
          });
        }
      } else {
        throw error;
      }
    }

    // Parse the JSONL using shared parser
    const { messages, rawLines, rawEntries, planSlug, planInsertAfter } = parseTranscriptJsonl(content);

    // If the session wrote a plan file, inject it at the right position
    if (planSlug && planInsertAfter != null) {
      const planPath = join(homedir(), '.claude', 'plans', `${planSlug}.md`);
      try {
        const planContent = await fs.readFile(planPath, 'utf-8');
        if (planContent.trim()) {
          const planMessage: typeof messages[0] = {
            role: 'assistant',
            content: planContent.trim(),
            timestamp: messages[planInsertAfter].timestamp,
          };
          messages.splice(planInsertAfter + 1, 0, planMessage);
        }
      } catch {
        // Plan file doesn't exist or isn't readable — skip
      }
    }

    // --- Unprocessed prompts detection ---
    // history.jsonl entries are written the instant the user hits send,
    // but the JSONL transcript only contains messages that Claude actually
    // processed.  If Claude was interrupted (or the process never started),
    // trailing history prompts won't appear in the JSONL.  Return them
    // separately so the frontend can pre-fill the editor for re-sending.
    //
    // We can't compare counts because the JSONL may contain auto-injected
    // user messages (e.g. "This session is being continued...") that never
    // appear in history.jsonl.  Instead, match by content prefix.
    let unprocessedPrompt: string | undefined;
    const historyPrompts = await getHistoryPrompts(sanitizedSessionId);
    if (historyPrompts.length > 0) {
      const jsonlUserPrefixes = new Set(
        messages
          .filter(m => m.role === 'user')
          .map(m => m.content.substring(0, 150))
      );

      // Walk backwards from the end of history to find the contiguous
      // block of trailing prompts that have no match in the JSONL.
      // Use the last one as the prompt to pre-fill in the editor.
      for (let i = historyPrompts.length - 1; i >= 0; i--) {
        const prefix = historyPrompts[i].content.substring(0, 150);
        if (!jsonlUserPrefixes.has(prefix)) {
          unprocessedPrompt = historyPrompts[i].content;
        } else {
          break;
        }
      }
    }

    // --- Incomplete response detection ---
    let suggestedPrompt: SuggestedPrompt | undefined;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant') {
      // Time gate: only suggest if the JSONL hasn't been modified recently.
      // Claude API delays and conversation compaction can cause gaps of 1+ min.
      try {
        const fileStat = await fs.stat(resolvedJsonlPath);
        const age = Date.now() - fileStat.mtimeMs;

        if (age >= STALE_THRESHOLD_MS) {
          // Find the last raw assistant entry with a content array
          const lastAssistant = [...rawEntries]
            .reverse()
            .find(e => e.type === 'assistant' && Array.isArray(e.message?.content));

          if (lastAssistant) {
            const contentBlocks = lastAssistant.message.content;
            const lastBlock = contentBlocks[contentBlocks.length - 1];

            // Case 1: unresolved tool_use (no matching tool_result)
            if (lastBlock?.type === 'tool_use') {
              const toolUseId = lastBlock.id;
              const hasResult = rawEntries.some(e =>
                e.type === 'user' &&
                Array.isArray(e.message?.content) &&
                e.message.content.some(
                  (b: any) => b.type === 'tool_result' && b.tool_use_id === toolUseId
                )
              );
              if (!hasResult) {
                suggestedPrompt = {
                  context: 'Interrupted',
                  text: generateToolSuggestion(lastBlock.name, lastBlock.input),
                };
              }
            }

            // Case 2: trailing intent language with no tool_use follow-through
            if (!suggestedPrompt && lastBlock?.type === 'text') {
              const suggestion = detectIntentLanguage(lastBlock.text);
              if (suggestion) {
                suggestedPrompt = {
                  context: 'Incomplete response',
                  text: suggestion,
                };
              }
            }
          }
        }
      } catch {
        // stat failed — skip suggestion
      }
    }

    // Archive to SQLite (fire-and-forget — never blocks the response)
    const display = historyPrompts[0]?.content || messages.find(m => m.role === 'user')?.content || sanitizedSessionId;
    archiveTranscript(sanitizedSessionId, project, display.substring(0, 200), content, messages, rawLines)
      .catch(err => console.error('[Transcript API] Archive error:', err));

    return NextResponse.json({ messages, suggestedPrompt, unprocessedPrompt });
  } catch (error) {
    console.error('[Transcript API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load transcript' },
      { status: 500 }
    );
  }
}
