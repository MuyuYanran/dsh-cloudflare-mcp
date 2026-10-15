/**
 * dsh-cloudflare-mcp — Cloudflare MCP connection for DeepSeek Harness.
 * Host half.
 *
 * Runs the official OAuth flow against https://mcp.cloudflare.com/mcp (dynamic
 * client registration, PKCE S256, loopback callback on the GUI's own web server,
 * refresh-token grant — see src/oauth.ts), keeps the MCP connection supervised,
 * serves the /api/dsh-cloudflare-mcp route family the settings panel talks to,
 * and stores tokens in ~/.dsh/dsh-cloudflare-mcp.json (mode 0600).
 *
 * The model does NOT get its Cloudflare tools from this plugin any more. The
 * plugin re-exposes the OAuth-authenticated connection as a standard Streamable
 * HTTP MCP server on loopback (src/bridge.ts), and the bundle inserts a plain
 * `@deepseek-ai/dsh-mcp-client` row pointed at it (src/patch.ts owns that row's
 * id). Consequences, all deliberate:
 *
 * - `mcp__cloudflare__*` comes from an ordinary MCP row, so it is one server
 *   among others: dsh-mcp-manager-plus lists it, enables/disables it, restarts
 *   it, and shows its tools.
 * - "The Cloudflare MCP service" is that row. Turning it off removes every tool
 *   definition plus this plugin's helper tools and its system-prompt announcement
 *   — the whole prompt-token cost of an unused connection — while the OAuth
 *   grant, the settings panel and the endpoint stay mounted so the user can turn
 *   it back on without re-authorizing.
 * - The settings-page switch writes the same `disabled` override the manager
 *   writes, into the same profile patch layer. One truth, two surfaces: they
 *   cannot disagree, and neither needs the other installed.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CLOUDFLARE_MCP_API, type RouteContext } from './routes.ts';
/** Stable cordis plugin name. */
export declare const name = "cloudflare-mcp";
/** Services required before the surfaces can mount. */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * The profile patch layer was reconciled and the tree converged. The host
         * emits it after `dsh plugin` enable/disable and after a watched
         * `cordis.patch.yml` reload — including one dsh-mcp-manager-plus wrote.
         */
        'app-boot/config-reload'(): void;
        /**
         * This plugin wrote the MCP-service switch itself, so its model-facing
         * surfaces should re-sync without waiting for the profile reload.
         */
        'dsh-cloudflare-mcp/service-changed'(): void;
    }
}
/** The `serverName` namespace of the standard row (and thus the tool prefix). */
export declare const SERVICE_SERVER_NAME = "cloudflare";
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const CLOUDFLARE_MCP_GUIDANCE: string;
/** Plugin config, read from the composition row. */
export interface Config {
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
    /** Master switch for the plugin (routes, endpoint, tools, prompt section). */
    enabled?: boolean;
    /**
     * Escape hatch for a composition that does not mount the standard MCP row:
     * register `mcp__cloudflare__*` directly on `ctx.tools`, the way this plugin
     * did before it exposed a loopback MCP endpoint. The service switch then
     * governs this plugin's own registration instead of a loader row. Defaults to
     * false, which is the mode that cooperates with dsh-mcp-manager-plus.
     */
    registerToolsDirectly?: boolean;
}
/**
 * Mount the Cloudflare MCP connection, its surfaces, and the service switch.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Re-export for the settings panel's route table. */
export { CLOUDFLARE_MCP_API };
/** Re-exports for host consumers and the smoke tests. */
export { CloudflareMcpStore, mask, configPath, MCP_URL, type CloudflareMcpConfigView } from './store.ts';
export { OAuthFlow, CloudflareOAuthProvider, type PendingFlow } from './oauth.ts';
export { createSupervisor, type McpSupervisor } from './mcp.ts';
export { makeRoutes } from './routes.ts';
export { createMcpBridge, MCP_BRIDGE_PATH, type McpBridge } from './bridge.ts';
export { MCP_CLIENT_PACKAGE as SERVICE_ROW_PACKAGE, SERVICE_ROW_ID, parsePatch, readDisabled, hasDisabledOverride, readPatchText, resolvePatchPath, setDisabled, writePatch, PatchConflictError, fromFileUrl, joinPatch, dshHome, argvProfile, } from './patch.ts';
export type { RouteContext, ServiceControl, ServiceState } from './routes.ts';
export { defineTool };
/** Shared tool dependencies. */
export type ToolContext = RouteContext;
