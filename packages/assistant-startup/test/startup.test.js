import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveStartupConfig } from '../src/config.js';
import { identityProblems, loadIdentity, registerIdentitySections, SOUL_SECTION, SYSTEM_SECTION } from '../src/identity.js';
import { parseArgs } from '../src/argv.js';

/** @param {string} home */
function makeHome(home) {
  mkdirSync(join(home, 'identity'), { recursive: true });
  return home;
}

describe('启动参数', () => {
  it('三种模式与错误路径', () => {
    assert.deepEqual(parseArgs([]), { mode: 'daemon', errors: [] });
    assert.deepEqual(parseArgs(['--once', '报一下时间']), { mode: 'once', errors: [], task: '报一下时间' });
    assert.deepEqual(parseArgs(['--once=报一下时间']), { mode: 'once', errors: [], task: '报一下时间' });
    assert.equal(parseArgs(['--doctor']).mode, 'doctor');
    assert.equal(parseArgs(['-h']).mode, 'help');
    assert.match(parseArgs(['--once']).errors[0], /--once 需要一个非空任务/u);
    assert.match(parseArgs(['--doctor', 'x']).errors[0], /不接受任务参数/u);
    assert.match(parseArgs(['--once', 'a', '--doctor']).errors[0], /互斥/u);
    assert.match(parseArgs(['--bogus']).errors[0], /未知选项/u);
  });

  it('多个词的任务被拼成一条', () => {
    assert.equal(parseArgs(['--once', '列出', '你的', '工具']).task, '列出 你的 工具');
  });
});

describe('身份装配', () => {
  it('缺文件只告警；存在则按原样进 section，并禁用插值', () => {
    const home = makeHome(mkdtempSync(join(tmpdir(), 'identity-')));
    writeFileSync(join(home, 'identity', 'SOUL.md'), '你是小助手。\n');
    writeFileSync(join(home, 'identity', 'SYSTEM.md'), '规则里出现 {{model}} 也应当原样保留。\n');

    const identity = loadIdentity({ dshHome: home });
    const soul = identity.sections.find((section) => section.name === SOUL_SECTION);
    const system = identity.sections.find((section) => section.name === SYSTEM_SECTION);
    assert.equal(soul?.text, '你是小助手。\n');
    assert.equal(soul?.order, 0);
    assert.equal(system?.order, 10200);
    assert.equal(system?.interpolate, false, '身份文本必须原样保留，不能被 {{…}} 插值炸掉');
    assert.equal(identity.files.find((file) => file.label === 'SOUL')?.braceReferences, 0);
    assert.ok(identity.warnings.some((warning) => warning.includes('AGENTS')), 'AGENTS 缺失应被告知');
    assert.deepEqual(identityProblems(identity), ['SYSTEM 有 1 处 {{…}}']);
  });

  it('把 section 注册进 systemPrompt，空文本不注册', () => {
    const home = makeHome(mkdtempSync(join(tmpdir(), 'identity-')));
    writeFileSync(join(home, 'identity', 'SOUL.md'), 'S');
    const identity = loadIdentity({ dshHome: home });
    /** @type {any[]} */
    const registered = [];
    const ctx = {
      get: (/** @type {string} */ name) => name === 'systemPrompt' ? { section: (/** @type {any} */ section) => registered.push(section) } : undefined
    };
    const result = registerIdentitySections(ctx, identity);
    assert.deepEqual(result.registered, [SOUL_SECTION]);
    assert.equal(registered[0].interpolate, false);
  });

  it('没有 systemPrompt 服务时安静跳过而不是崩溃', () => {
    const identity = loadIdentity({ dshHome: makeHome(mkdtempSync(join(tmpdir(), 'identity-'))) });
    assert.deepEqual(registerIdentitySections({ get: () => undefined }, identity), { registered: [] });
  });
});

describe('启动配置', () => {
  it('默认值与非法值', () => {
    const config = resolveStartupConfig({}, { DSH_HOME: '/tmp/home' }, '/home/t');
    assert.equal(config.dshHome, '/tmp/home');
    assert.equal(config.onceTimeoutMs, 600000);
    assert.throws(() => resolveStartupConfig({ onceTimeoutMs: 0 }), /onceTimeoutMs/u);
  });
});
