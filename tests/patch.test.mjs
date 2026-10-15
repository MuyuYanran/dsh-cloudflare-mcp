/**
 * dsh-cloudflare-mcp — patch-layer tests (offline).
 *
 * The switch's durable record is the profile patch layer, the same file and the
 * same row dsh-mcp-manager-plus reads and writes. These tests pin the shapes
 * both sides must agree on: a comment header and unrelated items survive a
 * rewrite, the override block round-trips, enable/disable produce exactly the
 * lines the manager writes, and a candidate the splitter cannot trust is refused
 * rather than written.
 *
 *   node tests/patch.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVICE_ROW_ID,
  parsePatch,
  readDisabled,
  hasDisabledOverride,
  setDisabled,
  writePatch,
  readPatchText,
  resolvePatchPath,
  fromFileUrl,
} from '../lib/index.js'

let failures = 0
/** Run one named assertion block and keep counting. */
function check(name, body) {
  try {
    body()
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.error('FAIL ' + name + '\n     ' + String(error?.message ?? error))
  }
}

const SAMPLE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: dark',
  '- id: mcp-github',
  '  disabled: true',
].join('\n') + '\n'

check('parses the preamble and every top-level item', () => {
  const document = parsePatch(SAMPLE)
  assert.equal(document.items.length, 2)
  assert.equal(document.items[0].id, 'ui-theme')
  assert.equal(document.items[1].id, 'mcp-github')
  assert.equal(document.items[1].disabledKey, true)
  assert.equal(document.items[1].disabledValue, 'true')
})

check('a nested id inside an insert block is never an override target', () => {
  const document = parsePatch('- insert:\n    - id: ' + SERVICE_ROW_ID + '\n      name: x\n      config:\n        a: 1\n')
  assert.equal(document.items[0].isInsert, true)
  assert.equal(document.items[0].id, null)
  assert.equal(readDisabled(document, SERVICE_ROW_ID), false)
  assert.equal(hasDisabledOverride(document, SERVICE_ROW_ID), false)
})

check('no override means enabled', () => {
  assert.equal(readDisabled(parsePatch(SAMPLE), SERVICE_ROW_ID), false)
})

check('disable writes exactly the manager\'s shape and keeps the rest', () => {
  const next = setDisabled(SAMPLE, SERVICE_ROW_ID, false)
  assert.ok(next.includes('- id: ' + SERVICE_ROW_ID + '\n  disabled: true'), next)
  assert.ok(next.startsWith('# Your patch layer'), 'header comment preserved')
  assert.ok(next.includes('preference: dark'), 'unrelated row preserved')
  assert.ok(next.includes('- id: mcp-github'), 'other override preserved')
  assert.equal(readDisabled(parsePatch(next), SERVICE_ROW_ID), true)
})

check('enable writes an explicit disabled false (a bundle row needs the lift)', () => {
  const off = setDisabled(SAMPLE, SERVICE_ROW_ID, false)
  const on = setDisabled(off, SERVICE_ROW_ID, true)
  assert.ok(on.includes('- id: ' + SERVICE_ROW_ID + '\n  disabled: false'), on)
  assert.equal(readDisabled(parsePatch(on), SERVICE_ROW_ID), false)
})

check('repeated toggles replace the block instead of stacking duplicates', () => {
  let text = SAMPLE
  for (const state of [false, true, false, false, true]) text = setDisabled(text, SERVICE_ROW_ID, state)
  const overrides = parsePatch(text).items.filter((item) => item.id === SERVICE_ROW_ID)
  assert.equal(overrides.length, 1, 'exactly one override for the row')
  assert.equal(overrides[0].disabledValue, 'false')
})

check('a CRLF document keeps its line endings', () => {
  const crlf = SAMPLE.replace(/\n/gu, '\r\n')
  const next = setDisabled(crlf, SERVICE_ROW_ID, false)
  assert.ok(!next.includes('\n\r'), 'no lone LF before CR')
  assert.equal(next.split('\r\n').length, crlf.split('\r\n').length + 2)
})

check('an empty or placeholder layer becomes a valid list', () => {
  assert.equal(setDisabled('', SERVICE_ROW_ID, false).trim(), '- id: ' + SERVICE_ROW_ID + '\n  disabled: true')
  assert.ok(setDisabled('[]\n', SERVICE_ROW_ID, true).includes('- id: ' + SERVICE_ROW_ID))
})

