'use client';

import { useState, useCallback, useEffect } from 'react';
import { Plus, RotateCcw, Check, AlertTriangle, Terminal, Globe, ChevronRight, FileText, Pencil, Trash2, FolderOpen, Search, X, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Dialog, { ConfirmDialog } from '@/components/Dialog';
import { DirectoryPicker } from '@/components/DirectoryPicker';

interface McpServer {
  name: string;
  url: string;
  status: string;
  statusDetail: string;
  scope?: 'project' | 'user' | 'unknown';
  transport?: 'stdio' | 'http' | 'unknown';
}

interface McpForm {
  name: string;
  transport: 'stdio' | 'http' | 'codesearch';
  commandOrUrl: string;
  args: string;
  envVars: string;
  scope: 'user' | 'project';
  directories: string[];
}

type WizardStep = 'type' | 'details' | 'instructions';

const INITIAL_FORM: McpForm = {
  name: '', transport: 'stdio', commandOrUrl: '', args: '', envVars: '', scope: 'project', directories: [],
};

interface ParsedServer {
  name: string;
  url: string;
}

function deriveNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    // If last segment is "mcp", use the one before it
    if (segments.length >= 2 && segments[segments.length - 1] === 'mcp') {
      return segments[segments.length - 2];
    }
    if (segments.length >= 1 && segments[segments.length - 1] !== 'mcp') {
      return segments[segments.length - 1];
    }
    return parsed.hostname.replace(/\./g, '-');
  } catch {
    return 'mcp-server';
  }
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseUrls(text: string): ParsedServer[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && isValidUrl(l))
    .map(url => ({ name: deriveNameFromUrl(url), url }));
}

function generateTemplate(servers: ParsedServer[]): string {
  if (servers.length === 1) {
    const s = servers[0];
    return `# ${s.name}

This project uses the \`${s.name}\` MCP server.

**When to use:** Prefer \`${s.name}\` tools when [describe use case].

**Available tools:**
- \`tool_name\` — [description]
`;
  }
  const rows = servers.map(s => `| \`${s.name}\` | [description] |`).join('\n');
  return `# MCP Servers

This project uses ${servers.length} MCP servers.

| MCP Server | Description |
|------------|-------------|
${rows}

**When to use:** Prefer these MCP tools when [describe use case].
`;
}

function generateCodeSearchTemplate(name: string, directories: string[]): string {
  const dirList = directories.map(d => `- \`${d}\``).join('\n');
  return `# Code Search

This project has a \`${name}\` MCP server providing semantic and keyword code search.

Use \`codemogger_search\` BEFORE falling back to Grep or Glob when exploring the codebase.

**Directories to index on first use:**
${dirList}

Call \`codemogger_index\` for each directory above if not yet indexed.

**Search modes:**
- \`keyword\` — for identifiers, class names, method names
- \`semantic\` — for conceptual queries

Use \`includeSnippet=true\` to get full source in results.
After modifying source files, ask the user before calling \`codemogger_reindex\`.
`;
}

interface McpPanelProps {
  projectPath?: string | null;
}

