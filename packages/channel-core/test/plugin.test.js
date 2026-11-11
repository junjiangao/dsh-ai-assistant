import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { apply } from '../src/index.js';
import { createFakeDsh } from './support/fake-dsh.js';
import { inboundEvent, nextUpdateId, startCore } from './support/core.js';
import { eventually, settle } from './support/wait.js';

describe('channel-core 插件生命周期', () => {
  it('持有 pid 锁、写心跳、注册服务，dispose 后释放锁', async () => {
    const { fake } = await startCore();
    const lockPath = join(fake.home, 'run', 'host.pid');
    assert.equal(readFileSync(lockPath, 'utf8').trim(), String(process.pid));
    const heartbeatPath = join(fake.home, 'run', 'heartbeat.json');
    assert.ok(existsSync(heartbeatPath), '启动即写一次心跳');
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    assert.equal(heartbeat.pid, process.pid);
    assert.equal(heartbeat.inFlight, 0);

    await fake.dispose();
    assert.equal(existsSync(lockPath), false, 'dispose 必须释放 pid 锁');
  });

  it('同一数据根第二次启动直接失败并请求退出（M0 验收 3）', async () => {
    const fake = createFakeDsh();
    apply(fake.ctx, { home: fake.home, owners: { telegram: ['7'] } });
    const second = createFakeDsh({ dshHome: fake.home });
    assert.throws(() => apply(second.ctx, { home: fake.home, owners: { telegram: ['7'] } }), /已在运行/u);
    assert.deepEqual(second.exits, [1]);
    await fake.dispose();
  });

  it('/status 汇总版本、会话、在途、队列、通道与心跳', async () => {
    const { core, fake } = await startCore();
    const status = await core.status();
    assert.match(String(status.版本), /channel-core/u);
    assert.equal(status.在途回合, 0);
    assert.equal(status.队列深度, 0);
    assert.equal(status.待答提问, 0);
    assert.equal(status.通道.telegram, '连通（fake）');
    assert.match(String(status.心跳年龄), /^\d+s$/u);
    await fake.dispose();
  });
});

