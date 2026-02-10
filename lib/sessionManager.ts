import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { projectPathToSlug } from './utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface QueuedMessage {
  prompt: string;
  resolve: (value: void | PromiseLike<void>) => void;
  reject: (error: Error) => void;
  controller: ReadableStreamDefaultController;
}

/**
 * Check if a Claude CLI session JSONL file already exists for a given session ID and project.
 */
function sessionJsonlExists(sessionId: string, projectPath: string): boolean {
  const slug = projectPathToSlug(projectPath);
  const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
  return existsSync(jsonlPath);
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
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
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
      session.queue.push({ prompt, resolve, reject, controller });

      console.log(`[SessionManager] Added to queue. New length: ${session.queue.length}`);

      // If not currently processing, start processing
      // IMPORTANT: Set isProcessing BEFORE calling processQueue to prevent race conditions
      if (!session.isProcessing) {
        console.log(`[SessionManager] Starting queue processing for session ${sessionId}`);
        session.isProcessing = true;
        this.processQueue(session, encoder);
      } else {
        console.log(`[SessionManager] Session ${sessionId} is already processing, message queued`);
      }
    });
  }

  private async processQueue(session: SessionInfo, encoder: TextEncoder): Promise<void> {
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

    console.log(`[SessionManager] Processing message from queue. Remaining: ${session.queue.length}`);

    try {
      await this.executeClaudeCommand(
        session,
        message.prompt,
        message.controller,
        encoder
      );
      console.log(`[SessionManager] Command completed successfully`);
      message.resolve();
    } catch (error) {
      console.log(`[SessionManager] Command failed:`, error);
      message.reject(error as Error);
    } finally {
      session.currentProcess = null;

      console.log(`[SessionManager] Finished processing. Queue length: ${session.queue.length}`);

      // Process next message in queue
      if (session.queue.length > 0) {
        console.log(`[SessionManager] Processing next message in queue`);
        // Keep isProcessing = true and continue with next message
        this.processQueue(session, encoder);
      } else {
        console.log(`[SessionManager] Queue empty, setting isProcessing = false`);
        session.isProcessing = false;
      }
    }
  }

  private executeClaudeCommand(
    session: SessionInfo,
    prompt: string,
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let isClosed = false;
      let assistantResponse = ''; // Accumulate the assistant's response

      const safeEnqueue = (chunk: Uint8Array) => {
        if (!isClosed) {
          try {
            controller.enqueue(chunk);
          } catch (e) {
            isClosed = true;
          }
        }
      };

      const safeClose = () => {
        if (!isClosed) {
          try {
            controller.close();
            isClosed = true;
          } catch (e) {
            isClosed = true;
          }
        }
      };

      try {
        console.log(`[SessionManager] Prompt length: ${prompt.length} chars`);

        // Determine whether to create a new session or resume an existing one.
        // --session-id creates a new session (fails if JSONL already exists).
        // --resume continues an existing session (fails if JSONL doesn't exist).
        const cwd = session.projectPath || process.cwd();
        const isExistingSession = sessionJsonlExists(session.sessionId, cwd);

        const args = [
          '--print',
          '--verbose',
          '--output-format=stream-json',
          '--include-partial-messages',
          '--dangerously-skip-permissions',
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

        // Pass prompt via stdin to avoid OS command-line length limits
        const claude = spawn('claude', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd,
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
                    assistantResponse += text; // Accumulate response
                    const chunk = encoder.encode(`data: ${JSON.stringify({ text })}\n\n`);
                    safeEnqueue(chunk);
                  }
                  // Handle content block start - detect when a new text block starts
                  else if (event.type === 'content_block_start') {
                    if (event.content_block?.type === 'text' && event.index !== lastTextBlockIndex && lastTextBlockIndex !== -1) {
                      // New text block starting - add a separator
                      assistantResponse += '\n\n'; // Accumulate separator
                      const chunk = encoder.encode(`data: ${JSON.stringify({ text: '\n\n' })}\n\n`);
                      safeEnqueue(chunk);
                    }
                    if (event.content_block?.type === 'text') {
                      lastTextBlockIndex = event.index;
                    }
                    // Handle tool use start
                    else if (event.content_block?.type === 'tool_use') {
                      const toolName = event.content_block.name;
                      const chunk = encoder.encode(`data: ${JSON.stringify({ tool_use: { name: toolName, status: 'starting' } })}\n\n`);
                      safeEnqueue(chunk);
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
                        assistantResponse += '\n\n'; // Accumulate separator
                        const separator = encoder.encode(`data: ${JSON.stringify({ text: '\n\n' })}\n\n`);
                        safeEnqueue(separator);
                      }
                      assistantResponse += block.text; // Accumulate response
                      const chunk = encoder.encode(`data: ${JSON.stringify({ text: block.text })}\n\n`);
                      safeEnqueue(chunk);
                    }
                    // Handle tool use in complete message
                    else if (block.type === 'tool_use') {
                      const chunk = encoder.encode(`data: ${JSON.stringify({ tool_use: { name: block.name, input: block.input, status: 'complete' } })}\n\n`);
                      safeEnqueue(chunk);
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
                      const chunk = encoder.encode(`data: ${JSON.stringify({ tool_result: { preview: resultPreview } })}\n\n`);
                      safeEnqueue(chunk);
                    }
                  }
                }
              } catch (e) {
                console.error('Failed to parse JSON line:', line, e);
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
        });

        // Close stream when process ends
        claude.on('close', async (code) => {
          // Clear start time when process ends
          session.startedAt = undefined;
          session.lastActivity = Date.now();
          if (code !== 0 && !isClosed) {
            const chunk = encoder.encode(
              `data: ${JSON.stringify({ error: `Claude CLI exited with code ${code}` })}\n\n`
            );
            safeEnqueue(chunk);
            reject(new Error(`Claude CLI exited with code ${code}`));
          } else {
            resolve();
          }
          safeClose();
        });

        // Handle process errors
        claude.on('error', (error) => {
          const chunk = encoder.encode(
            `data: ${JSON.stringify({ error: error.message })}\n\n`
          );
          safeEnqueue(chunk);
          safeClose();
          reject(error);
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const chunk = encoder.encode(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        safeEnqueue(chunk);
        safeClose();
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

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.currentProcess) {
      session.currentProcess.kill();
      session.currentProcess = null;
    }
    if (session?.stuckCheckInterval) {
      clearInterval(session.stuckCheckInterval);
    }
    this.sessions.delete(sessionId);
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
