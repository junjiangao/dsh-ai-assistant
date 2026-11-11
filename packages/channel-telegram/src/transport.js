import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * 传输层：把"Telegram Bot API 的形状"和"本地占位符"放在同一组方法后面。
 *
 * 方法契约（适配器只用这些）：
 * - `getUpdates({ offset, timeoutSeconds })` → `Update[]`（`update_id` 由 transport 负责给）
 * - `sendMessage({ chatId, threadId, text, keyboard })` → `{ message_id }`
 * - `editMessageText({ chatId, messageId, text, keyboard })` → `{ unchanged? }`
 * - `answerCallbackQuery({ callbackId, text })`
 * - `downloadFile({ fileId })` → `{ bytes, name? }`
 * - `setMyCommands({ commands, scope?, languageCode? })` / `deleteMyCommands(...)`
 * - `sendChatAction({ chatId, threadId?, action? })`（threadId 原样传，General 要 1）
 * - `getChat({ chatId })` → `{ type, is_forum?, title? }`
 * - `getMe()` → `{ username, can_read_all_group_messages? }`
 *
 * 429 约定：抛出的错误带 `retryAfterMs`（core 的限速器按这个字段重排队，不需要 import 类型）。
 */

/** @typedef {ReturnType<typeof createSimulatedTransport>} Transport */

/**
 * 占位符传输：从 `<dir>/inbox.jsonl` 读脚本化消息，把出站写进 `<dir>/outbox.jsonl`。
 *
 * 这是**可用的**占位符而不是空实现：追加一行 JSON 就能让助理回应，
 * 让整条管线（归一化 → 路由 → 回合 → 流式编辑 → 终稿）在没有真实 token 时也能跑与验收。
 *
 * @param {{ dir: string }} options
 */
