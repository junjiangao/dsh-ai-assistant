import { decodeCallback, encodeCallback } from './callback.js';
import { shortId } from './util.js';

/**
 * @typedef {object} RenderableQuestion
 * @property {string} id
 * @property {string} question
 * @property {string} [detail]
 * @property {string} [header]
 * @property {{ label: string, description?: string }[]} [options]
 * @property {boolean} [multiSelect]
 * @property {{ kind: string, approve: string, reject?: string, always?: string }} [intent]
 */

/**
 * @typedef {object} Answer
 * @property {string} id
 * @property {string[]} selected
 * @property {string} [custom]
 */

/**
 * 提问应答编排（设计文档 §7.4）。
 *
 * 三条边界：
 * 1. **只认领本通道会话发起的提问**：没有路由绑定的提问一律 `next()`，否则会抢走别的界面（例如浏览器）的提问。
 * 2. **超时不等于失败**：`tool-ask-user` 配成 timed/600 后，超时返回 `{pending:true}`，模型继续；我们保留 callId 供迟到补答。
 * 3. **迟到补答走 `ctx.userQuestions.answer`**：那条路径会把答案作为 `user-question-reply` 消息 steer 进原会话。
 *
 * 状态机：`open → answered | expired | skipped`；只有 `expired` 且带 callId 的记录还能补答。
 *
 * @param {object} deps
 * @param {import('./config.js').CoreConfig} deps.config
 * @param {import('./util.js').Clock} deps.clock
 * @param {{ debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} deps.logger
 * @param {import('./audit.js').AuditLog} deps.audit
 * @param {(sessionId: string) => RouteResolution | undefined} deps.resolveRoute
 * @param {(channel: string) => import('./protocol.js').ChannelAdapter | undefined} deps.adapterFor
 * @param {() => { answer: (agent: any, callId: string, batch: { answers: Answer[] }) => boolean } | undefined} deps.userQuestions
 * @param {{ resolveAgent: (sessionId: string) => Promise<{ agent?: any, error?: any }> }} deps.sessionController
 * @param {(chat: { channel: string, chatId: string, threadId?: string }, text: string, options?: { throws?: boolean, buttons?: import('./protocol.js').Button[][] }) => Promise<{ messageId?: string }>} deps.sendDirect
 */
