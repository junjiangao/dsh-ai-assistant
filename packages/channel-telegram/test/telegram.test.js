import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isPlaceholderToken, resolveTelegramConfig } from '../src/config.js';
import { attachmentsOf, normalizeUpdate, threadForAction, threadForSend, threadIdOf } from '../src/normalize.js';
import { clampText, commandMenu, inlineKeyboard } from '../src/render.js';
import { attachTopic, loadTelegramSettings } from '../src/settings.js';
import { createHttpTransport, createSimulatedTransport } from '../src/transport.js';

describe('归一化', () => {
  it('普通消息映射成入站事件，update_id+1 作为游标', () => {
    const event = normalizeUpdate({
      update_id: 41,
      message: { message_id: 5, from: { id: 1000 }, chat: { id: 42, type: 'private' }, text: '你好' }
    }, { channel: 'telegram', account: 'default' });
    assert.deepEqual(event, {
      channel: 'telegram',
      account: 'default',
      rawId: '41',
      userId: '1000',
      chatId: '42',
      chatType: 'private',
      kind: 'message',
      text: '你好',
      nextCursor: 42,
      receivedAt: event.receivedAt
    });
  });

  it('群/论坛消息带上 chat.type 与 is_forum，话题沿用归一化规则', () => {
    const event = normalizeUpdate({
      update_id: 43,
      message: {
        message_id: 6,
        from: { id: 1000 },
        chat: { id: -100123, type: 'supergroup', is_forum: true },
        is_topic_message: true,
        message_thread_id: 12,
        text: '在话题里'
      }
    }, { channel: 'telegram', account: 'default' });
    assert.equal(event.chatType, 'supergroup');
    assert.equal(event.isForum, true);
    assert.equal(event.threadId, '12');
  });

  it('General 话题归一为 "1"，发送时转回 None', () => {
    assert.equal(threadIdOf({ is_topic_message: true }), '1');
    assert.equal(threadIdOf({ is_topic_message: true, message_thread_id: 7 }), '7');
    assert.equal(threadIdOf({}), undefined);
    assert.equal(threadForSend('1'), undefined);
    assert.equal(threadForSend('7'), 7);
    assert.equal(threadForSend(undefined), undefined);
    // typing 方向相反：General 的 1 必须保留
    assert.equal(threadForAction('1'), 1);
    assert.equal(threadForAction('7'), 7);
    assert.equal(threadForAction(undefined), undefined);
  });

  it('按钮回传归一成 callback 事件', () => {
    const event = normalizeUpdate({
      update_id: 7,
      callback_query: { id: 'cb', from: { id: 1000 }, data: 'v1|abcd1234|0|0|o', message: { message_id: 9, chat: { id: 42 }, is_topic_message: true } }
    }, { channel: 'telegram', account: 'default' });
    assert.equal(event.kind, 'callback');
    assert.deepEqual(event.callback, { id: 'cb', data: 'v1|abcd1234|0|0|o' });
    assert.equal(event.threadId, '1');
    assert.equal(event.text, '');
  });

  it('照片/文档/语音都提取成附件描述', () => {
    const attachments = attachmentsOf({
      photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 99 }],
      document: { file_id: 'doc', file_name: '报告.pdf', file_size: 12 },
      voice: { file_id: 'voice', file_size: 3 }
    });
    assert.deepEqual(attachments, [
      { kind: 'photo', size: 99, fileId: 'big' },
      { kind: 'document', name: '报告.pdf', size: 12, fileId: 'doc' },
      { kind: 'voice', size: 3, fileId: 'voice' }
    ]);
  });

  it('转不成文本或附件的消息带上 mediaKind（诊断用）', () => {
    const sticker = normalizeUpdate({
      update_id: 51,
      message: { message_id: 7, from: { id: 1000 }, chat: { id: 42 }, sticker: { file_id: 'st', emoji: '🙂' } }
    }, { channel: 'telegram', account: 'default' });
    assert.equal(sticker.text, '');
    assert.equal(sticker.mediaKind, 'sticker');

    const service = normalizeUpdate({
      update_id: 52,
      message: { message_id: 8, from: { id: 1000 }, chat: { id: 42 }, new_chat_members: [{ id: 5 }] }
    }, { channel: 'telegram', account: 'default' });
    assert.equal(service.mediaKind, 'service');

    // 有文字或附件时不需要它：那两种情况内容不为空，走正常管线。
    const photo = normalizeUpdate({
      update_id: 53,
      message: { message_id: 9, from: { id: 1000 }, chat: { id: 42 }, photo: [{ file_id: 'p', file_size: 1 }] }
    }, { channel: 'telegram', account: 'default' });
    assert.equal(photo.mediaKind, undefined);
  });

  it('不认识的 update 只回报 unsupported + 游标', () => {
    assert.deepEqual(normalizeUpdate({ update_id: 3, edited_message: {} }, { channel: 'telegram', account: 'default' }), { unsupported: true, nextCursor: 4 });
    assert.throws(() => normalizeUpdate({ update_id: 'x' }, { channel: 'telegram', account: 'default' }), /update_id/u);
  });
});

