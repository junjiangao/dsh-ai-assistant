import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { foldLastTurn, runOnce } from '../src/once.js';
import { capture, createStartupHost } from './support/fake.js';
import { eventually } from './support/wait.js';

/**
 * 跑 `--once` 并在提示提交后按脚本推进回合。
 * @param {{ finish: (host: any, sessionId: string) => void, timeoutMs?: number }} options
 */
async function runScripted({ finish, timeoutMs = 5000 }) {
  const host = createStartupHost({ dshHome: mkdtempSync(join(tmpdir(), 'once-')) });
  const stdout = capture();
  const stderr = capture();
  const promise = runOnce({ ctx: host.ctx, task: '报一下时间', timeoutMs, stdout, stderr });
  const sessionId = await eventually(() => host.prompts.at(0)?.sessionId, { label: 'prompt submitted' });
  finish(host, /** @type {string} */ (sessionId));
  const outcome = await promise;
  return { host, outcome, stdout: stdout.text(), stderr: stderr.text() };
}

describe('一次性回合', () => {
  it('走 sessionController（保住 preset 工具面），打印终稿并退出 0', async () => {
    const { host, outcome, stdout, stderr } = await runScripted({
      finish: (fake, sessionId) => {
        fake.append(sessionId, { type: 'turn/start', data: { turn: 0 } });
        fake.append(sessionId, { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '今天是 2026-11-09。' }] } } });
        fake.append(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
      }
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(stdout.trim(), '今天是 2026-11-09。');
    assert.match(stderr, /一次性回合（session session-1）/u);
    assert.equal(host.cancels.length, 0);
    assert.equal(host.creates.length, 1);
    assert.equal(host.prompts[0].content[0].text, '报一下时间');
    assert.match(host.prompts[0].requestId, /^once-/u);
  });

  it('多步文本按步拼接，重试只覆盖同一步', async () => {
    const { stdout } = await runScripted({
      finish: (fake, sessionId) => {
        fake.append(sessionId, { type: 'turn/start', data: { turn: 0 } });
        fake.append(sessionId, { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '先看文件' }] } } });
        fake.append(sessionId, { type: 'assistant/message', data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: '结论' }] } } });
        fake.append(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
      }
    });
    assert.equal(stdout.trim(), '先看文件\n\n结论');
  });

  it('失败回合打印错误码并以 1 退出', async () => {
    const { outcome, stderr } = await runScripted({
      finish: (fake, sessionId) => {
        fake.append(sessionId, { type: 'turn/start', data: { turn: 0 } });
        fake.append(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '限速' } } } });
      }
    });
    assert.equal(outcome.exitCode, 1);
    assert.match(stderr, /RATE_LIMIT: 限速/u);
  });

  it('超时会请求中断并以 124 退出，而不是挂死', async () => {
    const { host, outcome, stderr } = await runScripted({ finish: () => {}, timeoutMs: 30 });
    assert.equal(outcome.exitCode, 124);
    assert.equal(outcome.timedOut, true);
    assert.equal(host.cancels.length, 1);
    assert.match(stderr, /没有结束，已请求中断/u);
  });

  it('prompt 被拒绝时不吞异常', async () => {
    const host = createStartupHost({ dshHome: mkdtempSync(join(tmpdir(), 'once-')) });
    host.ctx.get('sessionController').prompt = async () => {
      throw new Error('session/agent-busy');
    };
    await assert.rejects(async () => await runOnce({ ctx: host.ctx, task: 'x', timeoutMs: 100, stdout: capture(), stderr: capture() }), /agent-busy/u);
  });
});

describe('foldLastTurn', () => {
  it('只取最后一轮，多步之间空行分隔', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 0 } },
        { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '旧回合' }] } } },
        { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'A' }, { type: 'tool-call' }] } } },
        { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'B' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
      ]
    };
    assert.deepEqual(foldLastTurn(session), { text: 'A\n\nB', reason: { kind: 'completed' } });
  });

  it('没有 turn/start 时返回空文本', () => {
    assert.deepEqual(foldLastTurn({ snapshotEvents: () => [] }), { text: '' });
  });
});
