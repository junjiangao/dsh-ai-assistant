import { join } from 'node:path';
import { JsonStore } from './json-store.js';
import { systemClock } from './util.js';

/** @typedef {import('./util.js').Clock} Clock */
/** @typedef {import('./json-store.js').LoggerLike} LoggerLike */

/**
 * 通道级持久状态。文件布局对应设计文档 §10：
 * `$DSH_HOME/channels/<channel>/{offset,receipts,routes,ledger,approvals}.json`。
 */
export class ChannelStores {
  /** @type {string} */
  channel;
  /** @type {JsonStore} */
  #cursorStore;
  /** @type {JsonStore} */
  #receiptStore;
  /** @type {JsonStore} */
  #routeStore;
  /** @type {JsonStore} */
  #ledgerStore;
  /** @type {JsonStore} */
  #approvalStore;
  /** @type {Clock} */
  #clock;
  /** @type {number} */
  #receiptLimit;
  /** @type {number} */
  #ledgerLimit;
  /** @type {number} */
  #approvalLimit;
  /** @type {number} */
  #recovered;

  /**
   * @param {{ dir: string, channel: string, clock?: Clock, logger?: LoggerLike, receiptLimit?: number, ledgerLimit?: number, approvalLimit?: number }} options
   */
  constructor({ dir, channel, clock = systemClock, logger, receiptLimit = 5000, ledgerLimit = 200, approvalLimit = 100 }) {
    this.channel = channel;
    this.#clock = clock;
    this.#receiptLimit = receiptLimit;
    this.#ledgerLimit = ledgerLimit;
    this.#approvalLimit = approvalLimit;
    const paths = {
      cursor: join(dir, 'offset.json'),
      receipts: join(dir, 'receipts.json'),
      routes: join(dir, 'routes.json'),
      ledger: join(dir, 'ledger.json'),
      approvals: join(dir, 'approvals.json')
    };
    this.#cursorStore = new JsonStore({ path: paths.cursor, initial: () => ({ version: 1, offset: null }), logger });
    this.#receiptStore = new JsonStore({ path: paths.receipts, initial: () => ({ version: 1, entries: [] }), logger });
    this.#routeStore = new JsonStore({ path: paths.routes, initial: () => ({ version: 1, routes: {} }), logger });
    this.#ledgerStore = new JsonStore({ path: paths.ledger, initial: () => ({ version: 1, entries: [] }), logger });
    this.#approvalStore = new JsonStore({ path: paths.approvals, initial: () => ({ version: 1, pending: {} }), logger });
    let recovered = 0;
    for (const store of [this.#cursorStore, this.#receiptStore, this.#routeStore, this.#ledgerStore, this.#approvalStore]) {
      if (store.load().recovered) recovered += 1;
    }
    this.#recovered = recovered;
  }

  /** @returns {number} 加载时被隔离的损坏文件数 */
  get recoveredFiles() {
    return this.#recovered;
  }

  /** 游标：只允许单调前进，崩溃后重投由收据去重兜住。 */
  get cursor() {
    const self = this;
    return {
      /** @returns {number | string | null} */
      get() {
        const cursorData = self.#cursorStore.data;
        if (typeof cursorData !== 'object' || cursorData === null) return null;
        const value = /** @type {{offset?: unknown}} */ (cursorData).offset;
        return typeof value === 'number' || typeof value === 'string' ? value : null;
      },
      /**
       * @param {number | string} next
       * @returns {Promise<{ advanced: boolean, offset: number | string }>}
       */
      async advance(next) {
        return await self.#cursorStore.update((data) => {
          const current = data.offset;
          if (typeof current === 'number' && typeof next === 'number') {
            if (next <= current) return { advanced: false, offset: current };
          } else if (current === next) {
            return { advanced: false, offset: current };
          }
          data.offset = next;
          return { advanced: true, offset: next };
        });
      }
    };
  }

  /** 收据：已处理事件标识的有界集合（FIFO 淘汰）。 */
  get receipts() {
    const self = this;
    return {
      /** @param {string} key @returns {boolean} */
      has(key) {
        const data = /** @type {{entries: [string, number][]}} */ (self.#receiptStore.data);
        return data.entries.some(([existing]) => existing === key);
      },
      /**
       * 记录一条收据；已存在时返回 false。
       * @param {string} key
       * @returns {Promise<boolean>}
       */
      async add(key) {
        return await self.#receiptStore.update((data) => {
          const entries = /** @type {[string, number][]} */ (data.entries);
          if (entries.some(([existing]) => existing === key)) return false;
          entries.push([key, self.#clock.now()]);
          const overflow = entries.length - self.#receiptLimit;
          if (overflow > 0) entries.splice(0, overflow);
          return true;
        });
      },
      /** @returns {number} */
      get size() {
        return /** @type {{entries: unknown[]}} */ (self.#receiptStore.data).entries.length;
      }
    };
  }

  /** 路由：(通道,账号,chat,thread) ↔ 会话。 */
  get routes() {
    const self = this;
    /** @param {string} key */
    const entryOf = (key) => {
      const routes = /** @type {Record<string, RouteEntry>} */ (/** @type {any} */ (self.#routeStore.data).routes);
      return routes[key];
    };
    return {
      /** @param {string} key @returns {RouteEntry | undefined} */
      get: entryOf,
      /** @param {string} sessionId @returns {{key: string, entry: RouteEntry} | undefined} */
      bySession(sessionId) {
        const routes = /** @type {Record<string, RouteEntry>} */ (/** @type {any} */ (self.#routeStore.data).routes);
        for (const [key, entry] of Object.entries(routes)) if (entry.sessionId === sessionId) return { key, entry };
        return undefined;
      },
      /**
       * @param {string} key
       * @param {{ sessionId: string, agentPreset?: string, userId?: string, cwd?: string, topic?: string }} binding
       * @returns {Promise<RouteEntry>}
       */
      async bind(key, binding) {
        return await self.#routeStore.update((data) => {
          const now = self.#clock.now();
          const previous = data.routes[key];
          const entry = {
            sessionId: binding.sessionId,
            ...(binding.agentPreset === undefined ? {} : { agentPreset: binding.agentPreset }),
            ...(binding.userId === undefined ? {} : { userId: binding.userId }),
            ...(binding.cwd === undefined ? {} : { cwd: binding.cwd }),
            ...(binding.topic === undefined ? {} : { topic: binding.topic }),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now
          };
          data.routes[key] = entry;
          return entry;
        });
      },
      /** @returns {string[]} */
      keys() {
        return Object.keys(/** @type {Record<string, unknown>} */ (/** @type {any} */ (self.#routeStore.data).routes));
      }
    };
  }

  /** 投递账本：一条回复只有一份终稿，重启后可恢复。 */
  get ledger() {
    const self = this;
    return {
      /**
       * 登记一次投递（回合开始时调用）。
       * @param {{ routeKey: string, sessionId: string, turn: number | null, kind: 'user'|'unattended' }} input
       * @returns {Promise<LedgerEntry>}
       */
      async open(input) {
        return await self.#ledgerStore.update((data) => {
          const now = self.#clock.now();
          /** @type {LedgerEntry} */
          const entry = {
            id: `${input.sessionId}:${input.turn ?? 'new'}:${now.toString(36)}`,
            routeKey: input.routeKey,
            sessionId: input.sessionId,
            turn: input.turn,
            kind: input.kind,
            state: 'open',
            messageId: null,
            finalHash: null,
            text: '',
            startedAt: now,
            updatedAt: now
          };
          data.entries.push(entry);
          const overflow = data.entries.length - self.#ledgerLimit;
          if (overflow > 0) data.entries.splice(0, overflow);
          return entry;
        });
      },
      /**
       * @param {string} id
       * @param {{ messageId?: string | null, messageIds?: string[], text?: string }} patch
       * @returns {Promise<void>}
       */
      async draft(id, patch) {
        await self.#ledgerStore.update((data) => {
          const entry = findEntry(data.entries, id);
          if (entry === undefined) return;
          if (patch.messageId !== undefined) entry.messageId = patch.messageId;
          if (patch.messageIds !== undefined) entry.messageIds = patch.messageIds;
          if (patch.text !== undefined) entry.text = patch.text;
          entry.updatedAt = self.#clock.now();
        });
      },
      /**
       * 写终稿；已 final 且哈希相同则幂等返回 false。
       * @param {string} id
       * @param {{ messageId: string, messageIds?: string[], text: string, finalHash: string }} final
       * @returns {Promise<{ written: boolean, entry?: LedgerEntry }>}
       */
      async finalize(id, final) {
        return await self.#ledgerStore.update((data) => {
          const entry = findEntry(data.entries, id);
          if (entry === undefined) return { written: false };
          if (entry.state === 'final' && entry.finalHash === final.finalHash) return { written: false, entry };
          entry.state = 'final';
          entry.messageId = final.messageId;
          if (final.messageIds !== undefined) entry.messageIds = final.messageIds;
          entry.text = final.text;
          entry.finalHash = final.finalHash;
          entry.updatedAt = self.#clock.now();
          return { written: true, entry };
        });
      },
      /**
       * @param {string} id
       * @param {string} reason
       * @returns {Promise<void>}
       */
      async abandon(id, reason) {
        await self.#ledgerStore.update((data) => {
          const entry = findEntry(data.entries, id);
          if (entry === undefined) return;
          if (entry.state === 'final') return;
          entry.state = 'aborted';
          entry.abandonReason = reason;
          entry.updatedAt = self.#clock.now();
        });
      },
      /**
       * 同一会话同一回合的既有投递记录（用于识别重复 turn/end 与重启恢复）。
       * @param {string} sessionId
       * @param {number} turn
       * @returns {LedgerEntry | undefined}
       */
      findByTurn(sessionId, turn) {
        const data = /** @type {{entries: LedgerEntry[]}} */ (/** @type {any} */ (self.#ledgerStore.data));
        return data.entries.findLast((entry) => entry.sessionId === sessionId && entry.turn === turn);
      },
      /** @param {string} routeKey @returns {LedgerEntry[]} */
      openFor(routeKey) {
        const data = /** @type {{entries: LedgerEntry[]}} */ (/** @type {any} */ (self.#ledgerStore.data));
        return data.entries.filter((entry) => entry.routeKey === routeKey && entry.state === 'open');
      },
      /** @returns {LedgerEntry[]} */
      all() {
        return [.../** @type {{entries: LedgerEntry[]}} */ (/** @type {any} */ (self.#ledgerStore.data)).entries];
      }
    };
  }

  /** 提问应答：待答提问、迟到补答所需的 callId 与消息位置。 */
  get approvals() {
    const self = this;
    return {
      /**
       * @param {string} id
       * @returns {PendingQuestion | undefined}
       */
      get(id) {
        return /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending)[id];
      },
      /**
       * @param {PendingQuestion} record
       * @returns {Promise<void>}
       */
      async put(record) {
        await self.#approvalStore.update((data) => {
          /** @type {any} */ (data).pending[record.id] = record;
          const keys = Object.keys(/** @type {any} */ (data).pending);
          const overflow = keys.length - self.#approvalLimit;
          if (overflow > 0) {
            for (const key of keys.slice(0, overflow)) delete /** @type {any} */ (data).pending[key];
          }
        });
      },
      /**
       * @param {string} id
       * @param {{ state: string, answers?: unknown, updatedAt?: number }} patch
       * @returns {Promise<void>}
       */
      async settle(id, patch) {
        await self.#approvalStore.update((data) => {
          const record = /** @type {any} */ (data).pending[id];
          if (record === undefined) return;
          Object.assign(record, patch);
        });
      },
      /** @param {string} sessionId @returns {PendingQuestion[]} */
      openForSession(sessionId) {
        const pending = /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending);
        return Object.values(pending).filter((record) => record.sessionId === sessionId && record.state === 'open');
      },
      /** @returns {PendingQuestion[]} */
      all() {
        const pending = /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending);
        return Object.values(pending);
      },
      /** @param {string} routeKey @returns {PendingQuestion[]} */
      openForRoute(routeKey) {
        const pending = /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending);
        return Object.values(pending).filter((record) => record.routeKey === routeKey && record.state === 'open');
      },
      /**
       * 仍在等待回答的记录，含已超时但仍可补答的那些。
       * @param {string} routeKey
       * @returns {PendingQuestion[]}
       */
      pendingForRoute(routeKey) {
        const pending = /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending);
        return Object.values(pending)
          .filter((record) => record.routeKey === routeKey && (record.state === 'open' || record.state === 'expired'))
          .sort((left, right) => left.createdAt - right.createdAt);
      },
      /** @param {string} routeKey @returns {PendingQuestion[]} */
      expiredForRoute(routeKey) {
        const pending = /** @type {Record<string, PendingQuestion>} */ (/** @type {any} */ (self.#approvalStore.data).pending);
        return Object.values(pending).filter((record) => record.routeKey === routeKey && record.state === 'expired');
      }
    };
  }

  /** 等待所有写入落盘。 @returns {Promise<void>} */
  async settled() {
    await Promise.all([
      this.#cursorStore.settled(),
      this.#receiptStore.settled(),
      this.#routeStore.settled(),
      this.#ledgerStore.settled(),
      this.#approvalStore.settled()
    ]);
  }
}

