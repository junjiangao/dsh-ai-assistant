import { writeJsonAtomicSync } from './json-store.js';
import { systemClock } from './util.js';

/** @typedef {import('./util.js').Clock} Clock */

/**
 * @typedef {object} HeartbeatState
 * @property {number} ts
 * @property {number} pid
 * @property {number} startedAt
 * @property {number | null} lastPoll
 * @property {boolean | null} lastGetMeOk
 * @property {number} inFlight
 * @property {number} queueDepth
 * @property {string | null} lastError
 * @property {Record<string, unknown>} adapters
 */

/**
 * 心跳与诊断面（设计文档 §9.3）。
 *
 * DSH 没有 pidfile，非 Web profile 启动成功完全静默，所以存活必须有自证：
 * 每 `intervalMs` 原子写一次 `$DSH_HOME/run/heartbeat.json`，字段就是 doctor 与健康计时器要读的那几个。
 * 定时器**不 unref**：它本身就是常驻进程的 ref 句柄之一。
 */
export class Heartbeat {
  /** @type {string} */
  path;
  /** @type {number} */
  intervalMs;
  /** @type {Clock} */
  #clock;
  /** @type {NodeJS.Timeout | undefined} */
  #timer;
  /**
   * @type {{ ts: number, pid: number, startedAt: number, lastPoll: number | null, lastGetMeOk: boolean | null,
   *   inFlight: number, queueDepth: number, dropped: number, lastError: string | null, adapters: Record<string, unknown> }}
   */
  #state;

  /**
   * @param {{ path: string, intervalMs?: number, clock?: Clock, pid?: number }} options
   */
  constructor({ path, intervalMs = 30000, clock = systemClock, pid = process.pid }) {
    this.path = path;
    this.intervalMs = intervalMs;
    this.#clock = clock;
    const now = clock.now();
    this.#state = {
      ts: now,
      pid,
      startedAt: now,
      lastPoll: null,
      lastGetMeOk: null,
      inFlight: 0,
      queueDepth: 0,
      dropped: 0,
      lastError: null,
      adapters: {}
    };
  }

  /** 启动周期写盘；返回 disposer（由 ctx.effect 持有）。 @returns {() => void} */
  start() {
    this.write();
    this.#timer = setInterval(() => this.write(), this.intervalMs);
    return () => {
      if (this.#timer !== undefined) clearInterval(this.#timer);
      this.#timer = undefined;
      this.write();
    };
  }

  /**
   * 更新字段并立即落盘（重要状态点，例如探活失败）。
   * @param {Partial<{ lastPoll: number | null, lastGetMeOk: boolean | null, inFlight: number, queueDepth: number, dropped: number, lastError: string | null }>} patch
   * @returns {void}
   */
  update(patch) {
    Object.assign(this.#state, patch);
    this.write();
  }

  /**
   * 通道适配器自报状态（/status 与 doctor 读取）。
   * @param {string} adapter
   * @param {unknown} detail
   * @returns {void}
   */
  report(adapter, detail) {
    this.#state.adapters[adapter] = detail;
  }

  /** @returns {HeartbeatState} 当前快照（浅拷贝） */
  snapshot() {
    return { ...this.#state, adapters: { ...this.#state.adapters } };
  }

  /** @returns {void} */
  write() {
    this.#state.ts = this.#clock.now();
    try {
      writeJsonAtomicSync(this.path, this.#state);
    } catch (error) {
      // 心跳写不进去不至于让助理停摆，但必须可见。
      process.stderr.write(`channel-core: 心跳写入失败（${this.path}）：${String(error)}\n`);
    }
  }
}