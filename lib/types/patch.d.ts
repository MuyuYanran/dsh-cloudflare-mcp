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
/** The row id of the standard MCP client row this bundle inserts. */
export declare const SERVICE_ROW_ID = "mcp-cloudflare";
/** The package that row mounts (kept here so the two halves agree on one name). */
export declare const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** One parsed top-level item of the patch document. */
interface PatchItem {
    /** Item start line (inclusive) in the document. */
    start: number;
    /** Item end line (exclusive). */
    end: number;
    /** `id` when the item is a pure override; null for an insert block. */
    id: string | null;
    /** Whether the item carries a `disabled:` key. */
    disabledKey: boolean;
    /** The literal `disabled:` value (`'true'` / `'false'`, empty when unreadable). */
    disabledValue: string;
    /** Whether the item is an `- insert:` block. */
    isInsert: boolean;
    /** Raw item text. */
    text: string;
}
/** The document view the switch works on. */
export interface PatchDocument {
    eol: string;
    lines: string[];
    items: PatchItem[];
}
/** The loader face this module needs; typed loosely — it is not ours. */
export interface LoaderLike {
    entries?: () => Iterable<{
        options?: {
            name?: string;
            config?: {
                path?: unknown;
            };
        };
    }>;
}
/** The DSH home, honouring `DSH_HOME` the way every harness tool does. */
export declare function dshHome(): string;
/** The profile this process booted (`--profile <name>`), if any. */
export declare function argvProfile(): string | undefined;
/**
 * Resolve the user patch layer the way dsh-mcp-manager-plus does: the
 * `cordis:include` entry the loader actually read is authoritative (a host that
 * owns the profile directory, such as DSH Desktop, may place it elsewhere), with
 * the conventional path as the fallback.
 * @param loader - the running composition's loader service, when reachable.
 * @returns absolute path of the profile's `cordis.patch.yml`.
 */
export declare function resolvePatchPath(loader?: LoaderLike): string;
/**
 * Decode a `file://` URL to a native path; a plain path passes through. Percent
 * escapes must be decoded — a host that hands the include path over as a file
 * URL names a directory containing a space as `%20`, and an undecoded path then
 * resolves to a file that does not exist.
 * @param value - a `file://` URL or a native path.
 */
export declare function fromFileUrl(value: string): string;
/** Read the patch file; a missing file is an empty document, anything else throws. */
export declare function readPatchText(patchPath: string): string;
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
export declare function parsePatch(text: string): PatchDocument;
/** Whether the document's `disabled` override for `rowId` turns the row off. */
export declare function readDisabled(document: PatchDocument, rowId: string): boolean;
/** Whether the document carries any `disabled` override for `rowId`. */
export declare function hasDisabledOverride(document: PatchDocument, rowId: string): boolean;
/**
 * Render a document back to text. The preamble is the lines before the first
 * item of the parsed document — a synthetic item added by {@link setDisabled}
 * carries `start: -1` and never relocates it.
 * @param document - the document view.
 * @param items - the replacement item list (defaults to the parsed items).
 * @returns file text ending in a newline; an empty document stays an empty list.
 */
export declare function joinPatch(document: PatchDocument, items?: PatchItem[]): string;
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
export declare function setDisabled(text: string, rowId: string, enabled: boolean): string;
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
export declare function writePatch(patchPath: string, next: string, expectedPrevious?: string): void;
/** The error a refused write reports when another writer got there first. */
export declare class PatchConflictError extends Error {
    constructor(message: string);
}
export {};
