import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseTranscriptJsonl, type TranscriptMessage } from '@/lib/transcriptParser';
import { archiveTranscript, loadTranscript } from '@/lib/transcriptArchiver';
import { sessionJsonlPath } from '@/lib/sessionPaths';
import { sessionManager } from '@/lib/sessionManager';
import { sdkSessionManager } from '@/lib/sdkSessionManager';

export const runtime = 'nodejs';

// How long (ms) since the JSONL was last modified before we consider
// the response "stale" and eligible for an incomplete-response suggestion.
// Claude API delays and conversation compaction can cause gaps of 1+ min.
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

    // Locate the transcript JSONL subst-drive / symlink safe. This replaces a
    // hand-rolled naive→realpath→scan chain that duplicated (and had drifted from)
    // lib/sessionPaths' findSessionJsonlDir.
    const resolvedJsonlPath = sessionJsonlPath(sanitizedSessionId, project);
    let content = '';
    if (resolvedJsonlPath) {
      try {
        content = await fs.readFile(resolvedJsonlPath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!content) {
      // JSONL missing — try SQLite archive, then history.jsonl.
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
      // A missing JSONL does NOT always mean "the CLI never persisted this
      // session": a brand-new session's JSONL only appears a few seconds after
      // the first turn spawns the CLI. If the session is LIVE right now (either
      // backend), this is that startup window — report it as `pending` (benign;
      // the stream buffer paints the in-flight turn) instead of `partial`, which
      // makes ChatTab show the scary "transcripts were not persisted" banner on
      // an actively-streaming session.
      const liveNow = sessionManager.getSessionHealth(sanitizedSessionId).isProcessing
        || sdkSessionManager.isSessionProcessing(sanitizedSessionId)
        || sdkSessionManager.isBackgroundActive(sanitizedSessionId);
      return NextResponse.json({
        messages: historyMessages,
        ...(liveNow ? { pending: true } : { partial: true }),
      });
    }

    // Parse the JSONL using shared parser
    const { messages, rawLines, rawEntries, planSlug, planInsertAfter, numCompactions, pendingAskUserQuestion, currentModel, totalOutputTokens, usageEvents, contextTokens } = parseTranscriptJsonl(content);

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

    // Archive to SQLite (fire-and-forget — never blocks the response)
    const display = historyPrompts[0]?.content || messages.find(m => m.role === 'user')?.content || sanitizedSessionId;
    archiveTranscript(sanitizedSessionId, project, display.substring(0, 200), content, messages, rawLines, undefined, { numCompactions, totalOutputTokens, usageEvents, contextTokens })
      .catch(err => console.error('[Transcript API] Archive error:', err));

    // For a LIVE (managed) session, report the model its next turn will use, not
    // the transcript-derived one: after a mid-session switch the transcript's most
    // recent assistant message still names the OLD model until a turn runs on the
    // new one, which would revert the composer's label on every reload. For a cold
    // or non-SDK session getManagedModel returns null and we keep the transcript
    // model — so a stale persisted override can't permanently mask what actually
    // served the session's turns.
    const liveModel = sdkSessionManager.getManagedModel(sanitizedSessionId);
    const effectiveModel = liveModel || currentModel;

    return NextResponse.json({ messages, unprocessedPrompt, numCompactions, pendingAskUserQuestion, currentModel: effectiveModel });
  } catch (error) {
    console.error('[Transcript API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load transcript' },
      { status: 500 }
    );
  }
}
