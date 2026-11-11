import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTelegramAdapter } from '../src/adapter.js';
import { normalizeUpdate } from '../src/normalize.js';

/** 只记录调用、按脚本回数据的传输。 */
function stubTransport(script) {
  const calls = [];
  return {
    id: 'stub',
    longPoll: false,
    calls,
    async getUpdates(request) {
      calls.push({ method: 'getUpdates', request });
      // 与 Telegram 一致：只按 offset 过滤，不"消费"——失败的条目下次还会被重投。
      const offset = typeof request.offset === 'number' ? request.offset : 0;
      return script.updates.filter((update) => update.update_id >= offset).slice(0, script.batchSize ?? 10);
    },
    async sendMessage(request) {
      calls.push({ method: 'sendMessage', request });
      return { message_id: 77 };
    },
    async editMessageText(request) {
      calls.push({ method: 'editMessageText', request });
      return {};
    },
    async answerCallbackQuery(request) {
      calls.push({ method: 'answerCallbackQuery', request });
    },
    async sendDocument(request) {
      calls.push({ method: 'sendDocument', request });
      return { message_id: 88 };
    },
    async downloadFile(request) {
      calls.push({ method: 'downloadFile', request });
      return { bytes: Buffer.from('bytes!'), name: 'a.txt' };
    },
    async setMyCommands(request) {
      calls.push({ method: 'setMyCommands', request });
      return true;
    },
    async sendChatAction(request) {
      calls.push({ method: 'sendChatAction', request });
      return true;
    },
    async getMe() {
      return { username: 'stub-bot' };
    }
  };
}

function fakeHost() {
  /** @type {any[]} */
  const ingested = [];
  /** @type {number[]} */
  const advanced = [];
  /** @type {any[]} */
  const polls = [];
  /** @type {any[]} */
  const errors = [];
  /** @type {any[]} */
  const saved = [];
  let cursor = 0;
  return {
    ingested,
    advanced,
    polls,
    errors,
    saved,
    cursorValue: () => cursor,
    cursor: { get: () => cursor },
    async advanceCursor(next) {
      advanced.push(next);
      cursor = next;
      return { advanced: true };
    },
    async ingest(event, options = {}) {
      await options.prepareAttachments?.(event);
      ingested.push(event);
      if (typeof event.nextCursor === 'number') cursor = event.nextCursor;
      return { status: 'accepted' };
    },
    reportPoll(ts) {
      polls.push(ts);
    },
    reportError(error) {
      errors.push(error);
    },
    reportHealth() {},
    async saveAttachment({ name, bytes }) {
      saved.push({ name, bytes });
      return `/tmp/inbox/${name}`;
    },
    inboxDir: '/tmp/inbox',
    stats: () => ({ inFlight: 0, queueDepth: 0 }),
    log: { info() {}, warn() {} },
    setIngestResult(result) {
      this.ingest = async (event, options = {}) => {
        await options.prepareAttachments?.(event);
        ingested.push(event);
        return result;
      };
    }
  };
}

/** @param {number} ms */
const sleep = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));

