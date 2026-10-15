/**
 * dsh-cloudflare-mcp — loopback MCP bridge tests.
 *
 * The whole "register into the standard MCP system" design rests on one
 * mechanism: the plugin's OAuth connection, re-exposed as a stateless
 * Streamable HTTP MCP server, must complete the real handshake that
 * @deepseek-ai/dsh-mcp-client performs — initialize, the initialized
 * notification, tools/list, tools/call — with a fresh transport per HTTP
 * request, and must reject a non-loopback caller.
 *
 * The upstream here is a stub supervisor, so this suite proves the transport
 * contract alone, needs no OAuth, and never touches the network.
 *
 *   node tests/bridge.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpBridge } from '../lib/index.js'

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

/** A supervisor that answers without any network, recording what it was asked. */
function stubSupervisor() {
  const calls = []
  return {
    calls,
    listToolDefinitions: async () => [
      { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'deploy', description: 'Deploy a worker', inputSchema: { type: 'object', properties: {} } },
    ],
    callTool: async (rawName, args, signal) => {
      calls.push({ rawName, args, signaled: signal !== undefined })
      return { content: [{ type: 'text', text: 'ran ' + rawName + ' with ' + JSON.stringify(args) }] }
    },
  }
}

const logger = { info() {}, warn() {}, error() {} }

/** Start a loopback server hosting the bridge; returns its URL and a disposer. */
async function serveBridge(supervisor) {
  const bridge = createMcpBridge(supervisor, logger)
  const server = createServer((req, res) => {
    void bridge.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: 'http://127.0.0.1:' + String(port) + '/mcp/cloudflare',
    async dispose() {
      await bridge.dispose()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function main() {
  const supervisor = stubSupervisor()
  const host = await serveBridge(supervisor)

  await check('a standard MCP client completes the full handshake', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(host.url))
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['deploy', 'search'])
    assert.equal(listed.tools[0].description !== undefined, true, 'descriptions carry through')
    const called = await client.callTool({ name: 'search', arguments: { q: 'hello' } })
    const text = JSON.stringify(called)
    assert.ok(text.includes('ran search with'), text)
    assert.ok(text.includes('hello'), 'arguments reach the upstream: ' + text)
    assert.equal(supervisor.calls.length, 1)
    assert.equal(supervisor.calls[0].rawName, 'search', 'the RAW upstream name is what gets called')
    await client.close()
  })

  await check('two sequential clients each get their own session', async () => {
    for (const _attempt of [0, 1]) {
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url)))
      const listed = await client.listTools()
      assert.equal(listed.tools.length, 2)
      await client.close()
    }
  })

  await check('tools are advertised lazily, so an unconnected upstream still lists', async () => {
    // The stub has no notion of "connected"; the bridge must not require a live
    // session just to answer tools/list — that is what the settings panel and a
    // restart of the row both depend on.
    const neverConnected = { ...supervisor, isConnected: () => false }
    const second = await serveBridge({
      ...neverConnected,
      listToolDefinitions: supervisor.listToolDefinitions,
      callTool: supervisor.callTool,
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(second.url)))
    assert.equal((await client.listTools()).tools.length, 2)
    await client.close()
    await second.dispose()
  })

  await check('a non-loopback peer is refused with 403', async () => {
    // The fence matters because the bridge forwards with the user's Cloudflare
    // token: a socket whose remoteAddress is not loopback must never be served.
    const bridge = createMcpBridge(supervisor, logger)
    const codes = []
    const res = {
      headersSent: false,
      writeHead(code) { codes.push(code); return this },
      end() { return this },
      once() { return this },
    }
    await bridge.handler({ method: 'POST', socket: { remoteAddress: '203.0.113.9' } }, res)
    assert.deepEqual(codes, [403], String(codes))
    await bridge.dispose()
  })

  await check('GET answers 405 and DELETE answers 400', async () => {
    const bridge = createMcpBridge(supervisor, logger)
    const codes = []
    const fakeRes = () => ({
      headersSent: false,
      writeHead(code) { codes.push(code); return this },
      end() { return this },
    })
    for (const method of ['GET', 'DELETE']) {
      await bridge.handler({ method, socket: { remoteAddress: '127.0.0.1' } }, fakeRes())
    }
    assert.deepEqual(codes, [405, 400], String(codes))
    await bridge.dispose()
  })

  await host.dispose()
}

main().then(() => {
  if (failures > 0) {
    console.error('bridge: ' + failures + ' failure(s)')
    process.exitCode = 1
  } else {
    console.log('bridge: PASS')
  }
}, (error) => {
  console.error('bridge: crashed', error)
  process.exitCode = 1
})
