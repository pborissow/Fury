/**
 * Stealth-session registry (lib/stealthSessions.ts, docs/ticket-stealth-sessions.md).
 *
 * The session layer is a scripted fake query(): each spawn records its options
 * and the prompts it receives, and the test (or an auto-responder) decides what
 * SDK messages come back. Nothing real is spawned (trackPids: false).
 *
 * Covers: safety defaults of the spawn options (§4), agent-file parsing,
 * provider-settings pass-through, acquire/reuse, serialization, idle kill,
 * recycle thresholds, config-change recycle, timeout → interrupt (and the kill
 * fallback), mid-ask death, usage dedupe + cost deltas (§5), provider-switch
 * recycle, shutdown, and the orphan sweep (§3).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP = mkdtempSync(join(tmpdir(), 'fury-stealth-'));
process.env.FURY_HOME = join(TMP, 'fury-home');

import {
  StealthSessionRegistry,
  StealthAskError,
  buildStealthOptions,
  parseAgentMarkdown,
  readProviderSettings,
  sweepStealthOrphans,
  stealthLabel,
  type StealthUsageRow,
  type QueryLike,
} from '../../lib/stealthSessions';
import { furyInternalPath } from '../../lib/furyHome';
import { eventBus } from '../../lib/eventBus';

afterAll(() => {
  delete process.env.FURY_HOME;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
});

// ---------------------------------------------------------------------------
// Fake query()
// ---------------------------------------------------------------------------

type Msg = Record<string, unknown>;

class FakeQuery implements QueryLike {
  prompts: string[] = [];
  interrupts = 0;
  ended = false;
  private out: Msg[] = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  /** Called for each pushed prompt; default does nothing (test drives it). */
  onPrompt: ((text: string, q: FakeQuery) => void) | null = null;
  onInterrupt: ((q: FakeQuery) => void) | null = null;

  constructor(public options: Record<string, unknown>, prompt: AsyncIterable<unknown>) {
    const ac = options.abortController as AbortController;
    ac.signal.addEventListener('abort', () => this.fail(new Error('Operation aborted')));
    void (async () => {
      for await (const m of prompt as AsyncIterable<{ message: { content: string } }>) {
        this.prompts.push(m.message.content);
        this.onPrompt?.(m.message.content, this);
      }
    })();
  }

  emit(m: Msg) { this.out.push(m); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  fail(err: Error) { this.failure = err; this.wake?.(); }

  async interrupt() { this.interrupts++; this.onInterrupt?.(this); }

  async *[Symbol.asyncIterator](): AsyncIterator<never> {
    while (true) {
      if (this.out.length) { yield this.out.shift() as never; continue; }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }

  // --- canned SDK messages ---
  assistant(id: string, opts: { text?: string; toolUse?: string; usage?: Msg; model?: string } = {}) {
    const content: Msg[] = [];
    if (opts.text) content.push({ type: 'text', text: opts.text });
    if (opts.toolUse) content.push({ type: 'tool_use', id: 'tu-' + id, name: opts.toolUse, input: {} });
    this.emit({
      type: 'assistant', parent_tool_use_id: null,
      message: { id, model: opts.model ?? 'claude-haiku-4-5-20251001', content, usage: opts.usage ?? { input_tokens: 10, output_tokens: 5 } },
    });
  }
  toolResult(id: string, isError = false) {
    this.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-' + id, is_error: isError }] } });
  }
  result(text: string, cumulativeCost: number, extra: Msg = {}) {
    this.emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: cumulativeCost, permission_denials: [], ...extra });
  }
}

/** Auto-responder: answers every prompt with "re:<prompt>", one API call each. */
function echo(q: FakeQuery) {
  let n = 0;
  let cost = 0;
  q.onPrompt = (text) => {
    n++;
    cost += 0.01;
    q.assistant(`m${n}`, { text: `re:${text}`, usage: { input_tokens: 100 * n, output_tokens: 5, cache_read_input_tokens: 0 } });
    q.result(`re:${text}`, cost);
  };
}

