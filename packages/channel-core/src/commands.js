/**
 * 命令面（设计文档 §7.5/§8）。
 *
 * 两类命令，拦截位置相同、执行者不同：
 * - **通道级**：路由、会话、模型、通道连通性——由本模块直接回答，不产生回合；
 * - **agent 级**：/compact、/goal 等由 DSH `commands` 服务注册的命令——解析后转发
 *   `ctx.commands.execute(agent, line, [], signal)`，只把结果回一条消息。
 *
 * 未识别的 /xxx 仍交回模型（设计 §7.5）：只有注册表里的名字才会被拦截，
 * 因此"用户粘贴一段以斜杠开头的文本"不会被误当成命令。
 */

/** 命令注册表：既驱动 /help，也驱动 Telegram 的客户端菜单（单一来源）。 */
const REGISTRY = Object.freeze([
  { name: 'help', description: '命令说明' },
  { name: 'status', description: '进程、通道、会话与心跳状态' },
  { name: 'whoami', description: '当前聊天、话题与用户标识' },
  { name: 'new', input: '[预设]', description: '开一个新会话（默认沿用当前预设）' },
  { name: 'sessions', input: '[条数]', description: '列出最近会话' },
  { name: 'resume', input: '<序号|session-id>', description: '把当前聊天接回已有会话' },
  { name: 'model', input: '[provider/model] [effort]', description: '查看或切换模型（同时改默认）' },
  { name: 'preset', input: '[预设 id]', description: '查看或切换预设（仅会话首轮前）' },
  { name: 'compact', description: '压缩当前会话历史' },
  { name: 'goal', input: '<目标描述>', description: '创建或更新目标' },
  { name: 'stop', description: '中断当前回合' },
  { name: 'skip', description: '跳过当前待答提问' }
]);

const KNOWN = new Set(REGISTRY.map((command) => command.name));

/**
 * 群里的命令会带 bot 用户名：`/new@example_bot standard`。
 * 只接受 Telegram 允许的 bot 用户名字符，避免把 `/a@b.c` 这种文本误判成命令。
 */
const COMMAND = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u;

/**
 * @param {string} text
 * @returns {{ name: string, args: string } | undefined}
 */
export function parseCommand(text) {
  const match = COMMAND.exec(text.trim());
  if (match === null) return undefined;
  let name = (match[1] ?? '').toLowerCase();
  // Telegram 客户端第一次打开 bot 会自动发 /start：当成 /help，别浪费一次模型回合。
  if (name === 'start') name = 'help';
  if (!KNOWN.has(name)) return undefined;
  return { name, args: (match[2] ?? '').trim() };
}

/**
 * @param {object} deps
 * @param {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} deps.logger
 * @param {import('./audit.js').AuditLog} deps.audit
 * @param {import('./runtime.js').RuntimeState} deps.state
 * @param {{
 *   create: (request: any) => Promise<{ sessionId: string, agentPreset?: string }>,
 *   cancel: (request: { sessionId: string }) => { accepted: boolean },
 *   resolveAgent: (sessionId: string) => Promise<{ agent?: any, error?: any }>,
 *   list?: (request: any, signal: AbortSignal) => Promise<{ items?: any[] }>,
 *   selectModel?: (request: any) => Promise<{ selected?: any }>,
 *   modelCatalog?: () => Promise<any>
 * }} deps.sessionController
 * @param {() => any} deps.agentPresets
 * @param {() => any} deps.commandsService DSH 的 `commands` 服务（未挂载时返回 undefined）
 * @param {{ skip: (routeKey: string, stores: import('./stores.js').ChannelStores) => Promise<number> }} deps.questions
 * @param {{ skip: (routeKey: string) => number }} deps.approvals
 * @param {(context?: { routeKey?: string }) => Promise<Record<string, unknown>>} deps.report
 * @param {(chat: { channel: string, chatId: string, threadId?: string }, text: string) => Promise<{ messageId?: string }>} deps.sendDirect
 */
