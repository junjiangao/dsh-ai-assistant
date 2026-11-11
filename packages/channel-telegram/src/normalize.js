/**
 * Telegram Update → 归一化入站事件（设计文档 §7.2）。
 *
 * 这里只做"平台方言 → 统一契约"的翻译：不判断权限、不去重、不建会话。
 * 不认识的 update 类型返回 `{ unsupported: true }`，适配器据此只推进游标。
 */

/**
 * General 话题在 Telegram 里可能没有 `message_thread_id`；项目约定把它归一为 `'1'`，
 * 这样 `(chat_id, thread_id)` 才能稳定地当会话键（发送时再把 `'1'` 转回 `None`）。
 * @param {any} message
 * @returns {string | undefined}
 */
export function threadIdOf(message) {
  if (message?.is_topic_message === true) return String(message.message_thread_id ?? 1);
  if (message?.message_thread_id === undefined || message.message_thread_id === null) return undefined;
  return String(message.message_thread_id);
}

/**
 * 发送方向：General（`'1'`）必须转成"不传 thread_id"，否则 Telegram 会把它当成另一个话题。
 * @param {string | undefined} threadId
 * @returns {number | undefined}
 */
export function threadForSend(threadId) {
  if (threadId === undefined || threadId === '' || threadId === '1') return undefined;
  const numeric = Number(threadId);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

/**
 * 发送方向（typing 等）：与 {@link threadForSend} 相反，General（`'1'`）**必须**保留。
 * Telegram 的 sendChatAction 只有在带 `message_thread_id=1` 时才会显示在 General 上，
 * 而 sendMessage 传 1 反而会报错——两条路径故意不对称。
 * @param {string | undefined} threadId
 * @returns {number | undefined}
 */
export function threadForAction(threadId) {
  if (threadId === undefined || threadId === '') return undefined;
  const numeric = Number(threadId);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

/**
 * @typedef {{ kind: 'photo'|'document'|'voice'|'audio'|'video', name?: string, size?: number, fileId?: string }} NormalizedAttachment
 */

/**
 * 一条 Telegram 消息里的附件描述（不含字节；下载由适配器完成）。
 * @param {any} message
 * @returns {NormalizedAttachment[]}
 */
export function attachmentsOf(message) {
  /** @type {NormalizedAttachment[]} */
  const attachments = [];
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    attachments.push({ kind: 'photo', size: largest.file_size, fileId: largest.file_id });
  }
  if (message?.document) {
    attachments.push({
      kind: 'document',
      ...(message.document.file_name === undefined ? {} : { name: message.document.file_name }),
      size: message.document.file_size,
      fileId: message.document.file_id
    });
  }
  for (const kind of /** @type {const} */ (['voice', 'audio', 'video'])) {
    const media = message?.[kind];
    if (media === undefined || media === null) continue;
    attachments.push({
      kind,
      ...(media.file_name === undefined ? {} : { name: media.file_name }),
      size: media.file_size,
      fileId: media.file_id
    });
  }
  return attachments;
}

/**
 * 无法转成文本或附件的消息类型。
 *
 * 只用于诊断：没有它，这类消息在审计里只剩一条 `detail:"empty"`，
 * 事后既不知道用户发了什么，也分不清"平台推了服务消息"和"我们的归一化漏了一种类型"。
 */
const UNHANDLED_MEDIA_KEYS = /** @type {const} */ ([
  'sticker', 'animation', 'video_note', 'location', 'venue', 'contact', 'poll', 'dice', 'paid_media'
]);

/**
 * @param {any} message
 * @returns {string | undefined}
 */
export function mediaKindOf(message) {
  for (const key of UNHANDLED_MEDIA_KEYS) {
    if (message?.[key] !== undefined && message[key] !== null) return key;
  }
  for (const key of /** @type {const} */ (['pinned_message', 'new_chat_members', 'left_chat_member', 'new_chat_title', 'forum_topic_created'])) {
    if (message?.[key] !== undefined && message[key] !== null) return 'service';
  }
  return undefined;
}

/**
 * @param {any} update
 * @param {{ channel: string, account: string, receivedAt?: number }} context
 * @returns {import('@junjiangao/channel-core').InboundEvent | { unsupported: true, nextCursor: number }}
 */
export function normalizeUpdate(update, { channel, account, receivedAt = Date.now() }) {
  const updateId = Number(update?.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new TypeError(`Telegram update_id 不是非负整数：${JSON.stringify(update?.update_id)}`);
  const nextCursor = updateId + 1;

  const message = update?.message;
  if (message !== undefined && message !== null) {
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    const chatType = typeof message.chat?.type === 'string' ? message.chat.type : undefined;
    const attachments = attachmentsOf(message);
    const mediaKind = text === '' && attachments.length === 0 ? mediaKindOf(message) : undefined;
    /** @type {import('@junjiangao/channel-core').InboundEvent} */
    const event = {
      channel,
      account,
      rawId: String(updateId),
      userId: String(message.from?.id ?? message.chat?.id ?? ''),
      chatId: String(message.chat?.id ?? ''),
      ...(threadIdOf(message) === undefined ? {} : { threadId: threadIdOf(message) }),
      ...(chatType === undefined ? {} : { chatType }),
      ...(message.chat?.is_forum === true ? { isForum: true } : {}),
      kind: 'message',
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(mediaKind === undefined ? {} : { mediaKind }),
      nextCursor,
      receivedAt
    };
    return event;
  }

  const callback = update?.callback_query;
  if (callback !== undefined && callback !== null) {
    const source = callback.message;
    const chatType = typeof source?.chat?.type === 'string' ? source.chat.type : undefined;
    /** @type {import('@junjiangao/channel-core').InboundEvent} */
    const event = {
      channel,
      account,
      rawId: String(updateId),
      userId: String(callback.from?.id ?? ''),
      chatId: String(source?.chat?.id ?? callback.from?.id ?? ''),
      ...(threadIdOf(source) === undefined ? {} : { threadId: threadIdOf(source) }),
      ...(chatType === undefined ? {} : { chatType }),
      ...(source?.chat?.is_forum === true ? { isForum: true } : {}),
      kind: 'callback',
      text: '',
      callback: { id: String(callback.id), data: typeof callback.data === 'string' ? callback.data : '' },
      nextCursor,
      receivedAt
    };
    return event;
  }

  return { unsupported: true, nextCursor };
}