describe('入站管线', () => {
  /** @type {Awaited<ReturnType<typeof startCore>>} */
  let core;
  before(async () => {
    core = await startCore();
  });
  after(async () => {
    await core.fake.dispose();
  });

  it('白名单用户的消息被提交，路由与会话建立，游标推进', async () => {
    const event = inboundEvent({ rawId: '2001', text: '报一下时间', nextCursor: 2002 });
    const result = await core.host.ingest(event);
    assert.equal(result.status, 'accepted');
    assert.equal(core.fake.prompts.length, 1);
    const prompt = core.fake.prompts[0];
    assert.equal(prompt.requestId, 'telegram:2001');
    assert.deepEqual(prompt.content, [{ type: 'text', text: '报一下时间' }]);
    assert.equal(prompt.mode, 'queue');
    assert.equal(core.host.cursor.get(), 2002);
  });

  it('重复 update_id 不二次提交（M1 验收）', async () => {
    const before = core.fake.prompts.length;
    const event = inboundEvent({ rawId: '3001', text: '只发一次', nextCursor: 3002 });
    await core.host.ingest(event);
    const again = await core.host.ingest({ ...event, text: '只发一次' });
    assert.equal(again.status, 'duplicate');
    assert.equal(core.fake.prompts.length, before + 1);
  });

  it('游标不倒退', async () => {
    const before = Number(core.host.cursor.get());
    await core.host.ingest(inboundEvent({ rawId: String(nextUpdateId()), nextCursor: 1 }));
    assert.equal(Number(core.host.cursor.get()), before);
  });

  it('越权用户不回消息、只写审计', async () => {
    const outboxBefore = core.adapter.outbox.length;
    const result = await core.host.ingest(inboundEvent({ rawId: '4001', userId: '999', text: '我是陌生人' }));
    assert.equal(result.status, 'denied');
    assert.equal(core.fake.prompts.filter((prompt) => prompt.requestId === 'telegram:4001').length, 0);
    assert.equal(core.adapter.outbox.length, outboxBefore);
    const auditToday = join(core.fake.home, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`);
    assert.match(readFileSync(auditToday, 'utf8'), /"kind":"denied"/u);
  });

  it('空内容事件被忽略，但审计里留下消息类型', async () => {
    const before = core.fake.prompts.length;
    const result = await core.host.ingest(inboundEvent({ rawId: '4501', text: '', mediaKind: 'sticker' }));
    assert.equal(result.status, 'accepted');
    assert.equal(result.detail, 'empty');
    assert.equal(core.fake.prompts.length, before, '空内容不该提交给模型');
    const auditToday = join(core.fake.home, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`);
    assert.match(readFileSync(auditToday, 'utf8'), /"rawId":"4501".*"detail":"empty","mediaKind":"sticker"/u);
  });

  it('命令在入站阶段被拦截，不进模型上下文', async () => {
    const before = core.fake.prompts.length;
    const result = await core.host.ingest(inboundEvent({ rawId: '5001', text: '/status' }));
    assert.equal(result.status, 'command');
    assert.equal(core.fake.prompts.length, before);
    assert.match(core.adapter.lastText(), /助理状态/u);
  });

  it('未知斜杠命令交回模型，而不是被当成错误吞掉', async () => {
    const before = core.fake.prompts.length;
    const result = await core.host.ingest(inboundEvent({ rawId: '5002', text: '/whatever 帮我看看' }));
    assert.equal(result.status, 'accepted');
    assert.equal(core.fake.prompts.length, before + 1);
  });

  it('回合在途时 /new 被拒绝，避免旧回合的投递失去路由', async () => {
    const event = inboundEvent({ rawId: '5003', text: '开始一个长任务' });
    await core.host.ingest(event);
    const result = await core.host.ingest(inboundEvent({ rawId: '5004', text: '/new' }));
    assert.equal(result.status, 'command');
    assert.match(core.adapter.lastText(), /当前回合仍在运行/u);
  });

  it('会话已不存在时自动重建并重投（崩溃后的路由修复）', async () => {
    const own = await startCore();
    await own.host.ingest(inboundEvent({ rawId: '6001', text: '还在吗' }));
    const routeFile = join(own.fake.home, 'channels', 'telegram', 'routes.json');
    const routes = JSON.parse(readFileSync(routeFile, 'utf8'));
    routes.routes['telegram:default:42:'].sessionId = 'session-missing';
    writeFileSync(routeFile, JSON.stringify(routes, null, 2));
    await own.fake.dispose();

    // 新实例读同一数据根：路由指向的会话不存在，必须就地重建而不是把消息丢掉
    const restarted = await startCore({ config: { home: own.fake.home } });
    const result = await restarted.host.ingest(inboundEvent({ rawId: '6002', text: '在吗', nextCursor: 9000 }));
    assert.equal(result.status, 'accepted');
    assert.equal(restarted.fake.prompts.length, 1);
    const repaired = JSON.parse(readFileSync(routeFile, 'utf8'));
    assert.notEqual(repaired.routes['telegram:default:42:'].sessionId, 'session-missing');
    await restarted.fake.dispose();
  });

  it('身份文件有变更时，下次启动推给 owner，且每份快照只推一次', async () => {
    const own = await startCore();
    await own.host.ingest(inboundEvent({ rawId: 'identity-1', text: '先建立 owner 路由' }));
    await own.fake.dispose();

    const snapshot = join(own.fake.home, 'identity-history', '20261109T000000Z');
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, 'DIFF.txt'), '--- SOUL.md\n+++ SOUL.md\n-旧人格\n+新人格\n');

    const restarted = await startCore({ config: { home: own.fake.home } });
    await eventually(() => restarted.adapter.outbox.some((entry) => entry.text.includes('身份文件在启动前有变更')), { label: 'identity push' });
    const pushed = restarted.adapter.outbox.find((entry) => entry.text.includes('身份文件在启动前有变更'));
    assert.match(pushed.text, /新人格/u);
    assert.ok(existsSync(join(snapshot, '.notified')));
    await restarted.fake.dispose();

    const third = await startCore({ config: { home: own.fake.home } });
    await settle(5);
    assert.equal(third.adapter.outbox.some((entry) => entry.text.includes('身份文件在启动前有变更')), false, '同一份快照不应重复推送');
    await third.fake.dispose();
  });

  it('重启后恢复中断投递：补一句中断提示并封口，不重放', async () => {
    const own = await startCore();
    await own.host.ingest(inboundEvent({ rawId: '9101', text: '开始', nextCursor: 9102 }));
    const sessionId = /** @type {string} */ (own.fake.prompts.at(-1).sessionId);
    const session = own.fake.sessions.get(sessionId);
    assert.ok(session !== undefined);
    own.fake.appendSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
    own.fake.dispatch('agent/assistant-stream', { agent: { id: sessionId, session }, frame: { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 0 } });
    own.fake.dispatch('agent/assistant-stream', { agent: { id: sessionId, session }, frame: { type: 'chunk', attemptId: 'a', revision: 2, turn: 1, step: 0, chunk: { type: 'text-delta', text: '先说一半' } } });
    await eventually(() => own.adapter.outbox.some((entry) => entry.text === '先说一半'), { label: 'draft message' });
    const ledgerFile = join(own.fake.home, 'channels', 'telegram', 'ledger.json');
    await eventually(() => JSON.parse(readFileSync(ledgerFile, 'utf8')).entries.some((entry) => entry.messageId !== null), { label: 'ledger draft' });
    await own.fake.dispose();

    const restarted = await startCore({ config: { home: own.fake.home } });
    await eventually(() => restarted.adapter.outbox.some((entry) => entry.text.includes('进程重启时中断')), { label: 'interrupted notice' });
    await eventually(() => JSON.parse(readFileSync(ledgerFile, 'utf8')).entries.every((entry) => entry.state !== 'open'), { label: 'ledger sealed' });
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    assert.equal(ledger.entries.some((entry) => entry.state === 'aborted'), true);
    await restarted.fake.dispose();
  });
});