describe('适配器', () => {
  it('把 update 归一化后交给 ingest，并上报轮询时间', async () => {
    const transport = stubTransport({ updates: [{ update_id: 0, message: { from: { id: 1000 }, chat: { id: 42 }, text: '你好' } }] });
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5, initialBackoffMs: 5 });
    await adapter.start(host);
    await sleep(30);
    await adapter.stop();
    assert.equal(host.ingested.length, 1);
    assert.equal(host.ingested[0].text, '你好');
    assert.equal(host.ingested[0].channel, 'telegram');
    assert.ok(host.polls.length >= 1);
    assert.deepEqual(transport.calls[0].request.offset, 0);
  });

  it('未识别的 update 类型只推进游标，不写收据', async () => {
    const transport = stubTransport({ updates: [{ update_id: 5, edited_message: {} }] });
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5, initialBackoffMs: 5 });
    await adapter.start(host);
    await sleep(30);
    await adapter.stop();
    assert.equal(host.ingested.length, 0);
    assert.deepEqual(host.advanced, [6]);
  });

  it('ingest 失败时退避并重投同一条（游标不前进）', async () => {
    const transport = stubTransport({ updates: [{ update_id: 0, message: { from: { id: 1000 }, chat: { id: 42 }, text: 'hi' } }] });
    const host = fakeHost();
    host.setIngestResult({ status: 'failed', error: new Error('temporary') });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5, initialBackoffMs: 5 });
    await adapter.start(host);
    await sleep(60);
    await adapter.stop();
    assert.ok(host.ingested.length >= 2, `期望重投，实际 ${host.ingested.length} 次`);
    assert.equal(host.ingested[0].rawId, host.ingested[1].rawId);
  });

  it('轮询抛错时记录并继续，不退出循环', async () => {
    let failures = 2;
    const transport = stubTransport({ updates: [{ update_id: 0, message: { from: { id: 1000 }, chat: { id: 42 }, text: '后到' } }] });
    const original = transport.getUpdates.bind(transport);
    transport.getUpdates = async (request) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('boom');
      }
      return await original(request);
    };
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5, initialBackoffMs: 5 });
    await adapter.start(host);
    await sleep(80);
    await adapter.stop();
    assert.ok(host.errors.length >= 2);
    assert.equal(host.ingested.length, 1);
  });

  it('附件先下载落盘，再把本地路径交给 ingest', async () => {
    const transport = stubTransport({
      updates: [{
        update_id: 0,
        message: { from: { id: 1000 }, chat: { id: 42 }, caption: '看这个', document: { file_id: 'doc-1', file_name: 'a.txt', file_size: 6 } }
      }]
    });
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5, initialBackoffMs: 5 });
    await adapter.start(host);
    await sleep(30);
    await adapter.stop();
    assert.equal(host.saved.length, 1);
    assert.equal(host.saved[0].name, 'a.txt');
    assert.equal(host.ingested[0].attachments[0].path, '/tmp/inbox/a.txt');
  });

  it('send/edit 映射 chat/thread/按钮，probe 报告账号', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5 });
    const sent = await adapter.send({ chatId: '42', threadId: '7' }, '你好', { buttons: [[{ label: '好', data: 'v1|abcd1234|0|0|o' }]] });
    assert.deepEqual(sent, { messageId: '77' });
    const call = transport.calls.at(-1);
    assert.equal(call.request.chatId, 42);
    assert.equal(call.request.threadId, 7);
    assert.deepEqual(call.request.keyboard.inline_keyboard[0][0], { text: '好', callback_data: 'v1|abcd1234|0|0|o' });

    const unchanged = await adapter.edit({ chatId: '42' }, '77', '改一下');
    assert.equal(unchanged, 'ok');
    await adapter.ackCallback('cb-1', '已记录');
    assert.equal(transport.calls.at(-1).request.callbackId, 'cb-1');
    assert.deepEqual(await adapter.probe(), { ok: true, detail: '@stub-bot' });
  });

  it('typing 给 General 保留 message_thread_id=1，普通话题按数字传', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate });
    await adapter.typing({ chatId: '42', threadId: '1' });
    assert.deepEqual(transport.calls.at(-1), { method: 'sendChatAction', request: { chatId: 42, threadId: 1, action: 'typing' } });
    await adapter.typing({ chatId: '42', threadId: '7' });
    assert.equal(transport.calls.at(-1)?.request.threadId, 7);
  });

  it('forum 的 General（无 threadId）typing 自动带 message_thread_id=1', async () => {
    const transport = stubTransport({
      updates: [{
        update_id: 0,
        message: {
          message_id: 1,
          from: { id: 1000 },
          chat: { id: -1001234, type: 'supergroup', is_forum: true },
          text: '在 General 说话'
        }
      }]
    });
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5 });
    await adapter.start(host);
    await sleep(30);
    await adapter.typing({ chatId: '-1001234' });
    assert.equal(transport.calls.at(-1)?.request.threadId, 1, 'General 必须带 1 才显示 typing');

    await adapter.typing({ chatId: '42' });
    assert.equal(transport.calls.at(-1)?.request.threadId, undefined, '普通聊天不带 thread');
    await adapter.stop();
  });

  it('sendDocument 映射 chat/thread 与 caption', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate });
    const sent = await adapter.sendDocument({ chatId: '42', threadId: '7' }, { path: '/tmp/a.pdf', caption: '报告' });
    assert.deepEqual(sent, { messageId: '88' });
    const call = transport.calls.at(-1);
    assert.equal(call.method, 'sendDocument');
    assert.equal(call.request.chatId, 42);
    assert.equal(call.request.threadId, 7);
    assert.equal(call.request.caption, '报告');
  });

  it('General 话题发送时不带 message_thread_id', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate });
    await adapter.send({ chatId: '42', threadId: '1' }, '在往 General 发');
    assert.equal(transport.calls.at(-1).request.threadId, undefined);
  });

  it('setCommandMenu 校验后按 default scope 注册', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate });
    const count = await adapter.setCommandMenu([{ name: 'new', description: '开新会话' }]);
    assert.equal(count, 1);
    const call = transport.calls.at(-1);
    assert.equal(call.method, 'setMyCommands');
    assert.deepEqual(call.request.scope, { type: 'default' });
    assert.deepEqual(call.request.commands, [{ command: 'new', description: '开新会话' }]);
  });

  it('setCommandMenu 对非法命令名与不支持的传输都报错', async () => {
    const transport = stubTransport({ updates: [] });
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate });
    await assert.rejects(async () => await adapter.setCommandMenu([{ name: 'bad name', description: '坏名字' }]), /命令名不合法/u);
    const bare = createTelegramAdapter({ transport: { id: 'bare', longPoll: false, async getUpdates() { return []; }, async getMe() { return {}; } }, normalize: normalizeUpdate });
    await assert.rejects(async () => await bare.setCommandMenu([{ name: 'new', description: '开新会话' }]), /传输不支持/u);
  });

  it('stop() 之后不再轮询', async () => {
    const transport = stubTransport({ updates: [] });
    const host = fakeHost();
    const adapter = createTelegramAdapter({ transport, normalize: normalizeUpdate, pollIntervalMs: 5 });
    await adapter.start(host);
    await sleep(20);
    await adapter.stop();
    const callsAfterStop = transport.calls.length;
    await sleep(30);
    assert.equal(transport.calls.length, callsAfterStop);
  });
});
