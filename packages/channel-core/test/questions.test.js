import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inboundEvent, startCore } from './support/core.js';
import { eventually, settle } from './support/wait.js';

/**
 * 先把通道与会话绑定，再发起提问（与真实顺序一致：只有本通道会话的问题才被认领）。
 * @param {Awaited<ReturnType<typeof startCore>>} core
 * @returns {Promise<string>}
 */
async function bindSession(core) {
  await core.host.ingest(inboundEvent({ rawId: `bind-${Date.now()}`, text: '先建立会话' }));
  return /** @type {string} */ (core.fake.prompts.at(-1).sessionId);
}

/**
 * @param {string} sessionId
 * @param {{ questions: any[], callId?: string, signal?: AbortSignal, timed?: boolean }} options
 */
function requestFor(sessionId, { questions, callId = 'call-1', signal, timed = true }) {
  return {
    agent: { id: sessionId, session: { id: sessionId } },
    questions,
    wait: timed ? { callId, timed: true } : undefined,
    signal
  };
}

const simpleQuestions = [{ id: 'q1', question: '要发布吗？', options: [{ label: '发布' }, { label: '取消' }] }];

describe('提问应答', () => {
  it('只认领本通道会话的提问，其余交还下一个应答方', async () => {
    const core = await startCore();
    // 再注册一个更靠后的应答方：没有认领时应当轮到它
    core.fake.ctx.on('user-questions/request', async () => 'fallback');
    const result = await core.fake.dispatchWaterfall('user-questions/request', requestFor('session-unknown', { questions: simpleQuestions }));
    assert.equal(result, 'fallback');
    assert.equal(core.adapter.outbox.length, 0);
    await core.fake.dispose();
  });

  it('提问渲染成带按钮的消息；纯文字即答案', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions: simpleQuestions }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0), { label: 'question message' });
    const questionMessage = core.adapter.outbox.find((entry) => entry.buttons?.length > 0);
    assert.match(questionMessage.text, /要发布吗？/u);
    assert.deepEqual(questionMessage.buttons.map((row) => row[0].label), ['发布', '取消']);

    await core.host.ingest(inboundEvent({ rawId: 'a-1', text: '先别发布，等我看一下' }));
    const answers = await pending;
    assert.deepEqual(answers, { answers: [{ id: 'q1', selected: [], custom: '先别发布，等我看一下' }] });
    assert.equal(core.fake.prompts.filter((prompt) => prompt.requestId === 'telegram:a-1').length, 0, '回答不应再进入模型');
    await core.fake.dispose();
  });

  it('单选用按钮作答后回执并结算，按钮随之消失', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions: simpleQuestions }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0));
    const message = core.adapter.outbox.find((entry) => entry.buttons?.length > 0);
    const data = message.buttons[0][0].data;

    await core.host.ingest(inboundEvent({ rawId: 'b-1', kind: 'callback', text: '', callback: { id: 'cb-1', data } }));
    const answers = await pending;
    assert.deepEqual(answers, { answers: [{ id: 'q1', selected: ['发布'] }] });
    assert.ok(core.adapter.acks.includes('cb-1:已记录'));
    const finalEdit = core.adapter.outbox.at(-1);
    assert.equal(finalEdit?.buttons, undefined, '结算后的编辑不应再带按钮');
    assert.match(finalEdit?.text ?? '', /已选择：发布/u);
    await core.fake.dispose();
  });

  it('多选：点击切换选中态，提交后一次交回全部选项', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const questions = [{
      id: 'q1',
      question: '要包含哪些内容？',
      multiSelect: true,
      options: [{ label: '日志' }, { label: '配置' }]
    }];
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0));
    const message = core.adapter.outbox.find((entry) => entry.buttons?.length > 0);
    const [logButton, configButton, submitButton] = message.buttons.map((row) => row[0]);

    await core.host.ingest(inboundEvent({ rawId: 'c-1', kind: 'callback', text: '', callback: { id: 'cb-2', data: logButton.data } }));
    await core.host.ingest(inboundEvent({ rawId: 'c-2', kind: 'callback', text: '', callback: { id: 'cb-3', data: configButton.data } }));
    await eventually(() => core.adapter.outbox.some((entry) => {
      const labels = (entry.buttons ?? []).flat().map((button) => button.label);
      return labels.includes('✅ 日志') && labels.includes('✅ 配置');
    }), { label: 'toggled buttons' });
    assert.ok(core.adapter.outbox.some((entry) => (entry.text ?? '').includes('已选：日志、配置')), '选中态也要在正文里可见');
    await core.host.ingest(inboundEvent({ rawId: 'c-3', kind: 'callback', text: '', callback: { id: 'cb-4', data: submitButton.data } }));
    const answers = await pending;
    assert.deepEqual(answers, { answers: [{ id: 'q1', selected: ['日志', '配置'] }] });
    await core.fake.dispose();
  });

  it('超时不是错误：Host 侧收到 ASK_TIMED_OUT，记录降级为 expired 并可迟到补答', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const controller = new AbortController();
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions: [{ ...simpleQuestions[0], }], signal: controller.signal }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0));
    controller.abort();
    await assert.rejects(pending, (error) => {
      assert.equal(/** @type {any} */ (error).name, 'UserQuestionError');
      assert.equal(/** @type {any} */ (error).code, 'ASK_TIMED_OUT');
      return true;
    });
    await eventually(() => core.adapter.outbox.some((entry) => (entry.text ?? '').includes('已超时')), { label: 'timeout notice' });

    await core.host.ingest(inboundEvent({ rawId: 'd-1', text: '还是发布吧' }));
    assert.equal(core.fake.questionAnswers.length, 1);
    assert.equal(core.fake.questionAnswers[0].callId, 'call-1');
    assert.deepEqual(core.fake.questionAnswers[0].batch, { answers: [{ id: 'q1', selected: [], custom: '还是发布吧' }] });
    assert.match(core.adapter.lastText(), /已把回答补进原会话/u);
    await core.fake.dispose();
  });

  it('迟到的按钮点击同样走补答路径', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const controller = new AbortController();
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions: simpleQuestions, callId: 'call-2', signal: controller.signal }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0));
    const message = core.adapter.outbox.find((entry) => entry.buttons?.length > 0);
    const data = message.buttons[1][0].data;
    controller.abort();
    await assert.rejects(pending);
    await settle();
    await core.host.ingest(inboundEvent({ rawId: 'e-1', kind: 'callback', text: '', callback: { id: 'cb-9', data } }));
    assert.equal(core.fake.questionAnswers.length, 1);
    assert.deepEqual(core.fake.questionAnswers[0].batch, { answers: [{ id: 'q1', selected: ['取消'] }] });
    await core.fake.dispose();
  });

  it('/skip 以"用户跳过"正常结算，而不是让回合报错', async () => {
    const core = await startCore();
    const sessionId = await bindSession(core);
    const pending = core.fake.dispatchWaterfall('user-questions/request', requestFor(sessionId, { questions: simpleQuestions }));
    await eventually(() => core.adapter.outbox.some((entry) => entry.buttons?.length > 0));
    const result = await core.host.ingest(inboundEvent({ rawId: 'f-1', text: '/skip' }));
    assert.equal(result.status, 'command');
    const answers = await pending;
    assert.deepEqual(answers, { answers: [{ id: 'q1', selected: [], custom: '（用户跳过该提问）' }] });
    assert.match(core.adapter.lastText(), /已跳过/u);
    await core.fake.dispose();
  });
});