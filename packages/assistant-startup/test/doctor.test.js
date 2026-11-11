import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runDoctor } from '../src/doctor.js';

/**
 * 造一个"看起来健康"的数据根。
 * @returns {{ home: string, now: number, ctx: any, env: Record<string, string> }}
 */
function healthyHome() {
  const home = mkdtempSync(join(tmpdir(), 'doctor-'));
  mkdirSync(join(home, 'identity'), { recursive: true });
  mkdirSync(join(home, 'run'), { recursive: true });
  mkdirSync(join(home, 'sessions', 'session-1'), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  mkdirSync(join(home, 'identity-history', '20261109T000000Z'), { recursive: true });
  writeFileSync(join(home, 'identity', 'SOUL.md'), '你是助理。\n');
  writeFileSync(join(home, 'identity', 'SYSTEM.md'), '不要宽范围删除。\n');
  const now = Date.now();
  writeFileSync(join(home, 'run', 'heartbeat.json'), JSON.stringify({ ts: now - 5000, pid: process.pid, startedAt: now - 60000, inFlight: 0, queueDepth: 0, lastError: null }));
  writeFileSync(join(home, 'run', 'host.pid'), `${process.pid}\n`);
  writeFileSync(join(home, 'storages', 'schedule.json'), JSON.stringify({ tasks: {} }));
  writeFileSync(join(home, 'identity-history', '20261109T000000Z', 'DIFF.txt'), '');
  return {
    home,
    now,
    env: { https_proxy: 'http://proxy.test:3128', no_proxy: 'localhost', NODE_USE_ENV_PROXY: '1' },
    ctx: {
      get: (/** @type {string} */ name) => {
        if (name === 'agentPresets') return { list: async () => [{ id: 'standard' }, { id: 'minimal' }] };
        if (name === 'schedule') return { list: async () => ({ items: [{ id: 't1' }] }) };
        return undefined;
      }
    }
  };
}

describe('doctor', () => {
  it('健康数据根全绿，输出一页结论', async () => {
    const fixture = healthyHome();
    const report = await runDoctor({
      ctx: fixture.ctx,
      config: { dshHome: fixture.home, probeTimeoutMs: 1000 },
      env: /** @type {any} */ (fixture.env),
      now: fixture.now,
      probeTelegram: async () => ({ ok: true, detail: '占位符传输' })
    });
    assert.equal(report.ok, true);
    assert.equal(report.checks.filter((check) => check.status === 'fail').length, 0);
    assert.match(report.text, /助理诊断（DSH_HOME=/u);
    assert.match(report.text, /结论：可运行/u);
    const names = report.checks.map((check) => check.name);
    for (const name of ['数据根', '身份', '心跳', '单实例', '代理', '通道', '调度', '预设', '会话', '留痕']) {
      assert.ok(names.includes(name), `缺少检查项 ${name}`);
    }
  });

  it('数据根不存在是 fail；陈旧 pid 锁与陈旧心跳是 warn', async () => {
    const missing = await runDoctor({
      ctx: { get: () => undefined },
      config: { dshHome: join(tmpdir(), 'doctor-does-not-exist'), probeTimeoutMs: 1000 },
      env: /** @type {any} */ ({}),
      probeTelegram: async () => ({ ok: false, detail: '未配置' })
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.checks.find((check) => check.name === '数据根')?.status, 'fail');

    const fixture = healthyHome();
    const deadPid = 2 ** 22 + 54321;
    writeFileSync(join(fixture.home, 'run', 'host.pid'), `${deadPid}\n`);
    writeFileSync(join(fixture.home, 'run', 'heartbeat.json'), JSON.stringify({ ts: fixture.now - 600000, pid: deadPid, inFlight: 1, queueDepth: 0, lastError: 'boom' }));
    const report = await runDoctor({
      ctx: fixture.ctx,
      config: { dshHome: fixture.home, probeTimeoutMs: 1000 },
      env: /** @type {any} */ (fixture.env),
      now: fixture.now,
      probeTelegram: async () => ({ ok: true })
    });
    assert.equal(report.checks.find((check) => check.name === '单实例')?.status, 'warn');
    assert.equal(report.checks.find((check) => check.name === '心跳')?.status, 'warn');
    assert.equal(report.ok, true, '只有提示不应判定为失败');
  });

  it('探活失败是 fail；缺失服务降级为 warn', async () => {
    const fixture = healthyHome();
    const report = await runDoctor({
      ctx: { get: () => undefined },
      config: { dshHome: fixture.home, probeTimeoutMs: 1000 },
      env: /** @type {any} */ ({}),
      now: fixture.now,
      probeTelegram: async () => ({ ok: false, detail: '401 Unauthorized' })
    });
    assert.equal(report.checks.find((check) => check.name === '通道')?.status, 'fail');
    assert.equal(report.checks.find((check) => check.name === '预设')?.status, 'warn');
    assert.equal(report.ok, false);
    assert.match(report.text, /结论：有 1 项需要处理/u);
  });
});