export function createSimulatedTransport({ dir }) {
  const inboxPath = join(dir, 'inbox.jsonl');
  const outboxPath = join(dir, 'outbox.jsonl');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(inboxPath)) writeFileSync(inboxPath, '', { mode: 0o600 });
  if (!existsSync(outboxPath)) writeFileSync(outboxPath, '', { mode: 0o600 });

  /** @type {Map<string, { bytes: Buffer, name?: string }>} */
  const files = new Map();
  let messageCounter = readMessageCounter(outboxPath);

  /** @param {string} path @returns {string[]} */
  const linesOf = (path) => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  };

  /** @param {Record<string, unknown>} record */
  const append = (record) => {
    appendFileSync(outboxPath, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, { mode: 0o600 });
  };

  return {
    id: 'simulated',
    /** 占位符没有真实长轮询，用短轮询节奏。 */
    longPoll: false,

    /**
     * @param {{ offset: number, timeoutSeconds?: number }} request
     * @returns {Promise<any[]>}
     */
    async getUpdates({ offset }) {
      const lines = linesOf(inboxPath);
      const start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
      return lines.slice(start).map((line, index) => {
        const updateId = start + index;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return { update_id: updateId, message: { message_id: updateId, from: { id: 0 }, chat: { id: 0 }, text: `（无法解析的 inbox 行：${line.slice(0, 80)}）` } };
        }
        return { update_id: updateId, .../** @type {any} */ (scriptedToUpdate(parsed, { files, updateId })) };
      });
    },

    /**
     * @param {{ chatId: number, threadId?: number, text: string, keyboard?: any }} request
     * @returns {Promise<{ message_id: number }>}
     */
    async sendMessage({ chatId, threadId, text, keyboard }) {
      messageCounter += 1;
      const messageId = messageCounter;
      append({
        kind: 'send',
        chatId,
        ...(threadId === undefined ? {} : { threadId }),
        text,
        ...(keyboard === undefined ? {} : { keyboard }),
        messageId
      });
      return { message_id: messageId };
    },

    /**
     * @param {{ chatId: number, messageId: number, text: string, keyboard?: any }} request
     * @returns {Promise<{ unchanged?: boolean }>}
     */
    async editMessageText({ chatId, messageId, text, keyboard }) {
      const previous = lastFor(linesOf(outboxPath), messageId);
      if (previous !== undefined && previous.text === text && JSON.stringify(previous.keyboard ?? null) === JSON.stringify(keyboard ?? null)) {
        return { unchanged: true };
      }
      append({ kind: 'edit', chatId, messageId, text, ...(keyboard === undefined ? {} : { keyboard }) });
      return {};
    },

    /**
     * @param {{ callbackId: string, text?: string }} request
     * @returns {Promise<void>}
     */
    async answerCallbackQuery({ callbackId, text }) {
      append({ kind: 'ack', callbackId, ...(text === undefined ? {} : { text }) });
    },

    /**
     * 占位符把"发文件"记成一条带本地路径的事件，便于离线核对交付物确实被投递。
     * @param {{ chatId: number, threadId?: number, path: string, caption?: string }} request
     * @returns {Promise<{ message_id: number }>}
     */
    async sendDocument({ chatId, threadId, path, caption }) {
      messageCounter += 1;
      const messageId = messageCounter;
      append({ kind: 'document', chatId, ...(threadId === undefined ? {} : { threadId }), path, ...(caption === undefined ? {} : { caption }), messageId });
      return { message_id: messageId };
    },

    /**
     * @param {{ fileId: string }} request
     * @returns {Promise<{ bytes: Buffer, name?: string }>}
     */
    async downloadFile({ fileId }) {
      const file = files.get(fileId);
      if (file === undefined) throw new Error(`占位符里没有这个文件：${fileId}（脚本化消息需要 data_base64）`);
      return file;
    },

    /**
     * 命令菜单在占位符里落一条记录，便于离线核对待注册的清单。
     * @param {{ commands: { command: string, description: string }[], scope?: any, languageCode?: string }} request
     * @returns {Promise<true>}
     */
    async setMyCommands({ commands, scope, languageCode }) {
      append({ kind: 'menu', commands, ...(scope === undefined ? {} : { scope }), ...(languageCode === undefined ? {} : { languageCode }) });
      return true;
    },

    /**
     * @param {{ scope?: any, languageCode?: string }} [request]
     * @returns {Promise<true>}
     */
    async deleteMyCommands({ scope, languageCode } = {}) {
      append({ kind: 'menu-clear', ...(scope === undefined ? {} : { scope }), ...(languageCode === undefined ? {} : { languageCode }) });
      return true;
    },

    /**
     * @param {{ chatId: number, threadId?: number, action?: string }} request
     * @returns {Promise<true>}
     */
    async sendChatAction({ chatId, threadId, action = 'typing' }) {
      append({ kind: 'chatAction', chatId, ...(threadId === undefined ? {} : { threadId }), action });
      return true;
    },

    /**
     * @param {{ chatId: number }} request
     * @returns {Promise<{ id: number, type: string, title: string, is_forum: boolean }>}
     */
    async getChat({ chatId }) {
      return { id: chatId, type: 'private', title: '模拟聊天', is_forum: false };
    },

    async getMe() {
      return { id: 0, username: 'assistant-placeholder', is_bot: true, can_read_all_group_messages: false };
    }
  };
}

