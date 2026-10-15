/**
 * dsh-cloudflare-mcp — bundle patch shape test.
 *
 * The composition, not this plugin, decides whether `cordis.patch.yml` boots.
 * This test parses the shipped patch with the loader's own dialect (js-yaml's
 * JSON_SCHEMA plus the `!!js` tag, the same construction
 * `@deepseek-ai/cordis-plugin-include` uses) and then evaluates the expression
 * the standard MCP row carries, so a typo in the YAML or in the expression fails
 * here rather than at someone's next host start.
 *
 *   node tests/patch-shape.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
function check(name, body) {
  try {
    body()
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.error('FAIL ' + name + '\n     ' + String(error?.message ?? error))
  }
}

/** Resolve js-yaml the way the host does: from the profile that installs plugins. */
async function loadYaml() {
  const anchors = [
    process.env.DSH_PROFILE_DIR,
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'desktop'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web'),
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const anchor of anchors) {
    try {
      const require = createRequire(join(anchor, 'package.json'))
      const loaded = require('js-yaml')
      return loaded.default ?? loaded
    } catch {
      // Try the next anchor.
    }
  }
  throw new Error('js-yaml not resolvable from any profile directory; set DSH_PROFILE_DIR')
}

/** The loader's entry-list schema: JSON_SCHEMA plus a `!!js` expression tag. */
function entrySchema(yaml) {
  const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (value) => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
    represent: (value) => value.__jsExpr,
  })
  return yaml.JSON_SCHEMA.extend(jsExpr)
}

const patchPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')

/**
 * Evaluate one `!!js` expression exactly the way the loader does: a Function
 * whose parameter is named `ctx`, wrapped in `with (ctx)`, then `eval` of the
 * expression. Mirroring the real evaluator is the point — a hand-written
 * variant could pass while the host still fails to boot.
 * @param expr - the expression text the YAML tag carried.
 * @param ctx - the loader context stand-in.
 */
function evaluateExpression(expr, ctx) {
  // eslint-disable-next-line no-new-func
  return new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')(ctx, expr)
}

loadYaml().then((yaml) => {
  const raw = readFileSync(patchPath, 'utf8')
  let parsed
  check('the bundle patch parses as a top-level entry list', () => {
    parsed = yaml.load(raw, { schema: entrySchema(yaml) })
    assert.ok(Array.isArray(parsed), 'top level must be an array')
    assert.equal(parsed.length, 1, 'one insert block')
    assert.ok(Array.isArray(parsed[0].insert))
  })

  const rows = () => parsed[0].insert
  check('it inserts exactly the plugin row and the standard MCP row', () => {
    const ids = rows().map((row) => row.id)
    assert.deepEqual(ids, ['cloudflare-mcp', 'mcp-cloudflare'])
    const mcp = rows()[1]
    assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client')
    assert.equal(mcp.inject.join(','), 'webServer')
    assert.equal(mcp.config.serverName, 'cloudflare')
    assert.equal(mcp.config.transport, 'streamable-http')
  })

  check('the url expression evaluates to the loopback endpoint', () => {
    const node = rows()[1].config.url
    assert.equal(typeof node.__jsExpr, 'string', 'the url is a !!js expression')
    const value = evaluateExpression(node.__jsExpr, { get: (name) => (name === 'webServer' ? { port: 19387 } : undefined) })
    assert.equal(value, 'http://127.0.0.1:19387/mcp/cloudflare', String(value))
  })

  check('the url expression falls back when webServer is not resolvable yet', () => {
    // `ctx.get` always exists in the loader scope (dsh-base uses the same form);
    // what varies is whether the service answers, which is the case to model.
    const value = evaluateExpression(rows()[1].config.url.__jsExpr, { get: () => undefined })
    assert.equal(value, 'http://127.0.0.1:3080/mcp/cloudflare', String(value))
  })

  check('the plugin row config keeps both documented switches', () => {
    const plugin = rows()[0]
    assert.equal(plugin.name, 'dsh-cloudflare-mcp')
    assert.equal(plugin.config.announceToAgent, true)
    assert.equal(plugin.config.enabled, true)
    assert.equal(plugin.config.registerToolsDirectly, undefined, 'bridge mode is the default')
  })

  if (failures > 0) {
    console.error('patch-shape: ' + failures + ' failure(s)')
    process.exitCode = 1
  } else {
    console.log('patch-shape: PASS')
  }
}, (error) => {
  console.error('patch-shape: could not load js-yaml —', String(error?.message ?? error))
  process.exitCode = 1
})
