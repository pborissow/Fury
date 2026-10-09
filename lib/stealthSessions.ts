/**
 * Stealth sessions — hidden, Fury-owned background Claude sessions as reusable
 * infrastructure. See docs/ticket-stealth-sessions.md.
 *
 *   const librarian = await stealthSessions.acquire({
 *     name: 'ask-search',            // registry key; one warm session per name
 *     model: 'haiku',
 *     agent: 'transcript-searcher',  // <repo>/.claude/agents/<name>.md, or inline
 *     mcpServers: () => ({ transcripts: transcriptsServer(getDb) }),
 *     recycle: { maxTurns: 20, maxContextTokens: 50_000 },
 *     idleKillMs: 10 * 60_000,
 *   });
 *   const { text } = await librarian.ask(question, { onToolEvent, signal });
 *
 * WHY THIS IS NOT BUILT ON sdkSessionManager. That manager is a USER-session
 * engine: every turn emits eventBus events (the sidebar, dots, pills, stream
 * buffers all listen), appends history.jsonl, persists a transcript, and hydrates
 * per-session model/metadata from the archive DB. Routing an invisible session
 * through it would mean threading a "but not this one" check through dozens of
 * emit sites, with a leak waiting for every future one. Instead this module talks
 * to `query()` directly and emits NOTHING on the bus, so every event-driven
 * surface is blind to stealth sessions by construction. It reuses the manager's
 * extracted primitives (sdkInputStream, processOwnership) rather than its state.
 *
 * THE HIDING CONTRACT (§2). Disk-derived surfaces can't be hidden by
 * construction, because the CLI itself writes some state. Verified empirically
 * (scripts/probe-stealth-session.mjs, CLI 2.1.281):
 *   - `persistSession: false` → NO transcript under ~/.claude/projects, so nothing
 *     for the archiver → search, Stats session rows, and the history DB-merge
 *     never see one. (The archiver ALSO refuses internal cwds — belt and braces
 *     for a future consumer that opts into persistence.)
 *   - history.jsonl is never written by the SDK path (Fury's manager writes it by
 *     hand; that writer refuses internal cwds too).
 *   - A PID file IS written to ~/.claude/sessions/<pid>.json with `cwd` set to
 *     our internal path. liveSessionScanner drops entries whose cwd
 *     isInternalProject(), and the live-set computation also subtracts
 *     getSessionIds() (ids, for surfaces that only see ids).
 *
 * SAFETY DEFAULTS (§4) — an invisible session is the LEAST capable kind:
 *   - `tools: []`: no built-in tools at all unless the consumer lists them in
 *     `builtinTools` (AskUserQuestion is refused even then).
 *   - `strictMcpConfig`: only the consumer's MCP servers, never the user's.
 *   - `settingSources: []`: no user/project settings, so no user hooks, plugins,
 *     CLAUDE.md, or permission rules leak in. The user's PROVIDER settings (env,
 *     credential helpers) are passed through explicitly so a Bedrock failover
 *     still applies, and stealth sessions recycle on `provider:switched`.
 *   - `permissionMode: 'dontAsk'` + an explicit `allowedTools`: anything not
 *     pre-approved is DENIED by the CLI (reported in the result's
 *     permission_denials), never routed to a prompt nobody could answer. No
 *     canUseTool callback exists, so there is nothing that could park.
 *   - Per-ask timeout → interrupt; if the interrupt doesn't land, kill.
 */

import {
  query as sdkQuery,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInputStream, type InputStream } from './sdkInputStream';
import { furyInternalPath, furyInternalRoot, isInternalProject, isSameOrUnderLoose, isValidInternalName } from './furyHome';
import { pidAlive, parentPidOf, isProvableOrphan } from './processOwnership';
import { eventBus, type AppEvent } from './eventBus';
import { log } from './logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An agent definition passed inline (instead of by file name). */
export type StealthAgent = AgentDefinition & { name: string };