/**
 * 真实 Bot API 传输；默认使用官方地址，可由部署配置指定可信服务器。
 * @param {{ token: string, apiBase?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createHttpTransport({ token, apiBase = 'https://api.telegram.org', fetchImpl = fetch, timeoutMs = 40000 }) {
  if (typeof token !== 'string' || token.trim() === '') throw new Error('createHttpTransport: 需要非空 bot token');

  /**
   * @param {string} value
   */
  const cleanErrorText = (value) => value
    .replaceAll(token, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@');

  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  async function fetchTelegram(url, init) {
    try {
      return await fetchImpl(url, { ...init, redirect: 'error' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(cleanErrorText(detail));
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<any>}
   */
  async function call(method, params) {
    const response = await fetchTelegram(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    /** @type {any} */
    const payload = await response.json().catch(() => ({}));
    if (payload.ok === true) return payload.result;
    const code = payload.error_code ?? response.status;
    const description = cleanErrorText(String(payload.description ?? `HTTP ${response.status}`));
    if (code === 429) {
      const retryAfter = Number(payload.parameters?.retry_after ?? 1);
      const error = new Error(`Telegram 限速：${description}`);
      /** @type {any} */ (error).retryAfterMs = Math.max(0, retryAfter * 1000);
      throw error;
    }
    if (description.includes('message is not modified')) return { unchanged: true };
    const error = new Error(`Telegram ${method} 失败（${code}）：${description}`);
    /** @type {any} */ (error).telegramCode = code;
    throw error;
  }

  return {
    id: 'http',
    longPoll: true,
    /** @param {{ offset: number, timeoutSeconds?: number }} request */
    async getUpdates({ offset, timeoutSeconds = 0 }) {
      return await call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] });
    },
    /** @param {{ chatId: number, threadId?: number, text: string, keyboard?: any }} request */
    async sendMessage({ chatId, threadId, text, keyboard }) {
      return await call('sendMessage', {
        chat_id: chatId,
        text,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        link_preview_options: { is_disabled: true }
      });
    },
    /** @param {{ chatId: number, messageId: number, text: string, keyboard?: any }} request */
    async editMessageText({ chatId, messageId, text, keyboard }) {
      return await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(keyboard === undefined ? {} : { reply_markup: keyboard })
      });
    },
    /** @param {{ callbackId: string, text?: string }} request */
    async answerCallbackQuery({ callbackId, text }) {
      await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text === undefined ? {} : { text }) });
    },
    /**
     * 文件走 multipart（Bot API 的 sendDocument 不接受 JSON 里的本地路径）。
     * @param {{ chatId: number, threadId?: number, path: string, caption?: string }} request
     * @returns {Promise<{ message_id: number }>}
     */
    async sendDocument({ chatId, threadId, path, caption }) {
      const bytes = await readFile(path);
      // Node 的 FormData/Blob 类型定义在 @types/node 里与 DOM 的构造签名不完全一致，
      // 这里只依赖运行时行为（undici 实现），类型上用 any 收口。
      const FormDataCtor = /** @type {any} */ (globalThis).FormData;
      const form = new FormDataCtor();
      form.append('chat_id', String(chatId));
      if (threadId !== undefined) form.append('message_thread_id', String(threadId));
      if (caption !== undefined) form.append('caption', caption);
      form.append('document', new Blob([/** @type {any} */ (bytes)]), basename(path));
      const response = await fetchTelegram(`${apiBase}/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
      /** @type {any} */
      const payload = await response.json().catch(() => ({}));
      if (payload.ok === true) return payload.result;
      const description = cleanErrorText(String(payload.description ?? ''));
      if (payload.error_code === 429) {
        const retryAfter = Number(payload.parameters?.retry_after ?? 1);
        const error = new Error(`Telegram 限速：${description}`);
        /** @type {any} */ (error).retryAfterMs = Math.max(0, retryAfter * 1000);
        throw error;
      }
      throw new Error(`Telegram sendDocument 失败（${String(payload.error_code ?? response.status)}）：${description}`);
    },
    /** @param {{ fileId: string }} request */
    async downloadFile({ fileId }) {
      const file = await call('getFile', { file_id: fileId });
      const url = `${apiBase}/file/bot${token}/${file.file_path}`;
      const response = await fetchTelegram(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`下载文件失败：HTTP ${response.status}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), ...(file.file_path === undefined ? {} : { name: file.file_path.split('/').pop() }) };
    },
    /**
     * 注册客户端斜杠菜单。scope 走 Bot API 原样结构（default / all_group_chats / chat）。
     * @param {{ commands: { command: string, description: string }[], scope?: any, languageCode?: string }} request
     * @returns {Promise<true>}
     */
    async setMyCommands({ commands, scope, languageCode }) {
      return await call('setMyCommands', {
        commands,
        ...(scope === undefined ? {} : { scope }),
        ...(languageCode === undefined ? {} : { language_code: languageCode })
      });
    },
    /** @param {{ scope?: any, languageCode?: string }} [request] */
    async deleteMyCommands({ scope, languageCode } = {}) {
      return await call('deleteMyCommands', {
        ...(scope === undefined ? {} : { scope }),
        ...(languageCode === undefined ? {} : { language_code: languageCode })
      });
    },
    /**
     * 回合进行中的 "正在输入"。与 sendMessage 故意不对称：General 主题要求
     * message_thread_id = 1，而 sendMessage 传 1 会被拒绝，所以 threadId 由调用方决定，
     * 适配器这里不做 threadForSend 转换。
     * @param {{ chatId: number, threadId?: number, action?: string }} request
     * @returns {Promise<true>}
     */
    async sendChatAction({ chatId, threadId, action = 'typing' }) {
      return await call('sendChatAction', {
        chat_id: chatId,
        action,
        ...(threadId === undefined ? {} : { message_thread_id: threadId })
      });
    },
    /**
     * 群类型、是否 forum、标题。诊断与话题门控用它，而不是缓存猜测。
     * @param {{ chatId: number }} request
     * @returns {Promise<{ id: number, type: string, title?: string, is_forum?: boolean, username?: string }>}
     */
    async getChat({ chatId }) {
      return await call('getChat', { chat_id: chatId });
    },
    async getMe() {
      return await call('getMe', {});
    }
  };
}

