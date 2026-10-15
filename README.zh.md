# dsh-cloudflare-mcp

> 本仓库维护在 [MuyuYanran/dsh-cloudflare-mcp](https://github.com/MuyuYanran/dsh-cloudflare-mcp)，
> 延续自最初的 [zhengjy01/dsh-cloudflare-mcp](https://github.com/zhengjy01/dsh-cloudflare-mcp)。
> OAuth 客户端、连接守护与设置面板均为原作者的工作；标准 MCP 行、回环 MCP 端点
> 以及服务总开关是本分支新增的部分。

DeepSeek Harness (DSH) 的 Cloudflare MCP 连接插件：官方 Cloudflare API MCP
服务器（[mcp.cloudflare.com](https://mcp.cloudflare.com/mcp)）+ 完整的
OAuth 2.0 客户端流程（动态客户端注册、PKCE S256、回调挂在 GUI 自己的
Web 服务上、refresh_token 自动续期）+ 可视化设置面板。

授权后，Cloudflare 的全部 API 工具（账户、Workers、Pages、DNS、R2、KV、
D1、AI 等）就会以 `mcp__cloudflare__*` 形式出现在会话中，遇 401 自动刷新令牌。

这些工具是作为**一个普通 MCP 服务器行**注册的，所以本插件额外提供一个总开关，
可以把整条连接关掉——同一个开关也会出现在
[dsh-mcp-manager-plus](https://github.com/appthin/dsh-mcp-manager-plus)
的「MCP 管理」页面里，于是不使用的 Cloudflare 连接不再消耗任何提示词 token。

## 为什么自建

DSH 自带的 `@deepseek-ai/dsh-mcp-client` 只支持静态 headers，无法完成
mcp.cloudflare.com 要求的 OAuth 流程（`WWW-Authenticate: Bearer realm="OAuth"`）。
本插件基于官方 `@modelcontextprotocol/sdk` 原语自己实现了 OAuth 客户端，
连接是真实授权，而不是手动贴 token。

## 各部分如何配合

插件负责鉴权，标准 MCP 行负责工具。

```
mcp.cloudflare.com  ←OAuth←  本插件  ←回环 MCP←  mcp-cloudflare 行  →  mcp__cloudflare__*
                             （设置面板、                      （@deepseek-ai/dsh-mcp-client）
                              cloudflare_mcp_* 辅助工具）
```

- bundle 补丁插入两行 loader 配置：`cloudflare-mcp`（本插件）与
  `mcp-cloudflare`（一个普通的 `@deepseek-ai/dsh-mcp-client` 行）。
- 插件把已通过 OAuth 鉴权的连接，重新暴露成一个标准 Streamable HTTP MCP
  服务器，地址 `http://127.0.0.1:<GUI 端口>/mcp/cloudflare`，那一行连的是它。
  这个回环端点只接受 `127.0.0.1`，并且令牌从不上网——它始终留在本进程内，
  所以并没有多暴露任何凭据。
- 结果是：Cloudflare 连接和其他 MCP 服务器完全同级。dsh-mcp-manager-plus
  可以列出、启用/停用、重启它，也能展开查看它的工具。
- `mcp-cloudflare` 行的 URL 用 `!!js` 表达式取真实 GUI 端口；行里不含任何
  本机信息，所以补丁层换 profile、换机器照样可用。

## 关闭服务（省 token）

`mcp__cloudflare__*` 的工具定义、本插件的辅助工具、以及插件的系统提示公告，
都是模型每次请求都要付费的文本。关闭服务就是把它们去掉：

- **设置面板**：「启用 Cloudflare MCP 服务」复选框。
- **MCP 管理页**（dsh-mcp-manager-plus）：`cloudflare` 这一行的启停开关。
- **对话里**：`cloudflare_mcp_service`，`action=on` / `action=off`。

这不是三个需要互相同步的开关，而是同一个开关的三个入口。三者读写的都是
同一条持久记录：profile 补丁层
（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里 `mcp-cloudflare` 行的
`disabled` 覆盖。因此面板开关和 MCP 管理页开关不可能不一致，而且两者都不
依赖对方是否安装。

服务关闭后**仍然保持挂载**的部分（这是刻意为之）：设置面板、OAuth 流程与
回调、回环端点，以及 `cloudflare_mcp_service` 本身（这样不用开浏览器，
agent 也能查询状态并重新打开）。只有会产生费用的部分会消失。上游连接在
关闭时断开，重新打开时按需恢复。

完成授权后，插件会就地重跑该标准行，新授予的工具无需重启 Host 就会出现。

## 安装

```sh
# 本地开发（link）
dsh plugin --profile web add link:/path/to/dsh-cloudflare-mcp
```

bundle 补丁会自动挂上两行配置，重启 Host 后生效。令牌存
`~/.dsh/dsh-cloudflare-mcp.json`（权限 0600）。

## 授权方式

两条路，都走同一个 Cloudflare OAuth 流程：

1. **设置面板**（Web GUI → 设置 → Cloudflare MCP）：点「开始授权」，
   浏览器打开 Cloudflare 授权页，授权后自动回调完成；「测试连接」列出发现的工具。
2. **对话里**：让 agent 执行 `cloudflare_mcp_oauth_start`，打开返回的
   `authorizeUrl`；或把回调地址里的 `code` 交给 `cloudflare_mcp_oauth_finish`。

## 工具

Agent 侧辅助工具（挂在 `ctx.tools` 上）：

| 工具 | 作用 |
|---|---|
| `cloudflare_mcp_status` | 授权 + 连接状态、开关状态、工具数量（不泄露密钥） |
| `cloudflare_mcp_oauth_start` | 开始 OAuth 流程，返回浏览器授权链接 |
| `cloudflare_mcp_oauth_finish` | 手动粘贴 code 的兜底方式 |
| `cloudflare_mcp_test` | 连接并列出 MCP 服务器全部工具 |
| `cloudflare_mcp_clear` | 清除凭据并断开 |
| `cloudflare_mcp_service` | 查询 / 开启 / 关闭 MCP 服务（共享的那个开关） |

另有 MCP 服务器自身的工具 `mcp__cloudflare__*`，由标准行提供，不由本插件注册。

## 配置项

从组合树的 `cloudflare-mcp` 行 `config:` 读取：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件总开关。设为 `false` 时什么都不挂载。 |
| `announceToAgent` | `true` | 是否在系统提示中公告本插件。 |
| `registerToolsDirectly` | `false` | 兜底开关：像本插件早期那样，把 `mcp__cloudflare__*` 直接注册到 `ctx.tools`。仅在 profile 没有挂载标准 MCP 行时使用——此时开关管的是本插件自身的注册，dsh-mcp-manager-plus 也就没有可管理的对象了。 |

## API 路由

全部仅限本机回环（127.0.0.1），OAuth 回调除外（需接受 mcp.cloudflare.com
的跨站跳转，但仍校验 OAuth state）：

- `GET  /api/dsh-cloudflare-mcp/status`
- `POST /api/dsh-cloudflare-mcp/oauth/start`
- `GET  /api/dsh-cloudflare-mcp/oauth/callback`（浏览器落地页）
- `POST /api/dsh-cloudflare-mcp/oauth/finish`
- `POST /api/dsh-cloudflare-mcp/oauth/refresh`
- `POST /api/dsh-cloudflare-mcp/test`
- `POST /api/dsh-cloudflare-mcp/clear`
- `POST /api/dsh-cloudflare-mcp/service` — 请求体 `{"enabled": true|false}`
- `POST /mcp/cloudflare` — 回环 MCP 端点（无状态 Streamable HTTP；
  GET 返回 405、DELETE 返回 400，都是刻意设计）

## 开发

```bash
pnpm install
npm run typecheck
npm run build                 # tsc 声明 + tsdown（lib/ + lib/client.js）
npm run test                  # 离线套件：不联网，也不碰真实凭据
DSH_CLOUDFLARE_MCP_LIVE=1 node tests/smoke.mjs   # 只额外跑真实 OAuth 第一阶段
```

| 套件 | 覆盖范围 |
|---|---|
| `tests/smoke.mjs` | 凭据存储往返、OAuth provider 元数据约定、脱敏 |
| `tests/patch.test.mjs` | 补丁层解析与改写：注释与无关条目保留、块标量不被切碎、覆盖块可往返、原子写 + 比较后交换 |
| `tests/patch-shape.test.mjs` | 随包发布的 `cordis.patch.yml` 能被 loader 自己的 YAML 方言解析，其 `!!js` 表达式可正确求值 |
| `tests/bridge.test.mjs` | 真实 MCP 客户端能对回环端点跑完 initialize → tools/list → tools/call；回环围栏确实生效 |
| `tests/host.test.mjs` | 用假上下文跑完整 `apply()`：每个工具都能编译、各表面跟随开关、两个方向的启停都成立、写出的覆盖正是 manager 读取的形状 |

`npm run test` 不会碰本机的真实凭据文件或补丁层——测试两者都会重定向到临时目录。

## License

MIT
