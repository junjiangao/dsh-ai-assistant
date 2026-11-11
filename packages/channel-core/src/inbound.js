import { assertInboundEvent } from './protocol.js';
import { routeKey, truncate } from './util.js';

/**
 * 入站管线（设计文档 §7.2）。
 *
 * 顺序固定为：**收据去重 → 授权 → 命令拦截 → 待答提问 → 路由 → 内容清洗 → 提交 → 推进游标**。
 * 两条不变式：
 * 1. 只有"提交已受理"（或明确不需要提交）才推进游标；失败不推进，让平台重投。
 * 2. 收据先落盘、游标后落盘：崩溃在两者之间时，重投会命中收据而不会二次提交。
 *
 * @param {object} deps
 * @param {import('./config.js').CoreConfig} deps.config
 * @param {import('./util.js').Clock} deps.clock
 * @param {{ debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} deps.logger
 * @param {import('./audit.js').AuditLog} deps.audit
 * @param {import('./runtime.js').RuntimeState} deps.state
 * @param {import('./heartbeat.js').Heartbeat} deps.heartbeat
 * @param {(channel: string) => import('./stores.js').ChannelStores} deps.storeFor
 * @param {{ prompt: (request: any, signal: AbortSignal) => Promise<unknown>, create: (request: any) => Promise<{ sessionId: string, agentPreset?: string }> }} deps.sessionController
 * @param {{ tryAnswer: (event: any, route: any) => Promise<{ handled: boolean, detail?: string }> }} deps.questions
 * @param {{ parse: (text: string) => { name: string, args: string } | undefined, handle: (event: any, context: any) => Promise<{ handled: boolean }> }} deps.commands
 * @param {{ handleEvent: (event: any, route: any) => Promise<{handled:boolean,detail?:string}> }} [deps.approvals]
 * @returns {{ ingest: (event: Partial<import('./protocol.js').InboundEvent>, options?: { prepareAttachments?: (event: any) => Promise<void> }) => Promise<import('./protocol.js').IngestResult> }}
 */
