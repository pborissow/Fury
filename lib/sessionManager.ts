import { spawn, ChildProcess } from 'child_process';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { eventBus } from './eventBus';
import { killProcessTree } from './killProcessTree';
import { detectUsageLimit, handleUsageLimitDetected } from './providerSwitch';
import { scrubSessionFile } from './imageScrubber';
import { findSessionJsonlDir } from './sessionPaths';
import { restoreJsonlFromArchive } from './transcriptArchiver';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface QueuedMessage {
  prompt: string;
  resolve: (value: void | PromiseLike<void>) => void;
  reject: (error: Error) => void;
}

function sessionJsonlExists(sessionId: string, projectPath: string): boolean {
  return findSessionJsonlDir(sessionId, projectPath) !== null;
}

export interface StreamBufferEvent {
  type: 'tool_start' | 'tool_complete' | 'tool_result' | 'text' | 'error';
  name?: string;
  input?: any;
  preview?: string;
  content?: string;
  ts: number;
}

export interface StreamBuffer {
  userPrompt: string;
  accumulatedText: string;
  events: StreamBufferEvent[];
  isActive: boolean;
  startedAt: number;
  completedAt?: number;
}

interface SessionInfo {
  sessionId: string;
  isProcessing: boolean;
  queue: QueuedMessage[];
  currentProcess: ChildProcess | null;
  projectPath?: string;
  lastActivity: number; // Timestamp of last activity
  startedAt?: number; // When current process started
  stuckCheckInterval?: NodeJS.Timeout; // Interval for checking if stuck
  streamBuffer?: StreamBuffer;
  stoppedByUser?: boolean; // Set when user explicitly stops processing
}

interface SessionHealth {
  isProcessing: boolean;
  queueLength: number;
  hasProcess: boolean;
  processingTime?: number;
  lastActivity: number;
  isStuck: boolean;
  stuckReason?: string;
}

