import { systemClock } from './util.js';

/** @typedef {import('./util.js').Clock} Clock */

/**
 * 进程内的易变状态：在途回合、最近错误、最近轮询。
 *
 * **不落盘**是刻意的：崩溃后「在途」这个事实已经不可信（副作用可能已发生），
 * 恢复走账本（`ledger.json` 里 state=open 的条目）而不是内存标记。
 */
export class RuntimeState {
  /**
   * 每条路由一个条目，`count` 是"已受理但还没结束的回合数"。
   * 计数而不是布尔，是因为同一聊天可以连着发多条消息：第二条在第一条结束前就被受理，
   * 同一路由可能有多个排队回合；计数可避免较早回合结束时误清较晚回合的在途状态。
   * @type {Map<string, { sessionId: string, since: number, turn: number | null, count: number }>}
   */
  inFlight = new Map();
  /** @type {string | null} */
  lastError = null;
  /** @type {number | null} */
  lastPoll = null;
  /** @type {boolean | null} */
  lastGetMeOk = null;
  /** @type {Clock} */
  #clock;

  /** @param {{ clock?: Clock }} [options] */
  constructor({ clock = systemClock } = {}) {
    this.#clock = clock;
  }

  /**
   * @param {string} routeKeyValue
   * @param {string} sessionId
   * @returns {void}
   */
  markInFlight(routeKeyValue, sessionId) {
    const entry = this.inFlight.get(routeKeyValue);
    if (entry === undefined) {
      this.inFlight.set(routeKeyValue, { sessionId, since: this.#clock.now(), turn: null, count: 1 });
      return;
    }
    entry.count += 1;
    entry.sessionId = sessionId;
  }

  /**
   * 一个回合结束时消耗一次标记（入站提交与回合结束一一配对）。
   * @param {string} routeKeyValue
   * @returns {boolean} 同一路由上是否还有排队的回合
   */
  consumeInFlight(routeKeyValue) {
    const entry = this.inFlight.get(routeKeyValue);
    if (entry === undefined) return false;
    entry.count -= 1;
    if (entry.count > 0) return true;
    this.inFlight.delete(routeKeyValue);
    return false;
  }

  /**
   * @param {string} routeKeyValue
   * @param {number} turn
   * @returns {void}
   */
  setTurn(routeKeyValue, turn) {
    const entry = this.inFlight.get(routeKeyValue);
    if (entry !== undefined) entry.turn = turn;
  }

  /** @param {string} routeKeyValue @returns {void} */
  clearInFlight(routeKeyValue) {
    this.inFlight.delete(routeKeyValue);
  }

  /** @param {string} sessionId @returns {string | undefined} */
  routeOfSession(sessionId) {
    for (const [key, entry] of this.inFlight) if (entry.sessionId === sessionId) return key;
    return undefined;
  }

  /** @returns {number} 在途回合数（排队中的都算） */
  get inFlightCount() {
    let total = 0;
    for (const entry of this.inFlight.values()) total += entry.count;
    return total;
  }

  /**
   * @param {unknown} error
   * @returns {void}
   */
  recordError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = `${new Date(this.#clock.now()).toISOString()} ${message}`;
  }

  /** @param {number} ts @returns {void} */
  recordPoll(ts) {
    this.lastPoll = ts;
  }

  /** 会话没有聊天绑定、投递被丢弃的次数（按回合计，不按事件计）。 */
  dropped = 0;

  /** @returns {void} */
  noteDrop() {
    this.dropped += 1;
  }

  /** @returns {number} */
  get droppedCount() {
    return this.dropped;
  }
}
