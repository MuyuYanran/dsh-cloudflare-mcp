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

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CloudflareMcpStore } from './store.ts'
import { OAuthFlow } from './oauth.ts'
import { createSupervisor, type McpSupervisor } from './mcp.ts'
import { createMcpBridge, MCP_BRIDGE_PATH, type McpBridge } from './bridge.ts'
import { CLOUDFLARE_MCP_API, makeRoutes, type RouteContext, type ServiceControl, type ServiceState } from './routes.ts'
import {
  MCP_CLIENT_PACKAGE, SERVICE_ROW_ID, parsePatch, readDisabled, readPatchText,
  resolvePatchPath, setDisabled, writePatch, PatchConflictError, type LoaderLike,
} from './patch.ts'

/** Stable cordis plugin name. */
export const name = 'cloudflare-mcp'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The profile patch layer was reconciled and the tree converged. The host
     * emits it after `dsh plugin` enable/disable and after a watched
     * `cordis.patch.yml` reload — including one dsh-mcp-manager-plus wrote.
     */
    'app-boot/config-reload'(): void
    /**
     * This plugin wrote the MCP-service switch itself, so its model-facing
     * surfaces should re-sync without waiting for the profile reload.
     */
    'dsh-cloudflare-mcp/service-changed'(): void
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 161

/** The `serverName` namespace of the standard row (and thus the tool prefix). */
export const SERVICE_SERVER_NAME = 'cloudflare'

/** Local event fired after this plugin wrote the switch itself. */
const SERVICE_TOGGLE_EVENT = 'dsh-cloudflare-mcp/service-changed'

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const CLOUDFLARE_MCP_GUIDANCE =
  '本机已安装 dsh-cloudflare-mcp 插件（Cloudflare MCP 连接）：通过官方 OAuth 授权后，' +
  'Cloudflare 官方 MCP 服务器（mcp.cloudflare.com）的工具以 mcp__cloudflare__* 形式可用，' +
  '覆盖账户信息、Workers、Pages、DNS、R2、KV、D1、AI 等 Cloudflare API 操作。' +
  '授权流程：cloudflare_mcp_oauth_start 获取授权链接 → 用户浏览器登录 Cloudflare 并授权 → ' +
  '自动回调完成（也可把回调地址里的 code 交给 cloudflare_mcp_oauth_finish）。' +
  'cloudflare_mcp_status 查看连接状态（不回显令牌），cloudflare_mcp_test 测试连接并列出工具，' +
  'cloudflare_mcp_service 开启/关闭该 MCP 服务（关闭后这些工具与本公告都不再占用提示词）。' +
  '令牌存 ~/.dsh/dsh-cloudflare-mcp.json（权限 0600）。也可在 Web 设置页「Cloudflare MCP」面板中授权与测试。' +
  '用户提到「Cloudflare / MCP / Workers 部署 / 查账户」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, endpoint, tools, prompt section). */
  enabled?: boolean
  /**
   * Escape hatch for a composition that does not mount the standard MCP row:
   * register `mcp__cloudflare__*` directly on `ctx.tools`, the way this plugin
   * did before it exposed a loopback MCP endpoint. The service switch then
   * governs this plugin's own registration instead of a loader row. Defaults to
   * false, which is the mode that cooperates with dsh-mcp-manager-plus.
   */
  registerToolsDirectly?: boolean
}

