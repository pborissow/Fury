/**
 * End-to-end fidelity check: after the restore-from-archive fix, does Claude
 * CLI actually see the historical conversation as context?
 *
 * Reproduction: prompt the resumed session with "summarize what we've been
 * doing" and check the assistant's response for content that only appears
 * in the archived JSONL (Java AuditWriter, keyType, audit warning fix,
 * git add). If those tokens appear, the JSONL was meaningfully restored —
 * not just written to disk.
 *
 * Subject: session 85defa96-1b44-4030-8978-ca2b2db9db5d (last touched
 * 2026-03-10, JSONL deleted by Claude CLI's 30-day cleanup).
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSION_ID = '85defa96-1b44-4030-8978-ca2b2db9db5d';
const PROJECT_PATH = '/Users/peterborrisow/Documents/Java/BoatsGroup/maven/YC2-357';
const SLUG = '-Users-peterborrisow-Documents-Java-BoatsGroup-maven-YC2-357';
const DB = join(homedir(), '.claude', 'fury.db');
const JSONL = join(homedir(), '.claude', 'projects', SLUG, `${SESSION_ID}.jsonl`);

function archivedCount(): number {
  const out = execSync(`sqlite3 "${DB}" "SELECT COUNT(*) FROM messages WHERE session_id='${SESSION_ID}'"`, { encoding: 'utf-8' });
  return parseInt(out.trim(), 10) || 0;
}

async function waitForJsonlStable(stableMs: number, timeoutMs: number): Promise<{ stable: boolean; sizeBytes: number; lines: number }> {
  const t0 = Date.now();
  let lastSize = -1;
  let lastChangeAt = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!existsSync(JSONL)) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    const size = statSync(JSONL).size;
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= stableMs) {
      const lines = readFileSync(JSONL, 'utf-8').split('\n').filter(Boolean).length;
      return { stable: true, sizeBytes: size, lines };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const size = existsSync(JSONL) ? statSync(JSONL).size : 0;
  const lines = existsSync(JSONL) ? readFileSync(JSONL, 'utf-8').split('\n').filter(Boolean).length : 0;
  return { stable: false, sizeBytes: size, lines };
}

/** Concatenate all assistant text from JSONL entries written after the supplied wall-clock cutoff. */
function assistantTextSince(cutoffMs: number): string {
  if (!existsSync(JSONL)) return '';
  const out: string[] = [];
  for (const line of readFileSync(JSONL, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
    if (ts < cutoffMs) continue;
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
      }
    } else if (typeof content === 'string') {
      out.push(content);
    }
  }
  return out.join('\n');
}

test('resume preserves history AND Claude CLI sees the archived context', async ({ page }) => {
  test.setTimeout(240_000); // up to 4 minutes — model needs to respond

  // ---- Preconditions ----
  console.log('\n[FIDELITY] ====== Preconditions ======');
  const before = archivedCount();
  console.log('[FIDELITY] Archived messages before:', before);
  console.log('[FIDELITY] JSONL exists?', existsSync(JSONL));
  expect(before).toBe(11);
  expect(existsSync(JSONL)).toBe(false);

  // ---- Action ----
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const prompt =
    'Briefly summarize what we worked on in this session so far — what file, ' +
    'what problem, and what change. Keep it under 3 sentences. Do not call any tools.';
  console.log('\n[FIDELITY] ====== POST /api/claude ======');
  console.log('[FIDELITY] prompt:', JSON.stringify(prompt));
  const cutoff = Date.now();
  const res = await page.request.post('/api/claude', {
    data: { prompt, sessionId: SESSION_ID, projectPath: PROJECT_PATH },
  });
  expect(res.ok()).toBe(true);

  // ---- Wait for CLI completion (JSONL size stable for 8s) ----
  console.log('\n[FIDELITY] ====== Waiting for CLI to finish ======');
  const result = await waitForJsonlStable(8_000, 180_000);
  console.log('[FIDELITY] JSONL stable:', result.stable, 'size:', result.sizeBytes, 'lines:', result.lines);

  // ---- Extract the assistant response written AFTER the cutoff ----
  const summary = assistantTextSince(cutoff).trim();
  console.log('\n[FIDELITY] ====== Assistant response (post-cutoff) ======');
  console.log(summary || '(empty)');
  console.log('\n[FIDELITY] ====== End response ======');

  // ---- Assertions ----
  expect(summary.length).toBeGreaterThan(0);

  // The historical conversation was about fixing an AuditWriter Java class
  // that was spamming PROD warnings related to a blank keyType for blob
  // changes. The fix added a guard / early return.
  const TOKENS = [
    'AuditWriter',     // exact class name from the archived conversation
    'keyType',         // the field at issue
    'audit',           // topic
    'warning',         // symptom
    'blob',            // change type
    'recordAudit',     // method name from the diff in the archive
    'Java',
    'PROD',
  ];
  const lower = summary.toLowerCase();
  const hits = TOKENS.filter(t => lower.includes(t.toLowerCase()));
  console.log('[FIDELITY] Matched tokens from archived conversation:', hits);

  // At minimum we want >=2 distinct tokens that ONLY appear in the historical
  // conversation. If the resume didn't load history, Claude would have no way
  // to know about AuditWriter / keyType / recordAudit.
  expect(hits.length).toBeGreaterThanOrEqual(2);

  // Final state: archive still has at least the original 11 — possibly more
  // if the new assistant turn was archived in time.
  const after = archivedCount();
  console.log('[FIDELITY] Archived messages after:', after);
  expect(after).toBeGreaterThanOrEqual(11);
});