export interface StealthConfig {
  /** Registry key and cwd segment (~/.fury/internal/<name>). /^[a-z0-9][a-z0-9-]*$/ */
  name: string;
  /**
   * Human-readable name shown to users wherever this agent surfaces — today the
   * Stats panel's spend line ("Search agent"). Defaults to the name humanized
   * ("ask-search" → "Ask search"). Stored with every usage row, so Stats can
   * name past spend even when the agent isn't running.
   */
  label?: string;
  /**
   * Model alias or id. Overrides the agent file's `model:` when both are set.
   * A bare family alias ('haiku', 'sonnet', …), here or in the agent file, is
   * resolved at acquire() to the newest version in Fury's model catalog, and a
   * newer release recycles the warm session onto it.
   */
  model?: string;
  /**
   * Main-thread agent: a file name resolved to `<agentsDir>/<agent>.md`
   * (frontmatter: description, tools, model, …; body = system prompt), or an
   * inline definition. Its `tools:` can only NARROW what's allowed below.
   */
  agent?: string | StealthAgent;
  /** Directory holding agent .md files. Default: `<process.cwd()>/.claude/agents`. */
  agentsDir?: string;
  /** System prompt when no agent is used. */
  systemPrompt?: string;
  /**
   * In-process MCP servers (createSdkMcpServer). Prefer the FACTORY form: an
   * in-process server instance binds to one transport, and every recycle spawns a
   * fresh query, so a factory guarantees each spawn gets an unbound instance.
   */
  mcpServers?: Record<string, McpServerConfig> | (() => Record<string, McpServerConfig>);
  /**
   * Explicit allowlist (pre-approved, everything else denied). Default: every
   * tool on every server in `mcpServers` (`mcp__<server>`) plus `builtinTools`.
   */
  allowedTools?: string[];
  /** Built-in Claude Code tools to enable (e.g. ['Read','Grep']). Default: none. */
  builtinTools?: string[];
  /** Recycle (kill → fresh spawn on next ask) when either threshold is crossed. */
  recycle?: { maxTurns?: number; maxContextTokens?: number };
  /** Kill the warm process after this long unused. Default 10 min. */
  idleKillMs?: number;
  /** Default per-ask budget. Default 60 s. */
  askTimeoutMs?: number;
  /**
   * Structured output: every turn ends by emitting JSON matching this schema
   * (validated by the CLI, which retries the model on a mismatch). Surfaced as
   * AskResult.structured. A turn that can't produce valid output fails with
   * result_error / subtype 'error_max_structured_output_retries'.
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

export type StealthToolEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean };

export interface AskOptions {
  signal?: AbortSignal;
  /** Overrides the consumer's askTimeoutMs for this ask. */
  timeoutMs?: number;
  onToolEvent?: (e: StealthToolEvent) => void;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface AskResult {
  text: string;
  /** The stealth session that served the ask (never a user-visible id). */
  sessionId: string;
  durationMs: number;
  /** Agentic round-trips inside this ask. */
  numTurns: number;
  /** SDK-estimated spend for THIS ask (delta of the cumulative total). */
  costUsd: number;
  usage: TokenUsage;
  /** Tools the CLI refused (fail-closed evidence; see §4). */
  permissionDenials: { toolName: string; toolUseId: string }[];
  /** Schema-validated output when the consumer set `outputFormat`; else undefined. */
  structured?: unknown;
}

export type StealthErrorCode = 'timeout' | 'aborted' | 'session_died' | 'result_error' | 'disposed';

export class StealthAskError extends Error {
  constructor(
    public readonly code: StealthErrorCode,
    message: string,
    public readonly detail?: { subtype?: string; partialText?: string },
  ) {
    super(message);
    this.name = 'StealthAskError';
  }
}

export interface StealthSession {
  readonly name: string;
  ask(prompt: string, opts?: AskOptions): Promise<AskResult>;
  /** Kill this consumer's warm process now (the next ask respawns it). */
  release(): Promise<void>;
}

/** Diagnostic snapshot (never exposes prompts or content). */
export interface StealthStatus {
  name: string;
  label: string;
  sessionId: string | null;
  alive: boolean;
  busy: boolean;
  queued: number;
  model: string | null;
  turns: number;
  contextTokens: number;
  spawns: number;
  lastUsedAt: number | null;
  lifetimeCostUsd: number;
}

/** One deduped assistant API call, as persisted for Stats (§5). */
export interface StealthUsageRow extends TokenUsage {
  consumer: string;
  /** Human-readable consumer label at the time of the call. */
  label: string;
  sessionId: string;
  messageId: string;
  model: string | null;
  ts: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_KILL_MS = 10 * 60_000;
const DEFAULT_ASK_TIMEOUT_MS = 60_000;
/** After an interrupt, how long to wait for the turn's `result` before killing. */
const INTERRUPT_GRACE_MS = 5_000;
/** After abort(), how long before SIGKILLing any of our pids still alive. */
const KILL_GRACE_MS = 3_000;
/** Settings keys that select/authenticate the PROVIDER — the only user settings
 *  a stealth session inherits (see header). */
const PROVIDER_SETTING_KEYS = [
  'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper',
] as const;

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

interface ModelUsageTotals { input: number; output: number; cacheRead: number; cacheCreation: number }

/** modelUsage keys carry a context-variant suffix ('claude-opus-4-8[1m]'); messages don't. */
function modelKey(model: string | null): string {
  return (model ?? 'unknown').replace(/\[[^\]]*\]$/, '');
}

/** The CLI's internal tool that carries `outputFormat` results (observed name, CLI 2.1.281). */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * Parse a Claude Code agent file: `---` YAML-ish frontmatter + markdown body.
 * Supports the subset agent files actually use — `key: value`, comma lists
 * (`tools: a, b`), flow lists (`[a, b]`) and block lists (`- a`). No yaml dep.
 */
export function parseAgentMarkdown(md: string, fallbackName: string): StealthAgent {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error(`Agent "${fallbackName}": missing --- frontmatter ---`);
  const fm: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fm[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { fm[key] = []; listKey = key; continue; }
    listKey = null;
    fm[key] = unquote(value);
  }
  const str = (k: string) => (typeof fm[k] === 'string' ? (fm[k] as string) : undefined);
  const list = (k: string): string[] | undefined => {
    const v = fm[k];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.filter(Boolean);
    const inner = v.replace(/^\[(.*)\]$/, '$1');
    return inner.split(',').map((t) => unquote(t.trim())).filter(Boolean);
  };
  const prompt = m[2].trim();
  if (!prompt) throw new Error(`Agent "${fallbackName}": empty system prompt body`);
  const def: StealthAgent = {
    name: str('name') || fallbackName,
    description: str('description') || `Fury internal agent ${fallbackName}`,
    prompt,
  };
  const tools = list('tools');
  if (tools) def.tools = tools;
  const disallowed = list('disallowedTools');
  if (disallowed) def.disallowedTools = disallowed;
  const model = str('model');
  if (model) def.model = model;
  return def;
}

/** The user-facing name for a consumer: its `label`, else the name humanized. */
export function stealthLabel(config: Pick<StealthConfig, 'name' | 'label'>): string {
  const l = config.label?.trim();
  if (l) return l;
  const words = config.name.replace(/-+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Resolve `config.agent` to a definition (reads the file for a name). */
export function resolveAgent(config: StealthConfig): StealthAgent | null {
  if (!config.agent) return null;
  if (typeof config.agent !== 'string') return config.agent;
  if (!/^[A-Za-z0-9][\w-]*$/.test(config.agent)) throw new Error(`Invalid agent name "${config.agent}"`);
  const dir = config.agentsDir ?? join(process.cwd(), '.claude', 'agents');
  const file = join(dir, `${config.agent}.md`);
  return parseAgentMarkdown(readFileSync(file, 'utf8'), config.agent);
}

/** The user's provider-selecting settings from ~/.claude/settings.json (env +
 *  credential helpers). Anything else — hooks, permissions, plugins — is dropped. */
export function readProviderSettings(
  read: () => string = () => readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'),
): { env: Record<string, string>; helpers: Record<string, string> } {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(read()); } catch { /* absent/corrupt → defaults */ }
  const env: Record<string, string> = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  const helpers: Record<string, string> = {};
  for (const k of PROVIDER_SETTING_KEYS) if (typeof raw[k] === 'string') helpers[k] = raw[k] as string;
  return { env, helpers };
}

/**
 * Build the query() options for a stealth spawn. PURE (all inputs explicit) so
 * the safety defaults are unit-testable without spawning anything. Tests pin:
 * persistSession:false, settingSources:[], tools allowlist, strictMcpConfig,
 * dontAsk, AskUserQuestion disallowed, internal cwd, no canUseTool.
 */
export function buildStealthOptions(args: {
  config: StealthConfig;
  agent: StealthAgent | null;
  mcpServers: Record<string, McpServerConfig>;
  cwd: string;
  sessionId: string;
  abortController: AbortController;
  provider: { env: Record<string, string>; helpers: Record<string, string> };
  baseEnv?: Record<string, string | undefined>;
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess'];
}): Options {
  const { config, agent, mcpServers, cwd, sessionId, abortController, provider } = args;
  const builtins = (config.builtinTools ?? []).filter((t) => t !== 'AskUserQuestion');
  const allowedTools = (config.allowedTools ?? [
    ...Object.keys(mcpServers).map((s) => `mcp__${s}`),
    ...builtins,
  ]).filter((t) => t !== 'AskUserQuestion');

  const options: Options = {
    abortController,
    cwd,
    sessionId,
    // Invisible: no transcript on disk (the archiver/search/history root).
    persistSession: false,
    // Least capable: only what the consumer passed.
    tools: builtins,
    allowedTools,
    disallowedTools: ['AskUserQuestion'],
    mcpServers,
    strictMcpConfig: true,
    settingSources: [],
    // Inline flag-layer settings: provider credential helpers only, and no hooks
    // (a user Stop/Notification hook must not fire for an invisible session).
    settings: { ...provider.helpers, disableAllHooks: true } as Options['settings'],
    env: {
      ...(args.baseEnv ?? process.env),
      ...provider.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: `fury-stealth/${config.name}`,
    },
    // Non-interactive: unapproved tools are denied by the CLI, never prompted.
    permissionMode: 'dontAsk',
    // ON for accounting, not for UI: an `assistant` message's usage is a
    // snapshot taken at message START (output_tokens ≈ 1-10). The final output
    // count only arrives in the `message_delta` stream event. Off, output was
    // undercounted up to ~400× (observed 2026-10-08).
    includePartialMessages: true,
  };
  if (agent) {
    const { name, ...def } = agent;
    if (config.model) def.model = config.model;
    // An agent `tools:` allowlist also hides the CLI's StructuredOutput carrier,
    // and then the model can't emit the schema'd answer at all; it writes the
    // fields as prose and the CLI still reports success (observed 2026-10-08).
    if (config.outputFormat && def.tools && !def.tools.includes(STRUCTURED_OUTPUT_TOOL)) {
      def.tools = [...def.tools, STRUCTURED_OUTPUT_TOOL];
    }
    options.agents = { [name]: def };
    options.agent = name;
  } else if (config.systemPrompt) {
    options.systemPrompt = config.systemPrompt;
  }
  if (config.model) options.model = config.model;
  if (config.outputFormat) options.outputFormat = config.outputFormat;
  if (args.spawnClaudeCodeProcess) options.spawnClaudeCodeProcess = args.spawnClaudeCodeProcess;
  return options;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The slice of the SDK Query this module uses — the unit-test seam. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
}

export interface RegistryDeps {
  query: (args: { prompt: AsyncIterable<unknown>; options: Options }) => QueryLike;
  /** Persist usage rows for Stats. Default: INSERT into fury.db internal_usage. */
  recordUsage: (rows: StealthUsageRow[]) => Promise<void>;
  readProviderSettings: () => { env: Record<string, string>; helpers: Record<string, string> };
  /** Family alias → newest catalog id (default: lib/modelCatalog resolveModelAlias). */
  resolveModel: (model: string) => Promise<string>;
  /** Whether to spawn via our pid-tracking hook (off in tests: nothing real spawns). */
  trackPids: boolean;
  now: () => number;
}

interface PendingAsk {
  prompt: string;
  opts: AskOptions;
  resolve: (r: AskResult) => void;
  reject: (e: Error) => void;
  /** Detach the queued-abort listener. Called the moment the ask leaves the
   *  queue (dequeued to run, aborted, or disposed): a caller may reuse one
   *  long-lived signal across many asks, and a listener left behind per ask
   *  would pile up (and pin each ask's prompt) for that signal's lifetime. */
  detach: () => void;
}

interface ActiveTurn {
  startedAt: number;
  text: string[];
  usageByMsg: Map<string, { model: string | null; usage: TokenUsage }>;
  /** Final output_tokens per message id, from `message_delta` stream events. */
  finalOutput: Map<string, number>;
  /** Message id of the API response currently streaming (from message_start). */
  streamMsgId: string | null;
  /** tool_use ids of the CLI's internal StructuredOutput carrier, so their
   *  tool_result is hidden from onToolEvent along with the call itself. */
  internalToolIds: Set<string>;
  onToolEvent?: (e: StealthToolEvent) => void;
  settle: (msg: SDKMessage | null, err?: Error) => void;
}

interface Live {
  sessionId: string;
  q: QueryLike;
  input: InputStream;
  abortController: AbortController;
  pids: Set<number>;
  dead: boolean;
  turns: number;
  contextTokens: number;
  /** Cumulative SDK cost reported by the last result (for per-ask deltas). */
  costCursor: number;
  /** Last cumulative result.modelUsage per model (for per-turn deltas). */
  modelUsageCursor: Map<string, ModelUsageTotals>;
  turn: ActiveTurn | null;
}

interface Entry {
  config: StealthConfig;
  /** Fingerprint of the spawn-relevant config; a change forces a recycle. */
  fingerprint: string;
  live: Live | null;
  queue: PendingAsk[];
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  /** Set when a threshold/config/provider change means "respawn before next ask". */
  recycleRequested: boolean;
  spawns: number;
  lastUsedAt: number | null;
  lifetimeCostUsd: number;
}

function fingerprintOf(c: StealthConfig): string {
  return JSON.stringify({
    model: c.model ?? null,
    agent: typeof c.agent === 'string' ? c.agent : c.agent ? { ...c.agent } : null,
    agentsDir: c.agentsDir ?? null,
    systemPrompt: c.systemPrompt ?? null,
    allowedTools: c.allowedTools ?? null,
    builtinTools: c.builtinTools ?? null,
    outputFormat: c.outputFormat ?? null,
  });
}

export class StealthSessionRegistry {
  private entries = new Map<string, Entry>();
  private readonly deps: RegistryDeps;
  private readonly onBusEvent = (e: AppEvent) => {
    // A warm process keeps talking to the provider it was spawned under, so a
    // failover must respawn stealth sessions too (mirrors the user-session
    // recycle in /api/claude-sdk/recycle).
    if (e.type === 'provider:switched') this.recycleAll('provider switched');
  };

  constructor(deps?: Partial<RegistryDeps>) {
    this.deps = {
      query: (a) => sdkQuery(a as Parameters<typeof sdkQuery>[0]) as unknown as QueryLike,
      recordUsage: defaultRecordUsage,
      readProviderSettings: () => readProviderSettings(),
      resolveModel: async (m) => (await import('./modelCatalog')).resolveModelAlias(m),
      trackPids: true,
      now: () => Date.now(),
      ...deps,
    };
  }

  /** Subscribe to app events (provider switches). Called for the singleton. */
  attach(): void { eventBus.onApp(this.onBusEvent); }
  detach(): void { eventBus.offApp(this.onBusEvent); }

  /**
   * Get (lazily spawning) the warm session for `config.name`. Repeat calls with
   * the same name reuse it; a changed model/agent/tool config takes effect on
   * the next ask via a recycle. MCP servers/limits update in place.
   */
  async acquire(config: StealthConfig): Promise<StealthSession> {
    if (!isValidInternalName(config.name)) {
      throw new Error(`Invalid stealth-session name "${config.name}"`);
    }
    if (config.label !== undefined && (!config.label.trim() || config.label.length > 60)) {
      throw new Error(`Invalid stealth-session label for "${config.name}" (1-60 chars)`);
    }
    // Resolve the agent eagerly so a missing/malformed file fails at acquire(),
    // not on some later user's first question.
    const agent = resolveAgent(config);
    // Pin the concrete model now ('haiku' → 'claude-haiku-5-5'). It feeds the
    // fingerprint below, so a newer catalog entry recycles the session onto it.
    const requested = config.model ?? agent?.model;
    if (requested) config = { ...config, model: await this.deps.resolveModel(requested) };
    // Fingerprint the agent's CONTENT, not just its file name: editing the
    // agent file (prompt tuning) must reach a warm session on its next ask.
    const fp = fingerprintOf(agent ? { ...config, agent } : config);
    let e = this.entries.get(config.name);
    if (!e) {
      e = {
        config, fingerprint: fp, live: null, queue: [], busy: false, idleTimer: null,
        recycleRequested: false, spawns: 0, lastUsedAt: null, lifetimeCostUsd: 0,
      };
      this.entries.set(config.name, e);
    } else {
      if (e.fingerprint !== fp) e.recycleRequested = true;
      e.config = config;
      e.fingerprint = fp;
    }
    // Pre-warm: pay the CLI boot now, while the caller is still composing.
    if (!e.busy && (!e.live || e.live.dead || e.recycleRequested)) this.respawn(e);
    this.armIdle(e);
    const name = config.name;
    return {
      name,
      ask: (prompt, opts) => this.ask(name, prompt, opts),
      release: () => this.release(name),
    };
  }

  /** Queue a request/response turn on the consumer's session (serialized). */
  ask(name: string, prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`No stealth session "${name}" — acquire() first`));
    if (opts.signal?.aborted) return Promise.reject(new StealthAskError('aborted', 'Aborted before start'));
    return new Promise<AskResult>((resolve, reject) => {
      // A queued ask whose signal fires is simply dropped from the queue. Once
      // it starts running, runTurn owns abort handling with its own listener.
      const onQueuedAbort = () => {
        const i = e.queue.indexOf(pending);
        if (i >= 0) {
          e.queue.splice(i, 1);
          reject(new StealthAskError('aborted', 'Aborted while queued'));
        }
      };
      const pending: PendingAsk = {
        prompt, opts, resolve, reject,
        detach: () => opts.signal?.removeEventListener('abort', onQueuedAbort),
      };
      opts.signal?.addEventListener('abort', onQueuedAbort, { once: true });
      e.queue.push(pending);
      void this.pump(e);
    });
  }

