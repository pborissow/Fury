'use client';

import { useState, useCallback } from 'react';
import { Plus, RotateCcw, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Dialog from '@/components/Dialog';

interface McpServer {
  name: string;
  url: string;
  status: string;
  statusDetail: string;
}

export default function McpPanel() {
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const fetchMcpServers = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const res = await fetch('/api/mcp');
      const data = await res.json();
      setMcpServers(data.servers || []);
      if (data.error) setMcpError(data.error);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to fetch MCP servers');
    } finally {
      setMcpLoading(false);
    }
  }, []);

  // Add MCP server dialog
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpForm, setMcpForm] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', commandOrUrl: '', args: '', envVars: '', scope: 'user' as 'local' | 'user' | 'project' });
  const [mcpAddLoading, setMcpAddLoading] = useState(false);
  const [mcpAddError, setMcpAddError] = useState<string | null>(null);

  const handleAddMcpServer = useCallback(async () => {
    setMcpAddLoading(true);
    setMcpAddError(null);
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpForm),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setMcpAddError(data.error || 'Failed to add server');
        return;
      }
      setShowAddMcp(false);
      setMcpForm({ name: '', transport: 'stdio', commandOrUrl: '', args: '', envVars: '', scope: 'user' });
      fetchMcpServers();
    } catch (err) {
      setMcpAddError(err instanceof Error ? err.message : 'Failed to add server');
    } finally {
      setMcpAddLoading(false);
    }
  }, [mcpForm, fetchMcpServers]);

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">MCP Servers</h3>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMcpAddError(null);
                setShowAddMcp(true);
              }}
              className="h-7 w-7 p-0"
              title="Add MCP server"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchMcpServers}
              disabled={mcpLoading}
              className="h-7 w-7 p-0"
              title="Refresh"
            >
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
              <div
                key={server.name}
                className="p-3 rounded-lg border border-border bg-muted/30"
              >
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
                <div className="mt-0.5 ml-6 text-xs text-muted-foreground">
                  {server.statusDetail}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add MCP Server Dialog */}
      <Dialog
        open={showAddMcp}
        onOpenChange={(open) => { if (!open) setShowAddMcp(false); }}
        title="Add MCP Server"
        defaultWidth={480}
        defaultHeight={520}
        minWidth={380}
        minHeight={400}
        buttons={[
          { label: 'Cancel', onClick: () => setShowAddMcp(false), variant: 'ghost' },
          { label: mcpAddLoading ? 'Adding...' : 'Add Server', onClick: handleAddMcpServer, disabled: mcpAddLoading || !mcpForm.name || !mcpForm.commandOrUrl },
        ]}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Configure a new MCP server connection.</p>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Name</label>
            <input
              type="text"
              value={mcpForm.name}
              onChange={(e) => setMcpForm(f => ({ ...f, name: e.target.value }))}
              placeholder="my-server"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Transport</label>
            <select
              value={mcpForm.transport}
              onChange={(e) => setMcpForm(f => ({ ...f, transport: e.target.value as 'stdio' | 'http' }))}
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">
              {mcpForm.transport === 'http' ? 'URL' : 'Command'}
            </label>
            <input
              type="text"
              value={mcpForm.commandOrUrl}
              onChange={(e) => setMcpForm(f => ({ ...f, commandOrUrl: e.target.value }))}
              placeholder={mcpForm.transport === 'http' ? 'https://mcp.example.com/mcp' : 'npx my-mcp-server'}
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Arguments <span className="text-muted-foreground font-normal">(optional, space-separated)</span></label>
            <input
              type="text"
              value={mcpForm.args}
              onChange={(e) => setMcpForm(f => ({ ...f, args: e.target.value }))}
              placeholder="--port 3000"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Environment variables <span className="text-muted-foreground font-normal">(optional, KEY=value per line)</span></label>
            <textarea
              value={mcpForm.envVars}
              onChange={(e) => setMcpForm(f => ({ ...f, envVars: e.target.value }))}
              placeholder={"API_KEY=xxx\nDEBUG=true"}
              rows={2}
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Scope</label>
            <select
              value={mcpForm.scope}
              onChange={(e) => setMcpForm(f => ({ ...f, scope: e.target.value as 'local' | 'user' | 'project' }))}
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="local">Local (this machine)</option>
              <option value="user">User (all projects)</option>
              <option value="project">Project (shared via repo)</option>
            </select>
          </div>
          {mcpAddError && (
            <div className="text-sm text-red-400 p-2 bg-red-500/10 rounded">
              {mcpAddError}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
