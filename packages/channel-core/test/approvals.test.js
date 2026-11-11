import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApprovals } from '../src/approvals.js';
import { inboundEvent, startCore } from './support/core.js';
import { eventually } from './support/wait.js';

function setup(timeoutMs = 600000) {
  const route = { channel: 'telegram', account: 'default', chatId: '42' };
  const routeInfo = { routeKey: 'telegram:default:42', route, stores: {} };
  const messages = [];
  const acks = [];
  const bridge = createApprovals({
    timeoutMs,
    resolveRoute: () => routeInfo,
    adapterFor: () => ({ async send() { return { messageId: '1' }; }, async ackCallback(id, text) { acks.push([id, text]); } }),
    async sendDirect(_route, text, options) { messages.push({ text, options }); return { messageId: '1' }; }
  });
  const request = (signal) => bridge.request({ agent: { id: 'session-1' }, toolName: 'bash', reason: '确认命令', signal }, async () => 'unavailable');
  return { bridge, request, messages, acks, routeInfo };
}

describe('Telegram 审批桥', () => {
  it('按钮只结算一次并返回 allowed-once', async () => {
    const { bridge, request, messages, acks } = setup();
    const result = request();
    await new Promise((resolve) => setImmediate(resolve));
    const data = messages[0].options.buttons[0][0].data;
    const callback = { id: 'callback-1', data };
    assert.equal((await bridge.handleEvent({ callback, channel: 'telegram', account: 'default', chatId: '42' }, { routeKey: 'telegram:default:42' })).handled, true);
    assert.equal(await result, 'allowed-once');
    assert.equal(acks.length, 1);
    bridge.dispose();
  });

  it('拒绝按钮返回 rejected，且显示中文原因', async () => {
    const { bridge, request, messages } = setup();
    const result = request();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(messages[0].text, /确认命令/u);
    const data = messages[0].options.buttons[0][1].data;
    await bridge.handleEvent({ callback: { id: 'callback-2', data }, channel: 'telegram', account: 'default', chatId: '42' }, { routeKey: 'telegram:default:42' });
    assert.equal(await result, 'rejected');
    bridge.dispose();
  });

  it('绑定路由变化后取消待审批并使旧按钮失效', async () => {
    const { bridge, request, messages, routeInfo } = setup();
    const result = request();
    await new Promise((resolve) => setImmediate(resolve));
    routeInfo.routeKey = 'telegram:default:other';
    const data = messages[0].options.buttons[0][0].data;
    await bridge.handleEvent({ callback: { id: 'callback-3', data }, channel: 'telegram', account: 'default', chatId: '42' }, { routeKey: 'telegram:default:42' });
    assert.equal(await result, 'cancelled');
    bridge.dispose();
  });

  it('signal 取消与超时均 fail closed', async () => {
    const cancelled = setup();
    const controller = new AbortController();
    const result = cancelled.request(controller.signal);
    controller.abort();
    assert.equal(await result, 'cancelled');
    cancelled.bridge.dispose();

    const expired = setup(5);
    assert.equal(await expired.request(), 'unavailable');
    expired.bridge.dispose();
  });

  it('/skip 可拒绝当前 route 的待审批请求', async () => {
    const { bridge, request } = setup();
    const result = request();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.skip('telegram:default:42'), 1);
    assert.equal(await result, 'rejected');
    bridge.dispose();
  });

  it('发送未完成时，审批仍按期限结束；迟到的发送结果不改变结算', async () => {
    let finishSend;
    const bridge = createApprovals({
      timeoutMs: 5,
      resolveRoute: () => ({ routeKey: 'telegram:default:42', route: { channel: 'telegram', account: 'default', chatId: '42' } }),
      adapterFor: () => ({ async send() { return { messageId: '1' }; } }),
      sendDirect: () => new Promise((resolve) => { finishSend = resolve; })
    });
    const result = bridge.request({ agent: { id: 'session-1' }, toolName: 'bash' }, async () => 'unavailable');
    assert.equal(await result, 'unavailable');
    finishSend({ messageId: 'late-message' });
    await new Promise((resolve) => setImmediate(resolve));
    bridge.dispose();
  });
});


describe('审批宿主接入', () => {
  it('宿主事件经聊天按钮返回决定，skip 结算后续请求', async () => {
    const core = await startCore();
    try {
      await core.host.ingest(inboundEvent({ text: '建立会话' }));
      const sessionId = core.fake.prompts.at(-1).sessionId;
      const req = { agent: { id: sessionId }, toolName: 'bash', displayReason: { 'zh-CN': '确认本次操作' } };
      const result = core.fake.dispatchWaterfall('approval/request', req);
      await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.[0]?.[0]?.data?.startsWith('ap:')));
      const message = core.adapter.outbox.find((entry) => entry.buttons?.[0]?.[0]?.data?.startsWith('ap:'));
      assert.match(message.text, /确认本次操作/u);
      await core.host.ingest(inboundEvent({ kind: 'callback', text: '', callback: { id: 'approval-host', data: message.buttons[0][0].data } }));
      assert.equal(await result, 'allowed-once');
      const skipped = core.fake.dispatchWaterfall('approval/request', req);
      await eventually(() => core.adapter.outbox.filter((entry) => entry.buttons?.[0]?.[0]?.data?.startsWith('ap:')).length === 2);
      await core.host.ingest(inboundEvent({ text: '/skip' }));
      assert.equal(await skipped, 'rejected');
    } finally {
      await core.fake.dispose();
    }
  });
});