  private async pump(e: Entry): Promise<void> {
    if (e.busy) return;
    const next = e.queue.shift();
    if (!next) return;
    next.detach();
    e.busy = true;
    this.clearIdle(e);
    try {
      next.resolve(await this.runTurn(e, next));
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      e.busy = false;
      e.lastUsedAt = this.deps.now();
      this.maybeRecycleAfterTurn(e);
      if (e.queue.length) void this.pump(e);
      else this.armIdle(e);
    }
  }

  private runTurn(e: Entry, req: PendingAsk): Promise<AskResult> {
    if (!e.live || e.live.dead || e.recycleRequested) this.respawn(e);
    const live = e.live!;
    const timeoutMs = req.opts.timeoutMs ?? e.config.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

    return new Promise<AskResult>((resolve, reject) => {
      let stopping: StealthErrorCode | null = null;
      let timer: NodeJS.Timeout | null = null;
      let graceTimer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        req.opts.signal?.removeEventListener('abort', onAbort);
        if (live.turn === turn) live.turn = null;
      };

      const turn: ActiveTurn = {
        startedAt: this.deps.now(),
        text: [],
        usageByMsg: new Map(),
        internalToolIds: new Set(),
        finalOutput: new Map(),
        streamMsgId: null,
        onToolEvent: req.opts.onToolEvent,
        settle: (msg, err) => {
          cleanup();
          // Spend is recorded whatever the outcome — an aborted ask still cost money.
          const usage = this.flushUsage(e, live, turn, msg);
          const partialText = turn.text.join('');
          if (err || !msg || msg.type !== 'result') {
            reject(stopping
              ? new StealthAskError(stopping, stopping === 'timeout' ? `Ask exceeded ${timeoutMs} ms` : 'Ask aborted', { partialText })
              : new StealthAskError('session_died', err?.message ?? 'Stealth session ended mid-ask', { partialText }));
            return;
          }
          const r = msg as SDKMessage & {
            subtype: string; is_error: boolean; result?: string; num_turns: number;
            total_cost_usd: number; permission_denials?: { tool_name: string; tool_use_id: string }[];
            structured_output?: unknown;
          };
          live.turns++;
          const cumulative = num(r.total_cost_usd);
          const costUsd = Math.max(0, cumulative - live.costCursor);
          live.costCursor = cumulative;
          e.lifetimeCostUsd += costUsd;
          if (stopping) {
            reject(new StealthAskError(stopping, stopping === 'timeout' ? `Ask exceeded ${timeoutMs} ms` : 'Ask aborted', { partialText }));
            return;
          }
          if (r.subtype !== 'success' || r.is_error) {
            reject(new StealthAskError('result_error', `Stealth turn failed (${r.subtype})${r.result ? `: ${r.result}` : ''}`, { subtype: r.subtype, partialText }));
            return;
          }
          // The CLI can report success without ever emitting the structured
          // output it was asked for. With outputFormat set that's a failure,
          // not an answer.
          if (e.config.outputFormat && r.structured_output === undefined) {
            reject(new StealthAskError('result_error', 'Turn ended without the requested structured output', {
              subtype: 'missing_structured_output', partialText: typeof r.result === 'string' ? r.result : partialText,
            }));
            return;
          }
          resolve({
            text: typeof r.result === 'string' ? r.result : partialText,
            sessionId: live.sessionId,
            durationMs: this.deps.now() - turn.startedAt,
            numTurns: num(r.num_turns),
            costUsd,
            usage,
            permissionDenials: (r.permission_denials ?? []).map((d) => ({ toolName: d.tool_name, toolUseId: d.tool_use_id })),
            ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}),
          });
        },
      };

