/**
 * dsh-cloudflare-mcp — loopback MCP endpoint (the standard-protocol bridge).
 *
 * The Cloudflare MCP server needs OAuth, which `@deepseek-ai/dsh-mcp-client`
 * cannot do — that is the whole reason this plugin owns the connection. But an
 * OAuth-authenticated connection is also the only thing a standard MCP row needs
 * to *point at*, so this module re-exposes the plugin's upstream connection as a
 * plain Streamable HTTP MCP server on the harness's own loopback web server:
 *
 *     http://127.0.0.1:<gui-port>/mcp/cloudflare
 *
 * A standard row — `@deepseek-ai/dsh-mcp-client`, `serverName: cloudflare` — then
 * registers its tools exactly like any other MCP server, which makes the
 * connection visible and manageable in dsh-mcp-manager-plus (list / enable /
 * disable / restart), and makes the plugin's own tool registration unnecessary:
 * with `registerToolsOnMount: false` the supervisor only keeps the upstream
 * connection, and the model reaches it through the bridge.
 *
 * Design notes:
 * - **One transport per request, stateless.** dsh-mcp-client opens a single
 *   connection per server and never re-initializes on a dropped session, so a
 *   session-id carrying transport would break on every profile reload. A
 *   stateless transport answers every POST in-band and needs no resume stream.
 * - **Lazy upstream.** `tools/list` and `tools/call` bring the OAuth connection
 *   up on demand, so the bridge works right after an OAuth callback without the
 *   caller sequencing `start()` first.
 * - **No secrets on the wire.** The endpoint is loopback-only and the OAuth token
 *   stays inside this process; the bridge adds nothing to the request.
 * - **Tool-set changes are pushed.** When the supervisor re-syncs and the set of
 *   names changed, every live session gets `notifications/tools/list_changed`,
 *   which is what makes the model-facing tool list follow upstream changes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpSupervisor } from './mcp.ts';
/** Path of the loopback MCP endpoint, registered as an exact webserver route. */
export declare const MCP_BRIDGE_PATH = "/mcp/cloudflare";
/** The bridge handle. */
export interface McpBridge {
    /** The HTTP handler for the MCP endpoint route. */
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /** Push a tool-list-changed notification to every live session. */
    announceToolsChanged(): void;
    /** Close every live session. */
    dispose(): Promise<void>;
}
/**
 * Create the loopback MCP endpoint for one supervisor.
 * @param supervisor - the supervised Cloudflare connection.
 * @param logger - sink for bridge diagnostics.
 * @returns the bridge handle.
 */
export declare function createMcpBridge(supervisor: McpSupervisor, logger: {
    info(message: string): void;
    warn(message: string): void;
}): McpBridge;