function makeRegistry(opts: { auto?: boolean } = {}) {
  const spawned: FakeQuery[] = [];
  const usage: StealthUsageRow[] = [];
  const reg = new StealthSessionRegistry({
    trackPids: false,
    readProviderSettings: () => ({ env: {}, helpers: {} }),
    recordUsage: async (rows) => { usage.push(...rows); },
    query: ({ prompt, options }) => {
      const q = new FakeQuery(options as unknown as Record<string, unknown>, prompt);
      if (opts.auto !== false) echo(q);
      spawned.push(q);
      return q;
    },
  });
  return { reg, spawned, usage };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('buildStealthOptions — safety defaults (§4)', () => {
  const base = {
    agent: null,
    cwd: '/x/.fury/internal/t',
    sessionId: 'sid',
    abortController: new AbortController(),
    provider: { env: { CLAUDE_CODE_USE_BEDROCK: '1' }, helpers: { awsAuthRefresh: 'aws sso login' } },
    baseEnv: { PATH: '/bin' },
  };

  it('is invisible, isolated, least-capable and non-interactive by default', () => {
    const o = buildStealthOptions({ ...base, config: { name: 't' }, mcpServers: {} });
    expect(o.persistSession).toBe(false);          // no transcript on disk
    expect(o.settingSources).toEqual([]);          // no user hooks/plugins/permission rules
    expect(o.strictMcpConfig).toBe(true);          // never the user's MCP servers
    expect(o.tools).toEqual([]);                   // no built-in tools
    expect(o.allowedTools).toEqual([]);
    expect(o.disallowedTools).toContain('AskUserQuestion');
    expect(o.permissionMode).toBe('dontAsk');      // deny, never prompt
    expect(o.canUseTool).toBeUndefined();          // nothing that could park
    expect(o.cwd).toBe('/x/.fury/internal/t');
    expect((o.settings as Record<string, unknown>).disableAllHooks).toBe(true);
  });

  it('passes the provider through (env + credential helpers) and nothing else', () => {
    const o = buildStealthOptions({ ...base, config: { name: 't' }, mcpServers: {} });
    expect(o.env).toMatchObject({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'fury-stealth/t' });
    expect(o.settings).toEqual({ awsAuthRefresh: 'aws sso login', disableAllHooks: true });
  });

  it('allow-lists exactly the consumer MCP servers + opted-in builtins, never AskUserQuestion', () => {
    const o = buildStealthOptions({
      ...base,
      config: { name: 't', builtinTools: ['Read', 'AskUserQuestion'] },
      mcpServers: { transcripts: { type: 'stdio', command: 'x' } },
    });
    expect(o.tools).toEqual(['Read']);
    expect(o.allowedTools).toEqual(['mcp__transcripts', 'Read']);
    const o2 = buildStealthOptions({ ...base, config: { name: 't', allowedTools: ['mcp__a__b', 'AskUserQuestion'] }, mcpServers: {} });
    expect(o2.allowedTools).toEqual(['mcp__a__b']);
  });

  it('wires an agent as the main thread; consumer model overrides the agent model', () => {
    const o = buildStealthOptions({
      ...base,
      config: { name: 't', model: 'sonnet' },
      agent: { name: 'lib', description: 'd', prompt: 'p', model: 'haiku', tools: ['mcp__x__y'] },
      mcpServers: {},
    });
    expect(o.agent).toBe('lib');
    expect(o.agents?.lib).toEqual({ description: 'd', prompt: 'p', model: 'sonnet', tools: ['mcp__x__y'] });
    expect(o.model).toBe('sonnet');
  });
});

describe('parseAgentMarkdown', () => {
  it('parses comma, flow and block lists, quotes and comments', () => {
    const a = parseAgentMarkdown(`---
name: transcript-searcher
description: "Finds sessions"  # trailing comment
tools: mcp__t__search, mcp__t__get
model: haiku
---
You are a librarian.
`, 'fallback');
    expect(a).toEqual({ name: 'transcript-searcher', description: 'Finds sessions', prompt: 'You are a librarian.', tools: ['mcp__t__search', 'mcp__t__get'], model: 'haiku' });
    expect(parseAgentMarkdown('---\ndescription: d\ntools: [a, "b"]\n---\nP', 'n').tools).toEqual(['a', 'b']);
    expect(parseAgentMarkdown('---\ndescription: d\ntools:\n  - a\n  - b\n---\nP', 'n')).toMatchObject({ name: 'n', tools: ['a', 'b'] });
  });

  it('rejects a file without frontmatter or body', () => {
    expect(() => parseAgentMarkdown('just text', 'n')).toThrow(/frontmatter/);
    expect(() => parseAgentMarkdown('---\ndescription: d\n---\n  ', 'n')).toThrow(/empty/);
  });
});

describe('stealthLabel', () => {
  it('uses the explicit label, else humanizes the name', () => {
    expect(stealthLabel({ name: 'ask-search', label: '  Search agent ' })).toBe('Search agent');
    expect(stealthLabel({ name: 'ask-search' })).toBe('Ask search');
    expect(stealthLabel({ name: 'auto--label' })).toBe('Auto label');
  });
});

describe('readProviderSettings', () => {
  it('keeps env strings and credential helpers; drops hooks, permissions, plugins', () => {
    const r = readProviderSettings(() => JSON.stringify({
      env: { AWS_REGION: 'us-east-1', BAD: 3 },
      awsAuthRefresh: 'aws sso login',
      hooks: { Stop: [] }, permissions: { allow: ['Bash(*)'] }, enabledPlugins: { x: true },
    }));
    expect(r).toEqual({ env: { AWS_REGION: 'us-east-1' }, helpers: { awsAuthRefresh: 'aws sso login' } });
    expect(readProviderSettings(() => { throw new Error('ENOENT'); })).toEqual({ env: {}, helpers: {} });
  });
});

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

describe('StealthSessionRegistry', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('rejects unsafe names and missing agent files at acquire()', async () => {
    const { reg } = makeRegistry();
    await expect(reg.acquire({ name: '../evil' })).rejects.toThrow(/Invalid/);
    await expect(reg.acquire({ name: 'Upper' })).rejects.toThrow(/Invalid/);
    await expect(reg.acquire({ name: 'ok', agent: 'nope', agentsDir: TMP })).rejects.toThrow(/ENOENT/);
    await expect(reg.acquire({ name: 'ok', label: '   ' })).rejects.toThrow(/label/);
    await expect(reg.acquire({ name: 'ok', label: 'x'.repeat(61) })).rejects.toThrow(/label/);
  });

  it('spawns lazily in the reserved cwd, then reuses one warm session per name', async () => {
    const { reg, spawned } = makeRegistry();
    const a = await reg.acquire({ name: 'ask-search', model: 'haiku' });
    expect(spawned).toHaveLength(1); // pre-warmed at acquire
    expect(spawned[0].options.cwd).toBe(furyInternalPath('ask-search'));
    expect(existsSync(furyInternalPath('ask-search'))).toBe(true);
    const r1 = await a.ask('one');
    const b = await reg.acquire({ name: 'ask-search', model: 'haiku' });
    const r2 = await b.ask('two');
    expect(spawned).toHaveLength(1);
    expect(r1.text).toBe('re:one');
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(reg.getSessionIds()).toEqual([r1.sessionId]);
    expect(reg.isStealthSessionId(r1.sessionId)).toBe(true);

    await reg.acquire({ name: 'digest', model: 'sonnet' });
    expect(spawned).toHaveLength(2);
    expect(spawned[1].options.model).toBe('sonnet');
    await reg.killAll();
  });

  it('serializes concurrent asks on one session', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'q' });
    const q = spawned[0];
    const p1 = s.ask('first');
    const p2 = s.ask('second');
    await flush();
    expect(q.prompts).toEqual(['first']);           // second waits its turn
    expect(reg.list()[0]).toMatchObject({ busy: true, queued: 1 });
    q.assistant('a'); q.result('A', 0.01);
    expect((await p1).text).toBe('A');
    await flush();
    expect(q.prompts).toEqual(['first', 'second']);
    q.assistant('b'); q.result('B', 0.02);
    expect((await p2).text).toBe('B');
    await reg.killAll();
  });

  it('records deduped usage per API call (last value wins) and per-ask cost deltas (§5)', async () => {
    const { reg, spawned, usage } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'acct', label: 'Search agent' });
    const q = spawned[0];
    const p = s.ask('x');
    await flush();
    // Streaming repeats a message's usage per block; the last emission is final.
    q.assistant('m1', { toolUse: 'mcp__t__search', usage: { input_tokens: 50, output_tokens: 1 } });
    q.toolResult('m1');
    q.assistant('m1', { text: 'part', usage: { input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 }, cache_creation_input_tokens: 3 } });
    q.assistant('m2', { text: 'done', usage: { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 8 } });
    q.result('done', 0.05, { permission_denials: [{ tool_name: 'mcp__t__secret', tool_use_id: 'tu' }] });
    const r = await p;
    expect(r.costUsd).toBeCloseTo(0.05);
    expect(r.usage).toEqual({ input: 70, output: 13, cacheWrite5m: 3, cacheWrite1h: 8, cacheRead: 7 });
    expect(r.permissionDenials).toEqual([{ toolName: 'mcp__t__secret', toolUseId: 'tu' }]);
    await flush();
    expect(usage.map((u) => [u.consumer, u.label, u.messageId, u.output])).toEqual([['acct', 'Search agent', 'm1', 9], ['acct', 'Search agent', 'm2', 4]]);
    expect(reg.list()[0]).toMatchObject({ name: 'acct', label: 'Search agent' });
    expect(usage.every((u) => u.sessionId === r.sessionId && u.model === 'claude-haiku-4-5-20251001')).toBe(true);

    const p2 = s.ask('y');
    await flush();
    q.assistant('m3'); q.result('y', 0.08); // cumulative → delta 0.03
    expect((await p2).costUsd).toBeCloseTo(0.03);
    expect(reg.list()[0].lifetimeCostUsd).toBeCloseTo(0.08);
    await reg.killAll();
  });

  it('streams tool events to the consumer and survives a throwing callback', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'ev' });
    const q = spawned[0];
    const seen: string[] = [];
    const p = s.ask('x', { onToolEvent: (e) => { seen.push(e.type); throw new Error('consumer bug'); } });
    await flush();
    q.assistant('m', { toolUse: 'mcp__t__search' }); q.toolResult('m', true); q.result('ok', 0);
    expect((await p).text).toBe('ok');
    expect(seen).toEqual(['tool_use', 'tool_result']);
    await reg.killAll();
  });

  it('rejects a failed result with result_error but keeps the session warm', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'err' });
    const q = spawned[0];
    const p = s.ask('x');
    await flush();
    q.result('', 0, { subtype: 'error_max_turns', is_error: true });
    await expect(p).rejects.toMatchObject({ code: 'result_error', detail: { subtype: 'error_max_turns' } });
    expect(reg.getSessionIds()).toHaveLength(1);
    await reg.killAll();
  });

  it('timeout → interrupt; the interrupted turn\'s result is absorbed, session reused', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'slow', askTimeoutMs: 20 });
    const q = spawned[0];
    q.onInterrupt = (fq) => fq.result('', 0.01, { subtype: 'error_during_execution', is_error: true });
    const p = s.ask('hang');
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    expect(q.interrupts).toBe(1);
    echo(q);
    const r = await s.ask('next');
    expect(r.text).toBe('re:next');               // not the stale result
    expect(spawned).toHaveLength(1);
    await reg.killAll();
  });

  it('kills the session when an interrupt never settles (grace), and respawns next ask', async () => {
    vi.useFakeTimers();
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'wedge', askTimeoutMs: 1000 });
    const p = s.ask('hang');
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);      // timeout → interrupt (ignored)
    expect(spawned[0].interrupts).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);      // grace → kill
    expect(await caught).toMatchObject({ code: 'timeout' });
    expect(reg.getSessionIds()).toEqual([]);
    vi.useRealTimers();
    echo(spawned[0]);
    const r = s.ask('again');
    await flush();
    expect(spawned).toHaveLength(2);
    echo(spawned[1]); spawned[1].onPrompt?.('again', spawned[1]);
    expect((await r).text).toBe('re:again');
    await reg.killAll();
  });

  it('an AbortSignal stops a running ask, and drops a queued one without running it', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'abort' });
    const q = spawned[0];
    q.onInterrupt = (fq) => fq.result('', 0, { subtype: 'error_during_execution', is_error: true });
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = s.ask('running', { signal: ac1.signal });
    const p2 = s.ask('queued', { signal: ac2.signal });
    await flush();
    ac2.abort();
    await expect(p2).rejects.toMatchObject({ code: 'aborted' });
    ac1.abort();
    await expect(p1).rejects.toMatchObject({ code: 'aborted' });
    expect(q.prompts).toEqual(['running']);
    await expect(s.ask('pre', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(StealthAskError);
    await reg.killAll();
  });

  it('a signal reused across many asks accumulates no abort listeners', async () => {
    const { reg } = makeRegistry();
    const s = await reg.acquire({ name: 'reuse' });
    const ac = new AbortController();
    const live = new Set<unknown>();
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    vi.spyOn(ac.signal, 'addEventListener').mockImplementation((t, fn, o) => { live.add(fn); add(t, fn, o); });
    vi.spyOn(ac.signal, 'removeEventListener').mockImplementation((t, fn, o) => { live.delete(fn); remove(t, fn, o); });
    // Queue several at once (exercises the queued-abort listener) and sequentially.
    await Promise.all([s.ask('a', { signal: ac.signal }), s.ask('b', { signal: ac.signal }), s.ask('c', { signal: ac.signal })]);
    for (let i = 0; i < 5; i++) await s.ask(`n${i}`, { signal: ac.signal });
    expect(live.size).toBe(0);
    await reg.killAll();
  });

  it('a process that dies mid-ask rejects session_died; the next ask respawns', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'die' });
    const p = s.ask('x');
    await flush();
    spawned[0].fail(new Error('CLI crashed'));
    await expect(p).rejects.toMatchObject({ code: 'session_died' });
    expect(reg.getSessionIds()).toEqual([]);
    const r = s.ask('y');
    await flush();
    expect(spawned).toHaveLength(2);
    echo(spawned[1]); spawned[1].onPrompt?.('y', spawned[1]);
    expect((await r).text).toBe('re:y');
    await reg.killAll();
  });

  it('recycles after maxTurns and after maxContextTokens', async () => {
    const { reg, spawned } = makeRegistry();
    const s = await reg.acquire({ name: 'cyc', recycle: { maxTurns: 2 } });
    await s.ask('1'); await s.ask('2');            // 2nd crosses → killed after the ask
    expect(reg.getSessionIds()).toEqual([]);
    await s.ask('3');
    expect(spawned).toHaveLength(2);

    const { reg: reg2, spawned: sp2 } = makeRegistry();
    // echo() reports input 100*n tokens per call → context crosses 250 on call 3.
    const t = await reg2.acquire({ name: 'ctx', recycle: { maxContextTokens: 250 } });
    await t.ask('a'); await t.ask('b');
    expect(sp2).toHaveLength(1);
    await t.ask('c');
    expect(reg2.getSessionIds()).toEqual([]);
    await reg.killAll(); await reg2.killAll();
  });

  it('a changed model/agent config forces a respawn; an identical one does not', async () => {
    const { reg, spawned } = makeRegistry();
    await reg.acquire({ name: 'cfg', model: 'haiku' });
    await reg.acquire({ name: 'cfg', model: 'haiku', idleKillMs: 5 });
    expect(spawned).toHaveLength(1);
    await reg.acquire({ name: 'cfg', model: 'sonnet' });
    expect(spawned).toHaveLength(2);
    expect(spawned[0].options.abortController).toHaveProperty('signal.aborted', true);
    await reg.killAll();
  });

  it('kills an idle session after idleKillMs and respawns on demand', async () => {
    vi.useFakeTimers();
    const { reg, spawned } = makeRegistry();
    const s = await reg.acquire({ name: 'idle', idleKillMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(reg.getSessionIds()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reg.getSessionIds()).toHaveLength(0);
    vi.useRealTimers();
    expect((await s.ask('back')).text).toBe('re:back');
    expect(spawned).toHaveLength(2);
    await reg.killAll();
  });

  it('recycles on provider:switched (a warm process keeps its old provider)', async () => {
    const { reg, spawned } = makeRegistry();
    reg.attach();
    try {
      const s = await reg.acquire({ name: 'prov' });
      eventBus.emitApp({ type: 'provider:switched', provider: 'bedrock', message: 'x' });
      expect(reg.getSessionIds()).toEqual([]);
      await s.ask('after');
      expect(spawned).toHaveLength(2);
    } finally {
      reg.detach();
      await reg.killAll();
    }
  });

  it('killAll() kills live sessions and rejects queued asks with disposed', async () => {
    const { reg, spawned } = makeRegistry({ auto: false });
    const s = await reg.acquire({ name: 'bye' });
    const p1 = s.ask('running');
    const p2 = s.ask('queued');
    await flush();
    expect(await reg.killAll()).toBe(1);
    await expect(p1).rejects.toMatchObject({ code: 'session_died' });
    await expect(p2).rejects.toMatchObject({ code: 'disposed' });
    expect(spawned[0].prompts).toEqual(['running']);
    expect(reg.getSessionIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orphan sweep (§3)
// ---------------------------------------------------------------------------

describe('sweepStealthOrphans', () => {
  let sessionsDir: string;
  let internalRoot: string;
  beforeEach(() => {
    const root = mkdtempSync(join(TMP, 'sweep-'));
    sessionsDir = join(root, 'sessions');
    internalRoot = furyInternalPath('x').replace(/[\\/]x$/, '');
    mkdirSync(sessionsDir, { recursive: true });
    rmSync(internalRoot, { recursive: true, force: true });
  });

  const pidFile = (pid: number, cwd: string, startedAt = 1) =>
    writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId: `s${pid}`, cwd, startedAt }));

  it('kills provable internal orphans, removes stale files, spares everything else', async () => {
    const internal = (n: string) => join(internalRoot, n);
    for (const n of ['orphan', 'attached', 'mine', 'dead', 'unused']) mkdirSync(internal(n), { recursive: true });
    pidFile(101, internal('orphan'));             // alive, parent dead → kill
    pidFile(102, internal('attached'));           // alive, live parent (other Fury) → spare
    pidFile(103, internal('mine'));               // owned by this registry → spare
    pidFile(104, internal('dead'));               // pid dead → stale file removed
    pidFile(105, '/Users/me/project');            // not internal → never touched
    pidFile(106, internal('orphan'), Date.now() + 1e6); // newer than us → spare
    const killed: number[] = [];
    const r = await sweepStealthOrphans({
      sessionsDir,
      internalRoot,
      ownedPids: new Set([103]),
      alive: (pid) => pid !== 104 && pid !== 9001,
      parentOf: async (pid) => (pid === 101 ? 9001 : 4242),
      kill: (pid) => { killed.push(pid); },
      processStartedAt: 1000,
    });
    expect(killed).toEqual([101]);
    expect(r).toMatchObject({ killed: 1, staleFiles: 1 });
    expect(readdirSync(sessionsDir).sort()).toEqual(['102.json', '103.json', '105.json', '106.json']);
    // Dirs in use by a spared process survive; the rest are cleared.
    expect(readdirSync(internalRoot).sort()).toEqual(['attached', 'mine', 'orphan']);
  });

  it('never deletes a live session\'s dir when its PID file records the cwd in another form', async () => {
    mkdirSync(join(internalRoot, 'linked'), { recursive: true });
    mkdirSync(join(internalRoot, 'cased'), { recursive: true });
    mkdirSync(join(internalRoot, 'unused'), { recursive: true });
    // Same dir reached through a symlink: fails the lexical internal test.
    const link = join(TMP, `link-${Date.now()}`);
    symlinkSync(internalRoot, link);
    pidFile(201, join(link, 'linked'));
    // Case-different path (macOS/Windows fold case; elsewhere it's a distinct path).
    if (process.platform === 'darwin' || process.platform === 'win32') {
      pidFile(202, join(internalRoot, 'CASED'));
    } else {
      mkdirSync(join(internalRoot, 'CASED'));
      pidFile(202, join(internalRoot, 'CASED'));
    }
    const killed: number[] = [];
    await sweepStealthOrphans({
      sessionsDir, internalRoot, ownedPids: new Set(),
      alive: () => true,
      parentOf: async () => 4242,                 // live parent → spared
      kill: (pid) => { killed.push(pid); },
      processStartedAt: 1000,
    });
    expect(killed).toEqual([]);
    const left = readdirSync(internalRoot);
    expect(left).toContain('linked');
    expect(left.some((n) => n.toLowerCase() === 'cased')).toBe(true);
    expect(left).not.toContain('unused');
  });
});
