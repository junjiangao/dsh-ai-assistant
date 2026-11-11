import { hashText } from './util.js';

/** @typedef {import('./util.js').Clock} Clock */
/** @typedef {import('./stores.js').RouteEntry} RouteEntry */

/**
 * 出站编排（设计文档 §7.3）。
 *
 * 两件事：把回合中的文本增量**编辑进同一条消息**（≤1 次/秒），并在 `turn/end` 用
 * 持久日志里的终稿覆盖它；无人值守回合没有在途标记，因此另发一条新消息。
 *
 * 终稿唯一性由账本保证：`ledger.finalize` 对同一 (turn, hash) 是幂等的，
 * 重复的 `turn/end`（重投、恢复）不会产生第二条终稿。
 *
 * @param {object} deps
 * @param {import('./config.js').CoreConfig} deps.config
 * @param {Clock} deps.clock
 * @param {{ debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} deps.logger
 * @param {import('./audit.js').AuditLog} deps.audit
 * @param {import('./runtime.js').RuntimeState} deps.state
 * @param {import('./heartbeat.js').Heartbeat} deps.heartbeat
 * @param {import('./rate-limit.js').ChatPacer} deps.pacer
 * @param {(sessionId: string) => { routeKey: string, route: { channel: string, account: string, chatId: string, threadId?: string }, entry: RouteEntry, stores: import('./stores.js').ChannelStores } | undefined} deps.resolveRoute
 * @param {(channel: string) => import('./protocol.js').ChannelAdapter | undefined} deps.adapterFor
 * @param {() => Array<{ routeKey: string, route: { channel: string, account: string, chatId: string, threadId?: string }, entry: RouteEntry, stores: import('./stores.js').ChannelStores }>} deps.allRoutes
 */
