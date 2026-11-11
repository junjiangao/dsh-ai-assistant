# 项目约定（dsh-ai-assistant）

设计见 `docs/design/`，DSH 接口事实见 `docs/notes/dsh-api-contract.md`。

## 修改前

- 改通道、会话或事件代码前，阅读 `docs/notes/dsh-api-contract.md`。
- 改 bundle 或 preset 前，阅读 `packages/assistant-bundle/cordis.patch.yml` 顶部说明及 `deploy/gen-preset.mjs` 的修改次数校验。
- 已知实现限制见 `docs/notes/implementation-notes.md`；不要把待验证项描述为已完成。
- `docs/design/backlog.md` 是滚动待办；历史调研和实例记录属于本地资料，不作为当前设计依据。

## 开发与验证

```sh
pnpm install
pnpm verify
pnpm test
pnpm typecheck
node deploy/gen-preset.mjs --check
```

- 使用纯 ESM JavaScript 与 JSDoc 类型；`pnpm typecheck` 必须通过。
- `channel-core`、`channel-telegram` 和 `assistant-startup` 运行时只依赖 Node.js 内建模块和本项目包。
- 带 carrier 的 DSH 事件监听必须使用 `ctx.on(name, fn, { global: true })`。
- Patch 中的 `disabled: !!js` 表达式只能依赖全局对象；求值时注入服务尚不可用。
- 状态文件写入必须使用 `writeJsonAtomicSync`。
- 插件不得注册 `process.exit` 或 signal handler；进程退出由启动器处理。
- 注释说明设计原因和边界，避免重复代码行为。

测试使用 `node:test`，放在 `packages/<pkg>/test/`。需要 DSH 宿主时使用 `test/support/fake-dsh.js`，并按 API 契约维护。真实 Telegram、模型和 systemd 行为须在对应环境验证，不用 mock 结果替代真实环境结论。

## 凭据与本地配置

不得将凭据、个人运行配置或生成的实例数据提交到仓库。运行凭据保存在用户配置目录的环境文件中，并限制为 owner 可读写。项目 patch 使用 bundle 和 profile 配置，不写入共享 DSH 数据根的全局 patch。

## 变更与安全验证

- 代码与配置变更同步维护当前设计，已知验证缺口集中保存在实现说明中。
- 崩溃恢复不重放副作用，重投依赖收据与请求 id 幂等。
- 安全问题仅采用静态分析、类型/语法检查和不触发漏洞的常规回归；不构造或运行利用载荷、模拟攻击及攻击性探测，包括合成样本。
