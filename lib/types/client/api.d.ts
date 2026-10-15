/**
 * Browser-side API client for the /api/dsh-cloudflare-mcp route family. The
 * only data access path the settings panel uses — plain fetch, same origin.
 */
/** Public status view (mirrors the host contract). */
export interface CloudflareMcpStatusView {
    configured: boolean;
    authorized: boolean;
    tokenUpdatedAt: string;
    clientIdMasked: string;
    callbackUrl: string;
    mcpUrl: string;
    configPath: string;
    connected: boolean;
    toolCount: number;
    /** Loopback MCP endpoint the standard MCP row connects to. */
    mcpEndpoint?: string;
    /** The MCP-service switch (same row dsh-mcp-manager-plus toggles). */
    service?: CloudflareMcpServiceState;
}
/** The MCP-service switch state, as the host reports it. */
export interface CloudflareMcpServiceState {
    enabled: boolean;
    mounted: boolean;
    mode: 'bridge' | 'direct';
    managerManaged: boolean;
    modelToolCount: number;
    patchPath: string;
}
/** Error carrying the route's JSON error message. */
export declare class CloudflareMcpApiError extends Error {
    constructor(message: string);
}
/** The Cloudflare MCP panel API. */
export declare class CloudflareMcpApi {
    status(): Promise<CloudflareMcpStatusView>;
    oauthStart(): Promise<{
        ok: boolean;
        authorizeUrl?: string;
        error?: string;
    }>;
    oauthFinish(code: string, redirectUrl: string): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
    oauthRefresh(): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
    test(): Promise<{
        ok: boolean;
        message?: string;
        error?: string;
        tools?: string[];
        view: CloudflareMcpStatusView;
    }>;
    clear(): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
    /**
     * Turn the MCP service on or off. The host writes the `disabled` override of
     * the standard `mcp-cloudflare` row in the profile patch layer — the very row
     * dsh-mcp-manager-plus lists — so this is the same switch, seen from here.
     */
    setService(enabled: boolean): Promise<{
        ok: boolean;
        message?: string;
        error?: string;
        service?: CloudflareMcpServiceState;
    }>;
}