export function createOutbound({ config, clock, logger, audit, state, heartbeat, pacer, resolveRoute, adapterFor, allRoutes }) {
  /**
   * 以 `(routeKey, turn)` 为键。同一路由可以同时有多个已受理的回合在投递：
   * 排队时后一条消息的 `turn/start` 会早于前一条的 `turn/end` 到达。每路由一个槽位会被后到的回合覆盖，
   * 前一个回合的账本条目就永远停在 open，重启时被误判成"中断"。
   * @type {Map<string, Delivery>}
   */
  const deliveries = new Map();

  /** @param {string} routeKeyValue @param {number} turn @returns {string} */
  function keyOf(routeKeyValue, turn) {
    return `${routeKeyValue}\u0000${turn}`;
  }

  /**
   * 事件对应的投递：事件里带 turn 就精确归位，否则退回最近一个未终稿的回合。
   * @param {string} routeKeyValue
   * @param {unknown} turn
   * @returns {Delivery | undefined}
   */
  function deliveryFor(routeKeyValue, turn) {
    if (typeof turn === 'number') {
      const exact = deliveries.get(keyOf(routeKeyValue, turn));
      if (exact !== undefined) return exact;
    }
    return latestOf(routeKeyValue);
  }

  /**
   * 已经报过"无路由丢弃"的 (session, turn)：一轮有很多事件，只留一条痕迹。
   * @type {Set<string>}
   */
  const droppedTurns = new Set();

  /**
   * 会话没有聊天绑定时的处置：**不投递**，但必须留痕。
   *
   * 这类会话通常来自 `schedule` 的 `new`/`new_once` 目标：宿主侧创建、路由表里没有它。
   * 早先这里直接 `return`，于是"消息蒸发"在审计、心跳、日志里都看不到
   * 定时会话可能没有聊天路由，记录后才能明确诊断未投递的输出。
   * @param {string} sessionId
   * @param {unknown} turn
   * @returns {void}
   */
  function noteDrop(sessionId, turn) {
    const key = `${sessionId}\u0000${typeof turn === 'number' ? turn : 'unknown'}`;
    if (droppedTurns.has(key)) return;
    // 无路由的会话可能是长期的定时会话，别让集合无界增长。
    if (droppedTurns.size >= 500) droppedTurns.clear();
    droppedTurns.add(key);
    state.noteDrop();
    audit.record('outbound-dropped', {
      sessionId,
      ...(typeof turn === 'number' ? { turn } : {}),
      reason: 'no-route'
    });
    logger.warn(`channel-core: 会话 ${sessionId} 没有聊天绑定，第 ${typeof turn === 'number' ? turn : '?'} 回合的输出没有投递`);
    heartbeat.update({ dropped: state.droppedCount });
  }

  /**
   * 最近一个未终稿的投递：流式帧没带 `turn` 时按它归位。
   * @param {string} routeKeyValue
   * @returns {Delivery | undefined}
   */
  function latestOf(routeKeyValue) {
    /** @type {Delivery | undefined} */
    let best;
    for (const delivery of deliveries.values()) {
      if (delivery.routeKey !== routeKeyValue || delivery.finalized) continue;
      if (best === undefined || delivery.turn > best.turn) best = delivery;
    }
    return best;
  }

  /**
   * @param {import('./protocol.js').ChatRef & { channel: string }} chat
   * @param {string} text
   * @param {{ buttons?: import('./protocol.js').Button[][], throws?: boolean }} [options]
   * @returns {Promise<{ messageId?: string }>}
   */
  async function sendDirect(chat, text, options = {}) {
    const adapter = adapterFor(chat.channel);
    if (adapter === undefined) {
      logger.warn(`channel-core: 通道 ${chat.channel} 未注册，出站被丢弃`);
      return {};
    }
    const chunks = splitForDelivery(text, config);
    const chatKey = chatKeyOf(chat);
    try {
      /** @type {{ messageId?: string }} */
      let last = {};
      for (const [index, chunk] of chunks.entries()) {
        const isLast = index === chunks.length - 1;
        // 按钮挂最后一条：长问题分条时，操作入口跟着结尾。
        const sendOptions = isLast && options.buttons !== undefined ? { buttons: options.buttons } : {};
        last = await pacer.run(chatKey, async () => await adapter.send(chat, chunkText(index, chunks.length, chunk), sendOptions));
      }
      return last;
    } catch (error) {
      state.recordError(error);
      logger.error(`channel-core: 发送失败（${chatKey}）：${messageOf(error)}`);
      if (options.throws === true) throw error;
      return {};
    }
  }

  /**
   * 回合开始：登记账本与本次投递的草稿状态。
   * @param {string} routeKey
   * @param {string} sessionId
   * @param {number} turn
   * @param {'user'|'unattended'} kind
   * @returns {Delivery | undefined}
   */
  function beginTurn(routeKey, sessionId, turn, kind) {
    const resolved = resolveRoute(sessionId);
    if (resolved === undefined) return undefined;
    const existing = deliveries.get(keyOf(routeKey, turn));
    if (existing !== undefined && !existing.finalized) return existing;
    /** @type {Delivery} */
    const delivery = {
      routeKey,
      sessionId,
      channel: resolved.route.channel,
      chatId: resolved.route.chatId,
      ...(resolved.route.threadId === undefined ? {} : { threadId: resolved.route.threadId }),
      ledgerId: '',
      ledgerReady: /** @type {Promise<{ id: string }>} */ (/** @type {unknown} */ (undefined)),
      stores: resolved.stores,
      turn,
      kind,
      messageId: null,
      extraMessageIds: [],
      text: '',
      steps: new Map(),
      tools: new Map(),
      deliverables: [],
      lastEditAt: 0,
      timer: undefined,
      typingTimer: undefined,
      sending: false,
      sendingPromise: undefined,
      dirty: false,
      finalized: false
    };
    // 先把投递放进内存，再异步落账本：否则 turn/start 与第一个 text-delta 之间的
    // 异步间隙会把流式首个文本块丢掉。
    deliveries.set(keyOf(routeKey, turn), delivery);
    delivery.ledgerReady = resolved.stores.ledger.open({ routeKey, sessionId, turn, kind }).then((entry) => {
      delivery.ledgerId = entry.id;
      return entry;
    });
    // 用户回合才需要“正在输入”；无人值守（定时/续行）在群里打字是噪音。
    if (kind === 'user') startTyping(delivery);
    return delivery;
  }

  /**
   * 回合进行中的“正在输入”。Telegram 的 typing 5 秒过期，所以按配置间隔续；
   * 只是体验，失败一律吞掉，不能影响投递。
   * @param {Delivery} delivery
   * @returns {void}
   */
  function startTyping(delivery) {
    if (config.typingIntervalMs <= 0 || delivery.typingTimer !== undefined) return;
    const adapter = adapterFor(delivery.channel);
    if (typeof adapter?.typing !== 'function') return;
    const chat = { chatId: delivery.chatId, ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }) };
    const ping = () => {
      void Promise.resolve(/** @type {any} */ (adapter).typing(chat)).catch(() => undefined);
    };
    ping();
    delivery.typingTimer = setInterval(ping, config.typingIntervalMs);
    // typing 只是体验，不应成为进程存活的最后一个句柄（也让测试能自然退出）。
    delivery.typingTimer.unref?.();
  }

  /** @param {Delivery} delivery */
  function stopTyping(delivery) {
    if (delivery.typingTimer === undefined) return;
    clearInterval(delivery.typingTimer);
    delivery.typingTimer = undefined;
  }

  /**
   * 把当前草稿写进同一条消息（首次是新建，之后是编辑）。
   *
   * 两个并发保护：
   * 1. 同一投递同时只允许一个 send/edit 在飞（否则多个 flush 都看到 messageId=null，会各发一条新消息）；
   * 2. 飞行期间来的新文本记到 dirty，飞完后再按节流补一次（保证最后一段文字不会丢）。
   * @param {Delivery} delivery
   * @returns {Promise<void>}
   */
  async function flushDraft(delivery) {
    if (delivery.finalized) return;
    if (delivery.sending) {
      delivery.dirty = true;
      return;
    }
    if (delivery.kind === 'user') startTyping(delivery);
    const text = draftText(delivery);
    if (text.trim() === '') return;
    const adapter = adapterFor(delivery.channel);
    if (adapter === undefined) return;
    const chat = { chatId: delivery.chatId, ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }) };
    const body = clampDraft(text, config);
    const chatKey = chatKeyOf({ channel: delivery.channel, chatId: delivery.chatId, ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }) });
    delivery.sending = true;
    delivery.lastEditAt = clock.now();
    const run = (async () => {
      try {
        if (delivery.messageId === null) {
          const sent = await pacer.run(chatKey, async () => {
            if (delivery.finalized) return undefined;
            return await adapter.send(chat, body, {});
          });
          if (sent?.messageId !== undefined) {
            delivery.messageId = sent.messageId;
            await draftRecord(delivery, { messageId: sent.messageId, text: delivery.text });
          }
        } else {
          await pacer.run(chatKey, async () => {
            if (delivery.finalized) return 'skipped';
            return await adapter.edit(chat, /** @type {string} */ (delivery.messageId), body, {});
          });
          await draftRecord(delivery, { text: delivery.text });
        }
      } catch (error) {
        state.recordError(error);
        logger.warn(`channel-core: 草稿投递失败（${chatKey}）：${messageOf(error)}`);
      }
    })();
    delivery.sendingPromise = run;
    try {
      await run;
    } finally {
      delivery.sending = false;
      delivery.sendingPromise = undefined;
      if (delivery.dirty && !delivery.finalized) {
        delivery.dirty = false;
        scheduleFlush(delivery);
      }
    }
  }

  /**
   * 按 `editIntervalMs` 安排下一次草稿刷新（同一时刻最多一个定时器）。
   * @param {Delivery} delivery
   * @returns {void}
   */
  function scheduleFlush(delivery) {
    if (delivery.finalized || delivery.timer !== undefined) return;
    if (delivery.sending) {
      // 飞行期间来的文本先记账；飞完后 flushDraft 的 finally 会再补一次。
      delivery.dirty = true;
      return;
    }
    const delay = Math.max(1, config.editIntervalMs - (clock.now() - delivery.lastEditAt));
    delivery.timer = setTimeout(() => {
      delivery.timer = undefined;
      void flushDraft(delivery);
    }, delay);
  }

  /**
   * @param {{ agent: { id: string, session: { id: string } }, frame: any }} payload
   * @returns {void}
   */
  function onAssistantStream({ agent, frame }) {
    const sessionId = agent?.id ?? agent?.session?.id;
    if (typeof sessionId !== 'string') return;
    const resolved = resolveRoute(sessionId);
    if (resolved === undefined) {
      noteDrop(sessionId, frame?.turn);
      return;
    }
    const delivery = deliveryFor(resolved.routeKey, frame?.turn);
    if (delivery === undefined || delivery.finalized) return;

    if (frame?.type === 'start') {
      // 同一 (turn, step) 的重试覆盖该步既有文本，避免失败尝试的残句混进终稿。
      if (typeof frame.step === 'number') delivery.steps.set(frame.step, '');
      // 重试的步骤会把工具调用再发一遍；旧 callId 的状态已经失效。
      delivery.tools.clear();
      return;
    }
    if (frame?.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return;
    const step = typeof frame.step === 'number' ? frame.step : 0;
    delivery.steps.set(step, `${delivery.steps.get(step) ?? ''}${chunk.text}`);
    delivery.text = draftText(delivery);

    const now = clock.now();
    if (!delivery.sending && now - delivery.lastEditAt >= config.editIntervalMs) {
      void flushDraft(delivery);
      return;
    }
    scheduleFlush(delivery);
  }

  /**
   * @param {{ id: string, snapshotEvents?: (from?: number, to?: number) => any[], seq?: number }} session
   * @param {{ type: string, data?: any, seq?: number }} event
   * @returns {Promise<void>}
   */
  async function onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string') return;
    const resolved = resolveRoute(sessionId);
    if (resolved === undefined) {
      noteDrop(sessionId, event.data?.turn);
      return;
    }

    if (event.type === 'turn/start') {
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : 0;
      const kind = state.inFlight.has(resolved.routeKey) ? 'user' : 'unattended';
      const started = beginTurn(resolved.routeKey, sessionId, turn, kind);
      started?.tools.clear();
      state.setTurn(resolved.routeKey, turn);
      heartbeat.update({ inFlight: state.inFlightCount });
      return;
    }

    // 工具状态行：assistant/message 里的 tool-call 块带名字，tool/result 按 callId 清掉。
    // 草稿里显示“正在执行 X”，让长工具调用期间不是一片空白。
    if (event.type === 'assistant/message') {
      const current = deliveryFor(resolved.routeKey, event.data?.turn);
      if (current === undefined || current.finalized) return;
      let added = false;
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
          current.tools.set(block.id, block.name);
          added = true;
        }
      }
      if (added) scheduleFlush(current);
      return;
    }

    if (event.type === 'tool/result') {
      const current = deliveryFor(resolved.routeKey, event.data?.turn);
      if (current === undefined || current.finalized) return;
      const callId = event.data?.message?.source?.callId;
      if (typeof callId === 'string' && current.tools.delete(callId)) scheduleFlush(current);
      return;
    }

    if (event.type === 'deliverables/presented') {
      const current = deliveryFor(resolved.routeKey, event.data?.turn);
      if (current === undefined || current.finalized) return;
      for (const file of event.data?.files ?? []) {
        if (typeof file?.path !== 'string' || file.path === '') continue;
        if (current.deliverables.some((entry) => entry.path === file.path)) continue;
        current.deliverables.push({
          path: file.path,
          ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {})
        });
      }
      return;
    }

    if (event.type !== 'turn/end') return;
    const turn = typeof event.data?.turn === 'number'
      ? event.data.turn
      : latestOf(resolved.routeKey)?.turn ?? 0;
    // 重复 turn/end（重放、恢复、上游重复发射）不能让同一回合出现第二份终稿。
    const prior = resolved.stores.ledger.findByTurn(sessionId, turn);
    if (prior !== undefined && (prior.state === 'final' || prior.state === 'aborted')) {
      const stale = deliveries.get(keyOf(resolved.routeKey, turn));
      if (stale !== undefined) {
        stale.finalized = true;
        stopTyping(stale);
        deliveries.delete(keyOf(resolved.routeKey, turn));
      }
      return;
    }
    // 没有看到 turn/start（例如订阅晚于回合开始）：仍要尽力给出终稿。
    // 这条路由上还有已受理未结束的提交，就说明这一轮是用户回合，别判成无人值守。
    const current = deliveries.get(keyOf(resolved.routeKey, turn))
      ?? beginTurn(resolved.routeKey, sessionId, turn, state.inFlight.has(resolved.routeKey) ? 'user' : 'unattended');
    if (current === undefined || current.finalized) return;

    if (current.timer !== undefined) {
      clearTimeout(current.timer);
      current.timer = undefined;
    }
    if (current.sendingPromise !== undefined) await current.sendingPromise.catch(() => undefined);
    stopTyping(current);
    current.tools.clear();
    const reason = event.data?.reason ?? { kind: 'completed' };
    const finalText = finalTextOf(session, turn, current, reason);
    current.finalized = true;

    const chat = { chatId: current.chatId, ...(current.threadId === undefined ? {} : { threadId: current.threadId }) };
    const adapter = adapterFor(current.channel);
    const chatKey = chatKeyOf({ channel: current.channel, ...chat });
    const chunks = splitForDelivery(finalText, config);
    const hash = hashText(finalText);

    try {
      if (adapter === undefined) throw new Error(`通道 ${current.channel} 未注册`);
      // 第一条复用流式那条消息；超长终稿的其余部分作为新消息补发，保证一份终稿不丢内容。
      const first = chunks[0] ?? '';
      if (current.messageId === null) {
        const sent = await pacer.run(chatKey, async () => await adapter.send(chat, first, {}));
        current.messageId = sent.messageId;
      } else {
        await pacer.run(chatKey, async () => await adapter.edit(chat, /** @type {string} */ (current.messageId), first, {}));
      }
      for (let index = 1; index < chunks.length; index += 1) {
        const prefix = `（${index + 1}/${chunks.length}）\n`;
        const sent = await pacer.run(chatKey, async () => await adapter.send(chat, `${prefix}${chunks[index]}`, {}));
        current.extraMessageIds.push(sent.messageId);
      }
      const ledgerEntry = await current.ledgerReady;
      // 交付物：present 产出的文件在终稿之后作为附件发出；通道不支持附件时退化为文字路径。
      if (current.deliverables.length > 0) {
        if (typeof adapter.sendDocument === 'function') {
          for (const file of current.deliverables) {
            try {
              await pacer.run(`${chatKey}:doc`, async () => await /** @type {any} */ (adapter).sendDocument(chat, { path: file.path, ...(file.description === undefined ? {} : { caption: file.description }) }));
              audit.record('outbound-deliverable', { channel: current.channel, chatId: current.chatId, sessionId, turn, path: file.path });
            } catch (error) {
              logger.warn(`channel-core: 交付物发送失败（${file.path}）：${messageOf(error)}`);
            }
          }
        } else {
          const listing = current.deliverables.map((file) => `- ${file.path}${file.description === undefined ? '' : `（${file.description}）`}`).join('\n');
          await pacer.run(chatKey, async () => await adapter.send(chat, splitForDelivery(`📎 交付物：\n${listing}`, config)[0] ?? '', {}));
        }
      }
      const written = await resolved.stores.ledger.finalize(ledgerEntry.id, {
        messageId: /** @type {string} */ (current.messageId),
        messageIds: [/** @type {string} */ (current.messageId), ...current.extraMessageIds],
        text: finalText,
        finalHash: hash
      });
      audit.record('outbound-final', {
        channel: current.channel,
        chatId: current.chatId,
        sessionId,
        turn,
        messageId: current.messageId,
        finalHash: hash,
        // 不能叫 `kind`：`AuditLog.record` 会把它拼在事件名之后，payload 里的 `kind` 会覆盖事件名，
        // 固定字段名，避免回合数据改变审计事件的类型。
        turnKind: current.kind,
        reason: reason.kind,
        written: written.written
      });
    } catch (error) {
      state.recordError(error);
      logger.error(`channel-core: 终稿投递失败（${chatKey}）：${messageOf(error)}`);
      await current.ledgerReady.then(async (entry) => await resolved.stores.ledger.abandon(entry.id, `final-failed:${messageOf(error)}`)).catch(() => undefined);
    } finally {
      stopTyping(current);
      deliveries.delete(keyOf(resolved.routeKey, turn));
      // 只有用户回合消耗一次在途标记：无人值守回合本来就没有标记，
      // 无条件清掉会把同一路由上仍在排队的用户回合一起抹掉。
      if (current.kind === 'user') state.consumeInFlight(resolved.routeKey);
      heartbeat.update({ inFlight: state.inFlightCount, queueDepth: pacer.totalDepth });
    }
  }

  /**
   * 重启恢复：账本里仍 open 的条目说明进程在回合中途死亡。
   * 把可见草稿补一句中断提示后封口，**不重放**，也不新发第二条终稿。
   * @param {string} [onlyChannel] 只处理该通道（未注册适配器的通道留到它注册时再处理）
   * @returns {Promise<number>} 处理条数
   */
  async function recoverInterrupted(onlyChannel) {
    let handled = 0;
    for (const candidate of allRoutes()) {
      if (onlyChannel !== undefined && candidate.route.channel !== onlyChannel) continue;
      for (const entry of candidate.stores.ledger.all()) {
        if (entry.state !== 'open') continue;
        handled += 1;
        const adapter = adapterFor(candidate.route.channel);
        if (entry.messageId !== null && adapter !== undefined) {
          const head = splitForDelivery(entry.text, config)[0] ?? '';
          const notice = entry.text.trim() === ''
            ? '⚠️ 上一回合在进程重启时中断（无输出）。'
            : `${head}\n\n⚠️ 上一回合在进程重启时中断。`;
          const chat = { chatId: candidate.route.chatId, ...(candidate.route.threadId === undefined ? {} : { threadId: candidate.route.threadId }) };
          try {
            await pacer.run(chatKeyOf({ channel: candidate.route.channel, ...chat }), async () =>
              await adapter.edit(chat, /** @type {string} */ (entry.messageId), notice, {})
            );
          } catch (error) {
            logger.warn(`channel-core: 中断提示投递失败：${messageOf(error)}`);
          }
        }
        await candidate.stores.ledger.abandon(entry.id, 'process-restart');
        audit.record('interrupted-sealed', { channel: candidate.route.channel, sessionId: entry.sessionId, ledger: entry.id });
      }
    }
    if (handled > 0) logger.info(`channel-core: 重启恢复已封口 ${handled} 条中断投递`);
    return handled;
  }

  /** @returns {void} */
  function dispose() {
    for (const delivery of deliveries.values()) {
      if (delivery.timer !== undefined) clearTimeout(delivery.timer);
      stopTyping(delivery);
    }
    deliveries.clear();
  }

  return { onAssistantStream, onSessionEvent, recoverInterrupted, sendDirect, dispose, get activeDeliveries() { return deliveries.size; } };
}