/**
 * Mount the Cloudflare MCP connection, its surfaces, and the service switch.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const directMode = config?.registerToolsDirectly === true

  const store = new CloudflareMcpStore()
  const flow = new OAuthFlow(store)
  const callbackUrl = `http://127.0.0.1:${ctx.webServer.port}${CLOUDFLARE_MCP_API.oauthCallback}`
  let bridge: McpBridge | undefined
  const supervisor: McpSupervisor = createSupervisor(ctx, store, flow, callbackUrl, {
    registerTools: directMode,
    onToolsetChanged: () => { bridge?.announceToolsChanged() },
  })
  bridge = directMode ? undefined : createMcpBridge(supervisor, ctx.logger)

  /** The patch layer this profile uses as the switch's durable record. */
  const patchPath = (): string => resolvePatchPath(ctx.get('loader') as LoaderLike | undefined)

  /**
   * The service state, recomputed on every read: in bridge mode the patch layer
   * is the truth (that is what makes the manager's toggle and this panel's
   * toggle one switch), and the live loader row says whether it converged.
   */
  const serviceState = (): ServiceState => {
    let fromLayer = true
    try {
      fromLayer = !readDisabled(parsePatch(readPatchText(patchPath())), SERVICE_ROW_ID)
    } catch (error) {
      // An unreadable layer must not decide for the user: keep the row as the
      // composition has it, and let the panel surface the read failure.
      ctx.logger.warn(`dsh-cloudflare-mcp: patch layer unreadable: ${String(error instanceof Error ? error.message : error)}`)
    }
    const entry = findServiceEntry(ctx)
    return {
      enabled: directMode ? enabled && supervisor.isRegistrationOn() : fromLayer,
      mounted: directMode ? supervisor.isConnected() : entry !== undefined && entry.disabled !== true && entry.fiber !== undefined,
      mode: directMode ? 'direct' : 'bridge',
      managerManaged: hasManagerRow(ctx),
      modelToolCount: countModelTools(ctx),
      patchPath: patchPath(),
    }
  }

  /**
   * Write the switch. In bridge mode this is literally the operation
   * dsh-mcp-manager-plus performs on the same row, so the two surfaces are one
   * toggle; the harness then reloads the profile and the row mounts or unmounts.
   * @param on - the desired state.
   * @returns the state as it stands right after the write.
   */
  const setService = (on: boolean): ServiceState => {
    if (directMode) {
      supervisor.setRegistration(on)
      if (!on) void supervisor.stop().catch(() => {})
      return { ...serviceState(), enabled: on }
    }
    const file = patchPath()
    // Compare-and-swap with one retry: dsh-mcp-manager-plus writes this same
    // file, so a candidate built from stale bytes is refused rather than allowed
    // to clobber the other surface's edit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previous = readPatchText(file)
      try {
        writePatch(file, setDisabled(previous, SERVICE_ROW_ID, on), previous)
        break
      } catch (error) {
        if (!(error instanceof PatchConflictError) || attempt === 1) throw error
      }
    }
    // The profile reload reconciles the row and re-runs sync through
    // `app-boot/config-reload`; announce locally too so a composition without a
    // configuration watcher still drops the model-facing surfaces at once.
    ctx.emit(SERVICE_TOGGLE_EVENT)
    return { ...serviceState(), enabled: on }
  }

  const service: ServiceControl = { state: serviceState, set: setService }
  /**
   * What a completed authorization does: open the upstream connection, and only
   * once that is settled re-run the standard MCP row so it re-discovers tools.
   * Reversing the order would have the row ask the bridge while the bridge still
   * has nothing, which is exactly the empty state the user just escaped.
   */
  const authorized = (): void => {
    void (async () => {
      try {
        await supervisor.start()
      } catch {
        // A failed first connect still leaves the row retrying on its own; the
        // panel's 测试连接 is the explicit path for the user to try again.
      }
      if (!directMode) {
        const entry = findServiceEntry(ctx)
        if (entry !== undefined) restartRow(entry, ctx.logger)
      }
      sync()
    })()
  }
  const context: RouteContext = { store, flow, supervisor, callbackUrl, service, authorized }

  /** Disposer for whatever surface mode is currently applied. */
  let disposeSurfaces: (() => void) | undefined
  /**
   * The last surface mode applied: 'on' = everything the model pays for,
   * 'off' = the keeper switch only, 'none' = the plugin master switch is off,
   * undefined = nothing mounted yet.
   */
  let surfaceMode: 'on' | 'off' | 'none' | undefined
  let started = false

  /**
   * Match the model-facing surfaces to the switch. The HTTP routes, the OAuth
   * callback and the loopback MCP endpoint are mounted once and stay mounted:
   * they cost no prompt tokens, and they are how the service gets turned back
   * on. With the service off, only `cloudflare_mcp_service` stays registered —
   * it is the one tool that must remain callable to turn things around from the
   * chat, and it is small enough not to matter for cost.
   */
  const sync = (): void => {
    const serviceOn = enabled && serviceState().enabled
    // The master switch off means the plugin contributes nothing at all — not
    // even the keeper — because its routes and endpoint are gone too, so a
    // registered tool would have no backend to talk to.
    const wanted = !enabled ? 'none' : (serviceOn ? 'on' : 'off')
    if (wanted === surfaceMode) return
    if (surfaceMode !== undefined) {
      disposeSurfaces?.()
      disposeSurfaces = undefined
    }
    surfaceMode = wanted
    if (wanted === 'none') return
    if (wanted === 'off') {
      // Nothing in the composition is paying for Cloudflare any more; in direct
      // mode this plugin owns the definitions, so drop them explicitly. Do not
      // hold the upstream session open either — re-enabled, the bridge or the
      // auto-connect path brings it back on demand.
      supervisor.setRegistration(false)
      void supervisor.stop().catch(() => {})
      started = false
      disposeSurfaces = ctx.effect(
        () => ctx.tools.register(cloudflareMcpServiceTool(context)),
        'dsh-cloudflare-mcp: switch kept online',
      )
      return
    }
    // In direct mode this plugin is the row, so it registers its own tools; in
    // bridge mode it never does — the standard row owns those definitions.
    supervisor.setRegistration(directMode)
    disposeSurfaces = ctx.effect(
      () => {
        const disposers = buildTools(context).map((tool) => ctx.tools.register(tool))
        const section = announceToAgent
          ? ctx.systemPrompt.section({
            name: 'plugin:dsh-cloudflare-mcp',
            order: SECTION_ORDER,
            text: CLOUDFLARE_MCP_GUIDANCE,
          })
          : undefined
        return () => {
          for (const dispose of disposers) dispose()
          if (section !== undefined) section()
        }
      },
      'dsh-cloudflare-mcp: model surfaces',
    )
    if (!started) {
      void (async () => {
        const view = await store.view(callbackUrl)
        if (view.authorized && !started && surfaceMode === 'on') {
          started = true
          void supervisor.start().catch(() => {})
        }
      })()
    }
  }

  // The always-mounted surfaces. Routes first: the panel must stay reachable
  // with the service off, since that is the only way back on.
  if (enabled) {
    for (const route of makeRoutes(context)) {
      ctx.effect(() => ctx.webServer.register(route), 'dsh-cloudflare-mcp: route ' + route.path)
    }
    if (bridge !== undefined) {
      const active = bridge
      ctx.effect(
        () => ctx.webServer.register({ kind: 'exact', path: MCP_BRIDGE_PATH, handler: active.handler }),
        'dsh-cloudflare-mcp: mcp endpoint',
      )
    }
  }

  sync()

  // Follow the patch layer in both directions: dsh-mcp-manager-plus writes the
  // same row's `disabled` override and the harness reconciles the profile after
  // the file changes, which is what lets a toggle made on that page take this
  // plugin's own surfaces off or on without a restart.
  ctx.on('app-boot/config-reload', () => { sync() })
  ctx.on(SERVICE_TOGGLE_EVENT, () => { sync() })

  ctx.effect(() => {
    return () => {
      void supervisor.dispose()
      void bridge?.dispose()
    }
  }, 'dsh-cloudflare-mcp: connection')
}