/**
 * 把脚本化的简写转成 Telegram 形状的 update，让归一化路径被真实覆盖。
 * @param {any} parsed
 * @param {{ files: Map<string, { bytes: Buffer, name?: string }>, updateId: number }} context
 * @returns {any}
 */
function scriptedToUpdate(parsed, { files, updateId }) {
  if (parsed.message !== undefined || parsed.callback_query !== undefined) return parsed;
  if (parsed.text === undefined && parsed.callback === undefined) return {};
  if (parsed.callback !== undefined) {
    return {
      callback_query: {
        id: parsed.callback.id ?? `sim-cb-${updateId}`,
        from: { id: parsed.userId ?? 0 },
        data: parsed.callback.data ?? '',
        message: {
          message_id: updateId,
          chat: { id: parsed.chatId ?? 0, type: parsed.chatType ?? 'private', ...(parsed.isForum === true ? { is_forum: true } : {}) },
          ...(parsed.threadId === undefined ? {} : { message_thread_id: parsed.threadId })
        }
      }
    };
  }
  /** @type {any} */
  const message = {
    message_id: updateId,
    from: { id: parsed.userId ?? 0 },
    chat: { id: parsed.chatId ?? 0, type: parsed.chatType ?? 'private', ...(parsed.isForum === true ? { is_forum: true } : {}) },
    date: Math.trunc(Date.now() / 1000),
    text: parsed.text ?? ''
  };
  if (parsed.threadId !== undefined) {
    message.message_thread_id = parsed.threadId;
    message.is_topic_message = true;
  }
  for (const attachment of parsed.attachments ?? []) {
    const fileId = `sim-${updateId}-${attachment.kind}-${files.size}`;
    files.set(fileId, {
      bytes: Buffer.from(attachment.data_base64 ?? '', 'base64'),
      ...(attachment.name === undefined ? {} : { name: attachment.name })
    });
    if (attachment.kind === 'photo') message.photo = [{ file_id: fileId, file_size: files.get(fileId)?.bytes.byteLength ?? 0 }];
    else if (attachment.kind === 'document') message.document = { file_id: fileId, file_name: attachment.name, file_size: files.get(fileId)?.bytes.byteLength ?? 0 };
    else if (attachment.kind === 'voice') message.voice = { file_id: fileId, file_size: files.get(fileId)?.bytes.byteLength ?? 0 };
    else if (attachment.kind === 'audio') message.audio = { file_id: fileId, file_name: attachment.name, file_size: files.get(fileId)?.bytes.byteLength ?? 0 };
    else if (attachment.kind === 'video') message.video = { file_id: fileId, file_name: attachment.name, file_size: files.get(fileId)?.bytes.byteLength ?? 0 };
  }
  return { message };
}

/**
 * @param {string[]} lines
 * @param {number} messageId
 * @returns {any}
 */
function lastFor(lines, messageId) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry.messageId === messageId) return entry;
    } catch {
      /* 跳过坏行 */
    }
  }
  return undefined;
}

/**
 * @param {string} outboxPath
 * @returns {number}
 */
function readMessageCounter(outboxPath) {
  if (!existsSync(outboxPath)) return 0;
  let max = 0;
  for (const line of readFileSync(outboxPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.messageId === 'number' && entry.messageId > max) max = entry.messageId;
    } catch {
      /* 坏行不影响计数 */
    }
  }
  return max;
}