export function createInbound({ config, clock, logger, audit, state, heartbeat, storeFor, sessionController, questions, commands, approvals }) {
  /**
   * @param {import('./protocol.js').InboundEvent} event
   * @param {'accepted'|'duplicate'|'denied'|'command'|'answered'} status
   * @param {{ sessionId?: string, detail?: string }} [extra]
   * @returns {Promise<import('./protocol.js').IngestResult>}
   */
  async function settle(event, status, extra = {}) {
    const stores = storeFor(event.channel);
    await stores.receipts.add(receiptKey(event));
    const advanced = await stores.cursor.advance(event.nextCursor);
    audit.record('inbound', {
      channel: event.channel,
      account: event.account,
      chatId: event.chatId,
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      userId: event.userId,
      rawId: event.rawId,
      status,
      ...extra,
      cursor: event.nextCursor,
      cursorAdvanced: advanced.advanced
    });
    return { status, ...extra };
  }

  /**
   * @param {Partial<import('./protocol.js').InboundEvent>} raw
   * @param {{ prepareAttachments?: (event: import('./protocol.js').InboundEvent) => Promise<void> }} [options]
   * @returns {Promise<import('./protocol.js').IngestResult>}
   */
  async function ingest(raw, { prepareAttachments } = {}) {
    const event = assertInboundEvent(raw);
    const stores = storeFor(event.channel);
    const key = receiptKey(event);

    // 1. 收据去重：重复投递既不二次提交，也不重复回话。
    if (stores.receipts.has(key)) {
      await stores.cursor.advance(event.nextCursor);
      logger.debug(`channel-core: 重复事件 ${key}，已忽略`);
      return { status: 'duplicate' };
    }

    // 2. 授权：越权**不回消息**（避免探测），只留审计。
    const owners = config.owners[event.channel] ?? [];
    if (!owners.includes(event.userId)) {
      audit.record('denied', { channel: event.channel, userId: event.userId, chatId: event.chatId, rawId: event.rawId });
      logger.warn(`channel-core: 拒绝非白名单用户 ${event.channel}:${event.userId}`);
      return await settle(event, 'denied');
    }

    // 附件下载/落盘属于副作用，必须等重复事件和未授权事件都被筛掉。
    await prepareAttachments?.(event);

    const rk = routeKey(event);
    const route = { channel: event.channel, account: event.account, chatId: event.chatId, ...(event.threadId === undefined ? {} : { threadId: event.threadId }) };

    // 3. 命令拦截：不进模型上下文。
    const command = event.command ?? commands.parse(event.text);
    if (command !== undefined) {
      const handled = await commands.handle({ ...event, command }, { route, routeKey: rk, stores });
      if (handled.handled) return await settle(event, 'command', { detail: command.name });
    }

    if (event.callback !== undefined && approvals !== undefined) {
      const handled = await approvals.handleEvent(event, { ...route, routeKey: rk, stores });
      if (handled.handled) return await settle(event, 'answered', { detail: handled.detail });
    }

    // 4. 待答提问：该聊天有未答问题时，文字/按钮就是答案。
    const pending = await questions.tryAnswer(event, { ...route, routeKey: rk, stores });
    if (pending.handled) return await settle(event, 'answered', { detail: pending.detail });

    // 5. 路由：无绑定则建会话并持久化绑定（幂等：先建后绑，崩溃最多留一个空会话）。
    const binding = stores.routes.get(rk);
    let sessionId = binding?.sessionId;
    let repaired = false;
    let createdNow = false;
    if (sessionId === undefined) {
      const created = await createSession(event.topic);
      if ('error' in created) {
        state.recordError(created.error);
        audit.record('inbound-failed', { channel: event.channel, rawId: event.rawId, stage: 'create-session', error: String(created.error) });
        return { status: 'failed', error: created.error };
      }
      sessionId = created.sessionId;
      createdNow = true;
      await bindRoute(stores, rk, event, created);
      logger.info(`channel-core: 为 ${rk} 新建会话 ${sessionId}${event.topic?.name === undefined ? '' : `（话题 ${event.topic.name}）`}`);
    }

    // 6. 内容清洗：截断 + 附件说明。话题名只在建会话的那一回合写进对话。
    const content = composeContent(event, config.maxPromptChars, createdNow ? event.topic?.name : undefined);
    if (content === undefined) {
      logger.warn(`channel-core: ${rk} 的空内容事件已忽略${event.mediaKind === undefined ? '' : `（${event.mediaKind}）`}`);
      // 保留无法处理的媒体类型，便于区分空消息和不支持的附件类型。
      return await settle(event, 'accepted', {
        detail: 'empty',
        ...(event.mediaKind === undefined ? {} : { mediaKind: event.mediaKind })
      });
    }

    const requestId = `${event.channel}:${event.rawId}`;
    // 必须在 submit **之前**置位：turn/start 可能在 prompt() 返回前就同步发出，
    // 先置位才能把这一轮判定为"用户回合"（编辑同一条消息）而不是"无人值守"（另发一条）。
    state.markInFlight(rk, sessionId);
    heartbeat.update({ inFlight: state.inFlightCount, lastError: state.lastError });
    let failure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await sessionController.prompt({ sessionId, content, requestId, mode: 'queue' }, new AbortController().signal);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        const code = codeOf(error);
        if (code === 'session/not-found' && !repaired) {
          repaired = true;
          const created = await createSession(event.topic);
          if ('error' in created) {
            failure = created.error;
            break;
          }
          sessionId = created.sessionId;
          await bindRoute(stores, rk, event, created);
          logger.warn(`channel-core: 路由 ${rk} 的会话已不存在，已改为新会话 ${sessionId}`);
          continue;
        }
        break;
      }
    }

    if (failure !== undefined) {
      // 只回收本次提交占用的那一个名额，别把同路由上排队的其它消息一起抹掉。
      state.consumeInFlight(rk);
      heartbeat.update({ inFlight: state.inFlightCount });
      state.recordError(failure);
      audit.record('inbound-failed', { channel: event.channel, rawId: event.rawId, sessionId, code: codeOf(failure), error: messageOf(failure) });
      if (isPermanent(failure)) {
        // 永久性拒绝（内容不合法等）：吞掉并推进，否则会无限重投。
        return await settle(event, 'accepted', { sessionId, detail: `dropped:${codeOf(failure) ?? 'unknown'}` });
      }
      return { status: 'failed', sessionId, error: failure };
    }

    audit.record('inbound-submitted', { channel: event.channel, chatId: event.chatId, sessionId, requestId });
    return await settle(event, 'accepted', { sessionId });
  }

  /**
   * 按话题规则建会话；规则里的 preset/cwd 坏了就回退默认，而不是让这个聊天永久失败。
   * @param {{ name?: string, preset?: string, cwd?: string } | undefined} topic
   * @returns {Promise<{ sessionId: string, agentPreset?: string } | { error: unknown }>}
   */
  async function createSession(topic) {
    /** @type {{ agentPreset?: string, cwd?: string }} */
    const request = {
      ...(typeof topic?.preset === 'string' ? { agentPreset: topic.preset } : {}),
      ...(typeof topic?.cwd === 'string' ? { cwd: topic.cwd } : {})
    };
    try {
      return await sessionController.create(request);
    } catch (error) {
      if (request.agentPreset === undefined && request.cwd === undefined) return { error };
      logger.warn(`channel-core: 话题规则建会话失败（${messageOf(error)}），回退默认配置`);
      audit.record('topic-role-fallback', { channel: 'inbound', topic: topic?.name, error: messageOf(error) });
      try {
        return await sessionController.create({});
      } catch (fallbackError) {
        return { error: fallbackError };
      }
    }
  }

  /**
   * 把建好的会话写回路由，顺带记住话题角色（cwd/展示名），供 /new 与 /whoami 用。
   * @param {import('./stores.js').ChannelStores} stores
   * @param {string} rk
   * @param {import('./protocol.js').InboundEvent} event
   * @param {{ sessionId: string, agentPreset?: string }} created
   * @returns {Promise<void>}
   */
  async function bindRoute(stores, rk, event, created) {
    await stores.routes.bind(rk, {
      sessionId: created.sessionId,
      userId: event.userId,
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      ...(event.topic?.cwd === undefined ? {} : { cwd: event.topic.cwd }),
      ...(event.topic?.name === undefined ? {} : { topic: event.topic.name })
    });
  }

  return { ingest };
}