export function createCommands({ logger, audit, state, sessionController, agentPresets, commandsService, questions, approvals, report, sendDirect }) {
  /**
   * @param {import('./protocol.js').InboundEvent & { command: { name: string, args: string } }} event
   * @param {{ route: { channel: string, account: string, chatId: string, threadId?: string }, routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {Promise<{ handled: boolean }>}
   */
  async function handle(event, context) {
    const chat = { channel: context.route.channel, chatId: context.route.chatId, ...(context.route.threadId === undefined ? {} : { threadId: context.route.threadId }) };
    const reply = async (/** @type {string} */ text) => {
      // 只有 /status、/whoami 默认把家目录缩成 ~；其它命令（以及显式 full）保留原文，
      // 否则用户要绝对路径时会被抹掉。
      await sendDirect(chat, text);
    };
    audit.record('command', {
      channel: context.route.channel,
      chatId: context.route.chatId,
      userId: event.userId,
      name: event.command.name,
      args: event.command.args
    });

    try {
      switch (event.command.name) {
        case 'help':
          await reply(helpText());
          return { handled: true };
        case 'status':
          await reply(await statusText(context));
          return { handled: true };
        case 'whoami':
          await reply(identityText(event, context));
          return { handled: true };
        case 'sessions':
          await reply(await sessionsText(event, context));
          return { handled: true };
        case 'resume':
          await reply(await resumeSession(event, context));
          return { handled: true };
        case 'model':
          await reply(await modelCommand(event, context));
          return { handled: true };
        case 'new':
          await reply(await newSession(event, context, event.command.args));
          return { handled: true };
        case 'preset':
          await reply(await presetCommand(event, context));
          return { handled: true };
        case 'compact':
        case 'goal':
          await reply(await runAgentCommand(event, context, event.command.name));
          return { handled: true };
        case 'skip': {
          const skipped = await questions.skip(context.routeKey, context.stores);
          const rejected = approvals.skip(context.routeKey);
          const total = skipped + rejected;
          await reply(total === 0 ? '当前没有待回答的提问或审批。' : `已跳过 ${skipped} 个提问，拒绝 ${rejected} 个审批。`);
          return { handled: true };
        }
        case 'stop': {
          const binding = context.stores.routes.get(context.routeKey);
          if (binding === undefined) {
            await reply('这个聊天还没有会话。');
            return { handled: true };
          }
          sessionController.cancel({ sessionId: binding.sessionId });
          state.clearInFlight(context.routeKey);
          await reply('⏹️ 已请求中断当前回合。');
          return { handled: true };
        }
        default:
          return { handled: false };
      }
    } catch (error) {
      // 命令处理失败不能抛回入站管线：那会被当成"可重试的投递失败"，同一条消息无限重投。
      logger.error(`命令 /${event.command.name} 处理失败：${messageOf(error)}`);
      await reply(`命令 /${event.command.name} 执行失败：${messageOf(error)}`);
      return { handled: true };
    }
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @param {string} args
   * @returns {Promise<string>}
   */
  async function newSession(event, context, args) {
    if (state.inFlight.has(context.routeKey)) {
      return '当前回合仍在运行；先 /stop 或等它结束再开新会话。';
    }
    const binding = context.stores.routes.get(context.routeKey);
    // 无参时优先用**当前配置**里的话题角色，其次才是路由记录：
    // 改了 settings.json 之后，正是靠这一条让老话题的 /new 采纳新 preset/cwd。
    const preset = args === '' ? (event.topic?.preset ?? binding?.agentPreset) : args.split(/\s+/u)[0];
    const cwd = event.topic?.cwd ?? binding?.cwd;
    const topicName = event.topic?.name ?? binding?.topic;
    try {
      const created = await sessionController.create({
        ...(preset === undefined ? {} : { agentPreset: preset }),
        ...(cwd === undefined ? {} : { cwd })
      });
      await context.stores.routes.bind(context.routeKey, {
        sessionId: created.sessionId,
        userId: event.userId,
        ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(topicName === undefined ? {} : { topic: topicName })
      });
      return `✅ 已开新会话 ${created.sessionId}${created.agentPreset === undefined ? '' : `（预设 ${created.agentPreset}）`}。`;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === 'agent-preset/not-found') return `没有这个预设：${preset ?? ''}。`;
      return `新建会话失败：${messageOf(error)}`;
    }
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {Promise<string>}
   */
  async function presetCommand(event, context) {
    const presetId = (event.command?.args ?? '').split(/\s+/u)[0] ?? '';
    if (presetId === '') return await presetListText();
    const binding = context.stores.routes.get(context.routeKey);
    if (binding === undefined) return '这个聊天还没有会话；直接发消息即可开始。';
    const presets = agentPresets();
    if (presets === undefined) return '当前组合没有挂载预设注册表。';
    /** @type {{ agent?: any, error?: any }} */
    const resolved = await sessionController.resolveAgent(binding.sessionId).catch((/** @type {unknown} */ error) => ({ error }));
    if (resolved.agent === undefined) return '原会话已不可用；发 /new 开个新会话。';
    try {
      const selected = await presets.select(resolved.agent, presetId);
      return `✅ 已切换到预设 ${selected}（仅在该会话首轮之前有效）。`;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === 'agent-preset/locked') return `这个会话已经开始过回合，不能再换预设。用 /new ${presetId} 开一个带该预设的新会话。`;
      if (code === 'agent-preset/not-found') return `没有这个预设：${presetId}。`;
      if (code === 'agent-preset/invalid') return `预设 ${presetId} 的组合无效，切换被拒绝。`;
      return `切换预设失败：${messageOf(error)}`;
    }
  }

  /** @returns {Promise<string>} */
  async function presetListText() {
    const presets = agentPresets();
    if (presets === undefined) return '当前组合没有挂载预设注册表。';
    if (typeof presets.list !== 'function') return '当前组合不支持预设列表。';
    const rows = await presets.list();
    if (!Array.isArray(rows) || rows.length === 0) return '没有可用预设。';
    return [
      '可用预设：',
      ...rows.map((row) => `- ${row.id}${row.isDefault === true ? '（默认）' : ''}${typeof row.name === 'string' ? `：${row.name}` : ''}`),
      '',
      '切换：/preset <id>（仅会话首轮前）或 /new <id>（新会话）。'
    ].join('\n');
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ route: { channel: string, account: string, chatId: string, threadId?: string }, routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {string}
   */
  function identityText(event, context) {
    const binding = context.stores.routes.get(context.routeKey);
    const chatType = typeof event.chatType === 'string' ? event.chatType : undefined;
    const cwd = binding?.cwd ?? process.cwd();
    return [
      '当前聊天：',
      `- 通道：${context.route.channel}/${context.route.account}`,
      `- 聊天：${context.route.chatId}${chatType === undefined ? '' : `（${chatType}${event.isForum === true ? '，forum' : ''}）`}`,
      `- 话题：${context.route.threadId ?? '无（非 topic 消息）'}${binding?.topic === undefined ? '' : `（${binding.topic}）`}`,
      `- 用户：${event.userId}`,
      `- 目录：${cwd}${binding?.cwd === undefined ? '（默认）' : ''}`,
      `- 会话：${binding?.sessionId ?? '尚未建立'}${binding?.agentPreset === undefined ? '' : `（预设 ${binding.agentPreset}）`}`
    ].join('\n');
  }

  /**
   * 会话列表按最近活动倒序，/sessions 与 /resume 共用同一份顺序。
   * @returns {Promise<any[]>}
   */
  async function sessionItems() {
    if (typeof sessionController.list !== 'function') return [];
    const result = await sessionController.list({}, new AbortController().signal);
    const items = Array.isArray(result?.items) ? [...result.items] : [];
    return items.sort((/** @type {any} */ left, /** @type {any} */ right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {Promise<string>}
   */
  async function sessionsText(event, context) {
    if (typeof sessionController.list !== 'function') return '当前组合不支持会话列表。';
    const limit = clampCount(event.command?.args, 10, 50);
    const items = await sessionItems();
    if (items.length === 0) return '还没有会话；直接发一条消息就会新建。';
    const binding = context.stores.routes.get(context.routeKey);
    const shown = items.slice(0, limit);
    const lines = [`最近 ${shown.length} 个会话（共 ${items.length} 个）：`];
    shown.forEach((item, index) => {
      const marks = [];
      if (item.sessionId === binding?.sessionId) marks.push('当前');
      if (item.running === true) marks.push('运行中');
      if (item.blank === true) marks.push('空会话');
      const age = typeof item.updatedAt === 'number' ? ` · ${ageText(Date.now() - item.updatedAt)}` : '';
      lines.push(`${index + 1}. ${String(item.sessionId)}${age}${marks.length === 0 ? '' : `（${marks.join('，')}）`}`);
    });
    lines.push('', '接回旧会话：/resume <序号|session-id>；开新的：/new。');
    return lines.join('\n');
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {Promise<string>}
   */
  async function resumeSession(event, context) {
    const reference = (event.command?.args ?? '').trim();
    if (reference === '') return '用法：/resume <序号|session-id>。';
    if (state.inFlight.has(context.routeKey)) return '当前回合仍在运行；先 /stop 或等它结束再切换会话。';
    if (typeof sessionController.list !== 'function') return '当前组合不支持会话列表，无法按序号接回。';
    const items = await sessionItems();
    const target = /^\d+$/u.test(reference)
      ? items[Number(reference) - 1]
      : items.find((item) => item.sessionId === reference);
    if (target === undefined) return `没有找到会话 ${reference}；发 /sessions 看可用列表。`;
    const current = context.stores.routes.get(context.routeKey);
    const cwd = event.topic?.cwd ?? current?.cwd;
    const topicName = event.topic?.name ?? current?.topic;
    await context.stores.routes.bind(context.routeKey, {
      sessionId: target.sessionId,
      userId: event.userId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(topicName === undefined ? {} : { topic: topicName })
    });
    return `✅ 已接回会话 ${target.sessionId}；下一条消息会进入该会话。`;
  }

  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @returns {Promise<string>}
   */
  async function modelCommand(event, context) {
    const binding = context.stores.routes.get(context.routeKey);
    const tokens = (event.command?.args ?? '').split(/\s+/u).filter((token) => token !== '');
    if (tokens.length === 0) return await modelStatusText(binding);
    if (binding === undefined) return '这个聊天还没有会话；先发一条消息建立会话。';
    if (typeof sessionController.selectModel !== 'function') return '当前组合不支持按会话切换模型。';
    const target = /** @type {string} */ (tokens[0]);
    const effort = tokens[1];
    const catalog = typeof sessionController.modelCatalog === 'function' ? await sessionController.modelCatalog() : undefined;
    const slash = target.lastIndexOf('/');
    const provider = slash > 0 ? target.slice(0, slash) : catalog?.default?.provider;
    const model = slash > 0 ? target.slice(slash + 1) : target;
    if (typeof provider !== 'string' || provider === '' || model === '') {
      return '用法：/model <provider/model> [effort]；不带参数查看当前与可用模型。';
    }
    try {
      const result = await sessionController.selectModel({
        sessionId: binding.sessionId,
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort })
      });
      const selected = result?.selected ?? { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
      const effortText = selected.reasoningEffort === undefined ? '' : `（effort ${selected.reasoningEffort}）`;
      return `✅ 已切换：${selected.provider}/${selected.model}${effortText}。同时写入默认，新会话也沿用（DSH 的 selectModel 语义）。`;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === 'session/model-unavailable') return `模型不可用：${messageOf(error)}`;
      if (code === 'session/not-found') return '会话已不存在；发 /new 开个新会话。';
      return `切换模型失败：${messageOf(error)}`;
    }
  }

  /**
   * @param {import('./stores.js').RouteEntry | undefined} binding
   * @returns {Promise<string>}
   */
  async function modelStatusText(binding) {
    const lines = [];
    if (binding !== undefined) {
      const resolved = await sessionController.resolveAgent(binding.sessionId).catch((/** @type {unknown} */ error) => ({ agent: undefined, error }));
      const current = resolved.agent?.model?.current?.();
      if (current !== undefined) {
        lines.push(`当前会话：${current.provider}/${current.model}${current.reasoningEffort === undefined ? '' : `（effort ${current.reasoningEffort}）`}`);
      }
    }
    if (typeof sessionController.modelCatalog !== 'function') {
      lines.push('当前组合不支持模型目录。');
      return lines.join('\n');
    }
    const catalog = await sessionController.modelCatalog();
    if (catalog?.default !== undefined) {
      lines.push(`部署默认：${catalog.default.provider}/${catalog.default.model}${catalog.default.reasoningEffort === undefined ? '' : `（effort ${catalog.default.reasoningEffort}）`}`);
    }
    const groups = Array.isArray(catalog?.groups) ? catalog.groups.slice(0, 8) : [];
    if (groups.length > 0) {
      lines.push('', '可用模型：');
      for (const group of groups) {
        const models = (group.models ?? []).slice(0, 12).map((/** @type {any} */ entry) => entry.id);
        lines.push(`- ${group.id}：${models.join('、')}`);
      }
    }
    if (Array.isArray(catalog?.failures) && catalog.failures.length > 0) {
      lines.push('', `不可用 provider：${catalog.failures.map((/** @type {any} */ failure) => `${failure.id}（${failure.message}）`).join('；')}`);
    }
    lines.push('', '切换：/model <provider/model> [effort]（会同时改默认）。');
    return lines.join('\n');
  }

  /**
   * 转发 DSH 官方命令。它们只写 command/run 与 command/done，不产生回合，
   * 所以结果直接回一条消息，不参与流式编辑。
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ routeKey: string, stores: import('./stores.js').ChannelStores }} context
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function runAgentCommand(event, context, name) {
    const binding = context.stores.routes.get(context.routeKey);
    if (binding === undefined) return '这个聊天还没有会话；先发一条消息建立会话。';
    const commands = commandsService();
    if (commands === undefined || typeof commands.execute !== 'function') return '当前组合没有挂载命令服务。';
    const resolved = await sessionController.resolveAgent(binding.sessionId).catch((/** @type {unknown} */ error) => ({ agent: undefined, error }));
    const agent = resolved.agent;
    if (agent === undefined) return '原会话已不可用；发 /new 开个新会话。';
    if (typeof commands.find === 'function' && commands.find(agent, name) === undefined) {
      return `当前会话没有 /${name} 这个命令（预设里未启用）。`;
    }
    // 重新拼一整行：execute 只认严格的 /name 语法，群里的 /name@Bot 要先剥掉。
    const line = `/${name}${event.command?.args === undefined || event.command.args === '' ? '' : ` ${event.command.args}`}`;
    const execution = await commands.execute(agent, line, [], new AbortController().signal);
    if (execution === undefined) return `/${name} 没有被执行（命令名或语法不被接受）。`;
    const result = execution.result;
    if (result?.kind === 'error') return `⚠️ /${name} 失败：${result.text ?? '未知错误'}`;
    return result?.text ?? `✅ /${name} 已完成。`;
  }

  /**
   * @param {{ routeKey?: string }} [context]
   * @returns {Promise<string>}
   */
  async function statusText(context) {
    try {
      const snapshot = await report(context === undefined ? {} : { routeKey: context.routeKey });
      const lines = ['助理状态'];
      for (const [key, value] of Object.entries(snapshot)) lines.push(`- ${key}：${format(value)}`);
      return lines.join('\n');
    } catch (error) {
      return `状态读取失败：${messageOf(error)}`;
    }
  }

  return { handle, parse: parseCommand, list: () => REGISTRY.map(({ name, description }) => ({ name, description })) };
}

/** @returns {string} */
function helpText() {
  const lines = ['可用命令（不会进模型上下文）：'];
  for (const command of REGISTRY) {
    lines.push(`/${command.name}${command.input === undefined ? '' : ` ${command.input}`} — ${command.description}`);
  }
  lines.push('', '群里可以写 /new@BotName；/compact 与 /goal 由当前会话的预设提供。未识别的 /xxx 会作为消息交给模型。');
  return lines.join('\n');
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function clampCount(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * @param {number} milliseconds
 * @returns {string}
 */
function ageText(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
