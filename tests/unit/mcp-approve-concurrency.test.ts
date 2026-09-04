/**
 * B2, retargeted (docs/ticket-mcp-auto-approve-stale-trust-store.md):
 * approveProjectServer now writes the CLI's canonical approval store,
 * `<project>/.claude/settings.local.json`, and must not lose its enable under
 * concurrent writers — the CLI's approval dialog and startup migration write
 * the same file. The file is SHARED (it also holds `permissions` etc.), so
 * unrelated keys must survive every write, and an existing-but-corrupt file
 * must never be clobbered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { approveProjectServer, isProjectServerApproved, localSettingsPath, overlayLocalApprovals } from '../../lib/mcpApprove';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A scratch PROJECT dir; optionally seed .claude/settings.local.json. */
async function scratchProject(seed?: unknown): Promise<{ project: string; settingsPath: string }> {
  const project = await mkdtemp(join(tmpdir(), 'fury-mcp-approve-'));
  dirs.push(project);
  const settingsPath = localSettingsPath(project);
  if (seed !== undefined) {
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(settingsPath, typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2));
  }
  return { project, settingsPath };
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, 'utf-8'));
}

describe('approveProjectServer (settings.local.json)', () => {
  it('creates .claude/settings.local.json on a fresh project and lands the enable', async () => {
    const { project, settingsPath } = await scratchProject(); // no .claude dir at all
    const ok = await approveProjectServer(project, 'codemogger');
    expect(ok).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect((await readSettings(settingsPath)).enabledMcpjsonServers).toContain('codemogger');
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(true);
  });

  it('is idempotent — no duplicate entries, no rewrite needed', async () => {
    const { project, settingsPath } = await scratchProject();
    await approveProjectServer(project, 'codemogger');
    await approveProjectServer(project, 'codemogger');
    expect((await readSettings(settingsPath)).enabledMcpjsonServers).toEqual(['codemogger']);
  });

  it('removes the server from disabledMcpjsonServers (the state that actually blocks loading)', async () => {
    const { project, settingsPath } = await scratchProject({
      disabledMcpjsonServers: ['codemogger', 'other'],
      enabledMcpjsonServers: [],
    });
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(false);
    await approveProjectServer(project, 'codemogger');
    const cfg = await readSettings(settingsPath);
    expect(cfg.enabledMcpjsonServers).toContain('codemogger');
    expect(cfg.disabledMcpjsonServers).toEqual(['other']); // ours cleared, other's kept
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(true);
  });

  it('preserves unrelated keys byte-for-byte semantically (the file is shared)', async () => {
    const permissions = {
      allow: ['Bash(npm run dev)', 'Bash(git status:*)'],
      deny: ['WebFetch'],
    };
    const { project, settingsPath } = await scratchProject({
      permissions,
      enableAllProjectMcpServers: false,
      someFutureCliKey: { nested: [1, 2, 3] },
      enabledMcpjsonServers: ['pre-existing'],
    });
    await approveProjectServer(project, 'codemogger');
    const cfg = await readSettings(settingsPath);
    expect(cfg.permissions).toEqual(permissions);
    expect(cfg.enableAllProjectMcpServers).toBe(false);
    expect(cfg.someFutureCliKey).toEqual({ nested: [1, 2, 3] });
    expect(cfg.enabledMcpjsonServers).toEqual(['pre-existing', 'codemogger']);
  });

  it('refuses to clobber an existing file that is not valid JSON', async () => {
    const { project, settingsPath } = await scratchProject('{ "permissions": { OOPS');
    const ok = await approveProjectServer(project, 'codemogger', { maxAttempts: 2, backoffMs: 1 });
    expect(ok).toBe(false);
    // The broken content is still there for the user to repair — not replaced.
    expect(await readFile(settingsPath, 'utf-8')).toBe('{ "permissions": { OOPS');
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(false);
  });

  it('survives a competing writer clobbering the file (verify-retry)', async () => {
    const { project, settingsPath } = await scratchProject({ permissions: { allow: ['Bash(ls:*)'] } });

    // A noisy competitor that keeps rewriting settings.local.json with unrelated
    // content (mirrors the CLI's own dialog/migration writes), racing the
    // approve. Without the re-read+verify-retry the approve's enable is lost.
    let stop = false;
    const competitor = (async () => {
      for (let i = 0; !stop && i < 200; i++) {
        try {
          const cfg = JSON.parse(await readFile(settingsPath, 'utf-8').catch(() => '{}'));
          cfg.permissions = { allow: ['Bash(ls:*)', `Bash(write-${i}:*)`] };
          await writeFile(settingsPath, JSON.stringify(cfg, null, 2));
        } catch { /* ignore races on the file itself */ }
        await new Promise(r => setTimeout(r, 1));
      }
    })();

    const ok = await approveProjectServer(project, 'codemogger');
    stop = true;
    await competitor;

    expect(ok).toBe(true);
    // Final state: our enable is present AND the competitor's key also survived
    // (we merge onto the latest read, not a stale snapshot).
    const cfg = await readSettings(settingsPath);
    expect(cfg.enabledMcpjsonServers).toContain('codemogger');
    expect(cfg.permissions).toBeTruthy();
  });

  it('N concurrent approvals for different servers all land', async () => {
    const { project, settingsPath } = await scratchProject();
    const names = ['srv-a', 'srv-b', 'srv-c', 'srv-d', 'srv-e'];
    await Promise.all(names.map(n => approveProjectServer(project, n)));
    const enabled = (await readSettings(settingsPath)).enabledMcpjsonServers as string[];
    for (const n of names) expect(enabled).toContain(n);
  });
});