      // Stop = interrupt (keeps the warm process), then wait briefly for the
      // interrupted turn's own `result` so it can't leak into the NEXT ask. If it
      // never lands, the process is wedged → kill it (next ask respawns).
      const stop = (code: StealthErrorCode) => {
        if (stopping) return;
        stopping = code;
        log.info('stealth', `ask ${code}; interrupting`, { data: { name: e.config.name, sessionId: live.sessionId } });
        live.q.interrupt().catch(() => { /* fall through to the grace kill */ });
        graceTimer = setTimeout(() => {
          this.killLive(e, live, `${code}: interrupt did not settle`);
        }, INTERRUPT_GRACE_MS);
        graceTimer.unref?.();
      };
      const onAbort = () => stop('aborted');
      req.opts.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      timer.unref?.();

      live.turn = turn;
      live.input.push({
        type: 'user',
        message: { role: 'user', content: req.prompt },
        parent_tool_use_id: null,
        session_id: live.sessionId,
      } as never);
    });
  }

  /**
   * Persist this turn's usage; return its totals. Never throws.
   *
   * Two sources, reconciled:
   *   1. Per API request (one row per message id): input/cache from the
   *      assistant snapshot (final at message start), output from message_delta.
   *      Per-request rows keep each prompt's size, which tiered pricing needs.
   *   2. result.modelUsage, the CLI's own cumulative per-model tally. Its
   *      per-turn delta also covers calls that never stream to us, e.g. the CLI's
   *      small auxiliary model call per query. Whatever (2) has beyond (1) is
   *      recorded as one `aux:` row per model, so recorded totals always match
   *      what the CLI says was spent. (No result, e.g. a killed turn → (1) only.)
   */
  private flushUsage(e: Entry, live: Live, turn: ActiveTurn, resultMsg: SDKMessage | null): TokenUsage {
    const total: TokenUsage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    const rows: StealthUsageRow[] = [];
    const ts = new Date(this.deps.now()).toISOString();
    const base = { consumer: e.config.name, label: stealthLabel(e.config), sessionId: live.sessionId, ts };
    const perModel = new Map<string, ModelUsageTotals>();
    for (const [messageId, { model, usage }] of turn.usageByMsg) {
      rows.push({ ...base, messageId, model, ...usage });
      const k = modelKey(model);
      const t = perModel.get(k) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      t.input += usage.input; t.output += usage.output; t.cacheRead += usage.cacheRead;
      t.cacheCreation += usage.cacheWrite5m + usage.cacheWrite1h;
      perModel.set(k, t);
    }
    turn.usageByMsg.clear();

    const mu = (resultMsg as { modelUsage?: Record<string, Record<string, unknown>> } | null)?.modelUsage;
    if (mu && typeof mu === 'object') {
      for (const [rawModel, v] of Object.entries(mu)) {
        const k = modelKey(rawModel);
        const cum: ModelUsageTotals = {
          input: num(v.inputTokens), output: num(v.outputTokens),
          cacheRead: num(v.cacheReadInputTokens), cacheCreation: num(v.cacheCreationInputTokens),
        };
        const prev = live.modelUsageCursor.get(k) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        live.modelUsageCursor.set(k, cum);
        const seen = perModel.get(k) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        const residual = {
          input: Math.max(0, cum.input - prev.input - seen.input),
          output: Math.max(0, cum.output - prev.output - seen.output),
          cacheRead: Math.max(0, cum.cacheRead - prev.cacheRead - seen.cacheRead),
          cacheCreation: Math.max(0, cum.cacheCreation - prev.cacheCreation - seen.cacheCreation),
        };
        if (residual.input + residual.output + residual.cacheRead + residual.cacheCreation > 0) {
          rows.push({
            ...base, messageId: `aux:${live.turns}:${k}`, model: k,
            input: residual.input, output: residual.output, cacheRead: residual.cacheRead,
            // modelUsage doesn't split cache writes by TTL; same convention as
            // the transcript parser for unsplit totals: 1h (CLI default).
            cacheWrite5m: 0, cacheWrite1h: residual.cacheCreation,
          });
        }
      }
    }

    for (const r of rows) {
      total.input += r.input; total.output += r.output;
      total.cacheWrite5m += r.cacheWrite5m; total.cacheWrite1h += r.cacheWrite1h;
      total.cacheRead += r.cacheRead;
    }
    if (rows.length) {
      this.deps.recordUsage(rows).catch((err) =>
        log.warn('stealth', 'usage record failed', { data: { name: e.config.name, error: String(err) } }));
    }
    return total;
  }


  private maybeRecycleAfterTurn(e: Entry): void {
    const live = e.live;
    if (!live || live.dead) return;
    const { maxTurns, maxContextTokens } = e.config.recycle ?? {};
    const reason =
      e.recycleRequested ? 'recycle requested'
      : maxTurns && live.turns >= maxTurns ? `maxTurns ${maxTurns}`
      : maxContextTokens && live.contextTokens >= maxContextTokens ? `context ${live.contextTokens} >= ${maxContextTokens}`
      : null;
    // Kill now (frees the process); the next ask spawns fresh. Bounded context
    // growth overall, continuity within a working burst.
    if (reason) this.killLive(e, live, reason);
  }

  private respawn(e: Entry): void {
    if (e.live && !e.live.dead) this.killLive(e, e.live, 'respawn');
    e.recycleRequested = false;
    const cwd = furyInternalPath(e.config.name);
    mkdirSync(cwd, { recursive: true });
    const sessionId = randomUUID();
    const input = createInputStream();
    const abortController = new AbortController();
    const pids = new Set<number>();
    const mcp = e.config.mcpServers;
    const options = buildStealthOptions({
      config: e.config,
      agent: resolveAgent(e.config),
      mcpServers: (typeof mcp === 'function' ? mcp() : mcp) ?? {},
      cwd,
      sessionId,
      abortController,
      provider: this.deps.readProviderSettings(),
      spawnClaudeCodeProcess: this.deps.trackPids ? trackedSpawn(pids, e.config.name, sessionId) : undefined,
    });
    const q = this.deps.query({ prompt: input.stream, options });
    const live: Live = {
      sessionId, q, input, abortController, pids, dead: false,
      turns: 0, contextTokens: 0, costCursor: 0, modelUsageCursor: new Map(), turn: null,
    };
    e.live = live;
    e.spawns++;
    log.info('stealth', 'spawned', { data: { name: e.config.name, sessionId, model: e.config.model ?? null } });
    void this.consume(e, live);
  }

  private async consume(e: Entry, live: Live): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const msg of live.q) {
        if (live.dead) break;
        this.handle(live, msg);
      }
    } catch (err) {
      if (!live.abortController.signal.aborted) {
        failure = err instanceof Error ? err : new Error(String(err));
        log.warn('stealth', 'query threw', { data: { name: e.config.name, error: failure.message } });
      }
    } finally {
      live.dead = true;
      live.turn?.settle(null, failure ?? new Error('Stealth session ended'));
      if (e.live === live) e.live = null;
    }
  }

  private handle(live: Live, msg: SDKMessage): void {
    const turn = live.turn;
    if (!turn) return; // between asks (e.g. init) — nothing is listening
    const m = msg as unknown as {
      type: string;
      parent_tool_use_id?: string | null;
      message?: { id?: string; model?: string; content?: unknown; usage?: Record<string, unknown> };
    };
    if (m.type === 'stream_event') {
      // Accounting only (see includePartialMessages): learn each response's
      // FINAL output_tokens from its message_delta.
      const ev = (msg as unknown as { event?: { type?: string; message?: { id?: string }; usage?: Record<string, unknown> } }).event;
      if (ev?.type === 'message_start') turn.streamMsgId = ev.message?.id ?? null;
      else if (ev?.type === 'message_delta' && turn.streamMsgId && ev.usage) {
        const id = turn.streamMsgId;
        const out = Math.max(num(ev.usage.output_tokens), turn.finalOutput.get(id) ?? 0);
        turn.finalOutput.set(id, out);
        const rec = turn.usageByMsg.get(id);
        if (rec) rec.usage.output = Math.max(rec.usage.output, out);
      }
      return;
    }
    if (m.type === 'assistant' && m.message) {
      const content = Array.isArray(m.message.content) ? m.message.content : [];
      for (const b of content as { type: string; id?: string; name?: string; input?: unknown; text?: string }[]) {
        if (b.type === 'tool_use') {
          // outputFormat's carrier tool is plumbing, not work the consumer
          // asked for: keep it out of progress UIs.
          if (b.name === STRUCTURED_OUTPUT_TOOL) { if (b.id) turn.internalToolIds.add(b.id); continue; }
          safeCall(turn.onToolEvent, { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input });
        }
        else if (b.type === 'text' && !m.parent_tool_use_id && b.text) turn.text.push(b.text);
      }
      const u = m.message.usage;
      if (u && m.message.id) {
        const cc = (u.cache_creation ?? null) as Record<string, unknown> | null;
        const flat = num(u.cache_creation_input_tokens);
        const split = cc && (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number');
        const usage: TokenUsage = {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          // Same attribution as the transcript parser: unsplit → 1h (CLI default TTL).
          cacheWrite5m: split ? num(cc!.ephemeral_5m_input_tokens) : 0,
          cacheWrite1h: split ? num(cc!.ephemeral_1h_input_tokens) : flat,
          cacheRead: num(u.cache_read_input_tokens),
        };
        // Streaming repeats a message's usage per content block, and the
        // snapshot's output is a START-of-message count: never let it lower a
        // final count already learned from message_delta.
        const prior = turn.usageByMsg.get(m.message.id)?.usage.output ?? 0;
        usage.output = Math.max(usage.output, prior, turn.finalOutput.get(m.message.id) ?? 0);
        turn.usageByMsg.set(m.message.id, { model: m.message.model ?? null, usage });
        if (!m.parent_tool_use_id) live.contextTokens = usage.input + flat + usage.cacheRead;
      }
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const b of m.message.content as { type: string; tool_use_id?: string; is_error?: boolean }[]) {
        if (b.type === 'tool_result' && !turn.internalToolIds.has(b.tool_use_id ?? '')) {
          safeCall(turn.onToolEvent, { type: 'tool_result', toolUseId: b.tool_use_id ?? '', isError: !!b.is_error });
        }
      }
    } else if (m.type === 'result') {
      turn.settle(msg);
    }
  }

  private killLive(e: Entry, live: Live, reason: string, immediate = false): void {
    if (live.dead && !live.pids.size) return;
    live.dead = true;
    log.info('stealth', 'kill', { data: { name: e.config.name, sessionId: live.sessionId, reason } });
    try { live.input.end(); } catch { /* best effort */ }
    try { live.abortController.abort(); } catch { /* best effort */ }
    live.turn?.settle(null, new Error(`Stealth session killed (${reason})`));
    if (e.live === live) e.live = null;
    // The SDK's abort terminates the CLI after its own grace; SIGKILL anything
    // of OURS that outlives it and drop its PID file so the scanner stays clean.
    // `immediate` is for shutdown, where the process exits before any timer fires.
    const hardKill = () => {
      for (const pid of live.pids) {
        if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ } }
        removePidFile(pid);
      }
    };
    if (live.pids.size) {
      if (immediate) hardKill();
      else setTimeout(hardKill, KILL_GRACE_MS).unref?.();
    }
  }

  private armIdle(e: Entry): void {
    this.clearIdle(e);
    const ms = e.config.idleKillMs ?? DEFAULT_IDLE_KILL_MS;
    if (!(ms > 0)) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null;
      if (!e.busy && !e.queue.length && e.live) this.killLive(e, e.live, 'idle');
    }, ms);
    e.idleTimer.unref?.();
  }

  private clearIdle(e: Entry): void {
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null; }
  }

  /** Kill the consumer's warm process now; the next ask (or acquire) respawns. */
  async release(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    this.clearIdle(e);
    if (e.live) this.killLive(e, e.live, 'released');
  }

  /** Respawn every consumer before its next ask (provider switch, config reload). */
  recycleAll(reason: string): void {
    for (const e of this.entries.values()) {
      e.recycleRequested = true;
      // Idle sessions die now; a busy one finishes its ask, then recycles.
      if (!e.busy && e.live) this.killLive(e, e.live, reason);
    }
  }

  /** Shutdown: kill everything, reject everything queued. Returns sessions killed. */
  async killAll(): Promise<number> {
    let killed = 0;
    for (const e of this.entries.values()) {
      this.clearIdle(e);
      for (const p of e.queue.splice(0)) { p.detach(); p.reject(new StealthAskError('disposed', 'Stealth registry shut down')); }
      if (e.live) { this.killLive(e, e.live, 'shutdown', true); killed++; }
    }
    return killed;
  }

  /** Ids of every live stealth session — subtracted from the live set (§2). */
  getSessionIds(): string[] {
    const ids: string[] = [];
    for (const e of this.entries.values()) if (e.live && !e.live.dead) ids.push(e.live.sessionId);
    return ids;
  }

  isStealthSessionId(id: string): boolean {
    for (const e of this.entries.values()) if (e.live?.sessionId === id) return true;
    return false;
  }

  list(): StealthStatus[] {
    return [...this.entries.values()].map((e) => ({
      name: e.config.name,
      label: stealthLabel(e.config),
      sessionId: e.live && !e.live.dead ? e.live.sessionId : null,
      alive: !!e.live && !e.live.dead,
      busy: e.busy,
      queued: e.queue.length,
      model: e.config.model ?? null,
      turns: e.live?.turns ?? 0,
      contextTokens: e.live?.contextTokens ?? 0,
      spawns: e.spawns,
      lastUsedAt: e.lastUsedAt,
      lifetimeCostUsd: e.lifetimeCostUsd,
    }));
  }

  /** Every pid this registry currently owns (orphan sweep exclusion). */
  ownedPids(): Set<number> {
    const s = new Set<number>();
    for (const e of this.entries.values()) for (const p of e.live?.pids ?? []) s.add(p);
    return s;
  }
}

