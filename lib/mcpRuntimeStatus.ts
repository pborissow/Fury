/**
 * Display identity vs runtime identity for MCP panel rows.
 *
 * WHY THIS EXISTS (P16): the MCP server list is CONFIG-derived — it says what is
 * registered, not what actually came up. Runtime health arrives separately, from
 * the active session's init, as a list of servers that failed to connect, keyed
 * by the name the server registers with the SDK.
 *
 * For every real stdio/http server those two names are the same string, so
 * matching by `name` works. The in-process code-search row is the exception: it
 * is displayed as "This Project (Local MCP)" but the engine behind it registers
 * — and reports failures — as `codemogger` (lib/codemoggerServer.ts). The names
 * never lined up, so an embedder/onnx init failure (exactly the case the failed
 * badge exists for) kept showing a green "connected" check.
 *
 * The fix is to stop overloading `name` with two jobs. A row may carry an
 * explicit `runtimeName` — the identity the runtime knows it by — and health is
 * always resolved against that, falling back to `name` when a row's display and
 * runtime identities are the same thing.
 *
 * Pure and dependency-free on purpose: imported by both the API route (server)
 * and McpPanel (client component).
 */

/** The name the in-process code-search engine registers with the SDK. */
export const CODESEARCH_MCP_SERVER_NAME = 'codemogger';

/** The label the code-search row is shown under in the MCP panel. */
export const CODESEARCH_DISPLAY_NAME = 'This Project (Local MCP)';

/** The subset of a panel row needed to resolve runtime health. */
export interface RuntimeIdentifiable {
  /** Display label — what the user sees in the panel. */
  name: string;
  /** Identity the runtime reports failures under, when it differs from `name`. */
  runtimeName?: string;
}

/**
 * The name to match a row against runtime health reports. Prefer the explicit
 * runtime identity; fall back to the display name, which is correct for every
 * real (config-registered) server.
 */
export function runtimeIdentity(server: RuntimeIdentifiable): string {
  return server.runtimeName ?? server.name;
}

/** Whether this row's server failed to connect in the active session. */
export function isServerRuntimeFailed(
  server: RuntimeIdentifiable,
  failedNames: ReadonlySet<string>,
): boolean {
  return failedNames.has(runtimeIdentity(server));
}
