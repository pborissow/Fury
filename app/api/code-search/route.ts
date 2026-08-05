import { NextRequest, NextResponse } from 'next/server';
import { mcpCache } from '@/lib/mcpCache';
import { ensureGitignoredIfRepo } from '@/lib/mcpArgs';
import { codemoggerReindexer } from '@/lib/codemoggerReindex';
import { dropProject, searchProject } from '@/lib/codemoggerServer';
import {
  readCodeSearchConfig,
  writeCodeSearchConfig,
  removeCodeSearchConfig,
  stripStdioCodemogger,
  migrateStdioCodemogger,
  codeSearchDbPath,
  hasIndexDb,
} from '@/lib/codeSearchConfig';

/**
 * "This project" code search — the IN-PROCESS replacement for the stdio codemogger
 * MCP registration (docs/ticket-codesearch-inprocess-mcp-macos-contention.md).
 *
 *   GET    ?projectPath=…            → { enabled, dirs, dbExists } (auto-migrates a
 *                                       legacy stdio codemogger entry first).
 *   GET    ?projectPath=…&q=…&mode=… → { results } — search the in-process index
 *                                       through the ONE process that owns the DB
 *                                       (preserves single-writer; used for
 *                                       observability/tests, no separate process).
 *   POST   { projectPath, dirs } → enable: write the config, gitignore `.codemogger/`,
 *                            strip any legacy stdio codemogger entry (acceptance #5),
 *                            and kick off the initial in-process index.
 *   DELETE { projectPath } → disable: remove the config, stop the watcher, and close
 *                            the in-process DB connection.
 *
 * Enabling registers NO MCP server — search runs inside Fury's process (attached via
 * options.mcpServers in the SDK session manager), so there's no separate codemogger
 * process contending on the index DB.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const projectPath = params.get('projectPath');
  if (!projectPath) return NextResponse.json({ enabled: false, dirs: [] });
  try {
    // Search mode: run the query IN THIS process (the single DB owner) so the index
    // can be observed without a second connection. Mutex-serialized with reindex.
    const q = params.get('q');
    if (q) {
      const modeParam = params.get('mode');
      const mode = modeParam === 'keyword' ? 'keyword' : 'semantic';
      const limit = Number(params.get('limit')) || 10;
      const results = await searchProject(projectPath, codeSearchDbPath(projectPath), q, { mode, limit });
      return NextResponse.json({ results });
    }

    // Fold a legacy stdio registration into the in-process model on read.
    if (migrateStdioCodemogger(projectPath)) {
      mcpCache.invalidate(projectPath, 'project').catch(() => { /* background */ });
    }
    const cfg = readCodeSearchConfig(projectPath);
    return NextResponse.json({
      enabled: !!cfg,
      dirs: cfg?.dirs ?? [],
      dbExists: hasIndexDb(projectPath),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CodeSearch API] GET error:', message);
    return NextResponse.json({ enabled: false, dirs: [], error: message }, { status: 200 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { projectPath, dirs } = await request.json();
    if (!projectPath || typeof projectPath !== 'string') {
      return NextResponse.json({ error: 'projectPath is required' }, { status: 400 });
    }
    const cleanDirs = Array.isArray(dirs) ? dirs.map((d: unknown) => String(d)).filter(Boolean) : [];

    // Enable: persist config, keep the index DB out of git, and remove any legacy
    // stdio codemogger entry so the CLI never re-spawns the competing process.
    writeCodeSearchConfig(projectPath, cleanDirs);
    await ensureGitignoredIfRepo(projectPath, '.codemogger/');
    const removedStdio = stripStdioCodemogger(projectPath);

    // Kick off the initial index in-process (fire-and-forget; logged inside). The
    // first call lazily loads the embedder — the wizard returns immediately.
    void codemoggerReindexer.reindexNow(projectPath).catch(() => { /* logged inside */ });

    mcpCache.invalidate(projectPath, 'project').catch(() => { /* background */ });
    return NextResponse.json({
      success: true,
      enabled: true,
      dirs: cleanDirs.length ? cleanDirs : [projectPath],
      removedStdio,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CodeSearch API] POST error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { projectPath } = await request.json();
    if (!projectPath || typeof projectPath !== 'string') {
      return NextResponse.json({ error: 'projectPath is required' }, { status: 400 });
    }
    removeCodeSearchConfig(projectPath);
    codemoggerReindexer.stopWatching(projectPath);
    await dropProject(projectPath); // close the in-process DB connection
    mcpCache.invalidate(projectPath, 'project').catch(() => { /* background */ });
    return NextResponse.json({ success: true, enabled: false });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CodeSearch API] DELETE error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