check('a comment-only layer keeps its comments and gains the row', () => {
  const next = setDisabled('# notes only\n', SERVICE_ROW_ID, false)
  assert.ok(next.startsWith('# notes only'), next)
  assert.ok(next.includes('- id: ' + SERVICE_ROW_ID))
})

check('a block scalar body is never read as a new entry', () => {
  // Exactly what dsh-mcp-manager-plus writes for a `!!js` expression: the block
  // body can carry lines starting with `- `, which must stay inside the row.
  const document = parsePatch([
    '- id: mcp-github',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    headers:',
    '      Authorization: !!js |-',
    '        `Bearer ${process.env.TOKEN}`',
    '        - a line that looks top-level',
    '- id: ' + SERVICE_ROW_ID,
    '  disabled: true',
  ].join('\n') + '\n')
  assert.equal(document.items.length, 2, 'the block body did not split the row')
  assert.equal(document.items[0].id, 'mcp-github')
  assert.equal(document.items[1].id, SERVICE_ROW_ID)
  assert.equal(readDisabled(document, SERVICE_ROW_ID), true)
  // Rewriting must relocate nothing: the block survives byte-for-byte.
  const next = setDisabled(document.items[0].text + '\n' + document.items[1].text + '\n', 'other', false)
  assert.ok(next.includes('Authorization: !!js |-'), 'block opener preserved')
  assert.ok(next.includes('        - a line that looks top-level'), 'block body preserved')
})

check('writePatch round-trips; a missing file reads as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfmcp-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  const candidate = setDisabled(SAMPLE, SERVICE_ROW_ID, false)
  writePatch(file, candidate)
  assert.equal(readFileSync(file, 'utf8'), candidate)
  assert.equal(readPatchText(join(dir, 'nope.yml')), '', 'missing file is an empty document')
})

check('writePatch refuses a document the loader could not parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfmcp-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  const good = setDisabled(SAMPLE, SERVICE_ROW_ID, false)
  writePatch(file, good)
  assert.throws(() => writePatch(file, 'key: a mapping, not a list\n'), /不是顶层条目列表/u)
  assert.throws(() => writePatch(file, 'stray prose\n- id: x\n  disabled: true\n'), /首个条目前只允许注释/u)
  assert.equal(readFileSync(file, 'utf8'), good, 'a refusal never writes')
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'no temp file left behind')
})

check('writePatch refuses to clobber a concurrent writer (compare-and-swap)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfmcp-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  const base = setDisabled(SAMPLE, SERVICE_ROW_ID, false)
  // First write: the file does not exist yet, so the expected previous content
  // is the empty document.
  writePatch(file, base, '')
  // Another surface wrote the row back on while we held a stale read.
  assert.throws(
    () => writePatch(file, setDisabled(SAMPLE, SERVICE_ROW_ID, false), SAMPLE),
    /被改动/u,
  )
  assert.equal(readFileSync(file, 'utf8'), base)
  // Re-reading first makes the retry succeed.
  const fresh = readFileSync(file, 'utf8')
  writePatch(file, setDisabled(fresh, SERVICE_ROW_ID, true), fresh)
  assert.equal(readDisabled(parsePatch(readFileSync(file, 'utf8')), SERVICE_ROW_ID), false)
})

check('resolvePatchPath follows the loader include entry, file URL decoded', () => {
  const loader = { entries: () => [{ options: { name: 'cordis:include', config: { path: 'file:///C:/Program%20Files/dsh/profiles/web/cordis.yml' } } }] }
  // The answer is a native path (backslashes on Windows); compare normalized.
  assert.equal(resolvePatchPath(loader).replace(/\\/gu, '/'), 'C:/Program Files/dsh/profiles/web/cordis.patch.yml')
  assert.equal(fromFileUrl('/plain/path.yml'), '/plain/path.yml')
  const fallback = resolvePatchPath({ entries: () => [] })
  assert.ok(fallback.endsWith(join('cordis.patch.yml')), fallback)
  assert.ok(existsSync(fallback.replace(/cordis\.patch\.yml$/u, '')) || fallback.includes('.dsh'), fallback)
})

if (failures > 0) {
  console.error('patch: ' + failures + ' failure(s)')
  process.exitCode = 1
} else {
  console.log('patch: PASS')
}
