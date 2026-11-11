# DSH 0.2.2-rc.1 接口契约（本项目实际依赖的部分）

> 本文只记录**本项目代码实际调用**的接口，以及从随包源码核对到的事实。关键条给出源码位置；升级 DSH 后按当前设计 §9.7 重新核对。
> `$DSH_NM` 表示当前 DSH 安装树下的 `node_modules/@deepseek-ai`；以下源码位置均相对于该目录。

## 1. 插件（Cordis row）形态

一个插件包 = ESM 模块，导出：

| 导出 | 含义 |
|---|---|
| `name` | 稳定插件名（写进 Loader 行 id 之外的调试名） |
| `inject` | 依赖的**服务名**列表；缺服务则该行停在 pending |
| `Config` | schemastery 或 zod schema；**可选**。本项目不引入 schema 依赖，自行校验 config |
| `apply(ctx, config)` | 挂载体；`ctx` 是该插件自己的 fiber 上下文 |

依据：`$DSH_NM/dsh-cmdline/lib/index.js:27-32`（`ctx.provide`）、`$DSH_NM/dsh-time-context/lib/index.js` 等官方插件导出形态、`$DSH_NM/cordis/lib/index.js:903`（`ctx.on` 的 `{global:true}`）。

本项目所用的 ctx 能力：

- `ctx.get(name)`：读服务，未就绪返回 `undefined`；`ctx.inject([...], cb)`：服务就绪时回调。
- `ctx.provide(name, value)`：提供服务；`ctx.set(name, value)` 不可用于跨 fiber 注入。
- `ctx.effect(fn, label)`：`fn` 返回 disposer（或 generator），卸载时逆序释放。
- `ctx.on(event, listener, { global: true })`：**必须**带 `global: true`，否则带 carrier 的 agent/session 事件会被 scope 过滤掉（`cordis/lib/index.js:829-835`：`hook.global || !filter || filter(...)`）。
- `ctx.logger.{debug,info,warn,error}`。
- `ctx.interval(fn, ms)`：**不要用**。本项目用 `setInterval` + `ctx.effect` 自管，避免依赖 `cordis-plugin-timer` 是否挂载。

## 2. `!!js` 表达式（patch 层）

```js
// $DSH_NM/cordis-plugin-loader/lib/index.js:360-364
const evaluate = new Function("ctx", "expr", "with (ctx) { return eval(expr) }");
```

⇒ 表达式只能访问 **`ctx` 上可见的服务/属性**与**全局对象**。`require` 在该作用域中**不存在**（`new Function` 的函数体不在模块作用域），因此
“用 `!!js` 读身份文件”的写法不成立（身份文件由启动器运行期注册 section）。
`process`、`process.env` 可用（全局对象）。

## 3. 会话控制（`ctx.sessionController`）

服务名 `sessionController`（`dsh-api-session-controller/lib/index.js:3885` `super(ctx, "sessionController", …)`）。

| 方法 | 签名（host 侧） | 说明 |
|---|---|---|
| `create` | `({ sessionId?, cwd?, workspaceId?, agentPreset? }) => Promise<{sessionId, agentPreset?}>` | `cwd` 缺省为进程 cwd（`:731`）；`workspaceId` 与 `cwd` 互斥（`:725`） |
| `prompt` | `(request, signal) => Promise<{accepted:true}>` | `request = { sessionId, content: ContentBlock[], requestId, mode?: 'queue'|'steer', clientTimeZone? }`（`:4145-4158`）；`requestId` 幂等：同 id 重复提交返回 `{accepted:true}`（`:891,916,925,942`） |
| `resolveAgent` | `(sessionId) => Promise<{agent} \| {error}>` | 冷会话会被 resume（`:3979`、`:175-177`） |
| `cancel` | `({ sessionId }) => {accepted:true}` | 仅对已 attach 的会话；`agent.cancel({kind:'user'}, {keepInbox:true})`（`:1063-1069`） |
| `create` 的预设语义 | 见 `composeAgent` | 预设由 `agentPresets.resolve(id)` + `mount(agentCtx, id)` 组成（`:258-271`） |

错误：`RemoteError`，`error.code` 形如 `session/not-found`、`session/agent-busy`、`agent-preset/locked`、`agent-preset/not-found`。

## 4. Agent 注册表（`ctx.agents`）

- `agents.get(sessionId) => Agent | undefined`：**只对已挂载（live）会话**有值。
- `agents.turnBoundaryOf(session) => { turn, step, openTurnStartSeq, lastTurn }`（`dsh-agent/lib/index.js:486-488`）。
- `agent.whenIdle()`、`agent.status`（`'idle' | 'running' …`）、`agent.session`、`agent.id`。
- `agents.withoutInitiator(fn)`：不继承 initiator（schedule 用它投递）。

