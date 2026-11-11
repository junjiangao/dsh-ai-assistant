# Backlog（滚动清单）

此清单记录尚未完成的能力验证与候选工作。实现限制及权威未验证项见 [`docs/notes/implementation-notes.md`](../notes/implementation-notes.md)。完成代码变更后运行 `pnpm verify`。

## 待做

### 真实第三方 MCP server

通过 DSH 插件机制配置需要凭据的 MCP server，验证工具发现、断线恢复与单工具失败隔离。当前项目不捆绑 MCP server。

### Telegram 真实环境验收

验证群组话题角色、命令菜单、typing 状态，以及 `/compact` 和 `/goal` 在真实 DSH 会话中的结果。

### 完整恢复演练

在隔离测试实例中验证备份恢复，包括依赖重新安装后会话、profile 与调度状态可用。

## 候选能力

- 定时任务将新会话输出路由到指定聊天。
- 支持更多消息通道，并为每种通道明确定义授权和路由规则。
- 为 preset 快照漂移检查增加自动化流程。

## 当前不计划

- Web 管理界面或助理入站监听端口。
- 未经 owner 授权的群组成员访问。
- 自动修改主机安全策略或提供整机隔离。
