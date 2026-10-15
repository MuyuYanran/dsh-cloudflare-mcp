# dsh-cloudflare-mcp

Cloudflare MCP connection for DeepSeek Harness (DSH): the official
Cloudflare API MCP server ([mcp.cloudflare.com](https://mcp.cloudflare.com/mcp))
with the full OAuth 2.0 client dance — dynamic client registration, PKCE
S256, loopback callback on the GUI's own web server, refresh-token grant —
plus a web settings panel.

Once authorized, every Cloudflare API tool (accounts, Workers, Pages, DNS,
R2, KV, D1, AI, …) becomes available in agent sessions as
`mcp__cloudflare__*`, auto-refreshing its token on 401.

Because those tools are registered as an **ordinary MCP server row**, this
plugin also gives you one switch to turn the whole connection off — and the
same switch shows up in [dsh-mcp-manager-plus](https://github.com/appthin/dsh-mcp-manager-plus),
so an unused Cloudflare connection costs zero prompt tokens.

## Why this plugin

DSH's built-in `@deepseek-ai/dsh-mcp-client` supports static headers only —
it cannot complete the OAuth flow that `mcp.cloudflare.com` requires
(`WWW-Authenticate: Bearer realm="OAuth"`). This plugin implements the
OAuth client itself on the official `@modelcontextprotocol/sdk` primitives,
so the connection is genuinely authenticated, not token-pasted.

## How the pieces fit

The plugin owns the authentication; a standard MCP row owns the tools.

```
mcp.cloudflare.com  ←OAuth←  this plugin  ←loopback MCP←  mcp-cloudflare row  →  mcp__cloudflare__*
                              (settings panel,                                  (@deepseek-ai/dsh-mcp-client)
                               cloudflare_mcp_* helpers)
```

- The bundle inserts two loader rows: `cloudflare-mcp` (this plugin) and
  `mcp-cloudflare` (a plain `@deepseek-ai/dsh-mcp-client` row).
- The plugin re-exposes its OAuth-authenticated connection as a standard
  Streamable HTTP MCP server on loopback, `http://127.0.0.1:<gui-port>/mcp/cloudflare`,
  and the row connects to that. The loopback endpoint is guarded to
  `127.0.0.1` and never carries the token over the wire — the token stays in
  this process, so nothing new is exposed.
- Consequence: the Cloudflare connection is one server among the others.
  dsh-mcp-manager-plus can list it, enable/disable it, restart it, and show
  its tools, and the row survives like any other MCP server does.
- The `mcp-cloudflare` row's URL carries a `!!js` expression so it resolves
  the real GUI port at load; nothing about it is machine-specific, so the
  patch layer keeps working on another profile or machine.

## Switching the service off (token cost)

`mcp__cloudflare__*` definitions, the plugin's helper tools, and its
system-prompt announcement are all text the model pays for on every request.
Turning the service off removes them:

- **Settings panel**: the "启用 Cloudflare MCP 服务" checkbox.
- **MCP 管理 page** (dsh-mcp-manager-plus): the enable/disable switch on the
  `cloudflare` row.
- **Chat**: `cloudflare_mcp_service` with `action=on` / `action=off`.

These are not three toggles that sync — they are one toggle with three
surfaces. All three read and write the same durable record: the `disabled`
override of the `mcp-cloudflare` row in the profile patch layer
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). The panel switch and the
manager switch therefore cannot disagree, and neither one needs the other
installed.

What stays mounted when the service is off, on purpose: the settings panel,
the OAuth flow and callback, the loopback endpoint, and `cloudflare_mcp_service`
itself (so the agent can report the state and turn it back on without the
browser). Only the cost-bearing surfaces go away. The upstream connection is
closed when off and reopens on demand.

After authorization completes, the plugin re-runs the row so newly granted
tools appear without restarting the Host.

## Install

```sh
# local development (link)
dsh plugin --profile web add link:/path/to/dsh-cloudflare-mcp
```

The bundle patch mounts both rows automatically; a Host restart is needed for
the layer to compose. Tokens live in `~/.dsh/dsh-cloudflare-mcp.json`
(mode 0600).

## Authorize

Two ways, both starting the same OAuth flow against Cloudflare:

1. **Settings panel** (Web GUI → Settings → Cloudflare MCP): click 开始授权,
   the browser opens Cloudflare's consent page, and the loopback callback
   completes automatically. 测试连接 lists the discovered tools.
2. **Chat**: ask the agent to run `cloudflare_mcp_oauth_start`, open the
   returned `authorizeUrl`, or paste the callback `code` back into
   `cloudflare_mcp_oauth_finish`.

## Tools

Agent-facing helpers (mounted on `ctx.tools`):

| tool | what it does |
|---|---|
| `cloudflare_mcp_status` | authorization + connection state, switch state, tool count (no secrets) |
| `cloudflare_mcp_oauth_start` | begin the OAuth flow, return the browser URL |
| `cloudflare_mcp_oauth_finish` | manual code-paste fallback |
| `cloudflare_mcp_test` | connect and list the MCP server's tools |
| `cloudflare_mcp_clear` | wipe credentials and disconnect |
| `cloudflare_mcp_service` | read / enable / disable the MCP service (the shared switch) |

Plus the MCP server's own tools as `mcp__cloudflare__*`, contributed by the
standard row rather than by this plugin.

## Configuration

Read from the composition row (`config:` of the `cloudflare-mcp` row):

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | Plugin master switch. `false` mounts nothing at all. |
| `announceToAgent` | `true` | Whether the system-prompt section announces the plugin. |
| `registerToolsDirectly` | `false` | Escape hatch: register `mcp__cloudflare__*` on `ctx.tools` the way this plugin did before the loopback endpoint. Use it only when the profile does not mount the standard row — the switch then governs this plugin's own registration instead of a loader row, and dsh-mcp-manager-plus has nothing to manage. |

## API routes

All loopback-only (`127.0.0.1`), except the OAuth callback which accepts
the cross-site landing from `mcp.cloudflare.com` while still verifying the
OAuth `state`:

- `GET  /api/dsh-cloudflare-mcp/status`
- `POST /api/dsh-cloudflare-mcp/oauth/start`
- `GET  /api/dsh-cloudflare-mcp/oauth/callback` (browser landing)
- `POST /api/dsh-cloudflare-mcp/oauth/finish`
- `POST /api/dsh-cloudflare-mcp/oauth/refresh`
- `POST /api/dsh-cloudflare-mcp/test`
- `POST /api/dsh-cloudflare-mcp/clear`
- `POST /api/dsh-cloudflare-mcp/service` — body `{"enabled": true|false}`
- `POST /mcp/cloudflare` — the loopback MCP endpoint (stateless Streamable HTTP;
  GET answers 405 and DELETE 400 by design)

## Development

```bash
pnpm install
npm run typecheck
npm run build                 # tsc declarations + tsdown (lib/ + lib/client.js)
npm run test                  # offline suites, no network and no real credentials
DSH_CLOUDFLARE_MCP_LIVE=1 node tests/smoke.mjs   # live OAuth phase-1 only
```

| suite | covers |
|---|---|
| `tests/smoke.mjs` | credential store round-trip, OAuth provider metadata, masking |
| `tests/patch.test.mjs` | patch-layer parsing/rewriting: comments and unrelated rows survive, block scalars are not split, the override round-trips, atomic write with compare-and-swap |
| `tests/patch-shape.test.mjs` | the shipped `cordis.patch.yml` parses under the loader's own YAML dialect and its `!!js` expression evaluates |
| `tests/bridge.test.mjs` | a real MCP client completes initialize → tools/list → tools/call against the loopback endpoint; the loopback fence is enforced |
| `tests/host.test.mjs` | the whole `apply()` on a fake context: every tool compiles, surfaces follow the switch, both toggle directions work, and the written override is exactly what the manager reads |

`npm run test` never touches the machine's real credential file or patch layer;
the suites redirect both to throwaway temp directories.

## License

MIT
