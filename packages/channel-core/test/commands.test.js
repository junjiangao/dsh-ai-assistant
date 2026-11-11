import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCommand } from '../src/commands.js';
import { inboundEvent, startCore } from './support/core.js';
import { eventually } from './support/wait.js';

/**
 * 建立"chat → 会话"的绑定，并让该回合正常结束（命令面要求没有在途回合）。
 * @param {Awaited<ReturnType<typeof startCore>>} core
 * @returns {Promise<string>}
 */
async function bindAndFinish(core) {
  await core.host.ingest(inboundEvent({ rawId: `bind-${Date.now()}`, text: '建立会话' }));
  const sessionId = /** @type {string} */ (core.fake.prompts.at(-1).sessionId);
  core.fake.appendSessionEvent(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
  await eventually(() => core.core.inFlightCount() === 0, { label: 'turn finished' });
  return sessionId;
}

/**
 * 保证每个用例都释放锁、心跳与定时器。
 * @param {(core: Awaited<ReturnType<typeof startCore>>) => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withCore(body) {
  const core = await startCore();
  try {
    await body(core);
  } finally {
    await core.fake.dispose();
  }
}

describe('命令面', () => {
  it('parse 只认已实现的命令，其余交回模型', () => {
    assert.deepEqual(parseCommand('/status'), { name: 'status', args: '' });
    assert.deepEqual(parseCommand('  /new standard  '), { name: 'new', args: 'standard' });
    assert.equal(parseCommand('/unknown'), undefined);
    assert.equal(parseCommand('普通消息 /status'), undefined);
    assert.equal(parseCommand(''), undefined);
  });

  it('/help 列出全部命令', async () => {
    await withCore(async (core) => {
      await core.host.ingest(inboundEvent({ rawId: 'h-1', text: '/help' }));
      const text = core.adapter.lastText();
      for (const command of ['/status', '/new', '/preset', '/stop', '/skip', '/help']) {
        assert.ok(text.includes(command), `help 缺少 ${command}`);
      }
    });
  });

  it('/new 新建会话并改写路由', async () => {
    await withCore(async (core) => {
      const oldSession = await bindAndFinish(core);
      const result = await core.host.ingest(inboundEvent({ rawId: 'n-1', text: '/new' }));
      assert.equal(result.status, 'command');
      assert.equal(core.fake.creates.length, 2);
      const routes = JSON.parse(readFileSync(join(core.fake.home, 'channels', 'telegram', 'routes.json'), 'utf8'));
      const bound = routes.routes['telegram:default:42:'].sessionId;
      assert.notEqual(bound, oldSession);
      assert.match(core.adapter.lastText(), new RegExp(bound, 'u'));
    });
  });

  it('/new <预设> 把预设传给会话创建', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'n-2', text: '/new minimal' }));
      assert.equal(core.fake.creates.at(-1)?.agentPreset, 'minimal');
    });
  });

  it('/new 遇到不存在的预设时明确报错且不改路由', async () => {
    await withCore(async (core) => {
      const sessionId = await bindAndFinish(core);
      const missing = new Error('Unknown agent preset');
      /** @type {any} */ (missing).code = 'agent-preset/not-found';
      core.fake.failNextCreate(missing);
      await core.host.ingest(inboundEvent({ rawId: 'n-3', text: '/new nope' }));
      assert.match(core.adapter.lastText(), /没有这个预设：nope/u);
      const routes = JSON.parse(readFileSync(join(core.fake.home, 'channels', 'telegram', 'routes.json'), 'utf8'));
      assert.equal(routes.routes['telegram:default:42:'].sessionId, sessionId);
    });
  });

  it('/preset 在首轮前切换成功', async () => {
    await withCore(async (core) => {
      const sessionId = await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'p-1', text: '/preset ptc' }));
      assert.deepEqual(core.fake.presetSelections, [{ sessionId, preset: 'ptc' }]);
      assert.match(core.adapter.lastText(), /已切换到预设 ptc/u);
    });
  });

  it('/preset 在首轮之后给出 /new 的替代路径', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      core.fake.setPresetOutcome('locked');
      await core.host.ingest(inboundEvent({ rawId: 'p-2', text: '/preset ptc' }));
      assert.match(core.adapter.lastText(), /不能再换预设/u);
      assert.match(core.adapter.lastText(), /\/new ptc/u);
    });
  });

  it('/preset 遇到不存在的预设时明确报错', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      core.fake.setPresetOutcome('not-found');
      await core.host.ingest(inboundEvent({ rawId: 'p-3', text: '/preset nope' }));
      assert.match(core.adapter.lastText(), /没有这个预设：nope/u);
    });
  });

  it('/stop 请求中断并清除在途标记', async () => {
    await withCore(async (core) => {
      const sessionId = await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 's-1', text: '/stop' }));
      assert.deepEqual(core.fake.cancels, [{ sessionId }]);
      assert.equal(core.core.inFlightCount(), 0);
      assert.match(core.adapter.lastText(), /已请求中断/u);
    });
  });

  it('/status 在有 schedule 服务时报告任务数', async () => {
    await withCore(async (core) => {
      core.fake.services.set('schedule', { list: async () => ({ items: [{ id: 'a' }, { id: 'b' }] }) });
      const status = await core.core.status();
      assert.equal(status.定时任务, '2');
    });
  });

  it('命令回执不进入模型上下文，且被审计', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      const promptsBefore = core.fake.prompts.length;
      await core.host.ingest(inboundEvent({ rawId: 'audit-1', text: '/help' }));
      assert.equal(core.fake.prompts.length, promptsBefore);
      const audit = readFileSync(join(core.fake.home, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      assert.match(audit, /"kind":"command".*"name":"help"/u);
    });
  });

  it('群里的 /命令@BotName 与普通命令等价', () => {
    assert.deepEqual(parseCommand('/new@example_bot standard'), { name: 'new', args: 'standard' });
    assert.deepEqual(parseCommand('/status@example_bot'), { name: 'status', args: '' });
    assert.equal(parseCommand('/new@'), undefined);
    assert.equal(parseCommand('/a@b.c'), undefined);
  });

  it('/help 覆盖全部注册命令', async () => {
    await withCore(async (core) => {
      await core.host.ingest(inboundEvent({ rawId: 'h-2', text: '/help' }));
      const text = core.adapter.lastText();
      for (const command of ['/whoami', '/sessions', '/resume', '/model', '/compact', '/goal']) {
        assert.ok(text.includes(command), `help 缺少 ${command}`);
      }
    });
  });

  it('/whoami 报告聊天、话题、用户与会话', async () => {
    await withCore(async (core) => {
      await core.host.ingest(inboundEvent({
        rawId: 'w-0',
        text: '建立话题会话',
        chatId: '-100123',
        threadId: '12',
        chatType: 'supergroup',
        isForum: true
      }));
      const sessionId = /** @type {string} */ (core.fake.prompts.at(-1)?.sessionId);
      core.fake.appendSessionEvent(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
      await eventually(() => core.core.inFlightCount() === 0, { label: 'turn finished' });
      await core.host.ingest(inboundEvent({
        rawId: 'w-1',
        text: '/whoami',
        chatId: '-100123',
        threadId: '12',
        chatType: 'supergroup',
        isForum: true
      }));
      const text = core.adapter.lastText();
      assert.match(text, /聊天：-100123（supergroup，forum）/u);
      assert.match(text, /话题：12/u);
      assert.match(text, /用户：7/u);
      assert.match(text, /会话：/u);
      assert.ok(text.includes(sessionId), 'whoami 应带上当前会话 id');
    });
  });

  it('/sessions 列出会话并标记当前', async () => {
    await withCore(async (core) => {
      const first = await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'sn-1', text: '/new' }));
      const second = /** @type {string} */ (core.fake.prompts.at(-1)?.sessionId ?? '');
      await core.host.ingest(inboundEvent({ rawId: 'sn-2', text: '/sessions' }));
      const text = core.adapter.lastText();
      assert.ok(text.includes(first), '应列出旧会话');
      assert.ok(second === '' || text.includes(second));
      assert.match(text, /当前/u);
    });
  });

  it('/resume 把路由接回指定会话', async () => {
    await withCore(async (core) => {
      const first = await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'r-1', text: '/new' }));
      await core.host.ingest(inboundEvent({ rawId: 'r-2', text: `/resume ${first}` }));
      assert.match(core.adapter.lastText(), new RegExp(`已接回会话 ${first}`, 'u'));
      await core.host.ingest(inboundEvent({ rawId: 'r-3', text: '继续' }));
      assert.equal(core.fake.prompts.at(-1)?.sessionId, first);
    });
  });

  it('/model 展示当前与可用模型，带参数时切换并记录', async () => {
    await withCore(async (core) => {
      const sessionId = await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'm-1', text: '/model' }));
      assert.match(core.adapter.lastText(), /部署默认：provider-a\/model-a/u);
      assert.match(core.adapter.lastText(), /可用模型：/u);

      await core.host.ingest(inboundEvent({ rawId: 'm-2', text: '/model provider-a/model-b high' }));
      assert.deepEqual(core.fake.modelSelections, [{ sessionId, provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' }]);
      assert.match(core.adapter.lastText(), /已切换：provider-a\/model-b（effort high）/u);

      await core.host.ingest(inboundEvent({ rawId: 'm-3', text: '/model provider-a/missing' }));
      assert.match(core.adapter.lastText(), /模型不可用/u);
    });
  });

  it('/compact 与 /goal 转发给 DSH 命令服务', async () => {
    await withCore(async (core) => {
      const sessionId = await bindAndFinish(core);
      /** @type {Array<{ agentId: string, line: string }>} */
      const calls = [];
      core.fake.services.set('commands', {
        find: () => ({ name: 'compact' }),
        execute: async (/** @type {any} */ agent, /** @type {string} */ line) => {
          calls.push({ agentId: agent.id, line });
          return { commandId: 'c1', result: { kind: 'success', text: 'Compacted 3 history items.' } };
        }
      });
      await core.host.ingest(inboundEvent({ rawId: 'c-1', text: '/compact' }));
      assert.deepEqual(calls, [{ agentId: sessionId, line: '/compact' }]);
      assert.match(core.adapter.lastText(), /Compacted 3 history items/u);

      await core.host.ingest(inboundEvent({ rawId: 'c-2', text: '/goal 排查磁盘占用' }));
      assert.deepEqual(calls.at(-1), { agentId: sessionId, line: '/goal 排查磁盘占用' });
    });
  });

  it('/compact 在预设未启用该命令时明确说明', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      core.fake.services.set('commands', { find: () => undefined, execute: async () => undefined });
      await core.host.ingest(inboundEvent({ rawId: 'c-3', text: '/compact' }));
      assert.match(core.adapter.lastText(), /当前会话没有 \/compact/u);
    });
  });

  it('命令处理器抛错只回一条错误消息，不把事件判成投递失败', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      core.fake.services.set('commands', {
        find: () => ({ name: 'compact' }),
        execute: async () => {
          throw new Error('boom');
        }
      });
      const result = await core.host.ingest(inboundEvent({ rawId: 'c-4', text: '/compact' }));
      assert.equal(result.status, 'command');
      assert.match(core.adapter.lastText(), /执行失败：boom/u);
    });
  });

  it('/preset 不带参数时列出可用预设', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'p-4', text: '/preset' }));
      const text = core.adapter.lastText();
      assert.match(text, /standard（默认）/u);
      assert.match(text, /minimal/u);
    });
  });

  it('botCommands 与 /help 同源', async () => {
    await withCore(async (core) => {
      const list = core.core.botCommands();
      assert.ok(list.some((command) => command.name === 'new'));
      for (const command of list) {
        assert.ok(command.description.length >= 3, `${command.name} 的描述太短`);
      }
    });
  });

  it('/new 不带参数时沿用当前路由的预设', async () => {
    await withCore(async (core) => {
      await bindAndFinish(core);
      await core.host.ingest(inboundEvent({ rawId: 'n-4', text: '/new minimal' }));
      await core.host.ingest(inboundEvent({ rawId: 'n-5', text: '/new' }));
      assert.equal(core.fake.creates.at(-1)?.agentPreset, 'minimal');
    });
  });
});
describe('话题角色', () => {
  /**
   * @param {Awaited<ReturnType<typeof startCore>>} core
   * @returns {Promise<string>}
   */
  async function finishTurn(core) {
    const sessionId = /** @type {string} */ (core.fake.prompts.at(-1)?.sessionId);
    core.fake.appendSessionEvent(sessionId, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
    await eventually(() => core.core.inFlightCount() === 0, { label: 'turn finished' });
    return sessionId;
  }

  it('topic 规则决定新会话的预设与目录，话题名只写进首条消息', async () => {
    await withCore(async (core) => {
      await core.host.ingest(inboundEvent({
        rawId: 'tr-1',
        text: '开始',
        chatId: '-100',
        threadId: '2',
        chatType: 'supergroup',
        isForum: true,
        topic: { name: 'ops', preset: 'minimal', cwd: '/tmp/ops' }
      }));
      assert.deepEqual(core.fake.creates.at(-1), { agentPreset: 'minimal', cwd: '/tmp/ops' });
      const first = /** @type {any} */ (core.fake.prompts.at(-1));
      assert.match(first.content[0].text, /^（当前话题：ops）/u);

      const routes = JSON.parse(readFileSync(join(core.fake.home, 'channels', 'telegram', 'routes.json'), 'utf8'));
      assert.equal(routes.routes['telegram:default:-100:2'].cwd, '/tmp/ops');
      assert.equal(routes.routes['telegram:default:-100:2'].topic, 'ops');
      assert.equal(routes.routes['telegram:default:-100:2'].agentPreset, 'minimal');

      await finishTurn(core);
      await core.host.ingest(inboundEvent({
        rawId: 'tr-2',
        text: '继续',
        chatId: '-100',
        threadId: '2',
        topic: { name: 'ops' }
      }));
      const second = /** @type {any} */ (core.fake.prompts.at(-1));
      assert.doesNotMatch(second.content[0].text, /当前话题/u, '话题名只应出现在建会话那一回合');
    });
  });

  it('topic 里的 preset 不存在时回退默认并留审计', async () => {
    await withCore(async (core) => {
      const missing = new Error('Unknown agent preset');
      /** @type {any} */ (missing).code = 'agent-preset/not-found';
      core.fake.failNextCreate(missing);
      const result = await core.host.ingest(inboundEvent({
        rawId: 'tr-3',
        text: '开始',
        chatId: '-100',
        threadId: '3',
        topic: { name: '坏角色', preset: 'nope' }
      }));
      assert.equal(result.status, 'accepted');
      assert.equal(core.fake.creates.length, 2, '应先按 topic 建一次，失败后回退');
      assert.equal(core.fake.creates.at(-1)?.agentPreset, undefined);
      const audit = readFileSync(join(core.fake.home, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      assert.match(audit, /topic-role-fallback/u);
    });
  });

  it('改了话题配置后，老话题的 /new 采用新 preset/cwd', async () => {
    await withCore(async (core) => {
      // 先在没有 topic 规则时建立路由（模拟配置生效前就存在的会话）。
      await core.host.ingest(inboundEvent({ rawId: 'tc-1', text: '开始', chatId: '-100', threadId: '2' }));
      await finishTurn(core);
      // 重启后 settings 生效：消息带 topic 规则，/new 应采纳它而不是旧绑定。
      await core.host.ingest(inboundEvent({
        rawId: 'tc-2',
        text: '/new',
        chatId: '-100',
        threadId: '2',
        topic: { name: 'ops', preset: 'minimal', cwd: '/tmp/ops' }
      }));
      assert.deepEqual(core.fake.creates.at(-1), { agentPreset: 'minimal', cwd: '/tmp/ops' });
      const routes = JSON.parse(readFileSync(join(core.fake.home, 'channels', 'telegram', 'routes.json'), 'utf8'));
      assert.equal(routes.routes['telegram:default:-100:2'].cwd, '/tmp/ops');
      assert.equal(routes.routes['telegram:default:-100:2'].topic, 'ops');
    });
  });

  it('/whoami 输出绝对路径（供直接粘贴到配置）', async () => {
    await withCore(async (core) => {
      const home = homedir();
      await core.host.ingest(inboundEvent({
        rawId: 'h-9',
        text: '开始',
        chatId: '-100',
        threadId: '5',
        topic: { name: 'secret', cwd: `${home}/ops` }
      }));
      await finishTurn(core);
      await core.host.ingest(inboundEvent({ rawId: 'h-10', text: '/whoami', chatId: '-100', threadId: '5' }));
      const text = core.adapter.lastText();
      assert.ok(text.includes(`目录：${home}/ops`), '应显示绝对路径');
      assert.ok(!text.includes('目录：~/ops'), '不应再缩成 ~');
    });
  });

  it('/new 沿用话题的预设与目录，/whoami 显示话题名', async () => {
    await withCore(async (core) => {
      await core.host.ingest(inboundEvent({
        rawId: 'tr-4',
        text: '开始',
        chatId: '-100',
        threadId: '2',
        topic: { name: 'ops', preset: 'minimal', cwd: '/tmp/ops' }
      }));
      await finishTurn(core);
      await core.host.ingest(inboundEvent({ rawId: 'tr-5', text: '/new', chatId: '-100', threadId: '2' }));
      assert.deepEqual(core.fake.creates.at(-1), { agentPreset: 'minimal', cwd: '/tmp/ops' });
      await core.host.ingest(inboundEvent({ rawId: 'tr-6', text: '/whoami', chatId: '-100', threadId: '2' }));
      assert.match(core.adapter.lastText(), /话题：2（ops）/u);
      assert.match(core.adapter.lastText(), /目录：\/tmp\/ops/u);
    });
  });
});