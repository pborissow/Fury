import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { askSearch, keywordFallback, type AskEvent } from '@/lib/askSearch';
import { StealthAskError } from '@/lib/stealthSessions';
import { MAX_QUESTION_CHARS } from '@/lib/askIntent';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/search/ask   { question: string }
 *
 * Ask the Search agent (lib/askSearch.ts) a question about past sessions.
 * Streams NDJSON (`application/x-ndjson`), one AskEvent per line:
 *
 *   {"type":"progress","tool":"search_transcripts","input":{"q":"file tree","project":"/…/Fury"}}
 *   … more progress …
 *   {"type":"answer","summary":"…","results":[…],"dropped":0,"costUsd":…,"durationMs":…}
 *
 * The final event is exactly one of `answer`, `prose` (the agent answered,
 * but not in the schema), `fallback` (agent unavailable / timed out / failed:
 * keyword results on the question's residue) or `error`. Closing the request
 * (client abort) interrupts the agent's turn and ends the stream silently.
 */
export async function POST(req: NextRequest) {
  let question = '';
  try { question = String((await req.json())?.question ?? '').trim(); } catch { /* bad JSON */ }
  if (!question) return Response.json({ error: 'question is required' }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json({ error: `question is longer than ${MAX_QUESTION_CHARS} characters` }, { status: 400 });
  }

  // One abort for both disconnect signals: the request's, and the stream being
  // cancelled by the runtime when the client goes away mid-stream.
  const abort = new AbortController();
  const onReqAbort = () => abort.abort();
  req.signal.addEventListener('abort', onReqAbort, { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AskEvent) => {
        if (closed || abort.signal.aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); } catch { closed = true; }
      };
      try {
        const out = await askSearch(question, {
          signal: abort.signal,
          onToolEvent: (e) => {
            if (e.type !== 'tool_use') return;
            const i = (e.input ?? {}) as Record<string, unknown>;
            send({
              type: 'progress',
              tool: e.name.replace(/^mcp__transcripts__/, ''),
              input: {
                ...(typeof i.q === 'string' ? { q: i.q.slice(0, 200) } : {}),
                ...(typeof i.project === 'string' ? { project: i.project } : {}),
                ...(typeof i.sessionId === 'string' ? { sessionId: i.sessionId } : {}),
              },
            });
          },
        });
        send({ type: 'answer', ...out });
      } catch (err) {
        if (abort.signal.aborted) return; // the user cancelled: nothing to say
        const code = err instanceof StealthAskError ? err.code : 'error';
        const message = err instanceof Error ? err.message : String(err);
        log.warn('search.ask', 'agent failed; falling back', { data: { code, message } });
        // The agent answered in prose instead of the schema: that text IS the answer.
        if (err instanceof StealthAskError && err.detail?.subtype === 'missing_structured_output' && err.detail.partialText?.trim()) {
          send({ type: 'prose', text: err.detail.partialText.trim() });
          return;
        }
        try {
          const fb = await keywordFallback(await getDb(), question);
          send({ type: 'fallback', reason: code, message, ...fb });
        } catch (fbErr) {
          send({ type: 'error', message: `Search failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}` });
        }
      } finally {
        req.signal.removeEventListener('abort', onReqAbort);
        if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
      }
    },
    cancel() { abort.abort(); },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