## 5. 事件

### 5.1 `agent/assistant-stream`

payload = `{ agent, frame }`（`agent` 由 `agentEvents` 注入，`dsh-agent/lib/types/dispatch.js:31-42`；发射点 `dsh-agent-loop/lib/index.js:873`）。

frame：

- `{ type:'start', attemptId, revision, turn, step }`
- `{ type:'chunk', attemptId, revision, index, time, chunk }`，chunk.type ∈
  `text-delta`（`{text}`）、`reasoning-delta`、`block-start`、`block-end`、`tool-call-delta`、`usage`、`finish`
- `{ type:'end', … , outcome: {kind:'committed',eventType,seq} | {kind:'abandoned'} }`

（`dsh-agent-loop/lib/index.js:351-470`）

### 5.2 `session/event`

payload = `(session, event)`（`dsh-session/lib/index.js:1590-1602`）。本项目关心：

- `turn/start` `{turn}`
- `turn/end` `{ turn, reason: { kind: 'completed'|'error'|'interrupted'|…, error? } }`
- `assistant/message` `{ message: { content: Block[] } }`（终稿取文本块）
- `user/message`（`surfaceOp === 'append'`）

**注意**：这两个事件都带 carrier（agent/session 作用域），监听必须 `{ global: true }`。

工具状态行的数据源也是 `session/event`，不是流帧：

- `assistant/message` 的 `message.content` 里 `{ type: 'tool-call', id, name }` 给出 callId 与工具名（`dsh-session/lib/index.js:827-831`）；
- `tool/result` 的 `data.message.source.callId` 用于清除对应状态（`dsh-session/lib/index.js:839`）。
- 工具状态行选**持久事件**而不是流帧：`assistant/message` 的 tool-call 块带确定的名字与 callId，`tool/result` 带 callId；流帧里可能有 `tool-call-delta`，但字段形状与是否带 name 未核对，不作为数据源。

## 6. 提问（`ctx.userQuestions`）

- 应答方注册：`ctx.on('user-questions/request', async (request, next) => …)`，**必须 `{global:true}`**；不认领就 `return next()`（`cordis/lib/index.js:903-918`）。
  `request = { questions, agent?, signal?, wait?: { callId, timed } }`；`questions[i] = { id, question, detail?, header?, options?: [{label, description?}], multiSelect?, intent? }`
  （`dsh-user-questions/lib/index.js:680-711`）。
- 迟到补答：`ctx.userQuestions.answer(agent, callId, { answers: [{id, selected: string[], custom?}] })` → `true` 表示仍是 continued 并可补入；`false` 表示问题已不再等待（`:560-596`）。
  约束：`answers` 必须**逐题各一条**（`:568`）；已有排队应答时抛 `REPLY_QUEUED`（`:566`）。
- 超时：`tool-ask-user` 用 `{mode:'timed',timeout:600}` 时，到时返回 `{pending:true, callId}`，**不是错误**（`:648-651`）。
- 状态投影：`userQuestions.attachWait` 是 Remote 流，**host 侧不使用**；本项目以自身账本 + `answer()` 的返回值判定。

## 7. 调度（`ctx.schedule`）

- 任务 target：`session` / `new_once` / `new`，`create: {cwd?, agentPreset?}`。
- 激活路径：`schedule/resolve-agent` waterfall（`dsh-schedule/lib/index.js:1495-1497`），**web-app 已自带兜底**：
  `ctx.inject(['sessionController']) → sessionController.resolveAgent(sessionId)`（`:2117-2129`）。
  ⇒ 本版本无需由通道层额外注册调度激活兜底。
- 存储：`$DSH_HOME/storages`（`storageDomain`），文件由 `dsh-schedule` 自管。

## 8. 提示词（`ctx.systemPrompt`）

