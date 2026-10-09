'use client';

/**
 * Ask-mode request lifecycle for the Search tab (docs/ticket-ask-search.md §5).
 *
 * POSTs the question to /api/search/ask and folds its NDJSON event stream into
 * one AskState. Guarantees:
 *   - one ask at a time: a new ask aborts the one in flight (which interrupts
 *     the agent server-side), and re-asking the question already running is a
 *     no-op (no double spend from a double Enter);
 *   - cancel() and an unmount abort the request;
 *   - a superseded request can never write state (generation counter).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskEvent, ResolvedResult } from '@/lib/askSearch';
import type { SearchSessionResult } from './types';

export interface AskStep { tool: string; input: { q?: string; project?: string; sessionId?: string } }

export type AskState =
  | { status: 'running'; question: string; steps: AskStep[]; startedAt: number }
  | { status: 'answer'; question: string; steps: AskStep[]; summary: string; sessions: SearchSessionResult[];
      notes: Record<string, string>; dropped: number; durationMs: number }
  | { status: 'prose'; question: string; steps: AskStep[]; text: string }
  | { status: 'fallback'; question: string; steps: AskStep[]; reason: string; query: string;
      project: string | null; sessions: SearchSessionResult[]; totalHits: number }
  | { status: 'error'; question: string; steps: AskStep[]; message: string };

/** An agent result as an ordinary result card: its cited message is the hit row. */
export function toCard(r: ResolvedResult): SearchSessionResult {
  return {
    sessionId: r.sessionId,
    project: r.project,
    display: r.title,
    status: r.status,
    messageCount: r.messageCount,
    updatedAt: r.updatedAt,
    titleMatch: false,
    hits: r.hit && r.turnIndex !== null
      ? [{ role: r.hit.role, turnIndex: r.turnIndex, timestamp: r.hit.timestamp, snippet: r.hit.excerpt, rank: 0 }]
      : [],
    hitCount: r.hit ? 1 : 0,
  };
}

export function useAsk() {
  const [state, setState] = useState<AskState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const stateRef = useRef<AskState | null>(null);
  stateRef.current = state;

  const cancel = useCallback(() => {
    genRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(null);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(async (raw: string) => {
    const question = raw.trim();
    if (!question) return;
    const cur = stateRef.current;
    if (cur?.status === 'running' && cur.question === question) return; // double Enter

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++genRef.current;
    const steps: AskStep[] = [];
    const live = () => gen === genRef.current;
    setState({ status: 'running', question, steps: [], startedAt: Date.now() });

    const finish = (s: AskState) => { if (live()) setState(s); };
    try {
      const res = await fetch('/api/search/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        finish({ status: 'error', question, steps, message: err.error || `Request failed (${res.status})` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let ended = false;
      const handle = (e: AskEvent) => {
        if (e.type === 'progress') {
          steps.push({ tool: e.tool, input: e.input });
          if (live()) setState((s) => (s && s.status === 'running' ? { ...s, steps: [...steps] } : s));
        } else if (e.type === 'answer') {
          ended = true;
          finish({
            status: 'answer', question, steps, summary: e.summary, sessions: e.results.map(toCard),
            notes: Object.fromEntries(e.results.map((r) => [r.sessionId, r.why])),
            dropped: e.dropped, durationMs: e.durationMs,
          });
        } else if (e.type === 'prose') {
          ended = true;
          finish({ status: 'prose', question, steps, text: e.text });
        } else if (e.type === 'fallback') {
          ended = true;
          finish({ status: 'fallback', question, steps, reason: e.reason, query: e.query, project: e.project,
            sessions: e.results, totalHits: e.totalHits });
        } else if (e.type === 'error') {
          ended = true;
          finish({ status: 'error', question, steps, message: e.message });
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) { try { handle(JSON.parse(line)); } catch { /* malformed line: skip */ } }
        }
        if (done) break;
      }
      if (!ended) finish({ status: 'error', question, steps, message: 'The search agent stopped without answering.' });
    } catch (err) {
      if (ac.signal.aborted) return; // cancelled or superseded: state already handled
      finish({ status: 'error', question, steps, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  return { state, ask, cancel };
}
