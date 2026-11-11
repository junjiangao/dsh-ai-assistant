import { threadForAction, threadForSend } from './normalize.js';
import { clampText, commandMenu, inlineKeyboard } from './render.js';

/**
 * Telegram 适配器：长轮询 + 出站调用 + 探活。
 *
 * 它**不**做去重、路由、账本、限速——那些在 channel-core。这里只负责：
 * 1. 把 `getUpdates` 的 update 归一化后交给 `host.ingest`；
 * 2. 把 send/edit 翻成 Bot API 调用（含 `callback_data` 与 General 话题的处理）；
 * 3. 失败退避并上报 `host.reportError`，成功轮询上报 `reportPoll`。
 *
 * @param {object} options
 * @param {string} [options.id]
 * @param {string} [options.account]
 * @param {any} options.transport
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.initialBackoffMs]
 * @param {number} [options.backoffMaxMs]
 * @param {{ now: () => number }} [options.clock]
 * @param {{ info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void }} [options.logger]
 * @param {import('./normalize.js').normalizeUpdate | ((update: any, context: any) => any)} [options.normalize]
 */
export function createTelegramAdapter({
  id = 'telegram',
  account = 'default',
  transport,
  pollIntervalMs = 1000,
  initialBackoffMs = 1000,
  backoffMaxMs = 30000,
  clock = { now: () => Date.now() },
  logger,
  normalize
}) {
  /** @type {import('@junjiangao/channel-core').ChannelHost | undefined} */
  let host;
  let running = false;
  /** @type {Promise<void> | undefined} */
  let loop;
  /**
   * 见过 `chat.is_forum === true` 的聊天。Telegram 的 General 主题没有 thread id，
   * 但 typing 必须带 `message_thread_id = 1` 才会显示——发消息则相反，传 1 会报错。
   * 用户回合一定发生在本聊天的一条消息之后，所以这里用入站消息暖缓存就够。
   * @type {Set<string>}
   */
  const forumChats = new Set();

  /** @param {number} ms */
  const sleep = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * @param {{ chatId: string, threadId?: string }} chat
   * @param {string} text
   * @param {{ buttons?: import('@junjiangao/channel-core').Button[][] }} [options]
   * @returns {Promise<{ messageId: string }>}
   */
  async function send(chat, text, options = {}) {
    const result = await transport.sendMessage({
      chatId: numericChatId(chat.chatId),
      threadId: threadForSend(chat.threadId),
      text: clampText(text),
      keyboard: inlineKeyboard(options.buttons)
    });
    return { messageId: String(result.message_id) };
  }

  /**
   * @param {{ chatId: string, threadId?: string }} chat
   * @param {string} messageId
   * @param {string} text
   * @param {{ buttons?: import('@junjiangao/channel-core').Button[][] }} [options]
   * @returns {Promise<'ok' | 'unchanged'>}
   */
  async function edit(chat, messageId, text, options = {}) {
    const result = await transport.editMessageText({
      chatId: numericChatId(chat.chatId),
      messageId: Number(messageId),
      text: clampText(text),
      keyboard: inlineKeyboard(options.buttons)
    });
    return result?.unchanged === true ? 'unchanged' : 'ok';
  }

  /**
   * 发送 `present` 产出的交付物（文件）。
   * @param {{ chatId: string, threadId?: string }} chat
   * @param {{ path: string, caption?: string }} input
   * @returns {Promise<{ messageId: string }>}
   */
  async function sendDocument(chat, { path, caption }) {
    if (typeof transport.sendDocument !== 'function') throw new Error('channel-telegram: 传输不支持发送文件');
    const result = await transport.sendDocument({
      chatId: numericChatId(chat.chatId),
      threadId: threadForSend(chat.threadId),
      path,
      ...(caption === undefined ? {} : { caption: clampText(caption, 1024) })
    });
    return { messageId: String(result.message_id) };
  }

  /**
   * @param {string} callbackId
   * @param {string} [text]
   * @returns {Promise<void>}
   */
  async function ackCallback(callbackId, text) {
    await transport.answerCallbackQuery({ callbackId, ...(text === undefined ? {} : { text }) });
  }

  /**
   * 回合进行中的“正在输入”。Telegram 侧 5 秒过期，由 core 按间隔续期。
   * @param {{ chatId: string, threadId?: string }} chat
   * @returns {Promise<void>}
   */
  async function typing(chat) {
    if (typeof transport.sendChatAction !== 'function') return;
    // General 主题：路由里没有 threadId，但 typing 必须显式带 1。
    const threadId = chat.threadId ?? (forumChats.has(chat.chatId) ? '1' : undefined);
    await transport.sendChatAction({
      chatId: numericChatId(chat.chatId),
      threadId: threadForAction(threadId),
      action: 'typing'
    });
  }

  /**
   * 注册客户端 `/` 菜单。启动时调一次；失败由调用方决定是否降级成日志。
   * @param {Array<{ name: string, description: string }>} commands
   * @returns {Promise<number>} 实际注册条数
   */
  async function setCommandMenu(commands) {
    if (typeof transport.setMyCommands !== 'function') throw new Error('channel-telegram: 传输不支持命令菜单');
    const menu = commandMenu(commands);
    if (menu.length === 0) return 0;
    await transport.setMyCommands({ commands: menu, scope: { type: 'default' } });
    return menu.length;
  }

  /** @returns {Promise<{ ok: boolean, detail?: string }>} */
  async function probe() {
    try {
      const me = await transport.getMe();
      return { ok: true, detail: `@${me.username ?? 'unknown'}${transport.id === 'simulated' ? '（占位符传输）' : ''}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * @param {import('@junjiangao/channel-core').ChannelHost} registered
   * @returns {Promise<void>}
   */
  async function start(registered) {
    host = registered;
    running = true;
    loop = runLoop();
    // 启动时做一次探活：心跳里的 lastGetMeOk 不该等到第一次出站才有值。
    void probe().then((result) => registered.reportHealth({ ok: result.ok, ...(result.detail === undefined ? {} : { detail: result.detail }) }));
    await Promise.resolve();
  }

  /** @returns {Promise<void>} */
  async function stop() {
    running = false;
    await loop;
    loop = undefined;
  }

  /** @returns {Promise<void>} */
  async function runLoop() {
    if (host === undefined) return;
    let backoff = initialBackoffMs;
    while (running) {
      const current = host;
      try {
        const cursor = current.cursor.get();
        const offset = typeof cursor === 'number' ? cursor : 0;
        const updates = await transport.getUpdates({ offset, timeoutSeconds: transport.longPoll === true ? 25 : 0 });
        // 空轮询也要记一笔：否则 `lastPoll` 永远是 null，doctor/健康检查会把"安静"误判成"停摆"。
        current.reportPoll(clock.now());
        if (!running) break;
        if (!Array.isArray(updates) || updates.length === 0) {
          await sleep(pollIntervalMs);
          continue;
        }
        for (const update of updates) {
          const event = (normalize ?? fallbackNormalize)(update, { channel: id, account, receivedAt: clock.now() });
          // 记住 forum 聊天：General 的 typing 需要 message_thread_id=1，而路由里没有 threadId。
          if (event.isForum === true && typeof event.chatId === 'string') forumChats.add(event.chatId);
          if (event.unsupported === true) {
            // 未识别的 update 类型：只推进游标，不写收据（丢了也不影响正确性）。
            await current.advanceCursor(event.nextCursor);
            continue;
          }
          const result = await current.ingest(event, { prepareAttachments: (accepted) => attachFiles(current, accepted) });
          if (result.status === 'failed') {
            logger?.warn?.(`ingest 失败，退避 ${backoff}ms 后重投：${String(result.error)}`);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, backoffMaxMs);
            break;
          }
          backoff = initialBackoffMs;
        }
      } catch (error) {
        current.reportError(error);
        logger?.error?.(`轮询失败：${error instanceof Error ? error.message : String(error)}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, backoffMaxMs);
      }
    }
  }

  /**
   * 附件下载到 `workspace/inbox/<date>/`，把本地路径填回事件。
   * 下载失败只记录，不挡这条消息：文字往往已经足够表达意图。
   * @param {import('@junjiangao/channel-core').ChannelHost} current
   * @param {any} event
   * @returns {Promise<void>}
   */
  async function attachFiles(current, event) {
    for (const attachment of event.attachments ?? []) {
      if (attachment.fileId === undefined || typeof transport.downloadFile !== 'function') continue;
      try {
        const file = await transport.downloadFile({ fileId: attachment.fileId });
        attachment.path = await current.saveAttachment({ name: attachment.name ?? file.name, bytes: file.bytes });
      } catch (error) {
        current.reportError(error);
        logger?.warn?.(`附件下载失败（${attachment.kind}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { id, account, transport, start, stop, send, edit, sendDocument, typing, ackCallback, probe, setCommandMenu };
}

/**
 * 默认归一化（允许注入，便于测试与将来接入别的平台方言）。
 * @param {any} update
 * @param {{ channel: string, account: string, receivedAt?: number }} context
 * @returns {any}
 */
function fallbackNormalize(update, context) {
  throw new Error(`channel-telegram: 没有注入 normalize，无法处理 update（${JSON.stringify(context)}）`);
}

/**
 * Telegram 的 chat id 是整数；字符串形式保留给上层做路由键。
 * @param {string} chatId
 * @returns {number}
 */
function numericChatId(chatId) {
  const numeric = Number(chatId);
  if (!Number.isSafeInteger(numeric)) throw new Error(`channel-telegram: 非法的 chat id ${JSON.stringify(chatId)}`);
  return numeric;
}