/**
 * Re-run the live loader entry for the standard MCP row so it reconnects and
 * re-discovers its tools. This is the same in-place restart dsh-mcp-manager-plus
 * performs, and both loader generations are handled because the row API changed:
 * - cordis-plugin-loader ≤ 1.0.3 (dsh ≤ 0.1.6-alpha.x) disposes through the
 *   private `entry._dispose()` and remounts with `entry.init()`;
 * - 1.0.5+ (dsh ≥ 0.2.0-rc.x) replaced that with `entry.fiber.restart()`.
 * A missing row or an unsupported shape is not an error here: the tools simply
 * appear on the next host start.
 * @param entry - the live row entry.
 * @param logger - sink for diagnostics.
 */
function restartRow(entry: LoaderEntry, logger: { warn(message: string): void }): void {
  const own = entry as { _dispose?: () => Promise<unknown>; init?: () => Promise<unknown>; fiber?: { restart?: () => Promise<unknown>; state?: number } }
  if (typeof own._dispose === 'function' && typeof own.init === 'function') {
    void (async () => {
      await own._dispose?.()
      await own.init?.()
    })().catch(() => logger.warn('dsh-cloudflare-mcp: could not restart the mcp-cloudflare row'))
    return
  }
  if (typeof own.fiber?.restart === 'function') {
    void own.fiber.restart().catch(() => logger.warn('dsh-cloudflare-mcp: could not restart the mcp-cloudflare row'))
    return
  }
  logger.warn('dsh-cloudflare-mcp: the loader cannot restart the mcp-cloudflare row in place; its tools appear after the next host start')
}

