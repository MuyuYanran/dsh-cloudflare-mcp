/**
 * dsh-cloudflare-mcp — loopback HTTP routes for the web settings panel and
 * the OAuth callback.
 *
 * Route family: /api/dsh-cloudflare-mcp/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) except the OAuth callback, which must
 * accept the browser landing from mcp.cloudflare.com — it still requires a
 * loopback client and verifies the OAuth `state` inside the flow.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudflareMcpStore } from './store.ts';
import type { OAuthFlow } from './oauth.ts';
import type { McpSupervisor } from './mcp.ts';
/** Route paths. */
export declare const CLOUDFLARE_MCP_API: {
    readonly status: "/api/dsh-cloudflare-mcp/status";
    readonly oauthStart: "/api/dsh-cloudflare-mcp/oauth/start";
    readonly oauthCallback: "/api/dsh-cloudflare-mcp/oauth/callback";
    readonly oauthFinish: "/api/dsh-cloudflare-mcp/oauth/finish";
    readonly oauthRefresh: "/api/dsh-cloudflare-mcp/oauth/refresh";
    readonly test: "/api/dsh-cloudflare-mcp/test";
    readonly clear: "/api/dsh-cloudflare-mcp/clear";
    /** Enable/disable the MCP service row (shared with dsh-mcp-manager-plus). */
    readonly service: "/api/dsh-cloudflare-mcp/service";
};
/** Route handler context. */
export interface RouteContext {
    store: CloudflareMcpStore;
    flow: OAuthFlow;
    supervisor: McpSupervisor;
    /** The loopback OAuth callback URL. */
    callbackUrl: string;
    /** The MCP-service switch, backed by the profile patch layer. */
    service: ServiceControl;
    /**
     * Bring the upstream connection up after a successful authorization and then
     * re-run the standard MCP row so it re-discovers its tools. Sequenced
     * deliberately: restarting the row while the upstream is still down would have
     * it discover nothing again, which is the state the user was just in.
     */
    authorized(): void;
}
/**
 * The MCP-service switch. `state()` reads the profile patch layer — the same
 * file and the same row dsh-mcp-manager-plus writes — and `set()` writes it, so
 * the settings panel and the manager page cannot disagree.
 */
export interface ServiceControl {
    state(): ServiceState;
    set(enabled: boolean): ServiceState;
}
/** The switch state (mirrors the host contract in src/index.ts). */
export interface ServiceState {
    enabled: boolean;
    mounted: boolean;
    mode: 'bridge' | 'direct';
    managerManaged: boolean;
    modelToolCount: number;
    patchPath: string;
}
/**
 * Build every /api/dsh-cloudflare-mcp route (exact paths).
 * @param deps - store, oauth flow, MCP supervisor, callback URL, service switch.
 * @returns the route list.
 */
export declare function makeRoutes(deps: RouteContext): ({
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/status";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/start";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/callback";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/finish";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/refresh";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/test";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/clear";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/service";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
})[];
