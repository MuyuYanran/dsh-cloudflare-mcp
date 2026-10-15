/**
 * dsh-cloudflare-mcp — profile patch layer for the MCP-service switch.
 *
 * The Cloudflare MCP connection ships as two loader rows:
 *
 *   - `cloudflare-mcp`    — this plugin: OAuth, the settings panel, the
 *                           loopback MCP endpoint (always mounted, otherwise the
 *                           switch could never be flipped back on).
 *   - `mcp-cloudflare`    — a standard `@deepseek-ai/dsh-mcp-client` row pointed
 *                           at that endpoint. THIS is the row that puts
 *                           `mcp__cloudflare__*` into the model's tool list, so
 *                           it is what "the Cloudflare MCP service" means for
 *                           token cost.
 *
 * That second row is exactly what dsh-mcp-manager-plus manages, so the durable
 * state of the switch is the `disabled` override the manager reads and writes in
 * the profile's user patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).
 * One file, two surfaces: the panel switch and the manager switch address the
 * same row and therefore cannot drift.
 *
 * Shape of an override (a top-level item of the patch list):
 *
 *     - id: mcp-cloudflare
 *       disabled: true
 *
 * Writes are textual and surgical: comments, unrelated items and unknown keys in
 * the file survive verbatim, because the file belongs to the user. There is no
 * YAML dependency here — the layer stays writable on a profile that has no
 * `js-yaml` at its root, and a mistake can only ever cost one 2-line block.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The row id of the standard MCP client row this bundle inserts. */
export const SERVICE_ROW_ID = 'mcp-cloudflare'

/** The package that row mounts (kept here so the two halves agree on one name). */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** One parsed top-level item of the patch document. */
interface PatchItem {
  /** Item start line (inclusive) in the document. */
  start: number
  /** Item end line (exclusive). */
  end: number
  /** `id` when the item is a pure override; null for an insert block. */
  id: string | null
  /** Whether the item carries a `disabled:` key. */
  disabledKey: boolean
  /** The literal `disabled:` value (`'true'` / `'false'`, empty when unreadable). */
  disabledValue: string
  /** Whether the item is an `- insert:` block. */
  isInsert: boolean
  /** Raw item text. */
  text: string
}

/** The document view the switch works on. */
export interface PatchDocument {
  eol: string
  lines: string[]
  items: PatchItem[]
}

/** The loader face this module needs; typed loosely — it is not ours. */
export interface LoaderLike {
  entries?: () => Iterable<{ options?: { name?: string; config?: { path?: unknown } } }>
}

/** The DSH home, honouring `DSH_HOME` the way every harness tool does. */
export function dshHome(): string {
  const override = process.env.DSH_HOME
  return override !== undefined && override.trim() !== '' ? override : join(homedir(), '.dsh')
}

/** The profile this process booted (`--profile <name>`), if any. */
export function argvProfile(): string | undefined {
  const index = process.argv.indexOf('--profile')
  if (index !== -1 && index + 1 < process.argv.length && !process.argv[index + 1].startsWith('-')) {
    return process.argv[index + 1]
  }
  return undefined
}

/**
 * Resolve the user patch layer the way dsh-mcp-manager-plus does: the
 * `cordis:include` entry the loader actually read is authoritative (a host that
 * owns the profile directory, such as DSH Desktop, may place it elsewhere), with
 * the conventional path as the fallback.
 * @param loader - the running composition's loader service, when reachable.
 * @returns absolute path of the profile's `cordis.patch.yml`.
 */
export function resolvePatchPath(loader?: LoaderLike): string {
  const fromLoader = includePatchPath(loader)
  if (fromLoader !== undefined) return fromLoader
  return join(dshHome(), 'profiles', argvProfile() ?? 'web', 'cordis.patch.yml')
}

/**
 * Find the root include entry and rewrite its `cordis.yml` path onto the
 * sibling `cordis.patch.yml`.
 * @param loader - the loader service, if any.
 * @returns the patch path, or undefined when it cannot be determined.
 */
function includePatchPath(loader?: LoaderLike): string | undefined {
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    const options = entry.options
    if (options?.name !== 'cordis:include') continue
    const path = options.config?.path
    if (typeof path !== 'string' || !path.includes('cordis.yml')) continue
    return fromFileUrl(path).replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return undefined
}

/**
 * Decode a `file://` URL to a native path; a plain path passes through. Percent
 * escapes must be decoded — a host that hands the include path over as a file
 * URL names a directory containing a space as `%20`, and an undecoded path then
 * resolves to a file that does not exist.
 * @param value - a `file://` URL or a native path.
 */