export function createQuestions({ config, clock, logger, audit, resolveRoute, adapterFor, userQuestions, sessionController, sendDirect }) {
  /** @type {Map<string, ActiveQuestion>} */
  const active = new Map();

  /**
   * `user-questions/request` waterfall 处理器。
   * @param {any} request
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async function handleRequest(request, next) {
    const agent = request?.agent;
    const sessionId = agent?.id ?? agent?.session?.id;
    if (typeof sessionId !== 'string') return await next();
    const resolved = resolveRoute(sessionId);
    if (resolved === undefined) return await next();

    const questions = normalizeQuestions(request.questions);
    if (questions.length === 0) return await next();
    const callId = typeof request.wait?.callId === 'string' ? request.wait.callId : undefined;
    const timed = request.wait?.timed === true;
    /** @type {import('./stores.js').PendingQuestion} */
    const record = {
      id: callId ?? shortId('q-'),
      routeKey: resolved.routeKey,
      sessionId,
      agentId: sessionId,
      shortId: shortId('').slice(0, 8),
      ...(callId === undefined ? {} : { callId }),
      timed,
      channel: resolved.route.channel,
      account: resolved.route.account,
      chatId: resolved.route.chatId,
      ...(resolved.route.threadId === undefined ? {} : { threadId: resolved.route.threadId }),
      questions,
      selected: {},
      state: 'open',
      createdAt: clock.now(),
      updatedAt: clock.now()
    };

    const chat = chatOf(record);
    const rendered = renderQuestions(record);
    const sent = await sendDirect(chat, rendered.text, { buttons: rendered.buttons });
    if (sent.messageId === undefined) {
      logger.warn(`channel-core: 提问消息未能投递（${record.routeKey}），交还给下一个应答方`);
      return await next();
    }
    record.messageId = sent.messageId;
    await resolved.stores.approvals.put(record);
    audit.record('question-asked', {
      channel: record.channel,
      chatId: record.chatId,
      sessionId,
      recordId: record.id,
      timed,
      callId,
      questions: questions.length
    });

    const run = createPendingRun();
    active.set(record.id, { run, timer: undefined });
    const expire = () => {
      const entry = active.get(record.id);
      if (entry === undefined || entry.run.settled) return;
      void markExpired(record, resolved.stores, entry);
    };
    const onAbort = () => expire();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    // 兜底：即便 Host 的计时器不触发（阻塞模式），我们也不会永远挂着。
    const timer = setTimeout(expire, config.questionTimeoutMs);
    timer.unref?.();
    const entry = active.get(record.id);
    if (entry !== undefined) entry.timer = timer;

    try {
      const answers = await run.promise;
      return { answers };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      active.delete(record.id);
    }
  }

  /**
   * @param {import('./stores.js').PendingQuestion} record
   * @param {import('./stores.js').ChannelStores} stores
   * @param {{ run: PendingRun }} entry
   * @returns {Promise<void>}
   */
  async function markExpired(record, stores, entry) {
    record.state = 'expired';
    record.updatedAt = clock.now();
    await stores.approvals.settle(record.id, { state: 'expired', updatedAt: record.updatedAt });
    const note = record.callId === undefined
      ? '⌛ 这个问题已超时，且无法补答；请直接发新指令。'
      : '⌛ 已超时（模型继续执行）。之后回复文字或点按钮仍可补答到原会话。';
    await editQuestionMessage(record, note);
    if (!entry.run.settled) entry.run.reject(userQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT'));
    audit.record('question-expired', {
      channel: record.channel,
      chatId: record.chatId,
      recordId: record.id,
      callable: record.callId !== undefined
    });
  }

  /**
   * 入站文字/按钮即答案：先答仍在等待的，再考虑迟到补答。
   * @param {import('./protocol.js').InboundEvent} event
   * @param {RouteResolution} route
   * @returns {Promise<{ handled: boolean, detail?: string }>}
   */
  async function tryAnswer(event, route) {
    const pending = route.stores.approvals.pendingForRoute(route.routeKey);
    if (pending.length === 0) return { handled: false };
    const record = pending[0];
    if (record.state === 'expired') return await answerLate(event, record, route);
    return await answerOpenRecord(record, event, route);
  }

  /**
   * @param {import('./stores.js').PendingQuestion} record
   * @param {import('./protocol.js').InboundEvent} event
   * @param {RouteResolution} route
   * @returns {Promise<{ handled: boolean, detail?: string }>}
   */
  async function answerOpenRecord(record, event, route) {
    const activeEntry = active.get(record.id);
    if (activeEntry === undefined) {
      // 记录还标着 open，但进程已经重启过：等价于超时，走补答路径。
      record.state = 'expired';
      await route.stores.approvals.settle(record.id, { state: 'expired' });
      return await answerLate(event, record, route);
    }
    if (event.callback !== undefined) return await answerWithCallback(record, event.callback, route);
    const text = event.text.trim();
    if (text === '') return { handled: true, detail: 'empty' };
    if (record.questions.length !== 1) {
      await sendDirect(chatOf(record), '这个问题包含多个子问题，请用消息上的按钮逐个选择；或先发 /skip 跳过。');
      return { handled: true, detail: 'needs-buttons' };
    }
    const answers = record.questions.map((question) => ({ id: question.id, selected: [], custom: text }));
    await completeRecord(record, answers, route.stores, `✅ 已记录回答：${text}`);
    return { handled: true, detail: 'text-answer' };
  }

  /**
   * @param {import('./stores.js').PendingQuestion} record
   * @param {{ id: string, data: string }} callback
   * @param {RouteResolution} route
   * @returns {Promise<{ handled: boolean, detail?: string }>}
   */
  async function answerWithCallback(record, callback, route) {
    const adapter = adapterFor(record.channel);
    const decoded = decodeCallback(callback.data);
    if (decoded === undefined) {
      await adapter?.ackCallback?.(callback.id, '无法识别的按钮');
      return { handled: true, detail: 'bad-callback' };
    }
    if (decoded.recordShortId !== record.shortId) {
      await adapter?.ackCallback?.(callback.id, '这个按钮已过期');
      return { handled: true, detail: 'stale-callback' };
    }
    const question = record.questions[decoded.questionIndex];
    if (question === undefined) {
      await adapter?.ackCallback?.(callback.id, '这个按钮已过期');
      return { handled: true, detail: 'stale-callback' };
    }

    if (decoded.action === 's') {
      const answers = completedAnswers(record);
      if (answers.length !== record.questions.length) {
        await adapter?.ackCallback?.(callback.id, '还有问题没有选择');
        return { handled: true, detail: 'incomplete' };
      }
      await completeRecord(record, answers, route.stores, `✅ 已提交：${describeAnswers(answers)}`);
      await adapter?.ackCallback?.(callback.id, '已提交');
      return { handled: true, detail: 'submitted' };
    }

    const option = question.options?.[decoded.optionIndex];
    if (option === undefined) {
      await adapter?.ackCallback?.(callback.id, '这个选项已过期');
      return { handled: true, detail: 'stale-callback' };
    }
    if (question.multiSelect === true) {
      const current = record.selected?.[question.id] ?? [];
      const next = current.includes(option.label) ? current.filter((label) => label !== option.label) : [...current, option.label];
      record.selected = { ...record.selected, [question.id]: next };
      record.updatedAt = clock.now();
      await route.stores.approvals.put(record);
      await redrawQuestion(record);
      await adapter?.ackCallback?.(callback.id, next.includes(option.label) ? `已选：${option.label}` : `已取消：${option.label}`);
      return { handled: true, detail: 'toggled' };
    }

    if (record.questions.length !== 1) {
      await adapter?.ackCallback?.(callback.id, '请按顺序回答每个问题');
      return { handled: true, detail: 'incomplete' };
    }
    await completeRecord(record, [{ id: question.id, selected: [option.label] }], route.stores, `✅ 已选择：${option.label}`);
    await adapter?.ackCallback?.(callback.id, '已记录');
    return { handled: true, detail: 'answered' };
  }

  /**
   * 迟到补答：走 `ctx.userQuestions.answer`，把答案 steer 进原会话。
   * @param {import('./protocol.js').InboundEvent} event
   * @param {import('./stores.js').PendingQuestion} record
   * @param {RouteResolution} route
   * @returns {Promise<{ handled: boolean, detail?: string }>}
   */
  async function answerLate(event, record, route) {
    const chat = chatOf(record);
    if (record.callId === undefined) {
      await sendDirect(chat, '这个提问已结束且无法补答；请直接发新指令。');
      return { handled: true, detail: 'late-unavailable' };
    }
    const service = userQuestions();
    if (service === undefined) {
      await sendDirect(chat, '提问服务不可用，无法补答；请直接发新指令。');
      return { handled: true, detail: 'late-unavailable' };
    }
    /** @type {{ agent?: any, error?: any }} */
    const resolvedAgent = await sessionController.resolveAgent(record.sessionId).catch((/** @type {unknown} */ error) => ({ error }));
    if (resolvedAgent.agent === undefined) {
      await sendDirect(chat, '原会话已不可用，无法补答；请直接发新指令。');
      return { handled: true, detail: 'late-unavailable' };
    }

    const answers = lateAnswers(record, event);
    if (answers === undefined) {
      await sendDirect(chat, '请用消息上的按钮选择，或直接回复一段文字。');
      return { handled: true, detail: 'needs-buttons' };
    }
    if (event.callback !== undefined) await adapterFor(record.channel)?.ackCallback?.(event.callback.id, '已补答');
    try {
      const accepted = service.answer(resolvedAgent.agent, record.callId, { answers });
      if (!accepted) {
        await sendDirect(chat, '这个问题已不再等待回答；请直接发新指令。');
        return { handled: true, detail: 'late-unavailable' };
      }
      await route.stores.approvals.settle(record.id, { state: 'answered', answers, updatedAt: clock.now() });
      await editQuestionMessage(record, `✅ 已补答：${describeAnswers(answers)}`);
      await sendDirect(chat, '✅ 已把回答补进原会话。');
      audit.record('question-late-answer', { channel: record.channel, chatId: record.chatId, recordId: record.id, callId: record.callId });
      return { handled: true, detail: 'late-answered' };
    } catch (error) {
      const message = messageOf(error);
      await sendDirect(chat, `补答失败：${message}`);
      audit.record('question-late-failed', { channel: record.channel, chatId: record.chatId, recordId: record.id, error: message });
      return { handled: true, detail: 'late-failed' };
    }
  }

  /**
   * 结算一条在途提问：解析等待方，并把消息改成结果文本（同时去掉按钮）。
   * @param {import('./stores.js').PendingQuestion} record
   * @param {Answer[]} answers
   * @param {import('./stores.js').ChannelStores} stores
   * @param {string} summary
   * @returns {Promise<void>}
   */
  async function completeRecord(record, answers, stores, summary) {
    record.state = 'answered';
    record.updatedAt = clock.now();
    await stores.approvals.settle(record.id, { state: 'answered', answers, updatedAt: record.updatedAt });
    const entry = active.get(record.id);
    if (entry !== undefined) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.run.resolve(answers);
    }
    await editQuestionMessage(record, summary);
    audit.record('question-answered', { channel: record.channel, chatId: record.chatId, recordId: record.id, summary });
  }

  /**
   * 多选时只刷新按钮状态，不结算。
   * @param {import('./stores.js').PendingQuestion} record
   * @returns {Promise<void>}
   */
  async function redrawQuestion(record) {
    const adapter = adapterFor(record.channel);
    if (adapter === undefined || record.messageId === undefined) return;
    const rendered = renderQuestions(record);
    try {
      await adapter.edit(chatOf(record), record.messageId, rendered.text, { buttons: rendered.buttons });
    } catch (error) {
      logger.warn(`channel-core: 刷新选项失败：${messageOf(error)}`);
    }
  }

  /**
   * `/skip`：在途提问以显式"已跳过"结算；模型拿到的是正常答案而不是异常。
   * @param {string} routeKey
   * @param {import('./stores.js').ChannelStores} stores
   * @returns {Promise<number>}
   */
  async function skip(routeKey, stores) {
    let count = 0;
    for (const record of stores.approvals.pendingForRoute(routeKey)) {
      if (record.state === 'expired') continue;
      const answers = record.questions.map((question) => ({ id: question.id, selected: [], custom: '（用户跳过该提问）' }));
      record.state = 'skipped';
      record.updatedAt = clock.now();
      await stores.approvals.settle(record.id, { state: 'skipped' });
      const entry = active.get(record.id);
      if (entry !== undefined) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.run.resolve(answers);
      }
      await editQuestionMessage(record, '⏭️ 已跳过这个提问');
      count += 1;
    }
    return count;
  }

  /**
   * 进程启动时把上一次生命周期遗留的 open 记录降级为 expired：
   * 那些提问的等待方已经随进程消失，但带 callId 的仍可补答。
   * @param {import('./stores.js').ChannelStores} stores
   * @returns {Promise<number>}
   */
  async function expireStale(stores) {
    let count = 0;
    for (const record of stores.approvals.all()) {
      if (record.state !== 'open') continue;
      await stores.approvals.settle(record.id, { state: 'expired' });
      count += 1;
    }
    return count;
  }

  /** @returns {void} */
  function dispose() {
    for (const entry of active.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (!entry.run.settled) entry.run.reject(userQuestionError('channel-core 正在退出', 'ASK_ABORTED'));
    }
    active.clear();
  }

  /** @returns {number} */
  function activeCount() {
    return active.size;
  }

  /**
   * @param {import('./stores.js').PendingQuestion} record
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function editQuestionMessage(record, text) {
    const adapter = adapterFor(record.channel);
    if (adapter === undefined || record.messageId === undefined) return;
    try {
      await adapter.edit(chatOf(record), record.messageId, text, {});
    } catch (error) {
      logger.warn(`channel-core: 编辑提问消息失败：${messageOf(error)}`);
    }
  }

  return { handleRequest, tryAnswer, skip, expireStale, activeCount, dispose };
}

/**
 * @param {import('./stores.js').PendingQuestion} record
 * @param {import('./protocol.js').InboundEvent} event
 * @returns {Answer[] | undefined}
 */