function safeCall<T>(fn: ((e: T) => void) | undefined, ev: T): void {
  if (!fn) return;
  try { fn(ev); } catch (err) { log.warn('stealth', 'onToolEvent threw', { data: { error: String(err) } }); }
}

function sessionsDir(): string {
  return join(homedir(), '.claude', 'sessions');
}

function removePidFile(pid: number): void {
  try { rmSync(join(sessionsDir(), `${pid}.json`), { force: true }); } catch { /* best effort */ }
}

/** Spawn the CLI ourselves to record its pid (mirrors sdkSessionManager.startQuery). */
function trackedSpawn(pids: Set<number>, name: string, sessionId: string): Options['spawnClaudeCodeProcess'] {
  return (opts) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      signal: opts.signal,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const child: ChildProcess = spawn(opts.command, opts.args, spawnOpts);
    if (typeof child.pid === 'number') {
      const pid = child.pid;
      pids.add(pid);
      child.once('exit', () => { pids.delete(pid); removePidFile(pid); });
    }
    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString().trim();
      if (t) log.warn('stealth.stderr', t.slice(0, 500), { data: { name, sessionId } });
    });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: (signal) => child.kill(signal),
      on: (event, listener) => { child.on(event, listener as never); },
      once: (event, listener) => { child.once(event, listener as never); },
      off: (event, listener) => { child.off(event, listener as never); },
    };
  };
}