/**
 * @param {import('./protocol.js').InboundEvent} event
 * @returns {string}
 */
function receiptKey(event) {
  return `${event.channel}:${event.account}:${event.rawId}`;
}

/**
 * 组装提交给会话的内容块。附件以本地路径写进正文，模型用文件工具自己读。
 * @param {import('./protocol.js').InboundEvent} event
 * @param {number} maxChars
 * @param {string} [topicName] 建会话时的当前话题名，只在这一回合写进对话
 * @returns {{ type: 'text', text: string }[] | undefined}
 */
function composeContent(event, maxChars, topicName) {
  const text = truncate(event.text.trim(), maxChars);
  /** @type {string[]} */
  const notes = [];
  for (const attachment of event.attachments ?? []) {
    const label = attachment.name ?? attachment.kind;
    notes.push(attachment.path === undefined ? `（附件：${label}，未落盘）` : `（附件：${label} → ${attachment.path}）`);
  }
  const topicNote = topicName === undefined || topicName.trim() === '' ? '' : `（当前话题：${topicName}）`;
  const body = [topicNote, text, ...notes].filter((part) => part !== '').join('\n\n');
  if (body.trim() === '') return undefined;
  return [{ type: 'text', text: body }];
}

/**
 * DSH 的 RemoteError 用 `code` 区分域错误；普通 Error 没有。
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function codeOf(error) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 永久性失败重投也不会成功，推进游标避免卡死；其余按可重试处理。
 * @param {unknown} error
 * @returns {boolean}
 */
function isPermanent(error) {
  const code = codeOf(error);
  if (code === undefined) return false;
  return code === 'gateway/bad-request'
    || code === 'session/attachment-invalid'
    || code === 'session/invalid-time-zone'
    || code === 'agent-preset/not-found'
    || code === 'agent-preset/conflict'
    || code === 'session/conflict';
}
