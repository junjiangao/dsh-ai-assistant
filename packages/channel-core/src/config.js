import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * @typedef {object} CoreConfig
 * @property {string} dshHome 数据根（设计文档 §10）
 * @property {string} channelsDir `$DSH_HOME/channels`
 * @property {string} runDir `$DSH_HOME/run`
 * @property {string} auditDir `$DSH_HOME/audit`
 * @property {string} workspaceDir `$DSH_HOME/workspace`
 * @property {string} identityHistoryDir `$DSH_HOME/identity-history`
 * @property {readonly string[]} identityFiles 需要在启动时对账的身份文件
 * @property {number} receiptLimit 每通道保留的收据条数上限
 * @property {number} maxPromptChars 单条入站文本上限
 * @property {number} editIntervalMs 流式编辑最小间隔
 * @property {number} typingIntervalMs "正在输入"心跳间隔；0 关闭
 * @property {number} maxMessageChars 平台单条消息长度上限（超出的终稿分条发送）
 * @property {number} heartbeatIntervalMs 心跳写盘间隔
 * @property {number} questionTimeoutMs 阻塞式提问的兜底超时
 * @property {{perMinute: number, burst: number}} rate 每 chat 令牌桶
 * @property {Readonly<Record<string, readonly string[]>>} owners 通道 → 允许的用户 id 白名单
 * @property {boolean} pushIdentityDiff 启动时把身份变更推给 owner
 */

/**
 * 校验并补全 channel-core 的配置。
 *
 * 配置来自 bundle patch 的 `config` 段，可能只写一部分，因此这里同时承担默认值与
 * 「写错就 fail loudly」两件事：宁可启动失败，也不要带着错误的路径或空白名单跑起来。
 * @param {Record<string, unknown>} [raw]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Readonly<CoreConfig>}
 */
export function resolveCoreConfig(raw = {}, env = process.env, home = homedir()) {
  const rawHome = stringOrUndefined(raw.home) ?? stringOrUndefined(env.DSH_HOME);
  const dshHome = resolve(rawHome ?? join(home, '.dsh-assistant'));

  /**
   * @param {string} key
   * @param {number} fallback
   * @param {number} min
   * @returns {number}
   */
  const integer = (key, fallback, min) => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      throw new Error(`channel-core: 配置项 ${key} 必须是 >= ${min} 的整数，收到 ${JSON.stringify(value)}`);
    }
    return value;
  };

  const rateRaw = /** @type {Record<string, unknown>} */ (raw.rate ?? {});
  if (typeof rateRaw !== 'object' || rateRaw === null || Array.isArray(rateRaw)) {
    throw new Error('channel-core: 配置项 rate 必须是对象');
  }
  const perMinute = rateRaw.perMinute ?? 20;
  const burst = rateRaw.burst ?? 4;
  if (typeof perMinute !== 'number' || !Number.isFinite(perMinute) || perMinute <= 0) {
    throw new Error('channel-core: rate.perMinute 必须是正数');
  }
  if (typeof burst !== 'number' || !Number.isSafeInteger(burst) || burst < 1) {
    throw new Error('channel-core: rate.burst 必须是 >= 1 的整数');
  }

  const owners = resolveOwners(raw.owners);

  return Object.freeze({
    dshHome,
    channelsDir: join(dshHome, 'channels'),
    runDir: join(dshHome, 'run'),
    auditDir: join(dshHome, 'audit'),
    workspaceDir: join(dshHome, 'workspace'),
    identityHistoryDir: join(dshHome, 'identity-history'),
    identityFiles: Object.freeze([join(dshHome, 'identity', 'SOUL.md'), join(dshHome, 'identity', 'SYSTEM.md'), join(dshHome, 'AGENTS.md')]),
    receiptLimit: integer('receiptLimit', 5000, 16),
    maxPromptChars: integer('maxPromptChars', 32000, 1000),
    editIntervalMs: integer('editIntervalMs', 1200, 300),
    typingIntervalMs: integer('typingIntervalMs', 4000, 0),
    maxMessageChars: integer('maxMessageChars', 4000, 200),
    heartbeatIntervalMs: integer('heartbeatIntervalMs', 30000, 1000),
    questionTimeoutMs: integer('questionTimeoutMs', 600000, 1000),
    rate: Object.freeze({ perMinute, burst }),
    owners,
    pushIdentityDiff: raw.pushIdentityDiff === undefined ? true : raw.pushIdentityDiff === true
  });
}

/**
 * 白名单必须显式给出：空白名单会让助理对所有人开放，因此允许为空但由调用方决定是否拒答。
 * @param {unknown} value
 * @returns {Readonly<Record<string, readonly string[]>>}
 */
function resolveOwners(value) {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('channel-core: 配置项 owners 必须是 { 通道: [用户 id...] } 对象');
  }
  /** @type {Record<string, readonly string[]>} */
  const owners = {};
  for (const [channel, list] of Object.entries(value)) {
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new Error(`channel-core: owners.${channel} 必须是用户 id 字符串数组`);
    }
    owners[channel] = Object.freeze([...new Set(list.map((id) => id.trim()))]);
  }
  return Object.freeze(owners);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}