/**
 * How many `mcp__<server>__*` definitions the model currently sees. The tool
 * registry's catalog is read defensively: an older host without `schemas()`
 * simply reports zero rather than failing the status route.
 * @param ctx - host plugin context carrying the tools registry.
 */
function countModelTools(ctx: Context): number {
  const registry = ctx.tools as unknown as { schemas?: () => Array<{ name?: string }> }
  if (typeof registry.schemas !== 'function') return 0
  const prefix = `mcp__${SERVICE_SERVER_NAME}__`
  try {
    return registry.schemas().filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix)).length
  } catch {
    return 0
  }
}

/** One loader entry, typed loosely: the loader belongs to the host. */
interface LoaderEntry {
  options?: { id?: string; name?: string; config?: Record<string, unknown> }
  disabled?: boolean
  fiber?: unknown
}

/**
 * The live loader entries, or an empty list when no loader is reachable.
 * @param ctx - host plugin context.
 */
function loaderEntries(ctx: Context): LoaderEntry[] {
  const loader = ctx.get('loader') as { entries?: () => Iterable<LoaderEntry> } | undefined
  if (loader === undefined || typeof loader.entries !== 'function') return []
  try {
    return [...loader.entries()]
  } catch {
    return []
  }
}

/**
 * The live loader entry for the standard MCP row, if the composition has one.
 * @param ctx - host plugin context.
 */
function findServiceEntry(ctx: Context): LoaderEntry | undefined {
  return loaderEntries(ctx).find((entry) => entry.options?.name === MCP_CLIENT_PACKAGE
    && entry.options.config?.serverName === SERVICE_SERVER_NAME)
}

/**
 * Whether dsh-mcp-manager-plus is mounted, so the panel can name the shared
 * switch instead of leaving the user guessing where the other toggle lives.
 * @param ctx - host plugin context.
 */
function hasManagerRow(ctx: Context): boolean {
  return loaderEntries(ctx).some((entry) => entry.options?.name === 'dsh-mcp-manager-plus')
}

/** Re-export for the settings panel's route table. */
export { CLOUDFLARE_MCP_API }

/** Re-exports for host consumers and the smoke tests. */
export { CloudflareMcpStore, mask, configPath, MCP_URL, type CloudflareMcpConfigView } from './store.ts'
export { OAuthFlow, CloudflareOAuthProvider, type PendingFlow } from './oauth.ts'
export { createSupervisor, type McpSupervisor } from './mcp.ts'
export { makeRoutes } from './routes.ts'
export { createMcpBridge, MCP_BRIDGE_PATH, type McpBridge } from './bridge.ts'
export {
  MCP_CLIENT_PACKAGE as SERVICE_ROW_PACKAGE,
  SERVICE_ROW_ID, parsePatch, readDisabled, hasDisabledOverride, readPatchText, resolvePatchPath, setDisabled, writePatch,
  PatchConflictError, fromFileUrl, joinPatch, dshHome, argvProfile,
} from './patch.ts'
export type { RouteContext, ServiceControl, ServiceState } from './routes.ts'
export { defineTool }