function lateAnswers(record, event) {
  if (event.callback !== undefined) {
    const decoded = decodeCallback(event.callback.data);
    if (decoded === undefined) return undefined;
    const question = record.questions[decoded.questionIndex];
    const option = question?.options?.[decoded.optionIndex];
    if (question === undefined || option === undefined) return undefined;
    if (record.questions.length !== 1) return undefined;
    return [{ id: question.id, selected: [option.label] }];
  }
  const text = event.text.trim();
  if (text === '') return undefined;
  if (record.questions.length !== 1) return undefined;
  return record.questions.map((question) => ({ id: question.id, selected: [], custom: text }));
}

/**
 * 把宿主问题结构化成可渲染/可回答的形态；不认识的字段一律丢弃。
 * @param {any} questions
 * @returns {RenderableQuestion[]}
 */
export function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((question) => typeof question?.id === 'string' && typeof question?.question === 'string')
    .map((question) => ({
      id: question.id,
      question: question.question,
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(Array.isArray(question.options) ? {
        options: question.options
          .filter((/** @type {any} */ option) => typeof option?.label === 'string')
          .map((/** @type {any} */ option) => ({
            label: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {})
          }))
      } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(typeof question.intent?.kind === 'string' ? {
        intent: {
          kind: question.intent.kind,
          approve: String(question.intent.approve),
          ...(question.intent.reject === undefined ? {} : { reject: String(question.intent.reject) }),
          ...(question.intent.always === undefined ? {} : { always: String(question.intent.always) })
        }
      } : {})
    }))
    .filter((question) => question.id !== '' && question.question !== '');
}

