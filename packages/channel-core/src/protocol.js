/**
 * 通道契约（设计文档 §7.1）。
 *
 * core 不认识任何平台协议；适配器不认识路由、去重与账本。两边的唯一接缝就是这里的两个对象：
 * 适配器把平台事件归一化成 {@link InboundEvent} 交给 `host.ingest`，core 通过
 * {@link ChannelAdapter} 的 send/edit/probe 出站。
 *
 * 这是**唯一**需要实现的接口：接入 Telegram、企业微信或别处时，只需再给一个实现。
 */

/** @typedef {import('./stores.js').ChannelStores} ChannelStores */

/**
 * @typedef {object} AttachmentRef
 * @property {'photo'|'document'|'voice'|'audio'|'video'} kind
 * @property {string} [name] 原始文件名（可缺失）
 * @property {number} [size] 字节数
 * @property {string} [path] core 落盘后的本地绝对路径（由 core 填写）
 * @property {string} [fileId] 平台侧文件标识（适配器下载用，core 不解释）
 */

/**
 * 归一化入站事件。`rawId` 是该平台事件流里的唯一标识（Telegram 用 `update_id`），
 * 收据去重与 `requestId` 幂等都靠它。
 * @typedef {object} InboundEvent
 * @property {string} channel 适配器 id，例如 `telegram`
 * @property {string} account 平台账号标识（同一通道多账号时区分；单账号写 `default`）
 * @property {string} rawId 平台事件唯一标识
 * @property {string} userId 发送者 id（用于白名单）
 * @property {string} chatId 会话位置
 * @property {string} [threadId] 话题/线程；General 归一化后**不设置**
 * @property {string} [chatType] 平台聊天类型（private/group/supergroup/channel），仅用于诊断与门控
 * @property {boolean} [isForum] 是否 forum（Telegram 话题群），仅用于诊断与门控
 * @property {{ name?: string, preset?: string, cwd?: string }} [topic] 话题级角色提示（适配器按平台配置填充）
 * @property {'message'|'callback'} kind
 * @property {string} text 纯文本；callback 事件为空串
 * @property {{ name: string, args: string }} [command] 若适配器已识别为命令
 * @property {{ id: string, data: string }} [callback] 按钮回传
 * @property {AttachmentRef[]} [attachments]
 * @property {string} [mediaKind] 适配器识别出的、无法转成文本或附件的消息类型（贴纸/位置/投票/服务消息…），仅用于诊断
 * @property {number | string} nextCursor 处理成功后应推进到的游标
 * @property {number} receivedAt 毫秒时间戳
 */

/**
 * 出站按钮。`data` 由适配器编码（Telegram 的 `callback_data` 上限 64 字节）。
 * @typedef {object} Button
 * @property {string} label
 * @property {string} data
 */

/**
 * @typedef {object} ChatRef
 * @property {string} chatId
 * @property {string} [threadId]
 */

/**
 * @typedef {object} ChannelAdapter
 * @property {string} id
 * @property {(host: ChannelHost) => Promise<void>} start 开始收事件（长轮询/订阅）
 * @property {() => Promise<void>} stop 停止收事件
 * @property {(chat: ChatRef, text: string, options?: { buttons?: Button[][], disablePreview?: boolean }) => Promise<{ messageId: string }>} send
 * @property {(chat: ChatRef, messageId: string, text: string, options?: { buttons?: Button[][] }) => Promise<'ok' | 'unchanged'>} edit
 * @property {(chat: ChatRef) => Promise<void>} [typing] 回合进行中的“正在输入”；不支持时 core 跳过
 * @property {(callbackId: string, text?: string) => Promise<void>} [ackCallback]
 * @property {(chat: ChatRef, input: { path: string, caption?: string }) => Promise<{ messageId: string }>} [sendDocument] 发送 `present` 产出的交付物；不支持时 core 会退回文字路径
 * @property {() => Promise<{ ok: boolean, detail?: string }>} probe
 */

/**
 * 入站结果。`status` 决定适配器是否需要退避重投：
 * - `accepted` / `duplicate` / `denied` / `command` / `answered`：本条已结算，继续下一事件；
 * - `failed`：**不推进游标**，适配器应退避后重投。
 * @typedef {{ status: 'accepted'|'duplicate'|'denied'|'command'|'answered'|'failed', sessionId?: string, detail?: string, error?: unknown }} IngestResult
 */

