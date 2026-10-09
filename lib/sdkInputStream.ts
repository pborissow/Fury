import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A pushable async-iterable of user messages. This is the `prompt` we hand to
 * query(). The generator AWAITS when the queue is empty rather than returning —
 * returning would end the session and let the CLI exit. That awaiting is what
 * keeps the process alive between turns.
 */
export function createInputStream() {
  const queue: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let ended = false;

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (queue.length === 0) {
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      if (ended && queue.length === 0) return;
    }
  }

  return {
    stream: generator(),
    push(msg: SDKUserMessage) {
      queue.push(msg);
      notify?.();
      notify = null;
    },
    end() {
      ended = true;
      notify?.();
      notify = null;
    },
  };
}

export type InputStream = ReturnType<typeof createInputStream>;