async function defaultRecordUsage(rows: StealthUsageRow[]): Promise<void> {
  const { getDb } = await import('./db');
  const db = await getDb();
  await db.batch(rows.map((r) => ({
    sql: `INSERT OR REPLACE INTO internal_usage
            (consumer, label, session_id, message_id, model, ts, input, output, cache_write_5m, cache_write_1h, cache_read)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.consumer, r.label, r.sessionId, r.messageId, r.model, r.ts, r.input, r.output, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead],
  })), 'write');
}

// ---------------------------------------------------------------------------
// Orphan sweep (§3) — run at boot, before any acquire().
// ---------------------------------------------------------------------------

/** When this Node process started; anything older can't be ours. */
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

export interface SweepDeps {
  sessionsDir: string;
  internalRoot: string;
  ownedPids: Set<number>;
  alive: (pid: number) => boolean;
  parentOf: (pid: number) => Promise<number | null>;
  kill: (pid: number) => void;
  processStartedAt: number;
}

/**
 * Reap stealth leftovers from a previous server life. Only PID files whose cwd
 * is in the internal subtree are considered — that path is Fury-exclusive, so
 * there's no "external terminal shares this id" ambiguity. Still conservative
 * about killing (a second Fury instance sharing FURY_HOME is a real setup):
 *   - dead pid → just remove the stale PID file;
 *   - alive, predates this server, AND provably orphaned (parent dead or init)
 *     → SIGKILL + remove;
 *   - anything else (ours, or attached to a live parent) → spared.
 * Then empties internal/<name>/ dirs that no live process (internal or not, any
 * path form) is using. Age-based pruning is unnecessary: ancestry is the proof
 * (answers §8 Q3).
 */
export async function sweepStealthOrphans(deps?: Partial<SweepDeps>): Promise<{ killed: number; staleFiles: number; dirsRemoved: number }> {
  const d: SweepDeps = {
    sessionsDir: sessionsDir(),
    internalRoot: furyInternalRoot(),
    ownedPids: stealthSessions.ownedPids(),
    alive: pidAlive,
    parentOf: parentPidOf,
    kill: (pid) => process.kill(pid, 'SIGKILL'),
    processStartedAt: PROCESS_STARTED_AT,
    ...deps,
  };
  let killed = 0;
  let staleFiles = 0;
  const sparedCwds = new Set<string>();
  let files: string[] = [];
  try { files = readdirSync(d.sessionsDir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of files) {
    const full = join(d.sessionsDir, f);
    let e: { pid?: unknown; cwd?: unknown; startedAt?: unknown };
    try { e = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
    if (typeof e.pid !== 'number' || typeof e.cwd !== 'string') continue;
    if (!isInternalProject(e.cwd)) {
      // Not recognisably internal, so never killed. But its cwd still guards
      // the dir cleanup below: a cwd recorded via a symlinked path fails the
      // lexical test above yet may BE one of our internal dirs.
      if (d.alive(e.pid)) sparedCwds.add(e.cwd);
      continue;
    }
    if (d.ownedPids.has(e.pid)) { sparedCwds.add(e.cwd); continue; }
    if (!d.alive(e.pid)) {
      try { rmSync(full, { force: true }); staleFiles++; } catch { /* leave */ }
      continue;
    }
    const old = typeof e.startedAt === 'number' && e.startedAt < d.processStartedAt;
    if (old && isProvableOrphan(await d.parentOf(e.pid), process.pid, d.alive)) {
      try { d.kill(e.pid); killed++; } catch { /* raced */ }
      try { rmSync(full, { force: true }); } catch { /* leave */ }
    } else {
      sparedCwds.add(e.cwd);
    }
  }
  let dirsRemoved = 0;
  if (existsSync(d.internalRoot)) {
    for (const name of readdirSync(d.internalRoot)) {
      const dir = join(d.internalRoot, name);
      // Must match the way the internal-ness test above matches (normalized,
      // case-folded) AND tolerate symlinks — a raw string compare here could
      // miss a live spared session's cwd and rm -rf it out from under it.
      const inUse = [...sparedCwds].some((c) => isSameOrUnderLoose(c, dir));
      if (inUse) continue;
      try { rmSync(dir, { recursive: true, force: true }); dirsRemoved++; } catch { /* leave */ }
    }
  }
  return { killed, staleFiles, dirsRemoved };
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR; same proxy pattern as sdkSessionManager)
// ---------------------------------------------------------------------------

const SINGLETON_VERSION = 7; // 2: labels; 3: abort-listener detach; 4: outputFormat; 5: model aliases; 6: exact usage; 7: agent-content fingerprint
const g = globalThis as unknown as { __furyStealth?: StealthSessionRegistry; __furyStealthV?: number };
if (!g.__furyStealth || g.__furyStealthV !== SINGLETON_VERSION) {
  const prev = g.__furyStealth;
  // Warm caches only — nothing to adopt. Kill the old instance's processes so a
  // reload can't strand them, and drop its bus subscription.
  if (prev) { try { prev.detach(); void prev.killAll(); } catch { /* older shape */ } }
  const next = new StealthSessionRegistry();
  next.attach();
  g.__furyStealth = next;
  g.__furyStealthV = SINGLETON_VERSION;
}

export const stealthSessions: StealthSessionRegistry = new Proxy({} as StealthSessionRegistry, {
  get(_t, prop) {
    const live = g.__furyStealth as unknown as Record<string | symbol, unknown>;
    const v = live[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(live) : v;
  },
});
