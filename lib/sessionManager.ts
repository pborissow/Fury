import { spawn, ChildProcess } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from './utils';
import { eventBus } from './eventBus';
import { killProcessTree } from './killProcessTree';
import { detectUsageLimit, handleUsageLimitDetected } from './providerSwitch';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface QueuedMessage {
  prompt: string;
  resolve: (value: void | PromiseLike<void>) => void;
  reject: (error: Error) => void;
}

/**
 * Check if a Claude CLI session JSONL file already exists for a given session ID and project.
 */
/**
 * Find the project slug directory that contains a session JSONL.
 * Returns the slug directory path, or null if not found.
 * Handles symlink/mapped drive mismatches by trying the resolved path
 * and scanning project directories as a last resort.
 */
function findSessionJsonlDir(sessionId: string, projectPath: string): string | null {
  const base = join(homedir(), '.claude', 'projects');
  const slug = projectPathToSlug(projectPath);
  const primary = join(base, slug);
  if (existsSync(join(primary, `${sessionId}.jsonl`))) return primary;

  // Try the resolved real path (handles symlinks/mapped drives)
  try {
    const resolved = realpathSync(projectPath);
    if (resolved !== projectPath) {
      const altSlug = projectPathToSlug(resolved);
      if (altSlug !== slug) {
        const alt = join(base, altSlug);
        if (existsSync(join(alt, `${sessionId}.jsonl`))) return alt;
      }
    }
  } catch { /* ignore */ }

  return null;
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

      // If stopProcessing() or killSession() already handled state cleanup,
      // don't duplicate it here — just bail out.
      if (session.stoppedByUser || !this.sessions.has(session.sessionId)) {
        session.stoppedByUser = false;
        console.log(`[SessionManager] Skipping finally cleanup — session was stopped/killed`);
        return;
      }

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

  private executeClaudeCommand(
    session: SessionInfo,
    prompt: string,
  ): Promise<void> {
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
        let cwd = session.projectPath || process.cwd();
        const jsonlDir = findSessionJsonlDir(session.sessionId, cwd);
        const isExistingSession = jsonlDir !== null;

        if (isExistingSession) {
          // Ensure cwd matches the path the JSONL is stored under, since
          // symlinks/mapped drives can cause the history path and JSONL slug
          // to differ. If the primary slug didn't match, the resolved path did,
          // so use that as cwd so Claude CLI finds its own session file.
          const primarySlug = projectPathToSlug(cwd);
          const base = join(homedir(), '.claude', 'projects');
          if (!existsSync(join(base, primarySlug, `${session.sessionId}.jsonl`))) {
            try {
              const resolved = realpathSync(cwd);
              if (resolved !== cwd) cwd = resolved;
            } catch { /* keep original */ }
          }
        }

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

        // Stream the output - parse JSON stream from Claude CLI
        let buffer = '';
        let lastTextBlockIndex = -1; // Track text blocks to add separation
        claude.stdout.on('data', (data) => {
          // Update activity timestamp whenever we receive data
          session.lastActivity = Date.now();
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const json = JSON.parse(line);

                // Handle stream_event type with nested event
                if (json.type === 'stream_event' && json.event) {
                  const event = json.event;
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
                // Handle assistant message type with complete content
                else if (json.type === 'assistant' && json.message?.content) {
                  for (let i = 0; i < json.message.content.length; i++) {
                    const block = json.message.content[i];
                    if (block.type === 'text' && block.text) {
                      // Add separator between text blocks if this isn't the first one
                      if (i > 0 && json.message.content[i - 1]?.type === 'text') {
                        bufferText('\n\n');
                        eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, text: '\n\n' });
                      }
                      bufferText(block.text);
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, text: block.text });
                    }
                    // Handle tool use in complete message
                    else if (block.type === 'tool_use') {
                      bufferEvent({ type: 'tool_complete', name: block.name, input: block.input, ts: Date.now() });
                      eventBus.emitApp({ type: 'session:stream', sessionId: session.sessionId, toolUse: { name: block.name, status: 'complete', input: block.input } });
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
                const usageLimit = detectUsageLimit(line);
                if (usageLimit.detected) {
                  console.log('[SessionManager] Usage limit detected in stdout — triggering provider switch');
                  handleUsageLimitDetected(usageLimit).catch(err =>
                    console.error('[SessionManager] Failed to auto-switch provider:', err),
                  );
                }
              }
            }
          }
        });

        // Handle errors
        claude.stderr.on('data', (data) => {
          // Update activity even on stderr
          session.lastActivity = Date.now();
          const errorMessage = data.toString();
          console.error('Claude CLI error:', errorMessage);

          // Detect usage-limit messages and auto-switch to Bedrock
          const usageLimit = detectUsageLimit(errorMessage);
          if (usageLimit.detected) {
            console.log('[SessionManager] Usage limit detected in stderr — triggering provider switch');
            handleUsageLimitDetected(usageLimit).catch(err =>
              console.error('[SessionManager] Failed to auto-switch provider:', err),
            );
          }
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
        reject(error as Error);
      }
    });
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
