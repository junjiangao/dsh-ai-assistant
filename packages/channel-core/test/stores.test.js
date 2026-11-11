import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ChannelStores } from '../src/stores.js';

/** @returns {{ dir: string, clock: { now: () => number }, tick: (ms: number) => void }} */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-stores-'));
  let now = 1_000;
  return { dir, clock: { now: () => now }, tick: (ms) => { now += ms; } };
}

describe('ChannelStores', () => {
  it('游标只单调前进，并在重启后保持', async () => {
    const { dir } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram' });
    assert.equal(stores.cursor.get(), null);
    assert.equal((await stores.cursor.advance(10)).advanced, true);
    assert.equal((await stores.cursor.advance(7)).advanced, false);
    assert.equal(stores.cursor.get(), 10);
    await stores.settled();

    const reloaded = new ChannelStores({ dir, channel: 'telegram' });
    assert.equal(reloaded.cursor.get(), 10);
  });

  it('收据去重且按上限 FIFO 淘汰', async () => {
    const { dir, clock } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram', receiptLimit: 16, clock });
    assert.equal(await stores.receipts.add('telegram:default:1'), true);
    assert.equal(await stores.receipts.add('telegram:default:1'), false);
    assert.equal(stores.receipts.has('telegram:default:1'), true);
    for (let index = 2; index <= 20; index += 1) await stores.receipts.add(`telegram:default:${index}`);
    assert.equal(stores.receipts.has('telegram:default:1'), false, '最早的一条应被淘汰');
    assert.equal(stores.receipts.size, 16);
    await stores.settled();
  });

  it('路由双向可查，重复 bind 保留 createdAt', async () => {
    const { dir, clock } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram', clock });
    const first = await stores.routes.bind('telegram:default:42:', { sessionId: 'session-1', userId: '7' });
    clock.now();
    const second = await stores.routes.bind('telegram:default:42:', { sessionId: 'session-2', userId: '7' });
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.sessionId, 'session-2');
    assert.equal(stores.routes.bySession('session-2')?.key, 'telegram:default:42:');
    assert.equal(stores.routes.bySession('session-1'), undefined);
  });

  it('账本：终稿幂等，重复 finalize 不覆盖也不二次上报', async () => {
    const { dir, clock } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram', clock });
    const entry = await stores.ledger.open({ routeKey: 'telegram:default:42:', sessionId: 'session-1', turn: 1, kind: 'user' });
    await stores.ledger.draft(entry.id, { messageId: 'm1', text: '半截' });
    const first = await stores.ledger.finalize(entry.id, { messageId: 'm1', text: '终稿', finalHash: 'abc' });
    assert.equal(first.written, true);
    const again = await stores.ledger.finalize(entry.id, { messageId: 'm1', text: '终稿', finalHash: 'abc' });
    assert.equal(again.written, false);
    assert.equal(stores.ledger.openFor('telegram:default:42:').length, 0);
    assert.equal(stores.ledger.all()[0].text, '终稿');
  });

  it('账本：abandon 不会覆盖已定稿的条目', async () => {
    const { dir } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram' });
    const entry = await stores.ledger.open({ routeKey: 'k', sessionId: 's', turn: 1, kind: 'user' });
    await stores.ledger.finalize(entry.id, { messageId: 'm', text: 'done', finalHash: 'h' });
    await stores.ledger.abandon(entry.id, 'restart');
    assert.equal(stores.ledger.all()[0].state, 'final');
  });

  it('提问记录：pendingForRoute 同时给出 open 与 expired，已结算的不再出现', async () => {
    const { dir, clock } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram', clock });
    const base = {
      routeKey: 'telegram:default:42:',
      sessionId: 'session-1',
      agentId: 'session-1',
      timed: true,
      channel: 'telegram',
      account: 'default',
      chatId: '42',
      questions: [{ id: 'q1', question: '?' }],
      selected: {},
      createdAt: 1,
      updatedAt: 1
    };
    await stores.approvals.put({ ...base, id: 'a', shortId: 'aaaa1111', state: 'open' });
    await stores.approvals.put({ ...base, id: 'b', shortId: 'bbbb2222', state: 'expired', callId: 'call-b' });
    await stores.approvals.put({ ...base, id: 'c', shortId: 'cccc3333', state: 'answered' });
    assert.deepEqual(stores.approvals.pendingForRoute(base.routeKey).map((record) => record.id), ['a', 'b']);
    assert.deepEqual(stores.approvals.openForRoute(base.routeKey).map((record) => record.id), ['a']);
  });

  it('损坏的状态文件被隔离而不是让进程卡死', async () => {
    const { dir } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram' });
    await stores.receipts.add('x');
    await stores.settled();
    writeFileSync(join(dir, 'receipts.json'), '{ not json', 'utf8');
    const reloaded = new ChannelStores({ dir, channel: 'telegram' });
    assert.equal(reloaded.recoveredFiles, 1);
    assert.equal(reloaded.receipts.has('x'), false);
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('receipts.json.corrupt-'));
    assert.equal(leftovers.length, 1, '坏文件应被改名保留证据');
    await reloaded.receipts.add('y');
    await reloaded.settled();
    assert.match(readFileSync(join(dir, 'receipts.json'), 'utf8'), /"y"/u);
  });

  it('原子写：并发更新不丢，落盘内容可解析', async () => {
    const { dir } = fixture();
    const stores = new ChannelStores({ dir, channel: 'telegram' });
    await Promise.all(Array.from({ length: 20 }, async (_, index) => await stores.receipts.add(`e${index}`)));
    await stores.settled();
    const parsed = JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8'));
    assert.equal(parsed.entries.length, 20);
  });
});