describe('渲染', () => {
  it('按钮矩阵翻成 inline_keyboard，超过 64 字节直接拒绝', () => {
    assert.deepEqual(inlineKeyboard([[{ label: '发布', data: 'v1|abcd1234|0|0|o' }]]), {
      inline_keyboard: [[{ text: '发布', callback_data: 'v1|abcd1234|0|0|o' }]]
    });
    assert.equal(inlineKeyboard([]), undefined);
    assert.throws(() => inlineKeyboard([[{ label: 'x', data: 'a'.repeat(65) }]]), /64 字节/u);
  });

  it('命令菜单校验名称与描述，重复直接拒绝', () => {
    assert.deepEqual(commandMenu([{ name: 'New', description: '开新会话' }]), [{ command: 'new', description: '开新会话' }]);
    assert.throws(() => commandMenu([{ name: 'new!', description: '坏名字' }]), /命令名不合法/u);
    assert.throws(() => commandMenu([{ name: 'new', description: 'ok' }]), /3–256/u);
    assert.throws(() => commandMenu([{ name: 'new', description: '第一个' }, { name: 'new', description: '第二个' }]), /命令重复/u);
  });

  it('超长文本显式截断', () => {
    const result = clampText('a'.repeat(30), 10);
    assert.ok(result.startsWith('a'.repeat(10)));
    assert.match(result, /已截断/u);
  });
});

