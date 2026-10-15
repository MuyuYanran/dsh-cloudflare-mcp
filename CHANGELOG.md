# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-15

### 新增

- **注册进标准 MCP 体系**：bundle 补丁除插件自身外，另插入一行普通
  `@deepseek-ai/dsh-mcp-client`（`serverName: cloudflare`），指向本插件在回环
  地址上暴露的标准 Streamable HTTP MCP 端点 `/mcp/cloudflare`。Cloudflare 连接
  从此与其他 MCP 服务器同级，可在 dsh-mcp-manager-plus 的「MCP 管理」页面
  列出 / 启用 / 停用 / 重启，并展开查看其工具。
- **MCP 服务总开关（省 token）**：设置页新增「启用 Cloudflare MCP 服务」，
  新增 agent 工具 `cloudflare_mcp_service`（`action=on|off|status`），新增
  `POST /api/dsh-cloudflare-mcp/service`。关闭后 `mcp__cloudflare__*` 工具定义、
  本插件辅助工具与系统提示公告都不再进入提示词；设置页、OAuth 流程、回环端点与
  `cloudflare_mcp_service` 本身保留，以便随时重新打开。
- **与 dsh-mcp-manager-plus 联动**：开关读写的持久记录是 profile 补丁层里
  `mcp-cloudflare` 行的 `disabled` 覆盖——与 manager 完全相同的文件与行，
  因此是同一个开关的三个入口，而不是三个需要同步的开关；两者互不依赖。
  插件监听 `app-boot/config-reload`，在 manager 侧启停后同步自身的计费表面。
- 写入采用原子替换 + 比较后交换（乐观并发），与 manager 并发写入时不会互相覆盖；
  候选内容非顶层条目列表时拒绝写入。注释、无关条目、`!!js` 块标量原样保留。
- 授权完成后就地重跑该标准行，新授予的工具无需重启 Host 即可出现。
- 测试套件：`tests/patch.test.mjs`、`tests/patch-shape.test.mjs`、
  `tests/bridge.test.mjs`、`tests/host.test.mjs`，`npm run test` 一次跑完，
  全程离线且不触碰本机真实凭据与补丁层。

### 变更

- **不再由本插件直接注册 `mcp__cloudflare__*`**：改由标准 MCP 行提供，工具名与
  此前保持一致。如需恢复旧行为，可设 `config.registerToolsDirectly: true`。
- `cloudflare_mcp_status` 增加开关状态、装载状态与模型可见工具数量，并报告回环端点。
- 上游连接在服务关闭时断开，重新打开时按需恢复（此前保持常连）。

### 修复

- `tests/smoke.mjs` 强制把凭据路径重定向到临时目录。此前在未设
  `DSH_CLOUDFLARE_MCP_CONFIG` 的情况下运行会读写并在结束时删除
  `~/.dsh/dsh-cloudflare-mcp.json`，即本机真实 OAuth 凭据。
- 补丁层解析器识别 YAML 块标量：`!!js |-` 等块体中以 `- ` 开头的行不再被误判为
  新的顶层条目（此前会把用户的一行撕成两半并在改写时错位搬移）。
- 修复 `cloudflare_mcp_service` 参数使用了工具 schema DSL 不支持的 `choices`
  （应为 `enum`），该错误会导致整个插件行启动时无法激活。

## [0.1.2] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。