/**
 * 账本写入是异步的：投递状态先更新，记录其次。
 * @param {Delivery} delivery
 * @param {{ messageId?: string | null, text?: string }} patch
 * @returns {Promise<void>}
 */
async function draftRecord(delivery, patch) {
  const entry = await delivery.ledgerReady;
  await delivery.stores.ledger.draft(entry.id, patch);
}

/**
 * @typedef {object} Delivery
 * @property {string} routeKey
 * @property {string} sessionId
 * @property {string} channel
 * @property {string} chatId
 * @property {string} [threadId]
 * @property {string} ledgerId
 * @property {Promise<{ id: string }>} ledgerReady
 * @property {import('./stores.js').ChannelStores} stores
 * @property {number} turn
 * @property {'user'|'unattended'} kind
 * @property {string | null} messageId
 * @property {string[]} extraMessageIds 终稿分条时补发的消息
 * @property {string} text 助手正文（不含工具状态行）
 * @property {Map<number, string>} steps
 * @property {Map<string, string>} tools 正在执行的工具：callId → 名称
 * @property {{ path: string, description?: string }[]} deliverables
 * @property {number} lastEditAt
 * @property {NodeJS.Timeout | undefined} timer
 * @property {NodeJS.Timeout | undefined} typingTimer
 * @property {boolean} sending 是否有一个 send/edit 正在飞行
 * @property {Promise<void> | undefined} sendingPromise 在飞行的投递
 * @property {boolean} dirty 飞行期间又来了新文本
 * @property {boolean} finalized
 */