- `systemPrompt.section({ name, order, text, interpolate? })`：注册到**调用上下文的 scope 层**；同名只在**同一层**冲突（`dsh-system-prompt/lib/index.js:254-257`）。
- section order 常量：`HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`DEPLOYMENT_PERSONA_SUFFIX=10200`（`:10-45`）。
- `interpolate: false` 的 section **原样保留**，不解析 `{{var}}`（`renderPrompt`，`:118-120`）。
- 全局层已由 `system-prompt` 插件注册 `deployment:persona-prefix/suffix` 两个 section；同一全局层再注册同名会抛错。
  ⇒ 本项目用**不同名**（`assistant:identity-soul` / `assistant:identity-system`）+ `interpolate:false`，并把 `personaPrefix` 置空。

## 9. Profile / Bundle

- Profile 目录：`$DSH_HOME/profiles/<name>`，`package.json` 里 `dsh.profile.bundles` 为**有序** bundle 名列表；`cordis.patch.yml` 为用户层。
- Bundle 包：`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（可为数组，按序应用）（`dsh-app-boot/lib/index.js:1335-1349`）。
- Patch 语义：按行 id **整段替换 config**（不深合并）；`insert:` 追加新行（`composeEntries`/`applyPatches`）。
- Profile 自建 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`、`autoInstallPeers: false`（`dsh-app-boot/lib/index.js:1373-1378`）。
- 模块解析双锚点：先 dsh 安装目录，再 profile 目录（`profile.js` 注释 `:1317-1321`）。

## 10. 启动与命令行

- 启动器只解析自己的 flag；**其余参数原样交给被启动的树**（`dsh/lib/bin-CRFkuRU_.js:9-19,128`），由插件用 `dsh-cmdline` 的 `parseCmdline` 解析。
- `ctx.cmdlineArgs.get()` 返回冻结的参数数组；`ctx.appExit(code)` 请求退出（`dsh-cmdline/lib/index.js:27-32`）。
- 官方 one-shot 参考实现：`dsh-headless`（`lib/startup.js` + `lib/index.js`）。本项目 `--once` 走 `sessionController`（保留 preset 工具面），不复用 headless 的直连 `agents.create`（那会绕过 preset，见 `assertAdoptable` 拒绝带 preset 的会话）。

## 11. 兼容性补充

1. **同一个版本号有两个不同的构建**：`~/.local/opt/deepseek-harness/resources/app/dsh`（Electron 随包）
   与 `dsh` 命令实际加载的 npm 全局安装并不一致：npm 版的 `dsh-web-app` 少 `mcp-manager` 与
   `ui-agent-team` 两行，且 `@deepseek-ai/dsh-mcp-manager` 包本身不存在。`presets/standard.patch.yml` 两份一致。
   判断"当前是哪一份"：`command -v dsh` 的 shim 里写死的 `NODE_PATH`（`gen-preset.mjs` 就是这么找的）。
2. **`disabled` 在启动审计阶段求值，此时行 `inject` 未生效**：因此 `!!js` 里不能出现
   `ctx.<service>`，连 `ctx.get('<service>')` 也会让该行被判 `failed to import`（审计只打印这句，不带原因）。
   只能读 `process.*` 等全局对象。
3. **会话存储是 zstd 压缩的 JSONL**：`sessions/<cwd 编码>/<session-id>/session.v4.jsonl.zstd` + `session.lock`。
4. **`sessionController.prompt(request, signal)` 的 `signal` 必填**（内部先 `signal.throwIfAborted()`）。
5. **`turn/start` 可能在 `prompt()` resolve 之前同步发出**：依赖"在途回合"判断的逻辑必须在 submit **之前**置位。
6. **`deliverables/presented` 事件**：`present` 工具在工具结果成功后 append
   `{ turn, callId, files: [{ path, description? }] }`（`dsh-tool-present/lib/index.js:119`），
   是"把交付物发到聊天"的唯一数据源。路径是 process path（宿主机绝对路径）。
7. **权限行**：`sandbox-policy.mode`、`approval.policy`、`permission.presets` + `defaultPreset` 三处共同决定
   会话头里的 `permission/preset`、`sandbox/mode`、`approval/policy`；只改 `sandbox-policy` 不改 `permission.presets`
   会得到 "custom" 状态并可能启动失败（`dsh-permission-presets` 显式拒绝该组合）。
8. **pnpm 的 `file:` 与 `link:`**：`file:` 会复制包及其依赖，`link:` 只链接包本身、不展开依赖。
   本地开发用 `install.sh --link`（会把三个同级包显式 link 进 profile），生产用 `file:`。
## 12. 命令面与会话/模型接口

### 12.1 人类命令注册表 `ctx.commands`

| 项 | 事实 | 位置 |
|---|---|---|
| 服务行 | base 里 `commands` 是全局行；web-app 只把 host 层的 `command-goal`、`command-compact` 关掉，交给 preset 挂载 | `dsh-base/cordis.patch.yml:321`；`dsh-web-app/cordis.patch.yml:530,546,549`；`dsh-web-app/presets/standard.patch.yml:44,76-78` |
| 注册 | `register({ name, description, input?, recordInput?, handler })` 返回 disposer；同名同层抛错 | `dsh-commands/lib/index.js:266-268` |
| 发现 | `list(agent)` → `[{ name, description, input? }]`；`find(agent, name)` → definition | `:287-297` |
| 执行 | `execute(agent, line, attachments, signal)` → `{ commandId, result: { kind: 'success'\|'error', text?, sourceEventSeq? } }`，语法/名字不认时返回 `undefined`；会 append `command/run` 与 `command/done` | `:327-407` |
| 作用域 | 注册落 global 或 agent scope；agent 层遮蔽同名全局命令 | `:423`（`view(agent)` + `ScopedLayers`） |

⇒ 通道层不要重写 `/compact`、`/goal`：拿到 live agent 后直接 `execute`，结果只回一条消息（不产生回合）。

### 12.2 `sessionController` 的列表/模型接口

| 方法 | 形状 | 说明 |
|---|---|---|
| `list(_request, signal)` | `{ items: SessionSummary[] }` | 不 resume、不建会话 |
| SessionSummary | `{ sessionId, updatedAt, agentAvailable, formatStatus, running, blank, cwd?, origin?, parentSessionId?, projections? }` | **没有 title，也没有 agentPreset**（`summaryFor` `:2733-2747`；`listFields` `:2922-2928`） |
| `selectModel({ sessionId, provider, model, reasoningEffort? })` | `{ selected }` | 会 resume 会话；成功后**同时** `agentDefaultModel.saveSelection`，即改默认模型（`:704-728`） |
| `modelCatalog()` | `{ default, routableProviders, groups, failures }`；group = `{ id, name, models: [{ id, name, reasoning?, badge? }] }` | 不需要会话，按 provider 隔离失败（`:455-520`，服务方法 `:3942-3950`） |
| `resolveAgent(sessionId)` | `{ agent } \| { error }` | 冷会话会被 resume（`:3882-3884`） |
| `agent.model.current()` | `{ provider, model, reasoningEffort? }` 或 `undefined` | 未选择时回落到会话头的路由（`dsh-agent/lib/index.js:191-200`） |

来源文件：`dsh-api-session-controller/lib/index.js`（`$DSH_NM` 下的 npm 全局安装）。

### 12.3 Telegram 侧事实

- Bot API `getMe` 返回 `can_join_groups`、`can_read_all_group_messages`：后者为 `true` 表示群隐私模式关闭（bot 能读到群里所有消息），`/status` 与 doctor 用它诊断。
- `setMyCommands` 的 `scope` 是对象（`{ type: 'default' }`、`{ type: 'all_group_chats' }`、`{ type: 'chat', chat_id }`）；命令名 `[a-z0-9_]{1,32}`，描述 3–256 字符。
- `sendMessage` 拒绝 `message_thread_id = 1`（General），而 `sendChatAction` **需要** 1 才能显示在 General：两条路径故意不对称。
- 群里的命令形如 `/new@BotName`，命令名后带 `@` 与 bot 用户名；解析时必须兼容。

## 13. 调度投递与会话目标

- 到点后 `schedule` 把指令作为 **user 角色消息**追加进目标会话：`session/event` 的 `type` 是 `user/message`，
  `data.source.kind === "schedule"`。单次投递正文以 `[SCHEDULE REMINDER]` 开头并带 `schedule_id_json` /
  `occurrence_at` / `reminder_prompt_json`；批次投递带 `reminders_json`。源码：
  `dsh-schedule/lib/index.js:885`、`…:1387`、`…:2561`。
- 三种目标：`session` 复用已有会话（天然带着既有聊天绑定）；`new_once` 预留一个会话 id、首次投递创建后复用；
  `new` 每次投递新建。后两种由宿主创建会话，**不携带任何 channel/chat 信息**——`schedule` 只认识会话，不认识聊天。
- 推论：把定时产出送到某个聊天，必须由 channel 层自己建立「会话 → 聊天」的映射；`channel-core` 目前不做这件事，
  所以只有 `session` 目标能把输出送进聊天（实现限制见 `implementation-notes.md` §4）。

## 14. 权限审批

- `approval/request` 是独立 waterfall，监听需 `{ global: true }`。
- 请求为 `{ agent, toolName, callId?, reason?, displayReason?, signal? }`；`displayReason` 是按语言索引的文本对象。
- 返回 `allowed-once`、`rejected`、`cancelled`、`unavailable`，不认领时调用 `next()`。
- DSH 在开放回合中写入 `approval/asked` 与 `approval/decided`。只有 `allowed-once` 授权原操作一次。
- 无应答方或应答异常时返回 `unavailable`；请求信号取消时返回 `cancelled`。
- `dsh-base/cordis.patch.yml` 以 `DSH_PERMISSION_MODE` 决定默认写入模式，缺省 `workspace-write`；
  完整访问配 `never`，其他模式配 `ask`。本项目保留底座的权限预设组合。

来源：`dsh-user-approval/lib/index.js:153-213`、`lib/types/types.d.ts`；
`dsh-sandbox/lib/index.js:137-156`；`dsh-base/cordis.patch.yml:243-276`。
