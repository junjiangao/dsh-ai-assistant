import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 一个只实现本项目实际用到的那些面的 DSH 假宿主。
 *
 * 刻意逐条对齐 `docs/notes/dsh-api-contract.md`：`ctx.get/provide/on/effect`、
 * `sessionController.create/prompt/resolveAgent/cancel`、`session/event` 与
 * `agent/assistant-stream` 的 payload 形态、`user-questions/request` 的 waterfall。
 * 真实宿主的行为变化要通过更新本文件反映出来，而不是在测试里写特例。
 */

/**
 * @typedef {object} FakeSession
 * @property {string} id
 * @property {{ id: string, cwd?: string }} header
 * @property {any[]} events
 * @property {number} seq
 * @property {number} updatedAt
 * @property {(from?: number, to?: number) => any[]} snapshotEvents
 * @property {(seq: number) => any} eventAt
 */

/**
 * @param {{ dshHome?: string }} [options]
 */
export function createFakeDsh({ dshHome } = {}) {
  const home = dshHome ?? mkdtempSync(join(tmpdir(), 'assistant-test-'));
  mkdirSync(home, { recursive: true });

  /** @type {Map<string, unknown>} */
  const services = new Map();
  /** @type {Map<string, { callback: Function, global: boolean }[]>} */
  const listeners = new Map();
  /** @type {Array<{ label: string, dispose: () => void | Promise<void> }>} */
  const effects = [];
  /** @type {Map<string, FakeSession>} */
  const sessions = new Map();
  /** @type {Map<string, { id: string, session: FakeSession }>} */
  const agents = new Map();
  /** @type {string[]} */
  const logs = [];
  /** @type {number[]} */
  const exits = [];
  /** @type {Array<Record<string, unknown>>} */
  const prompts = [];
  /** @type {Array<Record<string, unknown>>} */
  const creates = [];
  /** @type {Array<Record<string, unknown>>} */
  const cancels = [];
  /** @type {Array<{ sessionId: string, callId: string, batch: any }>} */
  const questionAnswers = [];
  let questionAnswerResult = true;
  /** @type {Array<{ sessionId: string, preset: string }>} */
  const presetSelections = [];
  /** @type {Array<{ sessionId: string, provider: string, model: string, reasoningEffort?: string }>} */
  const modelSelections = [];
  /** @type {Map<string, { provider: string, model: string, reasoningEffort?: string }>} */
  const currentModels = new Map();
  /** @type {'ok'|'locked'|'not-found'} */
  let presetOutcome = 'ok';

  /** @type {Error | null} */
  let nextPromptError = null;
  /** @type {Error | null} */
  let nextCreateError = null;

  let sessionCounter = 0;

  /** @param {string} message */
  const log = (level, message) => logs.push(`${level}: ${message}`);

  const ctx = {
    /** @param {string} name */
    get(name) {
      return services.get(name);
    },
    /**
     * @param {string} name
     * @param {unknown} value
     */
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    /**
     * @param {string} name
     * @param {Function} callback
     * @param {{ global?: boolean, prepend?: boolean } | boolean} [options]
     */
    on(name, callback, options = {}) {
      const global = typeof options === 'object' ? options.global === true : false;
      const list = listeners.get(name) ?? [];
      list.push({ callback, global });
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.findIndex((entry) => entry.callback === callback);
        if (index >= 0) current.splice(index, 1);
      };
    },
    /**
     * @param {() => any} factory
     * @param {string} label
     */
    effect(factory, label) {
      const produced = factory();
      const dispose = typeof produced === 'function' ? produced : () => {};
      effects.push({ label: label ?? 'effect', dispose });
      return dispose;
    },
    logger: {
      debug: (/** @type {string} */ message) => log('debug', message),
      info: (/** @type {string} */ message) => log('info', message),
      warn: (/** @type {string} */ message) => log('warn', message),
      error: (/** @type {string} */ message) => log('error', message)
    }
  };

  /** @param {string} sessionId @param {any} event */
  function appendSessionEvent(sessionId, event) {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session ${sessionId}`);
    const withSeq = { seq: session.seq, ...event };
    session.events.push(withSeq);
    session.seq += 1;
    session.updatedAt = Date.now();
    dispatch('session/event', session, withSeq);
    return withSeq;
  }

  /**
   * @param {string} name
   * @param {...any} args
   */
  function dispatch(name, ...args) {
    const list = listeners.get(name) ?? [];
    for (const entry of [...list]) {
      try {
        entry.callback(...args);
      } catch (error) {
        log('error', `listener for ${name} threw: ${String(error)}`);
      }
    }
  }

  /**
   * @param {string} name
   * @param {any} first
   * @param {any[]} rest
   */
  async function dispatchWaterfall(name, first, ...rest) {
    const list = listeners.get(name) ?? [];
    let index = 0;
    const next = async () => {
      const entry = list[index];
      index += 1;
      if (entry === undefined) throw new Error(`no answerer for ${name}`);
      return await entry.callback(first, next);
    };
    return await next();
  }

  /** @param {string} sessionId */
  function makeSession(sessionId, cwd = home) {
    /** @type {FakeSession} */
    const session = {
      id: sessionId,
      header: { id: sessionId, cwd },
      events: [],
      seq: 0,
      updatedAt: Date.now(),
      snapshotEvents(from = 0, to) {
        return session.events.slice(from, to ?? session.events.length);
      },
      eventAt(seq) {
        return session.events[seq];
      }
    };
    sessions.set(sessionId, session);
    agents.set(sessionId, { id: sessionId, session, model: { current: () => currentModels.get(sessionId) } });
    return session;
  }

  const sessionController = {
    /** @param {{ agentPreset?: string, cwd?: string, sessionId?: string }} [request] */
    async create(request = {}) {
      creates.push({ ...request });
      if (nextCreateError !== null) {
        const error = nextCreateError;
        nextCreateError = null;
        throw error;
      }
      sessionCounter += 1;
      const sessionId = request.sessionId ?? `session-${sessionCounter}`;
      makeSession(sessionId, request.cwd ?? home);
      return { sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
    },
    /**
     * @param {{ sessionId: string, content: any[], requestId: string, mode?: string }} request
     * @param {AbortSignal} [signal]
     */
    async prompt(request, signal) {
      signal?.throwIfAborted?.();
      if (nextPromptError !== null) {
        const error = nextPromptError;
        nextPromptError = null;
        throw error;
      }
      const session = sessions.get(request.sessionId);
      if (session === undefined) {
        const error = new Error(`session "${request.sessionId}" not found`);
        /** @type {any} */ (error).code = 'session/not-found';
        throw error;
      }
      prompts.push({ ...request });
      return { accepted: true };
    },
    /** @param {string} sessionId */
    async resolveAgent(sessionId) {
      const agent = agents.get(sessionId);
      if (agent === undefined) return { error: new Error(`session "${sessionId}" not found`) };
      return { agent };
    },
    /** @param {{ sessionId: string }} request */
    cancel(request) {
      cancels.push({ ...request });
      return { accepted: true };
    },
    /** 与真实宿主一致：不 resume 就能列出会话，按活动时间倒序。 */
    async list() {
      const items = [...sessions.values()].map((session) => ({
        sessionId: session.id,
        updatedAt: session.updatedAt,
        running: false,
        blank: session.events.length === 0,
        ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd })
      }));
      return { items };
    },
    /** @param {{ sessionId: string, provider: string, model: string, reasoningEffort?: string }} request */
    async selectModel(request) {
      if (!sessions.has(request.sessionId)) {
        const error = new Error(`session "${request.sessionId}" not found`);
        /** @type {any} */ (error).code = 'session/not-found';
        throw error;
      }
      if (request.model === 'missing') {
        const error = new Error('model is not advertised by the provider');
        /** @type {any} */ (error).code = 'session/model-unavailable';
        throw error;
      }
      const selected = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort })
      };
      currentModels.set(request.sessionId, selected);
      modelSelections.push({ sessionId: request.sessionId, ...selected });
      return { selected: { ...selected } };
    },
    async modelCatalog() {
      return {
        default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'max' },
        routableProviders: ['provider-a'],
        groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] }],
        failures: []
      };
    }
  };

  const sessionsService = {
    /** @param {string} sessionId */
    get(sessionId) {
      return sessions.get(sessionId);
    },
    async flush() {}
  };

  services.set('sessionController', sessionController);
  services.set('sessions', sessionsService);
  services.set('agents', {
    /** @param {string} sessionId */
    get(sessionId) {
      return agents.get(sessionId);
    },
    /** @param {any} session */
    turnBoundaryOf(session) {
      const open = session.events.at(-1);
      return { turn: 0, step: 0, openTurnStartSeq: open?.type === 'turn/start' ? open.seq : null, lastTurn: 0 };
    }
  });
  services.set('appExit', (/** @type {number} */ code) => exits.push(code));
  services.set('agentPresets', {
    /** @returns {Promise<Array<{ id: string, name?: string, isDefault?: boolean }>>} */
    async list() {
      return [{ id: 'standard', name: '标准', isDefault: true }, { id: 'minimal', name: '极简' }];
    },
    /**
     * @param {{ id: string }} agent
     * @param {string} preset
     */
    async select(agent, preset) {
      presetSelections.push({ sessionId: agent.id, preset });
      if (presetOutcome === 'locked') {
        const error = new Error('This session has already started');
        /** @type {any} */ (error).code = 'agent-preset/locked';
        throw error;
      }
      if (presetOutcome === 'not-found') {
        const error = new Error('Unknown agent preset');
        /** @type {any} */ (error).code = 'agent-preset/not-found';
        throw error;
      }
      return preset;
    }
  });
  services.set('userQuestions', {
    /**
     * @param {{ id: string }} agent
     * @param {string} callId
     * @param {{ answers: any[] }} batch
     */
    answer(agent, callId, batch) {
      questionAnswers.push({ sessionId: agent.id, callId, batch });
      return questionAnswerResult;
    }
  });

  return {
    home,
    ctx,
    logs,
    exits,
    prompts,
    creates,
    cancels,
    questionAnswers,
    presetSelections,
    modelSelections,
    sessions,
    agents,
    services,
    sessionController,
    /** @param {Error} error */
    failNextPrompt(error) {
      nextPromptError = error;
    },
    /** @param {Error} error */
    failNextCreate(error) {
      nextCreateError = error;
    },
    /** @param {boolean} value */
    setQuestionAnswerResult(value) {
      questionAnswerResult = value;
    },
    /** @param {'ok'|'locked'|'not-found'} value */
    setPresetOutcome(value) {
      presetOutcome = value;
    },
    /** @param {string} sessionId @param {string} [cwd] */
    makeSession,
    appendSessionEvent,
    dispatch,
    dispatchWaterfall,
    /** @param {string} name @param {any} payload */
    dispatchAgentEvent(name, payload) {
      dispatch(name, payload);
    },
    /** 运行所有 effect disposer（逆序），用于验证 dispose 路径。 */
    async dispose() {
      for (const effect of [...effects].reverse()) await effect.dispose();
      effects.length = 0;
    },
    /** @param {string} path */
    readJson(path) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  };
}

/**
 * 记录型适配器：所有出站都被记下来，可以注入失败。
 * @param {{ id?: string }} [options]
 */
export function createFakeAdapter({ id = 'telegram' } = {}) {
  /** @type {Array<{ kind: 'send'|'edit', chatId: string, threadId?: string, text: string, messageId?: string, buttons?: any }>} */
  const outbox = [];
  /** @type {string[]} */
  const acks = [];
  /** @type {Array<{ chatId: string, threadId?: string }>} */
  const typings = [];
  /** @type {any} */
  let host;
  let counter = 0;
  /** @type {Error | null} */
  let nextSendError = null;
  /** @type {Error | null} */
  let nextEditError = null;

  /** @type {import('../../src/protocol.js').ChannelAdapter} */
  const adapter = {
    id,
    /** @param {any} registeredHost */
    async start(registeredHost) {
      host = registeredHost;
    },
    async stop() {},
    /**
     * @param {{ chatId: string, threadId?: string }} chat
     * @param {string} text
     * @param {{ buttons?: any }} [options]
     */
    async send(chat, text, options = {}) {
      if (nextSendError !== null) {
        const error = nextSendError;
        nextSendError = null;
        throw error;
      }
      counter += 1;
      const messageId = `m${counter}`;
      outbox.push({ kind: 'send', chatId: chat.chatId, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }), text, messageId, ...(options.buttons === undefined ? {} : { buttons: options.buttons }) });
      return { messageId };
    },
    /**
     * @param {{ chatId: string, threadId?: string }} chat
     * @param {string} messageId
     * @param {string} text
     * @param {{ buttons?: any }} [options]
     */
    async edit(chat, messageId, text, options = {}) {
      if (nextEditError !== null) {
        const error = nextEditError;
        nextEditError = null;
        throw error;
      }
      if (outbox.some((entry) => entry.kind === 'edit' && entry.messageId === messageId && entry.text === text)) return 'unchanged';
      outbox.push({ kind: 'edit', chatId: chat.chatId, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }), text, messageId, ...(options.buttons === undefined ? {} : { buttons: options.buttons }) });
      return 'ok';
    },
    /** @param {{ chatId: string, threadId?: string }} chat */
    async typing(chat) {
      typings.push({ chatId: chat.chatId, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }) });
    },
    /** @param {string} callbackId @param {string} [text] */
    async ackCallback(callbackId, text) {
      acks.push(`${callbackId}:${text ?? ''}`);
    },
    async probe() {
      return { ok: true, detail: 'fake' };
    }
  };

  return {
    adapter,
    outbox,
    acks,
    typings,
    get host() {
      return host;
    },
    /** @param {Error} error */
    failNextSend(error) {
      nextSendError = error;
    },
    /** @param {Error} error */
    failNextEdit(error) {
      nextEditError = error;
    },
    /** @returns {string} */
    lastText() {
      return outbox.at(-1)?.text ?? '';
    }
  };
}