/**
 * @param {import('./stores.js').PendingQuestion} record
 * @returns {{ text: string, buttons: import('./protocol.js').Button[][] }}
 */
export function renderQuestions(record) {
  const lines = [];
  /** @type {import('./protocol.js').Button[][]} */
  const buttons = [];
  record.questions.forEach((question, questionIndex) => {
    if (question.header !== undefined) lines.push(`【${question.header}】`);
    lines.push(`${questionIndex + 1}. ${question.question}`);
    if (question.detail !== undefined) lines.push(question.detail);
    if (question.multiSelect === true) {
      const chosen = record.selected?.[question.id] ?? [];
      lines.push(chosen.length === 0 ? '（可多选）' : `（已选：${chosen.join('、')}）`);
    }
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const chosen = (record.selected?.[question.id] ?? []).includes(option.label);
      buttons.push([{
        label: `${chosen ? '✅ ' : ''}${option.label}`,
        data: encodeCallback({ recordShortId: record.shortId, questionIndex, optionIndex, action: 'o' })
      }]);
      if (option.description !== undefined) lines.push(`- ${option.label}：${option.description}`);
    }
    if (question.multiSelect === true) {
      buttons.push([{ label: '提交选择', data: encodeCallback({ recordShortId: record.shortId, questionIndex, optionIndex: -1, action: 's' }) }]);
    }
  });
  lines.push('');
  lines.push(record.timed ? '（600 秒内没有回答会自动继续；之后回复文字仍可补答）' : '（回复文字也可以作为答案）');
  return { text: lines.join('\n'), buttons };
}

