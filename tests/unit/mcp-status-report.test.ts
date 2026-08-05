/**
 * B4 (docs/ticket-local-mcp-this-project-fails-first-use.md):
 * the SDK backend must surface MCP servers that did not connect at system:init.
 * reportMcpServers logs under sdk.mcp and emits a session:stream {mcpServers}
 * signal for any non-"connected" status, deduped across repeated inits. Drives
 * the private method directly and captures the eventBus (as health-startedat and
 * sdk-error-surfacing tests do).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sdkSessionManager } from '../../lib/sdkSessionManager';
import { eventBus, type AppEvent, type SessionStreamEvent } from '../../lib/eventBus';
import { log } from '../../lib/logger';

const mgr = sdkSessionManager as any;
const createdIds: string[] = [];
function newSession(id: string) {
  createdIds.push(id);
  return mgr.getOrCreate(id);
}

function captureStream() {
  const events: SessionStreamEvent[] = [];
  const listener = (e: AppEvent) => { if (e.type === 'session:stream') events.push(e as SessionStreamEvent); };
  eventBus.onApp(listener);
  return { events, stop: () => eventBus.offApp(listener) };
}

afterEach(() => {
  const sessions = (sdkSessionManager as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const id of createdIds.splice(0)) sessions.delete(id);
  vi.restoreAllMocks();
});

describe('reportMcpServers (B4)', () => {
  it('emits a session:stream {mcpServers} signal for a FAILED server and warns sdk.mcp', () => {
    const s = newSession('mcp-1');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const cap = captureStream();

    mgr.reportMcpServers(s, [
      { name: 'codemogger', status: 'failed' },
      { name: 'linear', status: 'connected' },
    ]);
    cap.stop();

    const ev = cap.events.find(e => e.sessionId === 'mcp-1' && e.mcpServers);
    expect(ev, 'a session:stream with mcpServers was emitted').toBeTruthy();
    expect(ev!.mcpServers).toEqual([{ name: 'codemogger', status: 'failed' }]);
    expect(warn).toHaveBeenCalledWith('sdk.mcp', expect.any(String), expect.objectContaining({
      sessionId: 'mcp-1',
      data: { servers: [{ name: 'codemogger', status: 'failed' }] },
    }));
  });

  it('emits nothing when every server is connected', () => {
    const s = newSession('mcp-2');
    const cap = captureStream();
    mgr.reportMcpServers(s, [{ name: 'codemogger', status: 'connected' }]);
    cap.stop();
    expect(cap.events.filter(e => e.sessionId === 'mcp-2' && e.mcpServers)).toHaveLength(0);
  });

  it('dedups a repeated init with the same failed set', () => {
    const s = newSession('mcp-3');
    const cap = captureStream();
    const servers = [{ name: 'codemogger', status: 'failed' }];
    mgr.reportMcpServers(s, servers);
    mgr.reportMcpServers(s, servers); // same set — should not re-emit
    cap.stop();
    expect(cap.events.filter(e => e.sessionId === 'mcp-3' && e.mcpServers)).toHaveLength(1);
  });

  it('re-emits when the FAILED set changes', () => {
    const s = newSession('mcp-4');
    const cap = captureStream();
    mgr.reportMcpServers(s, [{ name: 'codemogger', status: 'failed' }]);
    mgr.reportMcpServers(s, [{ name: 'other', status: 'failed' }]); // different failed server
    cap.stop();
    const evs = cap.events.filter(e => e.sessionId === 'mcp-4' && e.mcpServers);
    expect(evs).toHaveLength(2);
    expect(evs[1].mcpServers).toEqual([{ name: 'other', status: 'failed' }]);
  });

  it('needs-auth / pending are LOG-ONLY — no client signal, no warn (false-alarm guard)', () => {
    const s = newSession('mcp-6');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const cap = captureStream();

    mgr.reportMcpServers(s, [
      { name: 'claude.ai Gmail', status: 'pending' },
      { name: 'claude.ai Calendar', status: 'needs-auth' },
    ]);
    cap.stop();

    // No client-facing "failed" signal for benign states.
    expect(cap.events.filter(e => e.sessionId === 'mcp-6' && e.mcpServers)).toHaveLength(0);
    // Logged at info (diagnosis), never warn.
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('sdk.mcp', expect.any(String), expect.objectContaining({
      sessionId: 'mcp-6',
      data: { servers: [
        { name: 'claude.ai Gmail', status: 'pending' },
        { name: 'claude.ai Calendar', status: 'needs-auth' },
      ] },
    }));
  });

  it('a mixed init signals ONLY the failed servers, not the benign ones', () => {
    const s = newSession('mcp-7');
    const cap = captureStream();
    mgr.reportMcpServers(s, [
      { name: 'codemogger', status: 'failed' },
      { name: 'claude.ai Gmail', status: 'pending' },
    ]);
    cap.stop();
    const ev = cap.events.find(e => e.sessionId === 'mcp-7' && e.mcpServers);
    expect(ev!.mcpServers).toEqual([{ name: 'codemogger', status: 'failed' }]);
  });

  it('clears the banner on recovery (failed → connected) with an empty signal', () => {
    const s = newSession('mcp-8');
    const cap = captureStream();
    mgr.reportMcpServers(s, [{ name: 'codemogger', status: 'failed' }]);
    mgr.reportMcpServers(s, [{ name: 'codemogger', status: 'connected' }]); // recovered
    cap.stop();
    const evs = cap.events.filter(e => e.sessionId === 'mcp-8' && e.mcpServers);
    expect(evs).toHaveLength(2);
    expect(evs[0].mcpServers).toEqual([{ name: 'codemogger', status: 'failed' }]);
    expect(evs[1].mcpServers).toEqual([]); // clear
    expect(mgr.getMcpFailed('mcp-8')).toEqual([]); // durable state cleared too
  });

  it('a benign transition does NOT re-emit the failed banner (dedup on failed set only)', () => {
    const s = newSession('mcp-9');
    const cap = captureStream();
    // codemogger stays failed across both inits; only the benign connector moves.
    mgr.reportMcpServers(s, [
      { name: 'codemogger', status: 'failed' },
      { name: 'claude.ai Gmail', status: 'pending' },
    ]);
    mgr.reportMcpServers(s, [
      { name: 'codemogger', status: 'failed' },
      { name: 'claude.ai Gmail', status: 'connected' }, // benign transition
    ]);
    cap.stop();
    // Exactly ONE failed signal — the benign move must not re-fire it.
    expect(cap.events.filter(e => e.sessionId === 'mcp-9' && e.mcpServers)).toHaveLength(1);
    expect(mgr.getMcpFailed('mcp-9')).toEqual([{ name: 'codemogger', status: 'failed' }]);
  });

  it('ignores a non-array payload', () => {
    const s = newSession('mcp-5');
    const cap = captureStream();
    mgr.reportMcpServers(s, undefined);
    mgr.reportMcpServers(s, null);
    cap.stop();
    expect(cap.events.filter(e => e.sessionId === 'mcp-5' && e.mcpServers)).toHaveLength(0);
  });
});