export function fromFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value
  try {
    return fileURLToPath(value)
  } catch {
    // Fall through to the manual parse for a malformed URL.
  }
  try {
    const path = decodeURIComponent(new URL(value).pathname)
    // Windows file URLs carry a leading slash before the drive letter.
    return /^\/[A-Za-z]:/u.test(path) ? path.slice(1) : path
  } catch {
    return value.replace(/^file:\/\//u, '')
  }
}

/** Read the patch file; a missing file is an empty document, anything else throws. */
export function readPatchText(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return ''
    throw new Error('补丁层读取失败：' + String((error as Error)?.message ?? error))
  }
}

/**
 * Split a patch document into top-level items.
 *
 * An item starts at a line opening a top-level sequence entry (`- …`). Lines
 * before the first item are the preamble (the comment block users write, plus
 * the header every profile ships); trailing comments stay inside the item they
 * follow, which is what keeps a rewrite from relocating someone's note.
 * @param text - raw file text.
 * @returns the document view.
 */
export function parsePatch(text: string): PatchDocument {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // A trailing newline produces one empty final element; drop it and re-add it
  // on join, so a round-trip is byte-stable.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const starts = topLevelStarts(lines)
  const items: PatchItem[] = []
  for (let order = 0; order < starts.length; order += 1) {
    const from = starts[order]
    const to = order + 1 < starts.length ? starts[order + 1] : lines.length
    const body = lines.slice(from, to)
    items.push({ start: from, end: to, ...classify(body), text: body.join('\n') })
  }
  return { eol, lines, items }
}

/**
 * The line indices that open a top-level entry.
 *
 * A YAML block scalar (`script: !!js |-` followed by indented lines — exactly
 * what dsh-mcp-manager-plus writes for a `!!js` expression) may legitimately
 * carry lines that begin with `- `. Reading those as new top-level entries would
 * split one user row in half, and a later rewrite would relocate their content.
 * So block bodies are skipped by indent, the same rule YAML itself uses.
 * @param lines - the document's lines.
 */
function topLevelStarts(lines: string[]): number[] {
  const starts: number[] = []
  let blockIndent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (blockIndent >= 0) {
      const blank = line.trim() === ''
      if (blank || indentOf(line) >= blockIndent) continue
      blockIndent = -1
    }
    if (/^-(?:[ \t]|$)/u.test(line)) starts.push(index)
    const opened = blockScalarIndent(line)
    if (opened !== null) {
      // The block's own content must be deeper than the key that opened it; the
      // first deeper line fixes the indent everything else is measured against.
      blockIndent = opened.keyIndent + 1
    }
  }
  return starts
}

/**
 * Whether one line opens a YAML block scalar, and at what indent.
 * @param line - a raw document line.
 * @returns the key's indent, or null when the line opens no block.
 */
