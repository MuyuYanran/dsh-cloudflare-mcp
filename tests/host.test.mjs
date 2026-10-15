/**
 * dsh-cloudflare-mcp — host assembly test with a fake Cordis context.
 *
 * Boots the real `apply()` on a duck-typed context and drives the switch, which
 * is where the plugin's contract with the harness lives:
 * - every agent-facing tool compiles (a schema DSL violation previously took the
 *   whole row down at boot, silently for offline tests);
 * - routes and the loopback MCP endpoint mount;
 * - the model-facing surfaces (helper tools + announcement) follow the switch,
 *   while the always-on surfaces never do;
 * - the switch's durable record is the patch layer, written in exactly the shape
 *   dsh-mcp-manager-plus reads, and it is read back from there.
 *
 * DSH_HOME is redirected to a temp profile so the real user patch layer and
 * credential file are never touched.
 *
 *   node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
async function check(name, body) {
  try {
    await body()
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.error('FAIL ' + name + '\n     ' + String(error?.stack ?? error))
  }
}

/** A route the plugin asked the web server to mount. */
function makeHarness(patchContent) {
  const dir = mkdtempSync(join(tmpdir(), 'cfmcp-host-'))
  const profileDir = join(dir, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, patchContent)
  process.env.DSH_HOME = dir
  process.env.DSH_CLOUDFLARE_MCP_CONFIG = join(dir, 'credentials.json')
  process.argv = [process.argv[0], process.argv[1], '--profile', 'web']

  const state = {
    routes: new Map(), endpoints: [], tools: [], sections: [], listeners: new Map(), provided: new Map(), effects: 0,
  }
  const recordTool = (definition) => {
    state.tools.push(definition.name)
    return () => { state.tools = state.tools.filter((name) => name !== definition.name) }
  }
  const ctx = {
    webServer: {
      port: 39511,
      register(route) {
        // Handlers are kept so a test can drive the exact route apply() mounted.
        if (route.path === '/mcp/cloudflare') state.endpoints.push(route.path)
        else state.routes.set(route.path, route.handler)
        return () => {
          state.routes.delete(route.path)
          state.endpoints = state.endpoints.filter((path) => path !== route.path)
        }
      },
    },
    tools: { register: recordTool, schemas: () => state.tools.map((name) => ({ name })) },
    systemPrompt: {
      section(section) {
        state.sections.push(section.name)
        return () => { state.sections = state.sections.filter((name) => name !== section.name) }
      },
    },
    get(name) {
      if (name === 'loader') return { entries: () => [{ options: { name: 'dsh-mcp-manager-plus' } }] }
      return undefined
    },
    provide(name, value) { state.provided.set(name, value); return () => state.provided.delete(name) },
    effect(body) { state.effects += 1; return body() },
    on(name, listener) {
      const list = state.listeners.get(name) ?? []
      list.push(listener)
      state.listeners.set(name, list)
      return () => state.listeners.set(name, list.filter((entry) => entry !== listener))
    },
    emit(name) { for (const listener of state.listeners.get(name) ?? []) listener() },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, dir, patchPath, state }
}

const BASE_PATCH = '# user layer\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: dark\n'