/**
 * @param {unknown} entries
 * @param {string} id
 * @returns {LedgerEntry | undefined}
 */
function findEntry(entries, id) {
  return /** @type {LedgerEntry[]} */ (entries).find((entry) => entry.id === id);
}

/**
 * @typedef {object} RouteEntry
 * @property {string} sessionId
 * @property {string} [agentPreset]
 * @property {string} [cwd] 话题绑定的工作目录（/new 沿用）
 * @property {string} [topic] 话题展示名（/whoami 与日志用）
 * @property {string} [userId] 绑定时记下平台用户 id，用于"推给 owner"（身份 diff、告警）
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {object} LedgerEntry
 * @property {string} id
 * @property {string} routeKey
 * @property {string} sessionId
 * @property {number | null} turn
 * @property {'user'|'unattended'} kind
 * @property {'open'|'final'|'aborted'} state
 * @property {string | null} messageId 首条消息（流式编辑的那条）
 * @property {string[]} [messageIds] 终稿分条时的全部消息 id
 * @property {string | null} finalHash
 * @property {string} text
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {string} [abandonReason]
 */

/**
 * @typedef {object} PendingQuestion
 * @property {string} id
 * @property {string} routeKey
 * @property {string} sessionId
 * @property {string} agentId
 * @property {string} [callId]
 * @property {boolean} timed
 * @property {string} channel
 * @property {string} account
 * @property {string} chatId
 * @property {string} [threadId]
 * @property {string} [messageId]
 * @property {import('./questions.js').RenderableQuestion[]} questions
 * @property {string} shortId 按钮回传用的短码（重启后仍可解析）
 * @property {Record<string, string[]>} selected 多选已选项
 * @property {{ id: string, selected: string[], custom?: string }[]} [answers]
 * @property {'open'|'answered'|'expired'|'skipped'} state
 * @property {number} createdAt
 * @property {number} updatedAt
 */