function blockScalarIndent(line: string): { keyIndent: number } | null {
  if (/^\s*#/u.test(line)) return null
  const match = /^(\s*)[^\s].*:\s*(?:!![A-Za-z_][\w-]*\s+)?[-|>][0-9]*[-+]?\s*(?:#.*)?$/u.exec(line)
  if (match === null) return null
  return { keyIndent: match[1].length }
}

/** Leading-space count of a line (tabs count as one level each). */
function indentOf(line: string): number {
  const match = /^[ \t]*/u.exec(line)
  return match === null ? 0 : match[0].length
}

/** Extract the structural facts the switch needs from one item's lines. */
function classify(body: string[]): Pick<PatchItem, 'id' | 'disabledKey' | 'disabledValue' | 'isInsert'> {
  let id: string | null = null
  let disabledKey = false
  let disabledValue = ''
  let isInsert = false
  for (const line of body) {
    if (/^\s*#/u.test(line)) continue
    if (/^-[ \t]+insert:/u.test(line)) isInsert = true
    const idMatch = /^(?:-[ \t]+| {2})id:[ \t]*(.+?)[ \t]*$/u.exec(line)
    if (idMatch !== null && id === null) id = unquote(idMatch[1])
    const disabledMatch = /^ {2}disabled:[ \t]*(.+?)[ \t]*$/u.exec(line)
    if (disabledMatch !== null) {
      disabledKey = true
      disabledValue = unquote(disabledMatch[1])
    }
  }
  // An insert block declares its ids as `    - id:` lines; the switch only ever
  // addresses pure overrides, so those must not read as override targets.
  if (isInsert) id = null
  return { id, disabledKey, disabledValue, isInsert }
}

/** Strip one layer of YAML quoting from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Whether the document's `disabled` override for `rowId` turns the row off. */
export function readDisabled(document: PatchDocument, rowId: string): boolean {
  let disabled = false
  for (const item of document.items) {
    if (item.isInsert || item.id !== rowId || !item.disabledKey) continue
    disabled = item.disabledValue !== 'false'
  }
  return disabled
}

/** Whether the document carries any `disabled` override for `rowId`. */
export function hasDisabledOverride(document: PatchDocument, rowId: string): boolean {
  return document.items.some((item) => !item.isInsert && item.id === rowId && item.disabledKey)
}

/**
 * Render a document back to text. The preamble is the lines before the first
 * item of the parsed document — a synthetic item added by {@link setDisabled}
 * carries `start: -1` and never relocates it.
 * @param document - the document view.
 * @param items - the replacement item list (defaults to the parsed items).
 * @returns file text ending in a newline; an empty document stays an empty list.
 */
export function joinPatch(document: PatchDocument, items: PatchItem[] = document.items): string {
  const chunks: string[] = []
  const preambleEnd = document.items.length > 0 ? document.items[0].start : document.lines.length
  const preamble = document.lines.slice(0, preambleEnd).join(document.eol)
  if (preamble.trim() !== '') chunks.push(preamble)
  let wroteItem = false
  for (const item of items) {
    const body = item.text.split('\n').join(document.eol)
    if (body.trim() === '') continue
    chunks.push(body)
    wroteItem = true
  }
  if (!wroteItem) chunks.push('[]')
  let text = chunks.join(document.eol)
  if (text.trim() === '') return '[]' + document.eol
  if (!text.endsWith(document.eol)) text += document.eol
  return text
}

/**
 * Set or clear the `disabled` override for one row.
 *
 * Enabling a row that a bundle layer inserts needs an explicit `disabled:
 * false`: dropping the override cannot lift a row another layer holds down, and
 * dsh-mcp-manager-plus writes exactly this shape, so the two surfaces produce
 * byte-identical documents.
 * @param text - raw patch text (missing file = empty string).
 * @param rowId - the loader row to address.
 * @param enabled - the desired state.
 * @returns the new document text.
 */
export function setDisabled(text: string, rowId: string, enabled: boolean): string {
  const document = parsePatch(text)
  const keep = document.items.filter((item) => !(item.id === rowId && !item.isInsert && item.disabledKey))
  const block: PatchItem = {
    start: -1,
    end: -1,
    id: rowId,
    disabledKey: true,
    disabledValue: enabled ? 'false' : 'true',
    isInsert: false,
    text: ['- id: ' + rowId, '  disabled: ' + (enabled ? 'false' : 'true')].join('\n'),
  }
  return joinPatch(document, [...keep, block])
}

/**
 * Atomically replace the patch file, with an optimistic compare-and-swap.
 *
 * dsh-mcp-manager-plus writes this same file (it polls and writes on its own
 * page), so a read-modify-write that started from stale bytes would silently
 * drop whatever the other surface wrote in between. When `expectedPrevious` is
 * given, a file whose current content differs is refused instead of clobbered,
 * and the caller re-reads and retries against the fresh state.
 * @param patchPath - absolute path.
 * @param next - candidate content.
 * @param expectedPrevious - the exact text the candidate was built from.
 * @throws when the candidate is not a top-level entry list, the profile
 * directory is missing, or the file changed since it was read.
 */
export function writePatch(patchPath: string, next: string, expectedPrevious?: string): void {
  const candidate = parsePatch(next)
  const withoutComments = next.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (candidate.items.length === 0 && withoutComments !== '' && withoutComments !== '[]') {
    throw new Error('补丁层写入被拒绝：候选内容不是顶层条目列表')
  }
  // The loader parses this file as one top-level YAML list, so the only text
  // allowed above the first entry is blank lines and comments. Anything else
  // would make the profile fail to boot on the next start.
  const preamble = candidate.items.length > 0 ? candidate.lines.slice(0, candidate.items[0].start) : candidate.lines
  if (preamble.some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))) {
    throw new Error('补丁层写入被拒绝：首个条目前只允许注释或空行')
  }
  if (!next.endsWith('\n')) throw new Error('补丁层写入被拒绝：候选内容缺少结尾换行')
  const parent = dirname(patchPath)
  if (!existsSync(parent)) throw new Error('补丁层写入被拒绝：profile 目录不存在')
  const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (expectedPrevious !== undefined && current !== expectedPrevious) {
    throw new PatchConflictError('补丁层在读取之后被改动（可能有其他界面同时在写入），本次写入已取消。')
  }
  const temp = patchPath + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(temp, next)
  renameSync(temp, patchPath)
}

/** The error a refused write reports when another writer got there first. */
export class PatchConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchConflictError'
  }
}
