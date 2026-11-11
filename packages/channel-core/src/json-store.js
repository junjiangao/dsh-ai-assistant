import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fsyncDir } from './util.js';

/**
 * @typedef {object} LoggerLike
 * @property {(message: string) => void} warn
 */

/**
 * 单文件 JSON 持久化：读旧值、原子写、串行化写入。
 *
 * 设计约束（对应设计文档 §7.2/§9.4 的崩溃语义）：
 * - 写路径是「同目录临时文件 → fsync → rename → fsync 目录」，进程被杀不会留下半截 JSON；
 * - 同一文件的并发写入被串行化成一条 promise 链，后写覆盖前写；
 * - 读到无法解析的内容时**保留证据**（改名 `.corrupt-<ts>`）并回落到初始值，同时沿日志与审计报出来，
 *   而不是让一个坏文件把常驻进程卡死。
 */
export class JsonStore {
  /** @type {string} */
  path;
  /** @type {unknown} */
  #data;
  /** @type {() => unknown} */
  #initial;
  /** @type {LoggerLike | undefined} */
  #logger;
  /** @type {Promise<void>} */
  #chain = Promise.resolve();
  /** @type {boolean} */
  #loaded = false;

  /**
   * @param {{ path: string, initial: () => unknown, logger?: LoggerLike }} options
   */
  constructor({ path, initial, logger }) {
    this.path = path;
    this.#initial = initial;
    this.#logger = logger;
    this.#data = initial();
  }

  /**
   * 读盘；损坏时隔离坏文件并回落到初始值。
   * @returns {{ recovered: boolean }}
   */
  load() {
    this.#loaded = true;
    let text;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        this.#data = this.#initial();
        return { recovered: false };
      }
      throw error;
    }
    try {
      this.#data = JSON.parse(text);
      return { recovered: false };
    } catch {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        /* 隔离失败不改变可继续性 */
      }
      this.#logger?.warn(`channel-core: 无法解析 ${this.path}，已改名为 ${aside} 并从空状态继续`);
      this.#data = this.#initial();
      return { recovered: true };
    }
  }

  /** @returns {unknown} 当前内存值（调用方按约定结构读取） */
  get data() {
    if (!this.#loaded) throw new Error(`JsonStore ${this.path} 尚未 load()`);
    return this.#data;
  }

  /**
   * 串行修改并落盘：修改函数同步执行，随后立即持久化。
   * @template T
   * @param {(data: any) => T} mutate
   * @returns {Promise<T>}
   */
  async update(mutate) {
    const run = this.#chain.then(async () => {
      const result = mutate(this.#data);
      await this.#write();
      return result;
    });
    this.#chain = run.then(() => undefined, () => undefined);
    return await run;
  }

  /** 等待已排队的写入全部完成。 @returns {Promise<void>} */
  async settled() {
    await this.#chain;
  }

  /** 同步落盘（dispose 路径使用；与 update 的链不叠加，调用前先 settled）。 @returns {void} */
  saveSync() {
    this.#writeSync();
  }

  /** @returns {Promise<void>} */
  async #write() {
    this.#writeSync();
  }

  /** @returns {void} */
  #writeSync() {
    writeJsonAtomicSync(this.path, this.#data);
  }
}

/**
 * 原子写一个 JSON 文件：同目录临时文件 → fsync → rename → fsync 目录。
 * @param {string} path
 * @param {unknown} value
 * @returns {void}
 */
export function writeJsonAtomicSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/**
 * 读取一个可能不存在的 JSON 文件（只读快照，不参与写入）。
 * @param {string} path
 * @returns {unknown | undefined}
 */
export function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}