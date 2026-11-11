import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { apply, internals } from '../src/index.js';
import { SOUL_SECTION } from '../src/identity.js';
import { capture, createStartupHost } from './support/fake.js';
import { eventually } from './support/wait.js';

const original = { stdout: internals.stdout, stderr: internals.stderr, env: internals.env };
afterEach(() => {
  internals.stdout = original.stdout;
  internals.stderr = original.stderr;
  internals.env = original.env;
});

/**
 * @param {string[]} args
 * @param {{ home?: string, services?: Record<string, unknown> }} [options]
 */
function start(args, { home, services = {} } = {}) {
  const host = createStartupHost({ dshHome: home ?? mkdtempSync(join(tmpdir(), 'startup-')) });
  for (const [name, value] of Object.entries(services)) host.services.set(name, value);
  host.services.set('cmdlineArgs', { get: () => args });
  const stdout = capture();
  const stderr = capture();
  internals.stdout = stdout;
  internals.stderr = stderr;
  internals.env = /** @type {any} */ ({});
  /** @type {any[]} */
  const sections = [];
  host.services.set('systemPrompt', { section: (/** @type {any} */ section) => sections.push(section) });
  apply(host.ctx, { home: host.home });
  return { host, stdout, stderr, sections };
}

describe('assistant-startup 插件', () => {
  it('daemon 模式提供服务、注册身份 section、不退出', async () => {
    const home = mkdtempSync(join(tmpdir(), 'startup-'));
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'SOUL.md'), '你是助理。');
    const { host, sections } = start([], { home });
    const provided = /** @type {any} */ (host.services.get('assistantStartup'));
    assert.equal(provided.mode, 'daemon');
    assert.equal(provided.config.dshHome, home);
    assert.deepEqual(sections.map((section) => section.name), [SOUL_SECTION]);
    assert.equal(sections[0].interpolate, false);
    assert.deepEqual(host.exits, [], 'daemon 模式不应请求退出');
  });

  it('--help 打印用法并退出 0，不提供服务', async () => {
    const { host, stdout } = start(['--help']);
    assert.deepEqual(host.exits, [0]);
    assert.match(stdout.text(), /--once/u);
    assert.equal(host.services.get('assistantStartup'), undefined);
  });

  it('非法参数：stderr 说明并退出 2', async () => {
    const { host, stderr } = start(['--bogus']);
    assert.deepEqual(host.exits, [2]);
    assert.match(stderr.text(), /未知选项：--bogus/u);
    assert.match(stderr.text(), /用法：dsh --profile assistant/u);
  });

  it('--once 跑完一个回合后按结果退出', async () => {
    const { host, stdout } = start(['--once', '报一下时间']);
    const sessionId = await eventually(() => host.prompts.at(0)?.sessionId, { label: 'prompt' });
    host.append(/** @type {string} */ (sessionId), { type: 'turn/start', data: { turn: 0 } });
    host.append(/** @type {string} */ (sessionId), { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '现在是 18:00。' }] } } });
    host.append(/** @type {string} */ (sessionId), { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
    await eventually(() => host.exits.length > 0, { label: 'exit' });
    assert.deepEqual(host.exits, [0]);
    assert.equal(stdout.text().trim(), '现在是 18:00。');
  });

  it('--doctor 打印一页诊断并按结果退出', async () => {
    const home = mkdtempSync(join(tmpdir(), 'startup-'));
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'SOUL.md'), '你是助理。');
    const { host, stdout } = start(['--doctor'], { home });
    await eventually(() => host.exits.length > 0, { label: 'doctor exit' });
    assert.deepEqual(host.exits, [0]);
    assert.match(stdout.text(), /助理诊断/u);
    assert.match(stdout.text(), /结论：可运行/u);
  });
});