describe('占位符传输', () => {
  it('从 inbox.jsonl 读脚本消息，update_id 与行号一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-sim-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'inbox.jsonl'), [
      JSON.stringify({ text: '第一句', chatId: 42, userId: 1000 }),
      JSON.stringify({ text: '第二句', chatId: 42, userId: 1000, threadId: 7 })
    ].join('\n') + '\n');
    const transport = createSimulatedTransport({ dir });
    const updates = await transport.getUpdates({ offset: 0 });
    assert.equal(updates.length, 2);
    assert.equal(updates[0].update_id, 0);
    assert.equal(updates[1].update_id, 1);
    assert.equal(updates[1].message.message_thread_id, 7);
    const tail = await transport.getUpdates({ offset: 2 });
    assert.equal(tail.length, 0);
  });

  it('出站写 outbox.jsonl；相同内容的编辑回 unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-sim-'));
    const transport = createSimulatedTransport({ dir });
    const sent = await transport.sendMessage({ chatId: 42, text: '你好', keyboard: undefined });
    assert.equal(typeof sent.message_id, 'number');
    const first = await transport.editMessageText({ chatId: 42, messageId: sent.message_id, text: '你好，世界' });
    assert.deepEqual(first, {});
    const again = await transport.editMessageText({ chatId: 42, messageId: sent.message_id, text: '你好，世界' });
    assert.deepEqual(again, { unchanged: true });
    await transport.answerCallbackQuery({ callbackId: 'cb', text: '已记录' });
    const lines = readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.kind), ['send', 'edit', 'ack']);
    assert.equal(lines[0].text, '你好');
  });

  it('交付物作为 document 事件写进 outbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-sim-'));
    const transport = createSimulatedTransport({ dir });
    const sent = await transport.sendDocument({ chatId: 42, path: '/tmp/report.pdf', caption: '周报' });
    assert.equal(typeof sent.message_id, 'number');
    const line = JSON.parse(readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim());
    assert.equal(line.kind, 'document');
    assert.equal(line.path, '/tmp/report.pdf');
    assert.equal(line.caption, '周报');
  });

  it('命令菜单、typing 与 getChat 在占位符里也落记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-sim-'));
    const transport = createSimulatedTransport({ dir });
    await transport.setMyCommands({ commands: [{ command: 'new', description: '开新会话' }], scope: { type: 'default' } });
    await transport.sendChatAction({ chatId: 42, threadId: 1, action: 'typing' });
    const chat = await transport.getChat({ chatId: 42 });
    assert.equal(chat.type, 'private');
    assert.equal(chat.is_forum, false);
    const lines = readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.kind), ['menu', 'chatAction']);
    assert.deepEqual(lines[0].commands, [{ command: 'new', description: '开新会话' }]);
    assert.deepEqual(lines[0].scope, { type: 'default' });
    assert.equal(lines[1].threadId, 1);
    assert.equal(lines[1].action, 'typing');
  });

  it('脚本里的附件能按 fileId 取回字节', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-sim-'));
    const bytes = Buffer.from('hello world');
    writeFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({
      text: '看附件',
      chatId: 42,
      userId: 1000,
      attachments: [{ kind: 'document', name: 'a.txt', data_base64: bytes.toString('base64') }]
    })}\n`);
    const transport = createSimulatedTransport({ dir });
    const [update] = await transport.getUpdates({ offset: 0 });
    const event = normalizeUpdate(update, { channel: 'telegram', account: 'default' });
    assert.equal(event.attachments?.[0]?.name, 'a.txt');
    const file = await transport.downloadFile({ fileId: event.attachments[0].fileId });
    assert.equal(file.bytes.toString(), 'hello world');
    assert.equal((await transport.getMe()).username, 'assistant-placeholder');
  });
});

describe('HTTP 传输（stub fetch）', () => {
  /** @param {(url: string, init: any) => any} handler */
  function stubFetch(handler) {
    /** @type {Array<{ url: string, body: any }>} */
    const calls = [];
    /** @type {any} */
    const impl = async (url, init) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      const payload = await handler(String(url), init);
      return { ok: true, status: 200, json: async () => payload };
    };
    return { impl, calls };
  }

  it('getUpdates 带上 offset/timeout，sendMessage 带 chat_id 与 reply_markup', async () => {
    const { impl, calls } = stubFetch(async (url) => {
      if (url.endsWith('/getUpdates')) return { ok: true, result: [{ update_id: 1 }] };
      return { ok: true, result: { message_id: 5 } };
    });
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    const updates = await transport.getUpdates({ offset: 3, timeoutSeconds: 0 });
    assert.deepEqual(updates, [{ update_id: 1 }]);
    assert.match(calls[0].url, /\/bot123:abc\/getUpdates$/u);
    assert.equal(calls[0].body.offset, 3);

    const sent = await transport.sendMessage({ chatId: 42, threadId: 7, text: 'hi', keyboard: { inline_keyboard: [] } });
    assert.deepEqual(sent, { message_id: 5 });
    assert.equal(calls[1].body.chat_id, 42);
    assert.equal(calls[1].body.message_thread_id, 7);
    assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [] });
  });

  it('setMyCommands 带 scope，sendChatAction 原样传 message_thread_id=1，getChat 透传', async () => {
    const { impl, calls } = stubFetch(async (url) => {
      if (url.endsWith('/getChat')) return { ok: true, result: { id: -100, type: 'supergroup', is_forum: true } };
      return { ok: true, result: true };
    });
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    await transport.setMyCommands({ commands: [{ command: 'new', description: '开新会话' }], scope: { type: 'all_group_chats' } });
    assert.deepEqual(calls[0].body.scope, { type: 'all_group_chats' });
    assert.deepEqual(calls[0].body.commands, [{ command: 'new', description: '开新会话' }]);

    await transport.sendChatAction({ chatId: 42, threadId: 1 });
    assert.equal(calls[1].body.message_thread_id, 1, 'General 必须带 1，不能用 threadForSend 抹掉');
    assert.equal(calls[1].body.action, 'typing');

    const chat = await transport.getChat({ chatId: -100 });
    assert.equal(chat.type, 'supergroup');
    assert.equal(calls[2].body.chat_id, -100);
  });

  it('自定义 API 地址下的 JSON、上传与下载请求都禁止重定向', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-http-'));
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'hello');
    /** @type {Array<{ url: string, init: any }>} */
    const calls = [];
    /** @type {any} */
    const impl = async (url, init) => {
      calls.push({ url: String(url), init });
      const result = String(url).endsWith('/getFile') ? { file_path: 'documents/report.txt' } : { message_id: 9 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result }),
        arrayBuffer: async () => Buffer.from('downloaded')
      };
    };
    const apiBase = 'https://telegram.example/api';
    const transport = createHttpTransport({ token: '123:abc', apiBase, fetchImpl: impl });
    await transport.getMe();
    await transport.sendDocument({ chatId: 42, path: file });
    const downloaded = await transport.downloadFile({ fileId: 'file-id' });
    assert.equal(downloaded.bytes.toString(), 'downloaded');
    assert.equal(calls.length, 4);
    assert.ok(calls.every(({ init }) => init.redirect === 'error'));
    assert.ok(calls.every(({ url }) => url.startsWith(apiBase)));
  });

  it('429 抛带 retryAfterMs 的错误，供 core 的限速器重排队', async () => {
    const { impl } = stubFetch(async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }));
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    await assert.rejects(async () => await transport.getUpdates({ offset: 0 }), (error) => {
      assert.equal(/** @type {any} */ (error).retryAfterMs, 3000);
      return true;
    });
  });

  it('sendDocument 走 multipart，并复用 429 语义', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-http-'));
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'hello');
    const calls = [];
    /** @type {any} */
    const impl = async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    };
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    const sent = await transport.sendDocument({ chatId: 42, path: file, caption: '报告' });
    assert.deepEqual(sent, { message_id: 9 });
    assert.match(calls[0].url, /\/sendDocument$/u);
    assert.ok(calls[0].body instanceof FormData, 'multipart body');
    assert.equal(calls[0].body.get('caption'), '报告');
  });

  it('"message is not modified" 视为成功（unchanged）', async () => {
    const { impl } = stubFetch(async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }));
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    assert.deepEqual(await transport.editMessageText({ chatId: 42, messageId: 1, text: 'same' }), { unchanged: true });
  });

  it('其它错误带上方法名与描述，便于诊断', async () => {
    const { impl } = stubFetch(async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const transport = createHttpTransport({ token: '123:abc', fetchImpl: impl });
    await assert.rejects(async () => await transport.getMe(), /getMe 失败（401）：Unauthorized/u);
  });
});

describe('配置', () => {
  it('没有真实 token 时默认占位符传输；显式 http 但没 token 直接报错', () => {
    assert.equal(isPlaceholderToken(''), true);
    assert.equal(isPlaceholderToken('placeholder'), true);
    assert.equal(isPlaceholderToken('123456:abc'), true);
    assert.equal(isPlaceholderToken('987:realtoken'), false);

    const simulated = resolveTelegramConfig({ home: '/tmp/x' }, {}, '/home/t');
    assert.equal(simulated.transport, 'simulated');
    assert.equal(simulated.simulateDir, '/tmp/x/channels/telegram/sim');

    assert.throws(() => resolveTelegramConfig({ home: '/tmp/x', transport: 'http' }, {}, '/home/t'), /需要真实的 TELEGRAM_BOT_TOKEN/u);
  });
});

describe('topic 角色配置', () => {
  /** @param {unknown} body */
  function writeSettingsRaw(body) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }

  it('缺失文件为空；General 按 1 匹配，topic 按 id 匹配', () => {
    const empty = loadTelegramSettings('/tmp/definitely-no-telegram-settings.json');
    assert.equal(empty.topics.length, 0);
    assert.equal(empty.topicFor('-100'), undefined);

    const file = writeSettingsRaw({
      topics: [
        { chatId: '-100', name: 'lobby', preset: 'minimal' },
        { chatId: '-100', threadId: '2', name: 'ops', preset: 'standard', cwd: '/srv/ops' }
      ]
    });
    const settings = loadTelegramSettings(file);
    assert.equal(settings.topicFor('-100')?.name, 'lobby');
    assert.equal(settings.topicFor('-100', '2')?.cwd, '/srv/ops');
    assert.deepEqual(attachTopic({ chatId: '-100', threadId: '2' }, settings).topic, { name: 'ops', preset: 'standard', cwd: '/srv/ops' });
    assert.deepEqual(attachTopic({ chatId: '-100' }, settings).topic, { name: 'lobby', preset: 'minimal' });
    assert.equal(attachTopic({ chatId: '-200' }, settings).topic, undefined);
    assert.equal(attachTopic({ unsupported: true, chatId: '-100' }, settings).unsupported, true);
  });

  it('配置写错直接抛错，不带半套角色启动', () => {
    assert.throws(() => loadTelegramSettings(writeSettingsRaw('{bad json')), /无法解析/u);
    assert.throws(() => loadTelegramSettings(writeSettingsRaw({ topics: [{ chatId: 'x' }] })), /chatId 必须是整数/u);
    assert.throws(() => loadTelegramSettings(writeSettingsRaw({ topics: [{ chatId: '-1', threadId: 'a' }] })), /threadId 必须是非负整数/u);
    assert.throws(() => loadTelegramSettings(writeSettingsRaw({ topics: [{ chatId: '-1' }, { chatId: '-1' }] })), /重复/u);
    assert.throws(() => loadTelegramSettings(writeSettingsRaw({ topics: [{ chatId: '-1', preset: 3 }] })), /preset 必须是非空字符串/u);
  });
});