/**
 * Minimal stdio MCP server used only by tests/live-sessions/mcp-coexistence.spec.ts.
 *
 * Exposes ONE tool, `fixture_ping`, returning a distinctive token. Its sole purpose is
 * to be a REAL project `.mcp.json` MCP server that a session loads alongside the
 * in-process code-search server — so the test can prove code search
 * (`options.mcpServers`) doesn't shadow a project's own MCP servers
 * (docs/ticket-codesearch-inprocess-mcp-macos-contention.md, review follow-up #3).
 *
 * Imports resolve from THIS file's location (the Fury repo's node_modules), so the CLI
 * can spawn it with any cwd.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.tool(
  'fixture_ping',
  'Return a distinctive fixture token, proving this project MCP server loaded.',
  async () => ({ content: [{ type: 'text', text: 'fixture-pong-zappaflux' }] }),
);

await server.connect(new StdioServerTransport());