/** Shared tool dependencies. */
export type ToolContext = RouteContext

/** Build every agent-facing cloudflare_mcp_* tool. */
function buildTools(ctx: ToolContext): ReturnType<typeof defineTool>[] {
  return [
    cloudflareMcpStatusTool(ctx),
    cloudflareMcpOAuthStartTool(ctx),
    cloudflareMcpOAuthFinishTool(ctx),
    cloudflareMcpTestTool(ctx),
    cloudflareMcpClearTool(ctx),
    cloudflareMcpServiceTool(ctx),
  ]
}

/** One text content block. */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

/** Status tool: connection state, token age, switch state, tool count. */
function cloudflareMcpStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_status',
    description:
      '查看 dsh-cloudflare-mcp 插件状态：是否已 OAuth 授权、令牌最近更新时间、MCP 是否已连接、MCP 服务开关状态、模型当前可见的 Cloudflare 工具数量。不会泄露任何密钥。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          authorized: { type: 'boolean' },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          serviceEnabled: { type: 'boolean' },
          serviceMounted: { type: 'boolean' },
          modelToolCount: { type: 'number' },
          tokenUpdatedAt: { type: 'string' },
          mcpUrl: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      const view = await ctx.store.view(ctx.callbackUrl)
      const state = ctx.service.state()
      const lines = [
        view.authorized ? '已授权（令牌更新于 ' + view.tokenUpdatedAt + '）' : '未授权',
        '上游连接' + (ctx.supervisor.isConnected() ? '已建立' : '未建立'),
        'MCP 服务' + (state.enabled ? '开启' : '关闭'),
        '模型可见 Cloudflare 工具 ' + state.modelToolCount + ' 个',
        '上游端点 ' + view.mcpUrl,
        '凭据文件 ' + view.configPath,
      ]
      return {
        ok: true,
        message: 'dsh-cloudflare-mcp：' + lines.join('；') + '。' + (!view.authorized
          ? '请用 cloudflare_mcp_oauth_start 开始授权。'
          : state.enabled
            ? '可直接使用 mcp__cloudflare__* 工具。'
            : '服务当前关闭（不占提示词额度）；用 cloudflare_mcp_service action=on 打开。'),
        authorized: view.authorized,
        connected: ctx.supervisor.isConnected(),
        toolCount: ctx.supervisor.toolCount(),
        serviceEnabled: state.enabled,
        serviceMounted: state.mounted,
        modelToolCount: state.modelToolCount,
        tokenUpdatedAt: view.tokenUpdatedAt,
        mcpUrl: view.mcpUrl,
        configPath: view.configPath,
      }
    },
  })
}

/** OAuth start tool: begin the flow, return the browser URL. */
function cloudflareMcpOAuthStartTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_oauth_start',
    description:
      '开始 Cloudflare MCP 的 OAuth 授权流程：返回授权链接（authorizeUrl），让用户用浏览器打开并登录 Cloudflare 授权。授权完成后自动回调本机完成。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          authorizeUrl: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const { authorizeUrl } = await ctx.flow.begin(ctx.callbackUrl)
        return {
          ok: true,
          message: '请在浏览器中打开以下链接完成 Cloudflare 授权（打开后登录并点击允许）：' + authorizeUrl,
          authorizeUrl,
        }
      } catch (error) {
        return { ok: false, message: '开始授权失败：' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** OAuth finish tool: manual code paste fallback. */
function cloudflareMcpOAuthFinishTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_oauth_finish',
    description:
      '手动完成 Cloudflare MCP 授权：把授权后浏览器地址栏里的 code 参数（或完整回调 URL）传给本工具，完成令牌交换。用于浏览器未能自动回调的情况。',
    parameters: {
      code: { type: 'string', description: '授权回调 URL 中的 code 参数值' },
      redirectUrl: { type: 'string', description: '完整的授权回调 URL（自动提取 code）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: { code?: string; redirectUrl?: string }) {
      let code = typeof args.code === 'string' ? args.code.trim() : ''
      if (code === '' && typeof args.redirectUrl === 'string' && args.redirectUrl !== '') {
        try {
          code = new URL(args.redirectUrl).searchParams.get('code') ?? ''
        } catch {
          code = ''
        }
      }
      if (code === '') {
        return { ok: false, message: '缺少 code（或无法从 redirectUrl 提取 code）。' }
      }
      const result = await ctx.flow.complete(code, '')
      if (result.ok && ctx.service.state().enabled) {
        void ctx.supervisor.start().catch(() => {})
      }
      return result
    },
  })
}