/**
 * core 交给适配器的宿主面。
 * @typedef {object} ChannelHost
 * @property {(event: InboundEvent, options?: { prepareAttachments?: (event: InboundEvent) => Promise<void> }) => Promise<IngestResult>} ingest
 * @property {{ get: () => number | string | null }} cursor 只读游标（core 负责推进）
 * @property {(next: number | string) => Promise<{ advanced: boolean }>} advanceCursor 仅用于"确定丢弃"的事件（未识别的 update 类型），不写收据
 * @property {(ts: number) => void} reportPoll 记录一次成功轮询
 * @property {(error: unknown) => void} reportError 记录最近错误（心跳/诊断可见）
 * @property {(detail: Record<string, unknown>) => void} reportHealth 适配器自报状态
 * @property {(input: { name?: string, bytes: Uint8Array }) => Promise<string>} saveAttachment 落盘到 `workspace/inbox/<date>/`
 * @property {string} inboxDir
 * @property {() => { inFlight: number, queueDepth: number }} stats
 * @property {{ info: (message: string) => void, warn: (message: string) => void }} log
 */

/**
 * 校验并补齐适配器给出的事件，越界内容在进入管线前就被拒绝。
 * @param {Partial<InboundEvent>} event
 * @returns {InboundEvent}
 * @throws {TypeError} 字段缺失或类型不对
 */
export function assertInboundEvent(event) {
  const required = ['channel', 'account', 'rawId', 'userId', 'chatId', 'nextCursor'];
  for (const key of required) {
    if (typeof (/** @type {Record<string, unknown>} */ (event)[key]) === 'undefined') {
      throw new TypeError(`inbound event 缺少字段 ${key}`);
    }
  }
  for (const key of ['channel', 'account', 'rawId', 'userId', 'chatId']) {
    const value = /** @type {Record<string, unknown>} */ (event)[key];
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`inbound event 字段 ${key} 必须是非空字符串`);
  }
  if (event.threadId !== undefined && (typeof event.threadId !== 'string' || event.threadId === '')) {
    throw new TypeError('inbound event 字段 threadId 若存在必须是非空字符串');
  }
  if (event.chatType !== undefined && (typeof event.chatType !== 'string' || event.chatType === '')) {
    throw new TypeError('inbound event 字段 chatType 若存在必须是非空字符串');
  }
  if (event.isForum !== undefined && typeof event.isForum !== 'boolean') {
    throw new TypeError('inbound event 字段 isForum 若存在必须是布尔值');
  }
  if (event.mediaKind !== undefined && (typeof event.mediaKind !== 'string' || event.mediaKind === '')) {
    throw new TypeError('inbound event 字段 mediaKind 若存在必须是非空字符串');
  }
  if (event.topic !== undefined) {
    const topic = /** @type {any} */ (event.topic);
    if (topic === null || typeof topic !== 'object' || Array.isArray(topic)) {
      throw new TypeError('inbound event 字段 topic 若存在必须是对象');
    }
    for (const key of ['name', 'preset', 'cwd']) {
      if (topic[key] !== undefined && (typeof topic[key] !== 'string' || topic[key] === '')) {
        throw new TypeError(`inbound event 字段 topic.${key} 若存在必须是非空字符串`);
      }
    }
  }
  if (/** @type {string} */ (event.chatId).includes(':')) throw new TypeError('inbound event 的 chatId 不能包含 ":"（路由键用 ":" 分隔）');
  const kind = event.kind ?? 'message';
  if (kind !== 'message' && kind !== 'callback') throw new TypeError('inbound event 字段 kind 必须是 message 或 callback');
  const text = event.text ?? '';
  if (typeof text !== 'string') throw new TypeError('inbound event 字段 text 必须是字符串');
  const receivedAt = typeof event.receivedAt === 'number' ? event.receivedAt : Date.now();
  return {
    channel: /** @type {string} */ (event.channel),
    account: /** @type {string} */ (event.account),
    rawId: /** @type {string} */ (event.rawId),
    userId: /** @type {string} */ (event.userId),
    chatId: /** @type {string} */ (event.chatId),
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
    ...(event.chatType === undefined ? {} : { chatType: event.chatType }),
    ...(event.isForum === true ? { isForum: true } : {}),
    ...(event.topic === undefined ? {} : { topic: { ...event.topic } }),
    kind,
    text,
    ...(event.command === undefined ? {} : { command: event.command }),
    ...(event.callback === undefined ? {} : { callback: event.callback }),
    ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
    ...(event.mediaKind === undefined ? {} : { mediaKind: event.mediaKind }),
    nextCursor: /** @type {number | string} */ (event.nextCursor),
    receivedAt
  };
}