/**
 * @param {import('./stores.js').PendingQuestion} record
 * @returns {Answer[]}
 */
function completedAnswers(record) {
  /** @type {Answer[]} */
  const answers = [];
  for (const question of record.questions) {
    const selected = record.selected?.[question.id] ?? [];
    if (selected.length === 0) continue;
    answers.push({ id: question.id, selected });
  }
  return answers;
}

/**
 * @param {Answer[]} answers
 * @returns {string}
 */
function describeAnswers(answers) {
  return answers.map((answer) => `${answer.id}=${answer.selected.length > 0 ? answer.selected.join('、') : answer.custom ?? ''}`).join('；');
}

/**
 * 结构化地造一个 `UserQuestionError`：DSH 用 `name`+`code` 识别（`restoreUserQuestionError`），
 * 这样不必依赖它的类身份。
 * @param {string} message
 * @param {string} code
 * @returns {Error}
 */
export function userQuestionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  /** @type {any} */ (error).code = code;
  return error;
}

/**
 * @param {import('./stores.js').PendingQuestion} record
 * @returns {{ channel: string, chatId: string, threadId?: string }}
 */
function chatOf(record) {
  return { channel: record.channel, chatId: record.chatId, ...(record.threadId === undefined ? {} : { threadId: record.threadId }) };
}

/**
 * @typedef {object} ActiveQuestion
 * @property {PendingRun} run
 * @property {NodeJS.Timeout | undefined} timer
 */

/**
 * @typedef {object} PendingRun
 * @property {Promise<Answer[]>} promise
 * @property {(answers: Answer[]) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {boolean} settled
 */

/** @returns {PendingRun} */
function createPendingRun() {
  /** @type {PendingRun} */
  const run = {
    promise: /** @type {Promise<Answer[]>} */ (/** @type {unknown} */ (null)),
    resolve: () => {},
    reject: () => {},
    settled: false
  };
  run.promise = new Promise((resolve, reject) => {
    run.resolve = (answers) => {
      if (run.settled) return;
      run.settled = true;
      resolve(answers);
    };
    run.reject = (error) => {
      if (run.settled) return;
      run.settled = true;
      reject(error);
    };
  });
  return run;
}

/**
 * @typedef {object} RouteResolution
 * @property {string} routeKey
 * @property {{ channel: string, account: string, chatId: string, threadId?: string }} route
 * @property {import('./stores.js').RouteEntry} entry
 * @property {import('./stores.js').ChannelStores} stores
 */

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}