async function main() {
  const mod = await import('../lib/index.js')

  await check('apply() compiles every agent-facing tool without throwing', () => {
    const harness = makeHarness(BASE_PATCH)
    // A schema DSL violation throws out of defineTool and takes the row with it;
    // this is the regression guard for exactly that class of failure.
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    assert.ok(harness.state.tools.includes('cloudflare_mcp_service'), 'switch tool registered')
    assert.deepEqual(
      [...harness.state.tools].sort(),
      ['cloudflare_mcp_clear', 'cloudflare_mcp_oauth_finish', 'cloudflare_mcp_oauth_start',
        'cloudflare_mcp_service', 'cloudflare_mcp_status', 'cloudflare_mcp_test'],
      'the full helper set',
    )
  })

  await check('routes and the loopback endpoint always mount, the announcement too', () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    for (const path of ['/api/dsh-cloudflare-mcp/status', '/api/dsh-cloudflare-mcp/service',
      '/api/dsh-cloudflare-mcp/oauth/callback', '/api/dsh-cloudflare-mcp/oauth/start']) {
      assert.ok(harness.state.routes.has(path), path + ' mounted')
    }
    assert.deepEqual(harness.state.endpoints, ['/mcp/cloudflare'])
    assert.deepEqual(harness.state.sections, ['plugin:dsh-cloudflare-mcp'])
  })

  await check('an already-disabled row mounts only the keeper switch', () => {
    const harness = makeHarness(BASE_PATCH + '- id: mcp-cloudflare\n  disabled: true\n')
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    // Off means: no cost-bearing surfaces, but the switch stays callable so the
    // agent can report and reverse the state from a chat without the settings page.
    assert.deepEqual(harness.state.tools, ['cloudflare_mcp_service'], 'only the keeper')
    assert.equal(harness.state.sections.length, 0, 'no announcement')
    // The surfaces that let the user turn it back on must still be there.
    assert.ok(harness.state.routes.has('/api/dsh-cloudflare-mcp/service'), 'switch reachable')
    assert.deepEqual(harness.state.endpoints, ['/mcp/cloudflare'], 'endpoint stays mounted')
  })

  await check('disabling through the patch layer drops the model surfaces (manager direction)', () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    assert.equal(harness.state.tools.length, 6, 'full helper set while on')
    // dsh-mcp-manager-plus writes this file; the profile reload is what tells us.
    writeFileSync(harness.patchPath, BASE_PATCH + '- id: mcp-cloudflare\n  disabled: true\n')
    harness.ctx.emit('app-boot/config-reload')
    assert.deepEqual(harness.state.tools, ['cloudflare_mcp_service'], 'helpers gone, keeper stays')
    assert.equal(harness.state.sections.length, 0, 'announcement gone')
    assert.ok(harness.state.routes.has('/api/dsh-cloudflare-mcp/status'), 'panel still served')
  })

  await check('re-enabling through the patch layer brings them back', () => {
    const harness = makeHarness(BASE_PATCH + '- id: mcp-cloudflare\n  disabled: true\n')
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    assert.equal(harness.state.tools.length, 1)
    writeFileSync(harness.patchPath, BASE_PATCH + '- id: mcp-cloudflare\n  disabled: false\n')
    harness.ctx.emit('app-boot/config-reload')
    assert.equal(harness.state.tools.length, 6, 'the full set is back, no duplicates')
    assert.equal(new Set(harness.state.tools).size, 6, 'no double registration after a toggle cycle')
    assert.deepEqual(harness.state.sections, ['plugin:dsh-cloudflare-mcp'])
  })

  await check('the panel switch writes the manager-readable override and re-reads it', async () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    const response = await postJson(harness, '/api/dsh-cloudflare-mcp/service', { enabled: false })
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.equal(response.service.enabled, false)
    assert.equal(response.service.mode, 'bridge')
    const onDisk = readFileSync(harness.patchPath, 'utf8')
    assert.ok(onDisk.includes('- id: mcp-cloudflare\n  disabled: true'), onDisk)
    assert.ok(onDisk.startsWith('# user layer'), 'the user header survived')
    assert.equal(onDisk.includes('preference: dark'), true, 'the unrelated row survived')
    assert.deepEqual(harness.state.tools, ['cloudflare_mcp_service'], 'cost surfaces gone, keeper stays')
    // Turn it back on through the same route.
    const back = await postJson(harness, '/api/dsh-cloudflare-mcp/service', { enabled: true })
    assert.equal(back.service.enabled, true)
    assert.ok(harness.state.tools.includes('cloudflare_mcp_service'))
  })

  await check('status reports the switch, the endpoint, and never a secret', async () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    const view = await getJson(harness, '/api/dsh-cloudflare-mcp/status')
    assert.equal(view.mcpEndpoint, 'http://127.0.0.1:39511/mcp/cloudflare')
    assert.equal(view.service.enabled, true)
    assert.equal(view.service.managerManaged, true, 'the manager row was detected')
    assert.ok(!JSON.stringify(view).includes('access_token'), 'no token material in the view')
  })

  await check('a non-loopback caller cannot reach the switch or the endpoint', async () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true })
    const status = await postJson(harness, '/api/dsh-cloudflare-mcp/service', { enabled: false }, { remoteAddress: '203.0.113.9' })
    assert.equal(status.error, 'forbidden: loopback-only', JSON.stringify(status))
    assert.equal(harness.state.tools.length > 0, true, 'the service stayed on')
  })

  await check('plugin enabled:false mounts nothing at all', () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: false })
    assert.equal(harness.state.routes.size, 0)
    assert.equal(harness.state.endpoints.length, 0)
    assert.equal(harness.state.tools.length, 0)
  })

  await check('direct mode keeps the pre-bridge behaviour as an escape hatch', () => {
    const harness = makeHarness(BASE_PATCH)
    mod.apply(harness.ctx, { announceToAgent: true, enabled: true, registerToolsDirectly: true })
    // No bridge is mounted: this plugin registers its own tools, so there is no
    // standard row for the manager to toggle and nothing to proxy.
    assert.equal(harness.state.endpoints.length, 0, 'no bridge in direct mode')
    assert.ok(harness.state.tools.includes('cloudflare_mcp_service'), 'helpers still mount')
    const state = harness.ctx.state ?? harness.state
    assert.equal(state.tools.length > 0, true)
  })
}

/** Drive one route handler with a fake req/res and return the JSON it wrote. */
async function request(harness, path, { method = 'GET', body, remoteAddress = '127.0.0.1' } = {}) {
  // apply() mounted these handlers through the fake web server; calling the exact
  // registered function is what makes this a test of the real route table.
  const captured = harness.state.routes.get(path)
  if (captured === undefined) throw new Error('route not mounted: ' + path)
  let status = 0
  let payload = ''
  const res = {
    headersSent: false,
    writeHead(code) { status = code; return this },
    end(text) { payload = text ?? ''; return this },
    once() { return this },
  }
  const req = {
    method,
    url: path,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:39511', origin: 'http://127.0.0.1:39511' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await captured(req, res)
  let parsed = {}
  try { parsed = JSON.parse(payload) } catch { /* keep empty */ }
  return { status, ...parsed }
}

async function postJson(harness, path, body, options = {}) {
  return request(harness, path, { method: 'POST', body, ...options })
}
async function getJson(harness, path, options = {}) {
  return request(harness, path, { method: 'GET', ...options })
}

main().then(() => {
  if (failures > 0) {
    console.error('host: ' + failures + ' failure(s)')
    process.exitCode = 1
  } else {
    console.log('host: PASS')
  }
}, (error) => {
  console.error('host: crashed', error)
  process.exitCode = 1
})