/** Test tool: connect and list the Cloudflare MCP tools. */
function cloudflareMcpTestTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_test',
    description:
      '测试 Cloudflare MCP 连接：确认授权有效并列出服务器当前提供的全部工具名（这些名字会以 mcp__cloudflare__<name> 暴露给模型）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      const view = await ctx.store.view(ctx.callbackUrl)
      if (!view.authorized) {
        return { ok: false, message: '尚未授权：请用 cloudflare_mcp_oauth_start 开始授权。' }
      }
      try {
        if (!ctx.supervisor.isConnected()) {
          await ctx.supervisor.start()
        }
        const tools = await ctx.supervisor.listTools()
        return {
          ok: true,
          message: '连接成功：Cloudflare MCP 提供 ' + tools.length + ' 个工具。' +
            (tools.length > 0 ? ' 示例：' + tools.slice(0, 8).join('、') : ''),
          tools,
        }
      } catch (error) {
        return { ok: false, message: '测试失败：' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Clear tool: wipe credentials and disconnect. */
function cloudflareMcpClearTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_clear',
    description:
      '清除 Cloudflare MCP 的全部凭据（OAuth 令牌与客户端注册）并断开连接，MCP 工具随之不可用。需要用户确认后执行。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      ctx.flow.abort()
      await ctx.supervisor.dispose()
      await ctx.store.clearAll()
      return { ok: true, message: '已清除 Cloudflare MCP 的全部凭据。重新授权后工具才会回来。' }
    },
  })
}

/**
 * The MCP-service switch: turn the Cloudflare MCP connection off (no
 * `mcp__cloudflare__*` definitions, no helper tools, no announcement — hence no
 * prompt-token cost) or back on. It writes the same loader row that
 * dsh-mcp-manager-plus toggles, so both surfaces always report one state.
 */
function cloudflareMcpServiceTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_service',
    description:
      '开启或关闭 Cloudflare MCP 服务。关闭后模型不再看到 mcp__cloudflare__* 工具与本插件的工具和公告（省下这部分提示词 token），'
      + 'OAuth 授权、设置页与回环端点都保留，随时可再打开。这与「MCP 管理」页面里 cloudflare 那一行的启停是同一个开关。'
      + '不带 action 参数时只查询当前状态。',
    parameters: {
      action: {
        type: 'string',
        description: 'on=开启服务，off=关闭服务，status=只查询当前状态（默认 status）',
        enum: ['on', 'off', 'status'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enabled: { type: 'boolean' },
          mounted: { type: 'boolean' },
          modelToolCount: { type: 'number' },
          patchPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: { action?: string }) {
      const action = args.action === 'on' || args.action === 'off' ? args.action : 'status'
      try {
        const state = action === 'status' ? ctx.service.state() : ctx.service.set(action === 'on')
        return {
          ok: true,
          message: 'Cloudflare MCP 服务' + (state.enabled ? '已开启' : '已关闭')
            + '（装载' + (state.mounted ? '是' : '否') + '，模型可见工具 ' + state.modelToolCount + ' 个）。'
            + (action === 'status'
              ? '需要改动请用 action=on 或 action=off。'
              : state.enabled
                ? '工具与公告已恢复。'
                : '这部分提示词额度已释放；设置页「Cloudflare MCP」或 MCP 管理页都能重新打开。'),
          enabled: state.enabled,
          mounted: state.mounted,
          modelToolCount: state.modelToolCount,
          patchPath: state.patchPath,
        }
      } catch (error) {
        return { ok: false, message: '切换失败：' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}