/**
 * 按步拼接草稿：多步回合里逐步旁白与最终结论都保留，重试只覆盖同一步。
 * @param {Delivery} delivery
 * @returns {string}
 */
function draftText(delivery) {
  const body = [...delivery.steps.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
  // 工具调用期间给一行状态：否则长命令跑到一半时消息里只有上一段旁白，看起来像卡住。
  const names = [...delivery.tools.values()];
  const status = names.length === 0
    ? ''
    : `⏳ 正在执行 ${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}…`;
  return [body, status].filter((part) => part.trim() !== '').join('\n\n');
}

/**
 * 从**持久日志**取终稿：比流式草稿可靠（流可能丢帧、可能重试）。
 * @param {{ snapshotEvents?: (from?: number, to?: number) => any[] }} session
 * @param {number} turn
 * @param {Delivery} delivery
 * @param {{ kind: string, error?: { code?: string, message?: string } }} reason
 * @returns {string}
 */
export function finalTextOf(session, turn, delivery, reason) {
  /** @type {Map<number, string>} */
  const steps = new Map();
  if (typeof session.snapshotEvents === 'function') {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'assistant/message') continue;
      if (event.data?.turn !== turn) continue;
      const step = typeof event.data?.step === 'number' ? event.data.step : 0;
      const text = (event.data.message?.content ?? [])
        .filter((/** @type {{type: string}} */ block) => block.type === 'text')
        .map((/** @type {{text?: string}} */ block) => block.text ?? '')
        .join('');
      if (text.trim() === '') continue;
      steps.set(step, steps.get(step) === undefined ? text : `${steps.get(step)}\n\n${text}`);
    }
  }
  let text = [...steps.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .filter((value) => value.trim() !== '')
    .join('\n\n');
  if (text.trim() === '') text = delivery.text.trim();
  if (reason.kind === 'error') {
    const code = reason.error?.code ?? 'ERROR';
    const message = reason.error?.message ?? '回合失败';
    text = `${text === '' ? '' : `${text}\n\n`}⚠️ 回合失败：${code} ${message}`.trim();
  } else if (reason.kind === 'interrupted') {
    text = `${text === '' ? '' : `${text}\n\n`}⚠️ 本回合被中断`.trim();
  }
  if (text.trim() === '') text = `（回合结束，无输出；reason=${reason.kind}）`;
  return text;
}