describe('overlayLocalApprovals (panel false-negative fix)', () => {
  const row = (name: string, scope: string, status: string, statusDetail = '⏸ Pending approval (run `claude` to approve)') =>
    ({ name, scope, status, statusDetail });

  it('upgrades a project-scoped pending row that Fury approved in settings.local.json', async () => {
    const { project } = await scratchProject({ enabledMcpjsonServers: ['javaxt-core'] });
    const out = await overlayLocalApprovals(project, [row('javaxt-core', 'project', 'pending')]);
    expect(out[0].status).toBe('connected');
    expect(out[0].statusDetail).toContain('Approved (Fury');
  });

  it('leaves unapproved pending, non-project, and real CLI verdicts untouched', async () => {
    const { project } = await scratchProject({ enabledMcpjsonServers: ['approved-one'] });
    const rows = [
      row('not-approved', 'project', 'pending'),          // no approval → keep pending
      row('approved-one', 'user', 'pending'),             // user scope → CLI verdict stands
      row('approved-one', 'project', 'error', '✗ Failed'),// real connection attempt → keep
      row('approved-one', 'project', 'connected', '✔ Connected'),
    ];
    const out = await overlayLocalApprovals(project, rows);
    expect(out.map(r => r.status)).toEqual(['pending', 'pending', 'error', 'connected']);
    expect(out[2].statusDetail).toBe('✗ Failed');
  });

  it('does not upgrade a server that is enabled AND explicitly disabled (disable wins)', async () => {
    const { project } = await scratchProject({
      enabledMcpjsonServers: ['both'], disabledMcpjsonServers: ['both'],
    });
    const out = await overlayLocalApprovals(project, [row('both', 'project', 'pending')]);
    expect(out[0].status).toBe('pending');
  });

  it('is a no-op without a projectPath', async () => {
    const rows = [row('x', 'project', 'pending')];
    expect(await overlayLocalApprovals(null, rows)).toEqual(rows);
  });
});

describe('isProjectServerApproved', () => {
  it('false when the file is missing', async () => {
    const { project } = await scratchProject();
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(false);
  });

  it('false when enabled but ALSO disabled (an explicit disable wins)', async () => {
    const { project } = await scratchProject({
      enabledMcpjsonServers: ['codemogger'],
      disabledMcpjsonServers: ['codemogger'],
    });
    expect(await isProjectServerApproved(project, 'codemogger')).toBe(false);
  });
});
