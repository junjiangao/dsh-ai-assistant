import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLog } from '../src/audit.js';
import { resolveCoreConfig } from '../src/config.js';
import { Heartbeat } from '../src/heartbeat.js';
import { createOutbound } from '../src/outbound.js';
import { ChatPacer } from '../src/rate-limit.js';
import { RuntimeState } from '../src/runtime.js';
import { ChannelStores } from '../src/stores.js';
import { parseRouteKey } from '../src/util.js';
import { createFakeAdapter } from './support/fake-dsh.js';
import { eventually, settle } from './support/wait.js';

/**
 * 直接装配出站编排（不启动整个插件），时间与 sleep 完全可控。
 */
async function harness({ editIntervalMs = 20, maxMessageChars, typingIntervalMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-outbound-'));
  const channelDir = join(dir, 'channels', 'telegram');
  const clock = { now: () => now };
  let now = 1000;
  const stores = new ChannelStores({ dir: channelDir, channel: 'telegram', clock });
  await stores.routes.bind('telegram:default:42:', { sessionId: 'session-1', userId: '7' });
  const config = {
    ...resolveCoreConfig({ home: dir }),
    editIntervalMs,
    ...(maxMessageChars === undefined ? {} : { maxMessageChars }),
    ...(typingIntervalMs === undefined ? {} : { typingIntervalMs })
  };
  const adapter = createFakeAdapter();
  const state = new RuntimeState({ clock });
  const heartbeat = new Heartbeat({ path: join(dir, 'run', 'heartbeat.json'), clock });
  const audit = new AuditLog({ dir: join(dir, 'audit') });
  const pacer = new ChatPacer({ perMinute: 6000, burst: 100, clock, sleep: async () => {} });

  const resolveRoute = (sessionId) => {
    const found = stores.routes.bySession(sessionId);
    if (found === undefined) return undefined;
    return { routeKey: found.key, route: parseRouteKey(found.key), entry: found.entry, stores };
  };
  const allRoutes = () => stores.routes.keys().map((key) => ({ routeKey: key, route: parseRouteKey(key), entry: /** @type {any} */ (stores.routes.get(key)), stores }));

  const outbound = createOutbound({
    config,
    clock,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    audit,
    state,
    heartbeat,
    pacer,
    resolveRoute,
    adapterFor: (channel) => (channel === 'telegram' ? adapter.adapter : undefined),
    allRoutes
  });

  /** @param {string} sessionId @param {any} event */
  function sessionEvent(sessionId, event) {
    const session = { id: sessionId, events: [], seq: 0, snapshotEvents: () => session.events };
    session.events.push(event);
    return outbound.onSessionEvent(session, event);
  }

  return {
    dir,
    stores,
    adapter,
    outbound,
    state,
    config,
    advance(ms) {
      now += ms;
    },
    /** @param {string} text */
    delta(text, { turn = 1, step = 0 } = {}) {
      outbound.onAssistantStream({ agent: { id: 'session-1', session: { id: 'session-1' } }, frame: { type: 'chunk', turn, step, chunk: { type: 'text-delta', text } } });
    },
    start(turn = 1, { step = 0 } = {}) {
      outbound.onAssistantStream({ agent: { id: 'session-1', session: { id: 'session-1' } }, frame: { type: 'start', turn, step } });
    },
    sessionEvent
  };
}

describe('出站编排', () => {
  it('首个文本块新建消息，后续文本块编辑同一条', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    h.start();
    h.delta('你好');
    await eventually(() => h.adapter.outbox.length === 1);
    assert.deepEqual(h.adapter.outbox[0].kind, 'send');
    assert.equal(h.adapter.outbox[0].text, '你好');

    h.advance(1000);
    h.delta('，世界');
    await eventually(() => h.adapter.outbox.length === 2);
    assert.equal(h.adapter.outbox[1].kind, 'edit');
    assert.equal(h.adapter.outbox[1].messageId, h.adapter.outbox[0].messageId);
    assert.equal(h.adapter.outbox[1].text, '你好，世界');
  });

  it('间隔内的文本块被合流，不会每个 token 都打一次 API', async () => {
    const h = await harness({ editIntervalMs: 300 });
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    h.start();
    h.delta('a');
    await eventually(() => h.adapter.outbox.length === 1);
    h.delta('b');
    h.delta('c');
    await settle();
    assert.equal(h.adapter.outbox.length, 1, '间隔内不应发新请求');
    await eventually(() => h.adapter.outbox.length === 2, { timeoutMs: 1000 });
    assert.equal(h.adapter.outbox[1].text, 'abc');
  });

  it('turn/end 用持久日志的终稿覆盖草稿，多步文本都保留', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    session.events.push(
      { type: 'assistant/message', seq: 0, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '先看看文件' }] } } },
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '结论：没问题' }] } } }
    );
    await h.outbound.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
    h.outbound.onAssistantStream({ agent: { id: 'session-1' }, frame: { type: 'chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: '先看看文件' } } });
    await eventually(() => h.adapter.outbox.length === 1);
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const last = h.adapter.outbox.at(-1);
    assert.equal(last?.kind, 'edit');
    assert.equal(last?.text, '先看看文件\n\n结论：没问题');
    assert.equal(h.state.inFlightCount, 0, 'turn/end 必须清除在途标记');
  });

  it('无人值守回合（没有在途标记）另发一条新消息', async () => {
    const h = await harness();
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 3 } });
    h.start(3);
    h.delta('定时任务的报告', { turn: 3 });
    await eventually(() => h.adapter.outbox.length === 1);
    assert.equal(h.adapter.outbox[0].kind, 'send');
    const ledger = h.stores.ledger.all();
    assert.equal(ledger.at(-1)?.kind, 'unattended');
  });

  it('失败回合在终稿后附上错误码，中断回合附中断说明', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'too many' } } } });
    assert.match(h.adapter.lastText(), /⚠️ 回合失败：RATE_LIMIT too many/u);

    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 2 } });
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } });
    assert.match(h.adapter.lastText(), /⚠️ 本回合被中断/u);
  });

  it('重复 turn/end 不会产生第二份终稿', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const count = h.adapter.outbox.length;
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(h.adapter.outbox.length, count);
    assert.equal(h.stores.ledger.all().filter((entry) => entry.state === 'final').length, 1);
  });

  it('没有路由绑定的会话不投递，但留下一条 outbound-dropped', async () => {
    const h = await harness();
    const session = { id: 'session-other', events: /** @type {any[]} */ ([]), snapshotEvents: () => session.events };
    h.outbound.onAssistantStream({ agent: { id: 'session-other' }, frame: { type: 'chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: '外部会话' } } });
    await h.outbound.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
    await h.outbound.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '外部会话' }] } } });
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await settle();
    assert.equal(h.adapter.outbox.length, 0, '没有聊天就只能不投');
    assert.equal(h.state.droppedCount, 1, '同一 (session, turn) 只记一次，不按事件数膨胀');

    const auditDir = join(h.dir, 'audit');
    const drops = readdirSync(auditDir)
      .flatMap((name) => readFileSync(join(auditDir, name), 'utf8').trim().split('\n'))
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === 'outbound-dropped');
    assert.equal(drops.length, 1);
    assert.equal(drops[0].sessionId, 'session-other');
    assert.equal(drops[0].turn, 1);
    assert.equal(drops[0].reason, 'no-route');
  });

  it('慢速出站 + 连续文本块：整轮只创建一条消息，终稿不丢字', async () => {
    const h = await harness({ editIntervalMs: 1 });
    const originalSend = h.adapter.adapter.send;
    // 模拟真实网络往返：send 要几十毫秒才返回。若没有"同一时刻只允许一个投递"的保护，
    // 后续的 flush 会再次看到 messageId=null，各发一条新消息。
    h.adapter.adapter.send = async (/** @type {any} */ chat, /** @type {any} */ text, /** @type {any} */ options) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return await originalSend(chat, text, options);
    };
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    h.start();
    const total = 200;
    for (let index = 0; index < total; index += 1) h.delta('x');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const sends = h.adapter.outbox.filter((entry) => entry.kind === 'send');
    assert.equal(sends.length, 1, '整轮只能创建一条消息');
    assert.equal(/** @type {string} */ (h.adapter.outbox.at(-1)?.text).length, total, '终稿必须是完整的累积文本');
  });

  it('present 的交付物在终稿之后作为文件发出', async () => {
    const h = await harness();
    /** @type {any[]} */
    const documents = [];
    h.adapter.adapter.sendDocument = async (/** @type {any} */ chat, /** @type {any} */ input) => {
      documents.push({ chat, ...input });
      return { messageId: 'doc-1' };
    };
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    await h.sessionEvent('session-1', { type: 'deliverables/presented', data: { turn: 1, callId: 'c1', files: [{ path: '/tmp/report.pdf', description: '本周报告' }, { path: '/tmp/data.csv' }] } });
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.deepEqual(documents.map((entry) => entry.path), ['/tmp/report.pdf', '/tmp/data.csv']);
    assert.equal(documents[0].caption, '本周报告');
    assert.equal(documents[0].chat.chatId, '42');
  });

  it('通道不支持附件时，交付物退化为文字路径', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    await h.sessionEvent('session-1', { type: 'deliverables/presented', data: { turn: 1, callId: 'c1', files: [{ path: '/tmp/report.pdf' }] } });
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(h.adapter.outbox.at(-1)?.kind, 'send');
    assert.match(h.adapter.lastText(), /📎 交付物：\n- \/tmp\/report.pdf/u);
  });

  it('恢复：把仍开着的投递补上中断提示并封口', async () => {
    const h = await harness();
    const entry = await h.stores.ledger.open({ routeKey: 'telegram:default:42:', sessionId: 'session-1', turn: 1, kind: 'user' });
    await h.stores.ledger.draft(entry.id, { messageId: 'm-existing', text: '一半' });
    const handled = await h.outbound.recoverInterrupted();
    assert.equal(handled, 1);
    assert.equal(h.adapter.outbox.at(-1)?.messageId, 'm-existing');
    assert.match(h.adapter.lastText(), /进程重启时中断/u);
    assert.equal(h.stores.ledger.all()[0].state, 'aborted');
  });

  it('用户回合发“正在输入”，回合结束就停；无人值守不发', async () => {
    const h = await harness({ typingIntervalMs: 20 });
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    await eventually(() => h.adapter.typings.length >= 1, { label: 'typing started' });
    await h.sessionEvent('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const afterEnd = h.adapter.typings.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.adapter.typings.length, afterEnd, '回合结束后不应继续 typing');

    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.adapter.typings.length, afterEnd, '无人值守回合不应 typing');
  });

  it('工具调用期间草稿显示状态行，后续文本把它覆盖', async () => {
    const h = await harness();
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    await h.sessionEvent('session-1', {
      type: 'assistant/message',
      data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '先跑一下' }, { type: 'tool-call', id: 'call-1', name: 'bash' }] } }
    });
    await eventually(() => h.adapter.lastText().includes('⏳ 正在执行 bash'), { label: 'tool status' });

    await h.sessionEvent('session-1', { type: 'tool/result', data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' } } } });
    h.advance(1000);
    h.delta('结果出来了');
    await eventually(() => h.adapter.lastText() === '结果出来了', { label: 'status cleared by text' });
  });

  it('流式草稿超长时只显示首段并提示分条补发', async () => {
    const h = await harness({ maxMessageChars: 260, editIntervalMs: 1 });
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    h.start();
    h.delta('长'.repeat(400));
    await eventually(() => h.adapter.outbox.length === 1);
    const text = /** @type {string} */ (h.adapter.outbox[0]?.text);
    assert.ok(text.length <= 260, `草稿长度 ${text.length} 超上限`);
    assert.match(text, /分条补发/u);
  });

  it('超长终稿分条发送，账本记录全部 messageIds', async () => {
    const h = await harness({ maxMessageChars: 260 });
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    const text = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段：${'x'.repeat(100)}`).join('\n\n');
    session.events.push({ type: 'assistant/message', seq: 0, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text }] } } });
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    const sends = h.adapter.outbox.filter((entry) => entry.kind === 'send');
    assert.ok(sends.length >= 3, `应分多条，实际 ${sends.length}`);
    assert.match(/** @type {string} */ (sends[1]?.text), /^（2\/\d+）\n/u);
    const ledger = h.stores.ledger.findByTurn('session-1', 1);
    assert.equal(ledger?.messageIds?.length, sends.length);
    assert.equal(ledger?.messageIds?.[0], sends[0]?.messageId);
  });

  it('同一会话连发两条消息：两个回合各自成账，不留 open 条目', async () => {
    const h = await harness();
    const session = { id: 'session-1', events: /** @type {any[]} */ ([]), seq: 0, snapshotEvents: () => session.events };
    session.events.push(
      { type: 'assistant/message', seq: 0, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '第一条的回复' }] } } },
      { type: 'assistant/message', seq: 1, data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第二条的回复' }] } } }
    );
    // 第一条提交并开始
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 1 } });
    h.outbound.onAssistantStream({ agent: { id: 'session-1' }, frame: { type: 'chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: '第一条' } } });
    await eventually(() => h.adapter.outbox.length === 1);
    // 第一条还没结束，第二条已被受理（真机上排队回合的 turn/start 先到）
    h.state.markInFlight('telegram:default:42:', 'session-1');
    await h.sessionEvent('session-1', { type: 'turn/start', data: { turn: 2 } });
    h.outbound.onAssistantStream({ agent: { id: 'session-1' }, frame: { type: 'chunk', turn: 2, step: 0, chunk: { type: 'text-delta', text: '第二条' } } });
    await settle();

    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await h.outbound.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

    const entries = h.stores.ledger.all().filter((entry) => entry.sessionId === 'session-1');
    assert.equal(entries.filter((entry) => entry.state === 'open').length, 0, '不能留下 open 条目：重启时会被误判成中断');
    assert.deepEqual(entries.map((entry) => entry.turn).sort((a, b) => Number(a) - Number(b)), [1, 2]);
    const byTurn = new Map(entries.map((entry) => [entry.turn, entry]));
    assert.equal(byTurn.get(1)?.state, 'final');
    assert.equal(byTurn.get(2)?.state, 'final');
    assert.match(byTurn.get(1)?.text ?? '', /第一条的回复/u);
    assert.match(byTurn.get(2)?.text ?? '', /第二条的回复/u);
    assert.equal(h.state.inFlightCount, 0, '两个回合都结束后在途标记必须归零');

    // 审计的事件名不能被 payload 里的字段覆盖：终稿一律叫 outbound-final，回合类型在 turnKind 上。
    const auditDir = join(h.dir, 'audit');
    const records = readdirSync(auditDir)
      .flatMap((name) => readFileSync(join(auditDir, name), 'utf8').trim().split('\n'))
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    const finals = records.filter((record) => record.kind === 'outbound-final');
    assert.equal(finals.length, 2, '两条终稿都该记成 outbound-final');
    assert.deepEqual(finals.map((record) => record.turnKind), ['user', 'user']);
  });

  it('直发消息（命令回复）超长时分条，按钮挂最后一条', async () => {
    const h = await harness({ maxMessageChars: 260 });
    const result = await h.outbound.sendDirect(
      { channel: 'telegram', chatId: '42' },
      'y'.repeat(600),
      { buttons: [[{ label: '好', data: 'v1|abcd1234|0|0|o' }]] }
    );
    const sends = h.adapter.outbox.filter((entry) => entry.kind === 'send');
    assert.ok(sends.length >= 3);
    assert.equal(sends.at(-1)?.buttons?.[0]?.[0]?.label, '好');
    assert.equal(result.messageId, sends.at(-1)?.messageId);
  });
});