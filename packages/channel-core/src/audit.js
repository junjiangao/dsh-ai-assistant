import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dayKeyUtc } from './util.js';

/**
 * 追加式审计日志：`$DSH_HOME/audit/YYYY-MM-DD.jsonl`。
 *
 * 一行一条、同步追加，宁可慢一点也不在崩溃时丢记录。写入失败不打断消息管线
 * （审计是旁路，不是正确性前提），但会沿 logger 报出来。
 */
export class AuditLog {
  /** @type {string} */
  #dir;
  /** @type {{ warn: (message: string) => void } | undefined} */
  #logger;

  /**
   * @param {{ dir: string, logger?: { warn: (message: string) => void } }} options
   */
  constructor({ dir, logger }) {
    this.#dir = dir;
    this.#logger = logger;
  }

  /**
   * 追加一条审计。`fields` 里**不能**有 `kind`：它展开在事件名之后，会把事件名覆盖掉
   * 显式限定事件形状，避免业务字段覆盖审计类型。
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   * @returns {void}
   */
  record(kind, fields) {
    const now = Date.now();
    const line = JSON.stringify({ ts: new Date(now).toISOString(), kind, ...fields });
    try {
      mkdirSync(this.#dir, { recursive: true });
      appendFileSync(join(this.#dir, `${dayKeyUtc(now)}.jsonl`), `${line}\n`, { mode: 0o600 });
    } catch (error) {
      this.#logger?.warn(`channel-core: 审计写入失败：${String(error)}`);
    }
  }
}
