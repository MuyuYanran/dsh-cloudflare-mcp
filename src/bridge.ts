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

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpSupervisor } from './mcp.ts'

/** Path of the loopback MCP endpoint, registered as an exact webserver route. */
export const MCP_BRIDGE_PATH = '/mcp/cloudflare'

/**
 * Whether the request came from the loopback interface. The bridge forwards
 * calls with the user's Cloudflare OAuth token and has no credential of its own,
 * so it must never answer a remote client — the GUI can also be bound to a
 * network address, and the standard MCP row then sits on that same server.
 */
function isLoopbackSocket(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
}

/** Client-facing identity of the bridge (shown in loader logs). */
const BRIDGE_INFO = { name: 'cloudflare-mcp', version: '1.0.0' } as const

/** How the bridge describes itself to the model, through the standard bridge. */
const BRIDGE_INSTRUCTIONS =
  'Cloudflare API 工具，经 dsh-cloudflare-mcp 插件的官方 OAuth 授权连接 mcp.cloudflare.com。'

/** One live bridge session. */
interface BridgeSession {
  server: Server
  transport: StreamableHTTPServerTransport
}

/** The bridge handle. */
export interface McpBridge {
  /** The HTTP handler for the MCP endpoint route. */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Push a tool-list-changed notification to every live session. */
  announceToolsChanged(): void
  /** Close every live session. */
  dispose(): Promise<void>
}

/**
 * Create the loopback MCP endpoint for one supervisor.
 * @param supervisor - the supervised Cloudflare connection.
 * @param logger - sink for bridge diagnostics.
 * @returns the bridge handle.
 */
export function createMcpBridge(
  supervisor: McpSupervisor,
  logger: { info(message: string): void; warn(message: string): void },
): McpBridge {
  const sessions = new Set<BridgeSession>()

  const buildServer = (): Server => {
    const server = new Server(BRIDGE_INFO, {
      capabilities: { tools: {} },
      instructions: BRIDGE_INSTRUCTIONS,
    })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await supervisor.listToolDefinitions()
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        })),
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name
      const args = typeof request.params.arguments === 'object' && request.params.arguments !== null
        ? request.params.arguments as Record<string, unknown>
        : {}
      const result = await supervisor.callTool(name, args, extra.signal)
      if (!Array.isArray(result.content)) {
        const text = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
        if (result.isError === true) throw new Error(text)
        return { content: [{ type: 'text', text }] }
      }
      if (result.isError === true) {
        return { content: result.content, isError: true }
      }
      // Drop blocks the host bridge cannot carry, so a stale upstream shape
      // degrades to text instead of failing the whole call.
      return { content: result.content }
    })
    return server
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackSocket(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'cloudflare-mcp bridge: loopback-only' }))
      return
    }
    if (req.method !== 'POST') {
      // A stateless endpoint has nothing to resume on GET, and no headers to
      // delete on DELETE; answering both explicitly keeps diagnostics honest.
      // The MCP client treats 405 on GET as "no SSE stream", which is exactly right.
      res.writeHead(req.method === 'GET' ? 405 : 400, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
      res.end(JSON.stringify({ error: 'cloudflare-mcp bridge: stateless endpoint, POST only' }))
      return
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const session: BridgeSession = { server, transport }
    sessions.add(session)
    let settled = false
    const release = (): void => {
      if (settled) return
      settled = true
      sessions.delete(session)
    }
    transport.onclose = () => {
      release()
      void server.close().catch(() => {})
    }
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      logger.warn('cloudflare-mcp bridge: request failed: ' + String(error instanceof Error ? error.message : error))
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'cloudflare-mcp bridge request failed' }))
      }
    } finally {
      if (res.writableEnded) release()
      else res.once('close', () => { release(); void server.close().catch(() => {}) })
    }
  }

  return {
    handler,
    announceToolsChanged(): void {
      for (const session of sessions) {
        void session.server.sendToolListChanged().catch(() => {})
      }
    },
    async dispose(): Promise<void> {
      const live = [...sessions]
      sessions.clear()
      for (const session of live) {
        try {
          await session.transport.close()
          await session.server.close()
        } catch {
          // A dying session is not worth a failed unload.
        }
      }
    },
  }
}
