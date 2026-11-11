import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatPacer, RateLimitedError, TokenBucket } from '../src/rate-limit.js';

/** 时间与 sleep 完全可控的测试时钟。 */
function fakeClock() {
  let now = 0;
  /** @type {number[]} */
  const sleeps = [];
  return {
    clock: { now: () => now },
    sleeps,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    tick(ms) {
      now += ms;
    }
  };
}

describe('TokenBucket', () => {
  it('突发额度用完后按补桶速率等待', async () => {
    const { clock, sleep, sleeps } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 60, burst: 2, clock, sleep });
    await bucket.take();
    await bucket.take();
    assert.equal(sleeps.length, 0);
    await bucket.take();
    assert.deepEqual(sleeps, [1000], '60/分钟 = 每 1000ms 补一个');
  });

  it('等待后额度恢复，不会无限增长', async () => {
    const { clock, sleep, tick } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 60, burst: 2, clock, sleep });
    await bucket.take();
    await bucket.take();
    tick(10_000);
    await bucket.take();
    await bucket.take();
    await bucket.take(); // 第三次必须等待
    const before = clock.now();
    await bucket.take();
    assert.ok(clock.now() > before);
  });
});

describe('ChatPacer', () => {
  it('同一个 chat 严格串行，不同 chat 并行', async () => {
    const { clock, sleep } = fakeClock();
    const pacer = new ChatPacer({ perMinute: 6000, burst: 100, clock, sleep });
    /** @type {string[]} */
    const order = [];
    const first = pacer.run('a', async () => {
      order.push('a1-start');
      await Promise.resolve();
      order.push('a1-end');
    });
    const second = pacer.run('a', async () => {
      order.push('a2-start');
      order.push('a2-end');
    });
    const other = pacer.run('b', async () => {
      order.push('b-start');
    });
    await Promise.all([first, second, other]);
    assert.deepEqual(order.filter((entry) => entry.startsWith('a')), ['a1-start', 'a1-end', 'a2-start', 'a2-end']);
    assert.ok(order.includes('b-start'));
  });

  it('429 按 retry_after 重试，重试成功后不再抛出', async () => {
    const { clock, sleep, sleeps } = fakeClock();
    const pacer = new ChatPacer({ perMinute: 6000, burst: 100, clock, sleep, maxRetries: 2 });
    let attempts = 0;
    const result = await pacer.run('a', async () => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitedError(1500, 'slow down');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [1500]);
  });

  it('超过重试上限时把 429 抛给调用方', async () => {
    const { clock, sleep } = fakeClock();
    const pacer = new ChatPacer({ perMinute: 6000, burst: 100, clock, sleep, maxRetries: 1 });
    await assert.rejects(async () => await pacer.run('a', async () => {
      throw new RateLimitedError(10);
    }), RateLimitedError);
  });

  it('排队深度按 chat 统计，结束后归零', async () => {
    const { clock, sleep } = fakeClock();
    const pacer = new ChatPacer({ perMinute: 6000, burst: 100, clock, sleep });
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const running = pacer.run('a', async () => await gate);
    const queued = pacer.run('a', async () => 'done');
    assert.equal(pacer.depth('a'), 1);
    assert.equal(pacer.totalDepth, 1);
    release();
    await Promise.all([running, queued]);
    assert.equal(pacer.depth('a'), 0);
    assert.equal(pacer.totalDepth, 0);
  });
});