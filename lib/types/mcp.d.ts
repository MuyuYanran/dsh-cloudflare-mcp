/**
 * dsh-cloudflare-mcp — MCP connection supervisor.
 *
 * Connects to https://mcp.cloudflare.com/mcp with the OAuth provider
 * (the transport auto-attaches the bearer token and auto-refreshes on
 * 401), discovers the server's tools, and registers them on `ctx.tools`
 * under deterministic server-qualified public names
 * (`mcp__cloudflare__<rawName>`, same contract as @deepseek-ai/dsh-mcp-client).
 *
 * Lifecycle: only starts when tokens exist (an unauthenticated connect
 * would otherwise spin the OAuth redirect loop). On connection loss it
 * retries with bounded exponential backoff; when the user clears
 * credentials mid-run the supervisor stops.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type CloudflareMcpStore } from './store.ts';
import type { OAuthFlow } from './oauth.ts';
/** Connection supervisor handle. */
export interface McpSupervisor {
    /** Start (or restart) the supervised connection. Only connects when tokens exist. */
    start(): Promise<void>;
    /** Whether a client generation is currently connected. */
    isConnected(): boolean;
    /** Number of tools currently registered from this server. */
    toolCount(): number;
    /** List the MCP server's tools (live probe; requires a connected client). */
    listTools(): Promise<string[]>;
    /**
     * The upstream tool definitions (wire shapes, raw names). Connects on demand,
     * so a lazy caller never has to sequence `start()` itself.
     */
    listToolDefinitions(): Promise<ToolDefinition[]>;
    /** Forward one tool call to the upstream server. Connects on demand. */
    callTool(rawName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<UpstreamCallResult>;
    /**
     * Flip this supervisor between registering its tools on `ctx.tools` and only
     * serving them through the loopback endpoint. Turning registration off drops
     * every tool definition (and with it the tokens they cost) without closing the
     * upstream connection, so switching back on is instant.
     */
    setRegistration(enabled: boolean): void;
    /** Whether the supervisor currently owns `ctx.tools` registrations. */
    isRegistrationOn(): boolean;
    /**
     * Close the upstream connection and drop every tool definition, staying
     * restartable. The switch calls this when the service goes off so an unused
     * Cloudflare connection holds nothing open.
     */
    stop(): Promise<void>;
    /** Stop the supervisor and unregister all tools. */
    dispose(): Promise<void>;
}
/** One upstream tool, as the Cloudflare MCP server advertised it. */
export interface ToolDefinition {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}
/** The upstream `tools/call` result, before any bridging. */
export type UpstreamCallResult = {
    content?: unknown;
    isError?: boolean;
    toolResult?: unknown;
    [key: string]: unknown;
};
/** One ctx.tools registration built from an advertised upstream tool. */
export interface ToolRegistration {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): Array<{
            type: 'text';
            text: string;
        }>;
    };
    execute(args: unknown, exec: {
        signal: AbortSignal;
    }): Promise<unknown>;
}
/** Supervisor construction options. */
export interface SupervisorOptions {
    /**
     * When false the supervisor keeps the connection and the discovered tool set
     * but registers nothing on `ctx.tools` — the loopback MCP endpoint serves the
     * model instead, and registration is @deepseek-ai/dsh-mcp-client's job.
     * Defaults to true.
     */
    registerTools?: boolean;
    /** Called whenever the advertised tool set changes (used to notify bridge sessions). */
    onToolsetChanged?: () => void;
}
/**
 * Create the supervised connection for the Cloudflare MCP server.
 * @param ctx - cordis context carrying the tools registry and logger.
 * @param store - credential store (tokens gate the connection).
 * @param flow - OAuth flow providing the transport's auth provider.
 * @param callbackUrl - the loopback OAuth callback URL.
 * @param options - registration behaviour, see {@link SupervisorOptions}.
 * @returns the supervisor handle.
 */
export declare function createSupervisor(ctx: Context, store: CloudflareMcpStore, flow: OAuthFlow, callbackUrl: string, options?: SupervisorOptions): McpSupervisor;
