import { describe, it, expect } from 'vitest';
import {
  isServerRuntimeFailed,
  runtimeIdentity,
  CODESEARCH_MCP_SERVER_NAME,
  CODESEARCH_DISPLAY_NAME,
} from '@/lib/mcpRuntimeStatus';

/**
 * P16 (docs/ticket-sdk-branch-premerge-review.md): the synthetic code-search row
 * is displayed as "This Project (Local MCP)" but the in-process engine reports
 * runtime failures as `codemogger`. Matching health by display name meant an
 * embedder/onnx init failure kept showing a green "connected" check.
 */

/** Stand-in for the row shape the API returns for in-process code search. */
const codeSearchRow = {
  name: CODESEARCH_DISPLAY_NAME,
  runtimeName: CODESEARCH_MCP_SERVER_NAME,
};

describe('runtimeIdentity', () => {
  it('prefers the explicit runtime name', () => {
    expect(runtimeIdentity(codeSearchRow)).toBe('codemogger');
  });

  it('falls back to the display name for real config-registered servers', () => {
    expect(runtimeIdentity({ name: 'sqlite' })).toBe('sqlite');
  });
});

describe('isServerRuntimeFailed', () => {
  it('flags the code-search row when the engine failed under its runtime name', () => {
    // This is the exact P16 regression: the failure report says `codemogger`,
    // the row says "This Project (Local MCP)".
    const failed = new Set([CODESEARCH_MCP_SERVER_NAME]);
    expect(isServerRuntimeFailed(codeSearchRow, failed)).toBe(true);
  });

  it('leaves the code-search row healthy when nothing failed', () => {
    expect(isServerRuntimeFailed(codeSearchRow, new Set())).toBe(false);
    expect(isServerRuntimeFailed(codeSearchRow, new Set(['sqlite']))).toBe(false);
  });

  it('does NOT flag the row by its display label', () => {
    // Nothing reports failures under the friendly label; a match here would mean
    // the identities got crossed again.
    expect(isServerRuntimeFailed(codeSearchRow, new Set([CODESEARCH_DISPLAY_NAME]))).toBe(false);
  });

  it('still matches ordinary servers by name', () => {
    const failed = new Set(['sqlite']);
    expect(isServerRuntimeFailed({ name: 'sqlite' }, failed)).toBe(true);
    expect(isServerRuntimeFailed({ name: 'github' }, failed)).toBe(false);
  });

  it('does not cross-contaminate: a failed codemogger leaves other rows healthy', () => {
    const failed = new Set([CODESEARCH_MCP_SERVER_NAME]);
    expect(isServerRuntimeFailed({ name: 'github' }, failed)).toBe(false);
  });

  it('flags a real MCP server that happens to be named codemogger', () => {
    // A legacy stdio `codemogger` entry (pre-migration) has no runtimeName, so it
    // matches by name — which is correct: it IS the server that failed.
    expect(isServerRuntimeFailed({ name: 'codemogger' }, new Set(['codemogger']))).toBe(true);
  });
});

describe('identity constants', () => {
  it('are distinct — the whole premise of the bug', () => {
    expect(CODESEARCH_MCP_SERVER_NAME).not.toBe(CODESEARCH_DISPLAY_NAME);
  });

  it('match what lib/codemoggerServer registers with the SDK', async () => {
    // Guards against the constant drifting away from the actual SDK server name.
    const { readFileSync } = await import('fs');
    const src = readFileSync('lib/codemoggerServer.ts', 'utf-8');
    expect(src).toMatch(/name:\s*CODESEARCH_MCP_SERVER_NAME/);
  });
});