/**
 * 把一条长文本切成平台能接受的多条消息。
 *
 * 不做“已截断”：终稿丢内容比多发两条严重。优先在空行、其次单行处断开；
 * 留出分条前缀（`（2/10）`）的余量，并避免把代理对切成两半。
 * @param {string} text
 * @param {import('./config.js').CoreConfig} config
 * @returns {string[]}
 */
function splitForDelivery(text, config) {
  const limit = Math.max(200, (config.maxMessageChars ?? 4000) - 16);
  if (text.length <= limit) return [text];
  /** @type {string[]} */
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') chunks.push(rest);
  return chunks.length === 0 ? [''] : chunks;
}

/**
 * 流式草稿只显示第一条的容量，其余等终稿再分条补发；
 * 这样超长回答的第一个字也能 1 秒内出现。
 * @param {string} text
 * @param {import('./config.js').CoreConfig} config
 * @returns {string}
 */
function clampDraft(text, config) {
  const limit = config.maxMessageChars ?? 4000;
  if (text.length <= limit) return text;
  const marker = '\n\n…（内容较长，结束后分条补发）';
  let cut = Math.max(1, limit - marker.length);
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}${marker}`;
}

/**
 * @param {number} index 0 基
 * @param {number} total
 * @param {string} chunk
 * @returns {string}
 */
function chunkText(index, total, chunk) {
  return index === 0 || total <= 1 ? chunk : `（${index + 1}/${total}）\n${chunk}`;
}

/** @param {number} code @returns {boolean} */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {{ channel: string, chatId: string, threadId?: string }} chat
 * @returns {string}
 */
function chatKeyOf(chat) {
  return `${chat.channel}:${chat.chatId}:${chat.threadId ?? ''}`;
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
