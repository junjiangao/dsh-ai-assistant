import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 锁被另一个存活进程持有；这是**预期**的拒绝，不是故障。 */
export class LockHeldError extends Error {
  /** @param {number} pid */
  constructor(pid) {
    super(`已在运行（pid ${pid}）；同一数据根只允许一个宿主进程，否则长轮询会 409、定时任务会双投递`);
    this.name = 'LockHeldError';
    /** @type {number} */
    this.pid = pid;
  }
}

/**
 * 整生命周期独占的 pid 锁（设计文档 §9.4）。
 *
 * 没有现成保护可用：desktop 的 `profiles/<name>/lock` 只是 profile 写操作的短锁，
 * `dsh --profile` 这条路上没有单实例机制。因此这里用 `O_EXCL` 建文件 + `kill(pid,0)` 探活：
 * 只有 `ESRCH`（确认不存在）才抢占；`EPERM` 视为存活，绝不抢占。
 */
export class PidLock {
  /** @type {string} */
  path;
  /** @type {number} */
  pid;
  /** @type {boolean} */
  #held = false;

  /**
   * @param {{ path: string, pid?: number }} options
   */
  constructor({ path, pid = process.pid }) {
    this.path = path;
    this.pid = pid;
  }

  /**
   * @returns {{ pid: number } | undefined} 当前持锁者（不判活）
   */
  holder() {
    try {
      const text = readFileSync(this.path, 'utf8').trim();
      const pid = Number.parseInt(text, 10);
      return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * 取得锁；被存活进程占用时抛 {@link LockHeldError}。
   * @returns {{ stolenFrom?: number }}
   */
  acquire() {
    mkdirSync(dirname(this.path), { recursive: true });
    /** @type {number | undefined} */
    let stolenFrom;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const fd = openSync(this.path, 'wx', 0o600);
        try {
          writeSync(fd, `${this.pid}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.#held = true;
        return stolenFrom === undefined ? {} : { stolenFrom };
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        const holder = this.holder();
        if (holder === undefined) continue;
        if (isAlive(holder.pid)) {
          // 同一 pid 既可能是"本实例已持有"，也可能是同进程里又挂了一份组合；
          // 后者必须拒绝，否则两条长轮询会各投递一次。
          throw new LockHeldError(holder.pid);
        }
        try {
          unlinkSync(this.path);
        } catch (unlinkError) {
          if (/** @type {NodeJS.ErrnoException} */ (unlinkError).code !== 'ENOENT') throw unlinkError;
        }
        stolenFrom = holder.pid;
        continue;
      }
    }
    throw new Error(`channel-core: 无法取得 pid 锁 ${this.path}（连续三次与其它进程竞争）`);
  }

  /** 仅当锁仍属于本进程时删除。 @returns {void} */
  release() {
    if (!this.#held) return;
    this.#held = false;
    const holder = this.holder();
    if (holder?.pid !== this.pid) return;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
  }

  /** @returns {boolean} */
  get held() {
    return this.#held;
  }
}

/**
 * 探活：只有 ESRCH 才判定"不存在"。
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false;
    // EPERM：存在但属于别的用户 —— 对"是否存活"而言仍是存在。
    return true;
  }
}