export default function McpPanel({ projectPath }: McpPanelProps) {
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const fetchMcpServers = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const url = projectPath ? `/api/mcp?projectPath=${encodeURIComponent(projectPath)}` : '/api/mcp';
      const res = await fetch(url);
      const data = await res.json();
      setMcpServers(data.servers || []);
      if (data.error) setMcpError(data.error);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to fetch MCP servers');
    } finally {
      setMcpLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    fetchMcpServers();
  }, [fetchMcpServers]);

  // Wizard state
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('type');
  const [mcpForm, setMcpForm] = useState<McpForm>(INITIAL_FORM);
  const [mcpAddLoading, setMcpAddLoading] = useState(false);
  const [mcpAddError, setMcpAddError] = useState<string | null>(null);

  // Step 3: CLAUDE.md instructions
  const [instructions, setInstructions] = useState('');
  const [instructionsSaving, setInstructionsSaving] = useState(false);

  // Track what was successfully added (for step 3 display)
  const [addedServers, setAddedServers] = useState<ParsedServer[]>([]);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const handleDeleteServer = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch('/api/mcp', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: deleteTarget.name, projectPath }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setMcpError(data.error || 'Failed to remove server');
      }
      setDeleteTarget(null);
      fetchMcpServers();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to remove server');
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteTarget, projectPath, fetchMcpServers]);

  // Edit: opens wizard at step 2, pre-filled. Remove old, then re-add.
  const [editingServerName, setEditingServerName] = useState<string | null>(null);

  const handleEditServer = useCallback((server: McpServer) => {
    const isHttp = server.url.startsWith('http://') || server.url.startsWith('https://');
    setEditingServerName(server.name);
    setMcpForm({
      name: server.name,
      transport: isHttp ? 'http' : 'stdio',
      commandOrUrl: server.url,
      args: '',
      envVars: '',
      scope: server.scope === 'project' ? 'project' : 'user',
      directories: [],
    });
    setWizardStep('details');
    setMcpAddError(null);
    setInstructions('');
    setAddedServers([]);
    setShowAddMcp(true);
  }, []);

  const resetWizard = useCallback(() => {
    setWizardStep('type');
    setMcpForm(INITIAL_FORM);
    setMcpAddError(null);
    setInstructions('');
    setAddedServers([]);
    setEditingServerName(null);
  }, []);

  const openWizard = useCallback(() => {
    resetWizard();
    setShowAddMcp(true);
  }, [resetWizard]);

  const closeWizard = useCallback(() => {
    setShowAddMcp(false);
  }, []);

  // Directory picker for code search
  const [showDirPicker, setShowDirPicker] = useState(false);

  // Step 1: select transport type
  const handleSelectType = useCallback((transport: 'stdio' | 'http' | 'codesearch') => {
    setMcpForm(f => ({
      ...f,
      transport,
      name: transport === 'codesearch' && projectPath ? projectPath.split(/[/\\]/).filter(Boolean).pop() || '' : '',
      directories: transport === 'codesearch' && projectPath ? [projectPath] : [],
      scope: 'project',
    }));
    setWizardStep('details');
  }, [projectPath]);

  // Parse URLs for HTTP preview, flag duplicates against existing servers
  const httpServers = mcpForm.transport === 'http' ? parseUrls(mcpForm.commandOrUrl) : [];
  const existingNames = new Set(mcpServers.map(s => s.name));
  const existingUrls = new Set(mcpServers.map(s => s.url));
  const newHttpServers = httpServers.filter(s => !existingNames.has(s.name) && !existingUrls.has(s.url));

  // Step 2: submit details -> add server(s), then go to step 3
  const handleAddServer = useCallback(async () => {
    setMcpAddLoading(true);
    setMcpAddError(null);
    try {
      // If editing, remove the old server first
      if (editingServerName) {
        await fetch('/api/mcp', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: editingServerName, projectPath }),
        });
      }

      // Code search: translate to stdio with codemogger command
      if (mcpForm.transport === 'codesearch') {
        // Fetch homeDir to compute shared DB path
        let homeDir = '';
        try {
          const dirRes = await fetch('/api/directories');
          const dirData = await dirRes.json();
          homeDir = dirData.homeDir || '';
        } catch { /* fall through */ }

        const dbPath = homeDir ? `${homeDir}/.codemogger/index.db` : '.codemogger/index.db';

        const res = await fetch('/api/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: mcpForm.name,
            transport: 'stdio',
            commandOrUrl: 'codemogger',
            args: `--db ${dbPath} mcp`,
            envVars: '',
            scope: mcpForm.scope,
            projectPath,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMcpAddError(data.error || 'Failed to add server');
          return;
        }

        fetchMcpServers();
        setEditingServerName(null);
        setAddedServers([{ name: mcpForm.name, url: `codemogger (${mcpForm.directories.length} dirs)` }]);
        setInstructions(generateCodeSearchTemplate(mcpForm.name, mcpForm.directories));
        setWizardStep('instructions');
        return;
      }

      // Build list of servers to add (skip duplicates for batch HTTP adds)
      const servers: ParsedServer[] = mcpForm.transport === 'http' && httpServers.length > 0
        ? (httpServers.length > 1 ? newHttpServers : httpServers).map(s =>
            mcpForm.name && httpServers.length === 1 ? { ...s, name: mcpForm.name } : s)
        : [{ name: mcpForm.name, url: mcpForm.commandOrUrl }];

      if (servers.length === 0) {
        setMcpAddError('All servers already exist.');
        return;
      }

      const errors: string[] = [];
      const succeeded: ParsedServer[] = [];

      for (const server of servers) {
        const res = await fetch('/api/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mcpForm,
            name: server.name,
            commandOrUrl: server.url,
            projectPath,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          errors.push(`${server.name}: ${data.error || 'Failed'}`);
        } else {
          succeeded.push(server);
        }
      }

      if (errors.length > 0 && succeeded.length === 0) {
        setMcpAddError(errors.join('\n'));
        return;
      }

      fetchMcpServers();
      setEditingServerName(null);
      setAddedServers(succeeded);
      setInstructions(generateTemplate(succeeded));

      if (errors.length > 0) {
        setMcpAddError(`Added ${succeeded.length}/${servers.length}. Failed:\n${errors.join('\n')}`);
      }

      setWizardStep('instructions');
    } catch (err) {
      setMcpAddError(err instanceof Error ? err.message : 'Failed to add server');
    } finally {
      setMcpAddLoading(false);
    }
  }, [mcpForm, httpServers, newHttpServers, editingServerName, projectPath, fetchMcpServers]);

  // Step 3: save instructions to CLAUDE.md
  const handleSaveInstructions = useCallback(async () => {
    if (!projectPath || !instructions.trim()) return;
    setInstructionsSaving(true);
    setMcpAddError(null);
    try {
      const res = await fetch('/api/claude-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath, content: instructions.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setMcpAddError(data.error || 'Failed to update CLAUDE.md');
        return;
      }
      closeWizard();
    } catch (err) {
      setMcpAddError(err instanceof Error ? err.message : 'Failed to update CLAUDE.md');
    } finally {
      setInstructionsSaving(false);
    }
  }, [projectPath, instructions, closeWizard]);

  // --- Dialog config per step ---
  const stepTitle = {
    type: 'Add MCP Server',
    details: editingServerName
      ? `Edit: ${editingServerName}`
      : mcpForm.transport === 'codesearch' ? 'Code Search'
        : mcpForm.transport === 'stdio' ? 'Local Process' : 'Remote Server',
    instructions: 'Usage Instructions',
  }[wizardStep];

  const stepIndicator = editingServerName ? undefined : (
    <span className="text-xs text-muted-foreground">
      Step {wizardStep === 'type' ? 1 : wizardStep === 'details' ? 2 : 3} of 3
    </span>
  );

  const dialogButtons = (() => {
    switch (wizardStep) {
      case 'type':
        return [
          { label: 'Cancel', onClick: closeWizard, variant: 'ghost' as const },
        ];
      case 'details': {
        const isHttp = mcpForm.transport === 'http';
        const isCodeSearch = mcpForm.transport === 'codesearch';
        const isBatch = isHttp && httpServers.length > 1;
        const addableCount = isBatch ? newHttpServers.length : (isHttp ? httpServers.length : 1);
        const isValid = isCodeSearch
          ? !!mcpForm.name && mcpForm.directories.length > 0
          : isHttp
            ? isBatch ? addableCount > 0 : (httpServers.length > 0 && !!mcpForm.name)
            : !!mcpForm.name && !!mcpForm.commandOrUrl;
        const addLabel = mcpAddLoading
          ? (editingServerName ? 'Saving...' : 'Adding...')
          : editingServerName
            ? 'Save'
            : addableCount > 1
              ? `Add ${addableCount} Servers`
              : 'Add Server';
        return [
          editingServerName
            ? { label: 'Cancel', onClick: closeWizard, variant: 'ghost' as const }
            : { label: 'Back', onClick: () => setWizardStep('type'), variant: 'ghost' as const },
          {
            label: addLabel,
            onClick: handleAddServer,
            disabled: mcpAddLoading || !isValid,
          },
        ];
      }
      case 'instructions':
        return [
          { label: 'Skip', onClick: closeWizard, variant: 'ghost' as const },
          {
            label: instructionsSaving ? 'Saving...' : 'Save to CLAUDE.md',
            onClick: handleSaveInstructions,
            disabled: instructionsSaving || !instructions.trim() || !projectPath,
          },
        ];
    }
  })();

  const inputClass = "w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">MCP Servers</h3>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={openWizard} className="h-7 w-7 p-0" title="Add MCP server">
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={fetchMcpServers} disabled={mcpLoading} className="h-7 w-7 p-0" title="Refresh">
              <RotateCcw className={`h-3.5 w-3.5 ${mcpLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        {mcpLoading && mcpServers.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Loading MCP servers...
          </div>
        ) : mcpError && mcpServers.length === 0 ? (
          <div className="text-sm text-red-400 p-3 bg-red-500/10 rounded">
            {mcpError}
          </div>
        ) : mcpServers.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            No MCP servers configured.
          </div>
        ) : (
          <div className="space-y-2">
            {mcpServers.map((server) => (
              <div key={server.name} className="group/mcp relative p-3 rounded-lg border border-border bg-muted/30">
                <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/mcp:opacity-100 transition-opacity flex items-center gap-0.5 z-10">
                  <button
                    className="cursor-pointer p-1 rounded hover:bg-yellow-500/20 text-muted-foreground hover:text-yellow-500"
                    title="Edit server"
                    onClick={() => handleEditServer(server)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="cursor-pointer p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                    title="Remove server"
                    onClick={() => setDeleteTarget(server)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {server.status === 'connected' ? (
                    <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                  ) : server.status === 'needs_auth' ? (
                    <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
                  ) : server.status === 'error' ? (
                    <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
                  ) : (
                    <span className="h-4 w-4 flex items-center justify-center text-muted-foreground flex-shrink-0">?</span>
                  )}
                  <span className="text-sm font-medium text-foreground truncate">{server.name}</span>
                </div>
                <div className="mt-1 ml-6 text-xs text-muted-foreground truncate" title={server.url}>
                  {server.url}
                </div>
                <div className="mt-1 ml-6 flex items-center gap-2 text-xs text-muted-foreground">
                  {server.transport && server.transport !== 'unknown' && (
                    <span className="flex items-center gap-1" title={server.transport === 'http' ? 'Remote server (HTTP)' : 'Local process (stdio)'}>
                      {server.transport === 'http'
                        ? <Globe className="h-3 w-3" />
                        : <Terminal className="h-3 w-3" />}
                      {server.transport}
                    </span>
                  )}
                  {server.scope && server.scope !== 'unknown' && (
                    <span className="flex items-center gap-1" title={server.scope === 'project' ? 'This project only' : 'All projects'}>
                      {server.scope === 'project'
                        ? <FolderOpen className="h-3 w-3" />
                        : <Monitor className="h-3 w-3" />}
                      {server.scope === 'project' ? 'project' : 'all projects'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add MCP Server Wizard */}
      <Dialog
        open={showAddMcp}
        onOpenChange={(open) => { if (!open) closeWizard(); }}
        title={stepTitle}
        headerActions={stepIndicator}
        defaultWidth={500}
        defaultHeight={560}
        minWidth={400}
        minHeight={300}
        buttons={dialogButtons}
      >
        {/* Step 1: Type selection */}
        {wizardStep === 'type' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">What type of MCP server do you want to add?</p>
            <button
              onClick={() => handleSelectType('codesearch')}
              className="w-full flex items-center gap-3 p-4 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 hover:border-foreground/20 transition-colors text-left group"
            >
              <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center flex-shrink-0">
                <Search className="h-5 w-5 text-orange-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">This project</div>
                <div className="text-xs text-muted-foreground mt-0.5">Index and search your project code locally</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
            </button>
            <button
              onClick={() => handleSelectType('stdio')}
              className="w-full flex items-center gap-3 p-4 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 hover:border-foreground/20 transition-colors text-left group"
            >
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                <Terminal className="h-5 w-5 text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">Local process</div>
                <div className="text-xs text-muted-foreground mt-0.5">Run a custom MCP server command (stdio)</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
            </button>
            <button
              onClick={() => handleSelectType('http')}
              className="w-full flex items-center gap-3 p-4 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 hover:border-foreground/20 transition-colors text-left group"
            >
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0">
                <Globe className="h-5 w-5 text-green-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">Remote server</div>
                <div className="text-xs text-muted-foreground mt-0.5">Connects to a URL (http)</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
            </button>
          </div>
        )}

        {/* Step 2: Code Search details */}
        {wizardStep === 'details' && mcpForm.transport === 'codesearch' && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground block mb-1">Name</label>
              <input
                type="text"
                value={mcpForm.name}
                onChange={(e) => setMcpForm(f => ({ ...f, name: e.target.value }))}
                placeholder="my-project"
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground block mb-1">Directories to index</label>
              <div className="space-y-1.5">
                {mcpForm.directories.map((dir, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-muted/40 border border-border">
                    <FolderOpen className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-foreground truncate flex-1 font-mono" title={dir}>{dir}</span>
                    <button
                      className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive flex-shrink-0"
                      onClick={() => setMcpForm(f => ({ ...f, directories: f.directories.filter((_, j) => j !== i) }))}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 text-xs"
                onClick={() => setShowDirPicker(true)}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add directory
              </Button>
            </div>
            {mcpAddError && (
              <div className="text-sm text-red-400 p-2 bg-red-500/10 rounded whitespace-pre-wrap">
                {mcpAddError}
              </div>
            )}
          </div>
        )}

        {/* Step 2: stdio / http details */}
        {wizardStep === 'details' && mcpForm.transport !== 'codesearch' && (
          <div className="space-y-4">
            {/* Name: show for stdio always, for http only when single URL */}
            {(mcpForm.transport === 'stdio' || httpServers.length <= 1) && (
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">Name</label>
                <input
                  type="text"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="my-server"
                  className={inputClass}
                  autoFocus
                />
              </div>
            )}
            {mcpForm.transport === 'http' ? (
              <div>
                {editingServerName ? (
                  <>
                    <label className="text-sm font-medium text-foreground block mb-1">URL</label>
                    <input
                      type="text"
                      value={mcpForm.commandOrUrl}
                      onChange={(e) => setMcpForm(f => ({ ...f, commandOrUrl: e.target.value }))}
                      placeholder="https://mcp.example.com/mcp"
                      className={inputClass}
                    />
                  </>
                ) : (
                  <>
                    <label className="text-sm font-medium text-foreground block mb-1">
                      URL(s) <span className="text-muted-foreground font-normal">(one per line)</span>
                    </label>
                    <textarea
                      value={mcpForm.commandOrUrl}
                      onChange={(e) => setMcpForm(f => ({ ...f, commandOrUrl: e.target.value }))}
                      placeholder={"https://mcp.example.com/mcp\nhttps://another-server.com/mcp"}
                      rows={4}
                      className={`${inputClass} resize-none font-mono text-xs`}
                      autoFocus={httpServers.length > 1 || !mcpForm.name}
                    />
                  </>
                )}
                {httpServers.length > 1 && (
                  <div className="mt-2 space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">
                      {newHttpServers.length > 0
                        ? `${newHttpServers.length} server${newHttpServers.length === 1 ? '' : 's'} will be added:`
                        : 'All servers already exist.'}
                    </div>
                    {httpServers.map((s, i) => {
                      const isDuplicate = existingNames.has(s.name) || existingUrls.has(s.url);
                      return (
                        <div key={i} className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${isDuplicate ? 'bg-muted/20 opacity-50' : 'bg-muted/40'}`}>
                          <span className="font-medium text-foreground">{s.name}</span>
                          <span className="text-muted-foreground truncate flex-1">{s.url}</span>
                          {isDuplicate && <span className="text-yellow-500 flex-shrink-0">exists</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">Command</label>
                <input
                  type="text"
                  value={mcpForm.commandOrUrl}
                  onChange={(e) => setMcpForm(f => ({ ...f, commandOrUrl: e.target.value }))}
                  placeholder="npx my-mcp-server"
                  className={inputClass}
                />
              </div>
            )}
            {mcpForm.transport === 'stdio' && (
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">
                  Arguments <span className="text-muted-foreground font-normal">(optional, space-separated)</span>
                </label>
                <input
                  type="text"
                  value={mcpForm.args}
                  onChange={(e) => setMcpForm(f => ({ ...f, args: e.target.value }))}
                  placeholder="--port 3000"
                  className={inputClass}
                />
              </div>
            )}
            {mcpForm.transport === 'stdio' && (
              <div>
                <label className="text-sm font-medium text-foreground block mb-1">
                  Environment variables <span className="text-muted-foreground font-normal">(optional, KEY=value per line)</span>
                </label>
                <textarea
                  value={mcpForm.envVars}
                  onChange={(e) => setMcpForm(f => ({ ...f, envVars: e.target.value }))}
                  placeholder={"API_KEY=xxx\nDEBUG=true"}
                  rows={2}
                  className={`${inputClass} resize-none`}
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-foreground block mb-1">Scope</label>
              <select
                value={mcpForm.scope}
                onChange={(e) => setMcpForm(f => ({ ...f, scope: e.target.value as 'user' | 'project' }))}
                className={inputClass}
              >
                <option value="project">This project</option>
                <option value="user">All projects</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {mcpForm.scope === 'project'
                  ? 'Only available when working in the current project directory.'
                  : 'Available across all your projects.'}
              </p>
            </div>
            {mcpAddError && (
              <div className="text-sm text-red-400 p-2 bg-red-500/10 rounded whitespace-pre-wrap">
                {mcpAddError}
              </div>
            )}
          </div>
        )}

        {/* Step 3: CLAUDE.md instructions */}
        {wizardStep === 'instructions' && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <Check className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-green-400">
                {addedServers.length === 1 ? (
                  <><span className="font-medium">{addedServers[0].name}</span> added successfully.</>
                ) : (
                  <><span className="font-medium">{addedServers.length} servers</span> added successfully.</>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">
                Optionally add usage instructions to your project&apos;s <span className="font-mono text-foreground">CLAUDE.md</span> so Claude knows when and how to use this MCP server.
              </p>
            </div>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={10}
              className={`${inputClass} resize-none font-mono text-xs`}
            />
            {!projectPath && (
              <div className="text-xs text-yellow-400">
                No project path available. Open a session to enable saving to CLAUDE.md.
              </div>
            )}
            {mcpAddError && (
              <div className="text-sm text-red-400 p-2 bg-red-500/10 rounded">
                {mcpAddError}
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Directory picker for code search */}
      <DirectoryPicker
        open={showDirPicker}
        onOpenChange={setShowDirPicker}
        initialPath={projectPath || undefined}
        onSelect={(path) => {
          if (!mcpForm.directories.includes(path)) {
            setMcpForm(f => ({ ...f, directories: [...f.directories, path] }));
          }
          setShowDirPicker(false);
        }}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Remove MCP Server"
        message={<>Remove <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This will unregister it from Claude.</>}
        confirmLabel={deleteLoading ? 'Removing...' : 'Remove'}
        confirmVariant="destructive"
        onConfirm={handleDeleteServer}
      />
    </>
  );
}
