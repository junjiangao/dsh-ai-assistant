import { systemClock, sleep } from './util.js';

/** @typedef {import('./util.js').Clock} Clock */

/** 平台限速：适配器把 429 翻译成这个错误，core 读取 `retryAfterMs` 后重排队。 */
export class RateLimitedError extends Error {
  /** @param {number} retryAfterMs @param {string} [detail] */
  constructor(retryAfterMs, detail) {
    super(detail ?? `rate limited for ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    /** @type {number} */
    this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
  }
}

/**
 * 每 chat 的令牌桶（设计文档 §7.3 "每 chat 令牌桶，超限排队"）。
 *
 * 采用"存款"式令牌：`burst` 个初始令牌，每 `60_000 / perMinute` 毫秒补一个，上限 `burst`。
 * 取不到令牌时**等待**而不是失败——出站是必达语义，宁可慢。
 */
export class TokenBucket {
  /** @type {number} */
  #capacity;
  /** @type {number} */
  #refillMs;
  /** @type {Clock} */
  #clock;
  /** @type {number} */
  #tokens;
  /** @type {number} */
  #updatedAt;
  /** @type {(ms: number, signal?: AbortSignal) => Promise<void>} */
  #sleep;

  /** @param {{ perMinute: number, burst: number, clock?: Clock, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} options */
  constructor({ perMinute, burst, clock = systemClock, sleep: sleepFn = sleep }) {
    this.#capacity = burst;
    this.#refillMs = 60000 / perMinute;
    this.#clock = clock;
    this.#tokens = burst;
    this.#updatedAt = clock.now();
    this.#sleep = sleepFn;
  }

  /** @returns {void} */
  #refill() {
    const now = this.#clock.now();
    const elapsed = now - this.#updatedAt;
    if (elapsed <= 0) return;
    const gained = elapsed / this.#refillMs;
    this.#tokens = Math.min(this.#capacity, this.#tokens + gained);
    this.#updatedAt = now;
  }

  /**
   * 取得一个令牌，必要时等待。
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async take(signal) {
    while (true) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.#tokens) * this.#refillMs);
      await this.#sleep(Math.max(1, waitMs), signal);
    }
  }
}

/**
 * 每 chat 的串行队列 + 令牌桶 + 429 重试。
 *
 * 顺序保证来自每个 key 一条 promise 链：同一条消息的"新建 → 编辑 → 终稿"不会乱序；
 * 不同 chat 之间互不阻塞。
 */
export class ChatPacer {
  /** @type {Map<string, Promise<unknown>>} */
  #chains = new Map();
  /** @type {Map<string, TokenBucket>} */
  #buckets = new Map();
  /** @type {Map<string, number>} 每个 key 的在途/排队总数 */
  #pending = new Map();
  /** @type {number} */
  #perMinute;
  /** @type {number} */
  #burst;
  /** @type {Clock} */
  #clock;
  /** @type {number} */
  #maxRetries;
  /** @type {(ms: number, signal?: AbortSignal) => Promise<void>} */
  #sleep;

  /**
   * @param {{ perMinute: number, burst: number, clock?: Clock, maxRetries?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} options
   */
  constructor({ perMinute, burst, clock = systemClock, maxRetries = 2, sleep: sleepFn = sleep }) {
    this.#perMinute = perMinute;
    this.#burst = burst;
    this.#clock = clock;
    this.#maxRetries = maxRetries;
    this.#sleep = sleepFn;
  }

  /**
   * @param {string} key
   * @returns {number} 该 chat 等待中的次数（不含正在执行的一次）
   */
  depth(key) {
    return Math.max(0, (this.#pending.get(key) ?? 0) - 1);
  }

  /** @returns {number} 所有 chat 的排队深度之和 */
  get totalDepth() {
    let total = 0;
    for (const count of this.#pending.values()) total += Math.max(0, count - 1);
    return total;
  }

  /**
   * 在 `key` 的串行队列里执行一次出站动作。
   * @template T
   * @param {string} key
   * @param {(attempt: number) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async run(key, operation) {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const chain = previous.then(() => gate);
    this.#chains.set(key, chain);
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    try {
      await previous;
      const bucket = this.#bucket(key);
      for (let attempt = 0; ; attempt += 1) {
        await bucket.take();
        try {
          return await operation(attempt);
        } catch (error) {
          if (isRateLimited(error) && attempt < this.#maxRetries) {
            await this.#sleep(error.retryAfterMs);
            continue;
          }
          throw error;
        }
      }
    } finally {
      release();
      const remaining = (this.#pending.get(key) ?? 1) - 1;
      if (remaining <= 0) this.#pending.delete(key);
      else this.#pending.set(key, remaining);
      if (this.#chains.get(key) === chain) this.#chains.delete(key);
    }
  }

/** @param {string} key @returns {TokenBucket} */
  #bucket(key) {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = new TokenBucket({ perMinute: this.#perMinute, burst: this.#burst, clock: this.#clock, sleep: this.#sleep });
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }
}

/**
 * 适配器不必 import 本模块：任何带 `retryAfterMs` 的错误都按 429 处理，
 * 这样通道包可以零依赖 core 的类型系统而仍然遵守限速契约。
 * @param {unknown} error
 * @returns {error is { retryAfterMs: number }}
 */
export function isRateLimited(error) {
  return error instanceof RateLimitedError
    || (typeof error === 'object' && error !== null && 'retryAfterMs' in error && Number.isFinite(Number(/** @type {any} */ (error).retryAfterMs)));
}
