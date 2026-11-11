# DSH Personal Assistant

一个基于 DeepSeek Harness（DSH）的个人助理 profile 实现，包含 Telegram 通道、会话治理、启动器和 DSH bundle。助理进程不开放入站网络端口，通过 Telegram Bot API 长轮询收发消息。此项目配置的是 DSH 的文件写入权限与审批流程；它不提供整机级隔离。

## 功能

- DSH bundle 保留宿主的会话、预设和工具能力，并按项目需要配置插件。
- `channel-core` 提供路由、幂等收据、投递账本、限速、命令、审批请求和运行状态。
- `channel-telegram` 提供占位符传输及 Telegram Bot API 适配器，支持群组话题和流式回复。
- `assistant-startup` 提供 daemon、一次性执行和诊断入口，并装配助理身份文件。
- `deploy/` 提供安装、健康检查、诊断、身份快照及 systemd 用户单元模板。

## 仓库结构

```text
packages/
  channel-core/       # 通道无关的会话与投递治理
  channel-telegram/   # Telegram 适配器
  assistant-startup/  # 启动器、身份装配与诊断
  assistant-bundle/   # DSH bundle 与 preset 快照
deploy/               # 安装脚本、模板和诊断工具
docs/design/          # 当前设计与待办
docs/notes/           # DSH 接口契约与实现限制
```

## 环境要求

- Linux、Node.js 22.18 或更新版本、pnpm 10，以及 DSH `0.2.2-rc.1`。
- 若使用 systemd 常驻运行，需要可用的 systemd 用户会话。
- Telegram 通道需要 Bot Token、获准使用机器人的 owner 用户 ID，以及到 Telegram Bot API 的出站连接。

DSH 版本和安装方式会影响 bundle 兼容性。接口事实见 [DSH API 契约](docs/notes/dsh-api-contract.md)。

## 安装

```sh
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.1
pnpm install
./deploy/install.sh
```

按 [环境变量模板](deploy/templates/env.example) 配置模型凭据、权限模式及可选的 Telegram 凭据。真实凭据仅放在用户配置目录的环境文件中，并将文件权限设为 `600`；不要提交凭据或运行时配置。之后运行诊断并启动：

```sh
./deploy/bin/doctor.sh
systemctl --user restart dsh-assistant.service
```

安装脚本支持 `--link` 本地开发模式。默认安装将工作区软件包接入 DSH profile；更新代码后重新安装并重启服务，使 profile 和运行进程加载新版本。

## 权限与审批

默认使用 DSH 的 `workspace-write` 沙箱和 `ask` 审批策略。该模式约束助理工具的文件写入范围，不构成操作系统或主机隔离。DSH 版本、操作系统权限和部署配置共同影响实际边界；请以 DSH 自身权限说明为准。

Telegram owner 可在已绑定的聊天或话题中通过审批按钮允许一次操作或拒绝。待处理审批在 600 秒超时、取消或进程退出时失效；失效的请求不会恢复授权。DSH 负责记录审批审计。没有可用聊天路由时，审批请求不会自动获准；`--once` 模式不提供聊天审批。若要使用 DSH 的 `danger-full-access`，需显式设置 `DSH_PERMISSION_MODE=danger-full-access`，并由部署者自行承担其权限范围。

Telegram 附件只在 owner 检查通过后下载。网络配置中的 Telegram `apiBase` 属于部署者信任的配置；请求携带凭据时不会跟随重定向。代理错误与凭据会在诊断输出中清理。

## Telegram 设置

设置 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_OWNER_ID` 后启用真实 Bot API 传输。开发时可使用模板默认的占位符传输，通过本地 inbox/outbox 文件检查适配器交互。群组和话题角色可在运行时 Telegram 设置文件中指定；该文件由部署者维护，不属于仓库配置。

所有聊天入口共享 owner 白名单。群组成员不会因为能向 bot 发消息而自动获得助理权限。本 profile 的聊天审批允许一次或拒绝，失效请求不能补答或恢复授权。

## MCP

MCP 按 DSH 支持的插件和 profile 机制配置。本项目不捆绑 MCP server，也不代表安装后已连接真实 MCP 服务。使用第三方 MCP 插件前，应单独检查其来源、所需凭据和权限。

## 开发与验证

```sh
pnpm install
pnpm verify
pnpm test
pnpm typecheck
node deploy/gen-preset.mjs --check
```

`pnpm verify` 执行类型检查、Node.js 测试和 preset 快照核对。测试使用 `node:test` 与 DSH fake host。真实 Telegram、模型、systemd 重启、开机自启和完整恢复仍需要对应运行环境单独验收；自动化测试不替代这些验收。

## 文档

- [当前设计](docs/design/v4-定稿与实施计划.md)
- [实现限制与待验证项](docs/notes/implementation-notes.md)
- [DSH API 契约](docs/notes/dsh-api-contract.md)
- [术语表](GLOSSARY.md)

## 许可证

[MIT](LICENSE) © 2026 junjiangao

派生 preset 的上游版权与许可见 [第三方声明](packages/assistant-bundle/THIRD_PARTY_NOTICES.md)。