class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private readonly PROCESS_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly ACTIVITY_TIMEOUT = 30 * 1000; // 30 seconds of no activity
  private readonly BUFFER_TTL = 60 * 1000; // Keep completed buffers for 60 seconds

  getOrCreateSession(sessionId: string): SessionInfo {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        isProcessing: false,
        queue: [],
        currentProcess: null,
        lastActivity: Date.now(),
      });
    }
    return this.sessions.get(sessionId)!;
  }

  async processMessage(
    sessionId: string,
    prompt: string,
    conversationHistory: Message[] = [],
    projectPath?: string
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);

    // Update projectPath if provided
    if (projectPath) {
      session.projectPath = projectPath;
    }

    console.log(`[SessionManager] Processing message for session ${sessionId}`);
    console.log(`[SessionManager] Current queue length: ${session.queue.length}`);
    console.log(`[SessionManager] Is processing: ${session.isProcessing}`);

    return new Promise((resolve, reject) => {
      // Add to queue
      session.queue.push({ prompt, resolve, reject });

      console.log(`[SessionManager] Added to queue. New length: ${session.queue.length}`);

      // If not currently processing, start processing
      // IMPORTANT: Set isProcessing BEFORE calling processQueue to prevent race conditions
      if (!session.isProcessing) {
        console.log(`[SessionManager] Starting queue processing for session ${sessionId}`);
        session.isProcessing = true;
        eventBus.emitApp({
          type: 'session:health',
          sessionId,
          isProcessing: true,
          isStuck: false,
        });
        this.processQueue(session);
      } else {
        console.log(`[SessionManager] Session ${sessionId} is already processing, message queued`);
      }
    });
  }

  private async processQueue(session: SessionInfo): Promise<void> {
    console.log(`[SessionManager] processQueue called for session ${session.sessionId}`);
    console.log(`[SessionManager] isProcessing: ${session.isProcessing}, queue length: ${session.queue.length}`);

    // Double-check: This should already be true from processMessage, but check for safety
    if (!session.isProcessing) {
      console.log(`[SessionManager] WARNING: isProcessing was false in processQueue!`);
      session.isProcessing = true;
    }

    if (session.queue.length === 0) {
      console.log(`[SessionManager] Queue is empty, nothing to process`);
      session.isProcessing = false;
      return;
    }

    const message = session.queue.shift()!;

    // Initialize stream buffer so the frontend can restore state if the user
    // switches away and back while this message is being processed.
    session.streamBuffer = {
      userPrompt: message.prompt,
      accumulatedText: '',
      events: [],
      isActive: true,
      startedAt: Date.now(),
    };

    console.log(`[SessionManager] Processing message from queue. Remaining: ${session.queue.length}`);

    try {
      await this.executeClaudeCommand(session, message.prompt);
      console.log(`[SessionManager] Command completed successfully`);
      message.resolve();
    } catch (error) {
      console.log(`[SessionManager] Command failed:`, error);
      message.reject(error as Error);
    } finally {
      session.currentProcess = null;

      // If killSession() removed the session entirely, there's nothing to
      // clean up on it. (stopProcessing() leaves the session in the map, so
      // we still flow through the normal cleanup below — duplicate state
      // resets are cheap and prevent orphan `isProcessing=true` if
      // stopProcessing's tail ran into an exception before it reset state.)
      if (!this.sessions.has(session.sessionId)) {
        console.log(`[SessionManager] Session was killed — skipping finally cleanup`);
        return;
      }

      // Consume the stoppedByUser flag if set. It gates the exit handler's
      // resolve vs. reject decision; once finally runs the flag has served
      // its purpose and must reset so the next turn isn't classified as
      // user-stopped.
      session.stoppedByUser = false;

      // Keep stream buffer alive so the frontend can restore state if the user
      // switches back after completion. Mark inactive and set a TTL for cleanup.
      if (session.streamBuffer) {
        session.streamBuffer.isActive = false;
        session.streamBuffer.completedAt = Date.now();
      }

      console.log(`[SessionManager] Finished processing. Queue length: ${session.queue.length}`);

      // Process next message in queue
      if (session.queue.length > 0) {
        console.log(`[SessionManager] Processing next message in queue`);
        // Keep isProcessing = true and continue with next message
        this.processQueue(session);
      } else {
        console.log(`[SessionManager] Queue empty, setting isProcessing = false`);
        session.isProcessing = false;
        eventBus.emitApp({
          type: 'session:health',
          sessionId: session.sessionId,
          isProcessing: false,
          isStuck: false,
        });
      }
    }
  }

  private async executeClaudeCommand(
    session: SessionInfo,
    prompt: string,
  ): Promise<void> {
    // Preamble: if the JSONL is missing but we have the conversation archived,
    // restore it before spawning Claude CLI so --resume gets a real history
    // instead of silently degrading into a fresh session w/ recycled UUID.
    const preCwd = session.projectPath || process.cwd();
    if (!findSessionJsonlDir(session.sessionId, preCwd)) {
      const restoredPath = await restoreJsonlFromArchive(session.sessionId, preCwd);
      if (restoredPath) {
        console.log(`[SessionManager] Restored JSONL from archive: ${restoredPath}`);
      }
    }

    return new Promise((resolve, reject) => {
      const buf = session.streamBuffer;

      const bufferText = (text: string) => {
        if (!buf) return;
        buf.accumulatedText += text;
        // Coalesce consecutive text events
        const last = buf.events[buf.events.length - 1];
        if (last && last.type === 'text') {
          last.content = (last.content || '') + text;
        } else {
          buf.events.push({ type: 'text', content: text, ts: Date.now() });
        }
      };

      const bufferEvent = (evt: StreamBufferEvent) => {
        if (!buf) return;
        buf.events.push(evt);
      };

      try {
        console.log(`[SessionManager] Prompt length: ${prompt.length} chars`);

        // Determine whether to create a new session or resume an existing one.
        // --session-id creates a new session (fails if JSONL already exists).
        // --resume continues an existing session (fails if JSONL doesn't exist).
        // The async preamble above this Promise has already restored a JSONL
        // from the SQLite archive if one was missing — so by the time we reach
        // here, findSessionJsonlDir reflects post-restore state.
        let cwd = session.projectPath || process.cwd();
        const jsonlLocation = findSessionJsonlDir(session.sessionId, cwd);
        const isExistingSession = jsonlLocation !== null;

        // Use the cwd Claude CLI itself recorded in the JSONL, so its slug
        // derivation round-trips to the same project dir on resume. This
        // catches symlinks and Windows subst-mapped drives in one shot.
        if (jsonlLocation) cwd = jsonlLocation.canonicalCwd;

        const args = [
          '--print',
          '--verbose',
          '--output-format=stream-json',
          '--include-partial-messages',
          '--allow-dangerously-skip-permissions',
          '--permission-mode=bypassPermissions',
        ];

        if (isExistingSession) {
          args.push('--resume', session.sessionId);
        } else {
          args.push('--session-id', session.sessionId);
        }

        console.log(`[SessionManager] Spawning Claude CLI (${isExistingSession ? 'resume' : 'new'}) for session ${session.sessionId}`);
        if (session.projectPath) {
          console.log(`[SessionManager] Working directory: ${session.projectPath}`);
        }

        // The spawn-and-attach logic is wrapped so we can defer it until
        // after the JSONL scrub completes (otherwise the CLI may read the
        // un-scrubbed file and rebuild a 32MB+ API request). When the scrub
        // resolves we invoke launchCli from a Promise's `.finally`, which is
        // a different async context than the outer try/catch — so launchCli
        // owns its own error handling and routes failures to `reject` directly.
        const launchCli = () => {
        try {
        // Pass prompt via stdin to avoid OS command-line length limits.
        // Strip CLAUDECODE env var so the child process doesn't think it's
        // nested inside another Claude Code session (which would cause it to
        // refuse to start).
        const { CLAUDECODE, ...cleanEnv } = process.env;
        const claude = spawn('claude', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd,
          env: cleanEnv,
          // On Unix, create a new process group so killProcessTree can
          // send signals to the group without killing the Fury server.
          // On Windows detached opens a new console window, so skip it.
          ...(process.platform !== 'win32' ? { detached: true } : {}),
        });

        // Write prompt to stdin and close it so claude reads it
        claude.stdin.write(prompt);
        claude.stdin.end();

        // Write history entry immediately so the session appears in the sidebar
        // right away, not after the process completes.
        try {
          const historyEntry = JSON.stringify({
            display: prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt,
            pastedContents: {},
            timestamp: Date.now(),
            project: cwd,
            sessionId: session.sessionId,
          });
          const historyPath = join(homedir(), '.claude', 'history.jsonl');
          appendFile(historyPath, historyEntry + '\n', 'utf-8').catch(error => {
            console.error('[SessionManager] Failed to append to history.jsonl:', error);
          });
        } catch (error) {
          console.error('[SessionManager] Failed to build history entry:', error);
        }

        session.currentProcess = claude;
        console.log(`[SessionManager] Claude CLI process spawned with PID: ${claude.pid}`);

        // Mark when process started
        session.startedAt = Date.now();
        session.lastActivity = Date.now();

        // Periodic stuck detection — emits health event only on status change
        let wasStuck = false;
        session.stuckCheckInterval = setInterval(() => {
          const health = this.getSessionHealth(session.sessionId);
          if (health.isStuck !== wasStuck) {
            wasStuck = health.isStuck;
            eventBus.emitApp({
              type: 'session:health',
              sessionId: session.sessionId,
              isProcessing: health.isProcessing,
              isStuck: health.isStuck,
              stuckReason: health.stuckReason,
            });
          }
        }, 5000);

        // Helper: check any text for a usage-limit message and trigger failover
        let usageLimitTriggered = false;
        const checkUsageLimit = (text: string, source: string) => {
          if (usageLimitTriggered) return; // only trigger once per process
          const info = detectUsageLimit(text);
          if (info.detected) {
            usageLimitTriggered = true;
            console.log(`[SessionManager] *** USAGE LIMIT DETECTED (${source}) ***`);
            console.log(`[SessionManager]   Raw text: ${text.substring(0, 200)}`);
            console.log(`[SessionManager]   Reset: ${info.resetTimeRaw || 'unknown'}`);
            handleUsageLimitDetected(info).catch(err =>
              console.error('[SessionManager] Failed to auto-switch provider:', err),
            );
          }
        };

        // Accumulate stderr so we can inspect it on non-zero exit
        let stderrAccumulator = '';

        // Stream the output - parse JSON stream from Claude CLI
        let buffer = '';
        let lastTextBlockIndex = -1; // Track text blocks to add separation
        let lastEmittedModel: string | null = null;
        const emitModelIfNew = (model: string | undefined) => {
          if (!model || model === '<synthetic>') return;
          if (model === lastEmittedModel) return;
          lastEmittedModel = model;
          eventBus.emitApp({ type: 'session:model', sessionId: session.sessionId, model });
        };

        // Live output-token tally for this run, deduped by assistant message id
        // (streaming repeats the same message's cumulative usage). Summed and
        // emitted whenever it changes so the sidebar can count up in real time.
        const turnOutputByMsgId = new Map<string, number>();
        let currentStreamMsgId: string | null = null;
        let lastEmittedTurnTokens = -1;
        const emitUsageIfChanged = () => {
          let total = 0;
          for (const v of turnOutputByMsgId.values()) total += v;
          if (total === lastEmittedTurnTokens) return;
          lastEmittedTurnTokens = total;
          eventBus.emitApp({ type: 'session:usage', sessionId: session.sessionId, turnOutputTokens: total });
        };
        claude.stdout.on('data', (data) => {
          // Update activity timestamp whenever we receive data
          session.lastActivity = Date.now();
          const rawChunk = data.toString();
          buffer += rawChunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const json = JSON.parse(line);

                // Check structured JSON errors for usage-limit messages.
                // The CLI emits limit errors in a few different shapes:
                //   1. {"type":"error", "error":{"message":"..."}}
                //   2. {"type":"error", "message":"..."}
                //   3. {"type":"assistant", "error":"rate_limit",
                //        "message":{"model":"<synthetic>",
                //                   "content":[{"type":"text","text":"You've hit your limit · resets 5:40pm (...)"}]}}
                // Shape (3) is the one Claude Code actually uses, and the
                // parseable reset time lives inside the synthetic
                // assistant content rather than in the `error` field.
                const errorText =
                  json.error?.message || json.error?.text ||
                  (typeof json.error === 'string' ? json.error : '') ||
                  (json.type === 'error' && json.message ? json.message : '');
                // Use `!= null` so `error: null` is treated as "no
                // error" and we don't dump the full payload or scan
                // synthetic content for a non-existent error.
                const hasErrorIndicator = json.error != null || json.type === 'error';
                if (hasErrorIndicator) {
                  console.log('[SessionManager] Full JSON error payload:', JSON.stringify(json));
                  // For shape (3), the parseable reset time lives inside
                  // the synthetic assistant content. Build the most
                  // informative text we can BEFORE running detection so
                  // checkUsageLimit's "trigger once" guard latches on
                  // the version that includes the reset time.
                  let syntheticText = '';
                  if (Array.isArray(json.message?.content)) {
                    syntheticText = json.message.content
                      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
                      .map((b: any) => b.text)
                      .join(' ')
                      .trim();
                  }
                  // Prefer the richest text we have: synthetic content
                  // (most informative, contains "resets …") falls back
                  // to the structured error message text, which falls
                  // back to the bare token (e.g. "rate_limit").
                  const detectionText = syntheticText || errorText;
                  if (detectionText) {
                    console.log(`[SessionManager] Error event text for detection: ${detectionText.substring(0, 200)}`);
                    checkUsageLimit(detectionText, syntheticText ? 'stdout-synthetic-assistant' : 'stdout-json-error');
                  }
                }

                // Surface the model the CLI is running with. The init event
                // gives us the answer before any assistant content arrives,
                // which is the earliest point we can label the session.
                if (json.type === 'system' && json.subtype === 'init') {
                  emitModelIfNew(json.model);
                }

                // Handle stream_event type with nested event
                if (json.type === 'stream_event' && json.event) {
                  const event = json.event;
                  // Track output tokens live as the message streams. message_start
                  // gives the message id (+ initial usage); message_delta carries
                  // the running output_tokens for that message. Keyed by id so an
                  // agentic turn's messages sum correctly.
                  if (event.type === 'message_start' && event.message?.id) {
                    const mid: string = event.message.id;
                    currentStreamMsgId = mid;
                    const out = event.message.usage?.output_tokens;
                    if (typeof out === 'number') { turnOutputByMsgId.set(mid, out); emitUsageIfChanged(); }
                  } else if (event.type === 'message_delta' && currentStreamMsgId && typeof event.usage?.output_tokens === 'number') {
                    turnOutputByMsgId.set(currentStreamMsgId, event.usage.output_tokens);
                    emitUsageIfChanged();
                  }
                  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                    const text = event.delta.text;
                    bufferText(text);
                    eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, text });
                  }
                  // Handle content block start - detect when a new text block starts
                  else if (event.type === 'content_block_start') {
                    if (event.content_block?.type === 'text' && event.index !== lastTextBlockIndex && lastTextBlockIndex !== -1) {
                      // New text block starting - add a separator
                      bufferText('\n\n');
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, text: '\n\n' });
                    }
                    if (event.content_block?.type === 'text') {
                      lastTextBlockIndex = event.index;
                    }
                    // Handle tool use start
                    else if (event.content_block?.type === 'tool_use') {
                      const toolName = event.content_block.name;
                      bufferEvent({ type: 'tool_start', name: toolName, ts: Date.now() });
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, toolUse: { name: toolName, status: 'starting' } });
                    }
                  }
                }
                // Handle assistant message type with complete content.
                // Text blocks were already delivered as streaming deltas via
                // `stream_event content_block_delta` above — re-emitting them
                // from the assistant envelope would double every paragraph in
                // the buffer. The exception is synthetic messages (CLI-injected
                // usage-limit notices) which skip the streaming path entirely.
                else if (json.type === 'assistant' && json.message?.content) {
                  const isSynthetic = json.message.model === '<synthetic>';
                  if (!isSynthetic) emitModelIfNew(json.message.model);
                  // Update the live output-token tally as each assistant
                  // message lands (one per agentic step).
                  if (!isSynthetic && json.message.id && typeof json.message.usage?.output_tokens === 'number') {
                    turnOutputByMsgId.set(json.message.id, json.message.usage.output_tokens);
                    emitUsageIfChanged();
                  }
                  for (const block of json.message.content) {
                    if (block.type === 'text' && block.text && isSynthetic) {
                      bufferText(block.text);
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, text: block.text });
                    }
                    else if (block.type === 'tool_use') {
                      bufferEvent({ type: 'tool_complete', name: block.name, input: block.input, ts: Date.now() });
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, toolUse: { name: block.name, status: 'complete', input: block.input } });

                      // AskUserQuestion is auto-errored by the CLI in `--print`
                      // mode (Claude has no interactive stdin to read from).
                      // Kill the CLI server-side so it can't churn through
                      // tokens generating "Holding for your input" / more tool
                      // calls while the user is on another session. The dialog
                      // is surfaced via the SSE tool_complete event (if viewing)
                      // or via parser.pendingAskUserQuestion on navigation.
                      if (block.name === 'AskUserQuestion' && block.input?.questions?.length) {
                        console.log(`[SessionManager] AskUserQuestion detected for ${session.sessionId} — stopping CLI`);
                        this.stopProcessing(session.sessionId).catch(err =>
                          console.error('[SessionManager] Failed to stop on AskUserQuestion:', err)
                        );
                      }
                    }
                  }
                }
                // Handle user message (tool results)
                else if (json.type === 'user' && json.message?.content) {
                  for (const block of json.message.content) {
                    if (block.type === 'tool_result') {
                      const resultPreview = typeof block.content === 'string'
                        ? block.content.substring(0, 100) + (block.content.length > 100 ? '...' : '')
                        : JSON.stringify(block.content).substring(0, 100);
                      bufferEvent({ type: 'tool_result', preview: resultPreview, ts: Date.now() });
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, toolResult: { preview: resultPreview } });
                    }
                  }
                }
              } catch (e) {
                console.error('Failed to parse JSON line:', line, e);
                // Non-JSON output may contain usage-limit messages
                checkUsageLimit(line, 'stdout-raw');
              }
            }
          }
        });

        // Handle errors
        claude.stderr.on('data', (data) => {
          // Update activity even on stderr
          session.lastActivity = Date.now();
          const errorMessage = data.toString();
          stderrAccumulator += errorMessage;
          console.error('Claude CLI stderr:', errorMessage);

          // Detect usage-limit messages and auto-switch to Bedrock
          checkUsageLimit(errorMessage, 'stderr');
        });

        // Use 'exit' instead of 'close' for process lifecycle management.
        // 'close' waits for all stdio pipes to close, which may never happen
        // if Claude spawned subprocesses (e.g. Bash tool running mvn/npm) that
        // inherited the pipe handles and outlive the main process.
        // 'exit' fires as soon as the process itself exits.
        claude.on('exit', (code) => {
          if (session.stuckCheckInterval) {
            clearInterval(session.stuckCheckInterval);
            session.stuckCheckInterval = undefined;
          }
          // Clear start time when process ends
          session.startedAt = undefined;
          session.lastActivity = Date.now();
          if (session.streamBuffer) {
            session.streamBuffer.isActive = false;
          }

          // On non-zero exit, log everything and do a final usage-limit
          // check against accumulated stderr (covers cases where the
          // message arrived in chunks that didn't individually match).
          if (code !== 0 && code !== null && !session.stoppedByUser) {
            console.log(`[SessionManager] CLI exited with code ${code} — stderr dump:`);
            console.log(stderrAccumulator || '(empty)');
            checkUsageLimit(stderrAccumulator, 'stderr-on-exit');
          }

          // If the user explicitly stopped this process, treat it as a
          // clean exit regardless of the exit code.
          if (session.stoppedByUser) {
            // Don't reset stoppedByUser here — the processQueue finally
            // block checks it to skip duplicate cleanup. It will be
            // cleared there instead.
            resolve();
          } else if (code !== 0 && code !== null) {
            bufferEvent({ type: 'error', content: `Claude CLI exited with code ${code}`, ts: Date.now() });
            eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, error: `Claude CLI exited with code ${code}` });
            reject(new Error(`Claude CLI exited with code ${code}`));
          } else {
            resolve();
          }
        });

        // Handle process errors
        claude.on('error', (error) => {
          if (session.stuckCheckInterval) {
            clearInterval(session.stuckCheckInterval);
            session.stuckCheckInterval = undefined;
          }
          eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, error: error.message });
          reject(error);
        });
        } catch (error) {
          // Catch synchronous throws inside launchCli (e.g. spawn failure on
          // Windows for malformed args). Without this the error would escape
          // into the .finally promise chain that nothing awaits, hanging the
          // request forever.
          reject(error as Error);
        }
        }; // end launchCli

        // Strip stale base64 images from the JSONL before launching the CLI.
        // Images live forever in the conversation history otherwise and push
        // large sessions past the 32MB API request limit. Always launch the
        // CLI, even if scrubbing fails — this is best-effort cleanup.
        if (isExistingSession) {
          scrubSessionFile(session.sessionId, cwd, { keepRecentTurns: 0 })
            .then(result => {
              if (result && result.scrubbed > 0) {
                const mb = (result.bytesSaved / 1024 / 1024).toFixed(1);
                console.log(`[SessionManager] Scrubbed ${result.scrubbed} stale image(s) from ${session.sessionId} (${mb} MB saved)`);
              }
            })
            .catch(err => {
              console.error(`[SessionManager] Image scrub failed for ${session.sessionId}:`, err);
            })
            .finally(launchCli);
        } else {
          launchCli();
        }
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  /**
   * Return the conversation sessionIds of every Fury-managed CLI that is
   * currently spawned and running. Used to populate the live-sessions list
   * for the "Live" sidebar badge: as of Claude CLI v2.1.144 the per-process
   * PID file under `~/.claude/sessions/<pid>.json` carries a fresh spawn-
   * specific sessionId on every `--resume`, so the PID scanner alone misses
   * any session Fury resumed. Fury knows the canonical conversation id for
   * each process it spawned, so we surface that authoritatively here.
   */
  getActiveSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.isProcessing && session.currentProcess) {
        ids.push(sessionId);
      }
    }
    return ids;
  }

  getSessionHealth(sessionId: string): SessionHealth {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        isProcessing: false,
        queueLength: 0,
        hasProcess: false,
        lastActivity: 0,
        isStuck: false,
      };
    }

    const now = Date.now();

    // Self-correct an impossible state: isProcessing=true while there's no
    // child process AND no recorded start time means the spawn finished
    // (exit handler clears startedAt; finally nulls currentProcess) but the
    // isProcessing flag was never flipped. Without this, the UI sits on
    // bouncing dots forever — a stuck session that can only be cleared by
    // calling action:'kill'. Treat it as finished and emit session:health
    // so any listening UI catches up.
    if (
      session.isProcessing &&
      !session.currentProcess &&
      session.startedAt === undefined
    ) {
      console.warn(
        `[SessionManager] Orphan isProcessing=true detected for ${sessionId} — auto-correcting`
      );
      session.isProcessing = false;
      if (session.streamBuffer) {
        session.streamBuffer.isActive = false;
        if (!session.streamBuffer.completedAt) {
          session.streamBuffer.completedAt = now;
        }
      }
      eventBus.emitApp({
        type: 'session:health',
        sessionId,
        isProcessing: false,
        isStuck: false,
      });
    }

    const timeSinceActivity = now - session.lastActivity;
    const processingTime = session.startedAt ? now - session.startedAt : undefined;

    // Determine if stuck
    let isStuck = false;
    let stuckReason: string | undefined;

    if (session.isProcessing) {
      // Check if process has been running too long
      if (processingTime && processingTime > this.PROCESS_TIMEOUT) {
        isStuck = true;
        stuckReason = 'Process timeout - exceeded 5 minutes';
      }
      // Check if no activity for a while
      else if (timeSinceActivity > this.ACTIVITY_TIMEOUT) {
        isStuck = true;
        stuckReason = 'No activity for 30 seconds - may be waiting for input';
      }
      // Check if process exists but isn't responding
      else if (session.currentProcess && !session.currentProcess.pid) {
        isStuck = true;
        stuckReason = 'Process lost or terminated unexpectedly';
      }
    }

    return {
      isProcessing: session.isProcessing,
      queueLength: session.queue.length,
      hasProcess: !!session.currentProcess,
      processingTime,
      lastActivity: session.lastActivity,
      isStuck,
      stuckReason,
    };
  }

  getStreamBuffer(sessionId: string): StreamBuffer | null {
    const session = this.sessions.get(sessionId);
    if (!session?.streamBuffer) return null;

    // Expire completed buffers after TTL
    const buf = session.streamBuffer;
    if (!buf.isActive && buf.completedAt && Date.now() - buf.completedAt > this.BUFFER_TTL) {
      session.streamBuffer = undefined;
      return null;
    }

    return buf;
  }

  /**
   * Stop the currently running process for a session but keep the session
   * alive so the user can continue chatting. Queued messages are rejected.
   */
  async stopProcessing(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Mark as user-stopped so the exit handler resolves cleanly
    session.stoppedByUser = true;

    // Drain the queue — reject any pending messages
    while (session.queue.length > 0) {
      const queued = session.queue.shift()!;
      queued.reject(new Error('Processing stopped by user'));
    }

    // Clear stuck-check interval
    if (session.stuckCheckInterval) {
      clearInterval(session.stuckCheckInterval);
      session.stuckCheckInterval = undefined;
    }

    // Kill the entire process tree
    if (session.currentProcess) {
      const proc = session.currentProcess;
      session.currentProcess = null;
      await killProcessTree(proc);
    }

    // Mark the stream buffer as stopped (but preserve its text)
    if (session.streamBuffer) {
      session.streamBuffer.isActive = false;
      session.streamBuffer.completedAt = Date.now();
    }

    // The processQueue finally block will fire via the exit event and
    // emit session:health. But if the process was already null (edge case),
    // emit it ourselves.
    if (session.isProcessing) {
      session.isProcessing = false;
      session.startedAt = undefined;
      eventBus.emitApp({
        type: 'session:health',
        sessionId,
        isProcessing: false,
        isStuck: false,
      });
    }
  }

  /**
   * Destroy a session entirely — kills the process tree and removes all
   * in-memory state. Use stopProcessing() if you just want to stop the
   * current turn without tearing down the session.
   */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.stoppedByUser = true;
      session.streamBuffer = undefined;

      // Drain the queue
      while (session.queue.length > 0) {
        const queued = session.queue.shift()!;
        queued.reject(new Error('Session killed'));
      }

      if (session.stuckCheckInterval) {
        clearInterval(session.stuckCheckInterval);
        session.stuckCheckInterval = undefined;
      }

      if (session.currentProcess) {
        const proc = session.currentProcess;
        session.currentProcess = null;
        await killProcessTree(proc);
      }
    }
    this.sessions.delete(sessionId);
    eventBus.emitApp({
      type: 'session:health',
      sessionId,
      isProcessing: false,
      isStuck: false,
    });
  }
}

// Persist the singleton across Next.js HMR reloads in dev mode.
// Without this, every hot-module replacement creates a new SessionManager,
// orphaning any running Claude CLI processes and losing queue state.
const globalForSessionManager = globalThis as unknown as {
  __sessionManager: SessionManager | undefined;
};

export const sessionManager =
  globalForSessionManager.__sessionManager ?? new SessionManager();

if (process.env.NODE_ENV !== 'production') {
  globalForSessionManager.__sessionManager = sessionManager;
}
