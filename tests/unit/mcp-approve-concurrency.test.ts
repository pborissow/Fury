/**
 * B2 (docs/ticket-local-mcp-this-project-fails-first-use.md):
 * approveProjectServer must not lose its enable under concurrent writers to the
 * shared ~/.claude.json. The old unlocked read-modify-write dropped it (classic
 * lost update); the hardened version re-reads before writing, swaps atomically,
 * and verifies-with-retry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { approveProjectServer } from '../../lib/mcpApprove';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratchCfg(seed: unknown = {}): Promise<{ cfgPath: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), 'fury-claude-json-'));
  dirs.push(base);
  const cfgPath = join(base, '.claude.json');
  await writeFile(cfgPath, JSON.stringify(seed, null, 2));
  return { cfgPath, project: 'U:/some/project' };
}

async function readEnabled(cfgPath: string, project: string): Promise<string[]> {
  const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
  return cfg?.projects?.[project.replace(/\\/g, '/')]?.enabledMcpjsonServers ?? [];
}

describe('approveProjectServer (B2)', () => {
  it('adds the enable to a fresh/untrusted project', async () => {
    const { cfgPath, project } = await scratchCfg();
    const ok = await approveProjectServer(cfgPath, project, 'codemogger');
    expect(ok).toBe(true);
    expect(await readEnabled(cfgPath, project)).toContain('codemogger');
  });

  it('is idempotent — no duplicate entries', async () => {
    const { cfgPath, project } = await scratchCfg();
    await approveProjectServer(cfgPath, project, 'codemogger');
    await approveProjectServer(cfgPath, project, 'codemogger');
    expect(await readEnabled(cfgPath, project)).toEqual(['codemogger']);
  });

  it('removes the server from disabledMcpjsonServers if present', async () => {
    const { cfgPath, project } = await scratchCfg({
      projects: { 'U:/some/project': { disabledMcpjsonServers: ['codemogger'], enabledMcpjsonServers: [] } },
    });
    await approveProjectServer(cfgPath, project, 'codemogger');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    const entry = cfg.projects['U:/some/project'];
    expect(entry.enabledMcpjsonServers).toContain('codemogger');
    expect(entry.disabledMcpjsonServers).not.toContain('codemogger');
  });

  it('survives a competing writer clobbering the file (verify-retry)', async () => {
    const { cfgPath, project } = await scratchCfg();

    // A noisy competitor that keeps rewriting ~/.claude.json with unrelated
    // session metadata (mirrors what real Claude processes do), racing the
    // approve. Without the re-read+verify-retry the approve's enable is lost.
    let stop = false;
    const competitor = (async () => {
      for (let i = 0; !stop && i < 200; i++) {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, 'utf-8').catch(() => '{}'));
          cfg.numStartups = (cfg.numStartups ?? 0) + 1;
          cfg.lastNote = `write-${i}`;
          await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
        } catch { /* ignore races on the file itself */ }
        await new Promise(r => setTimeout(r, 1));
      }
    })();

    const ok = await approveProjectServer(cfgPath, project, 'codemogger');
    stop = true;
    await competitor;

    expect(ok).toBe(true);
    // Final state: our enable is present AND the competitor's key also survived
    // (we merge onto the latest read, not a stale snapshot).
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    expect(cfg.projects[project.replace(/\\/g, '/')].enabledMcpjsonServers).toContain('codemogger');
    expect(typeof cfg.numStartups).toBe('number');
  });

  it('N concurrent approvals for different servers all land', async () => {
    const { cfgPath, project } = await scratchCfg();
    const names = ['srv-a', 'srv-b', 'srv-c', 'srv-d', 'srv-e'];
    await Promise.all(names.map(n => approveProjectServer(cfgPath, project, n)));
    const enabled = await readEnabled(cfgPath, project);
    for (const n of names) expect(enabled).toContain(n);
  });
});
