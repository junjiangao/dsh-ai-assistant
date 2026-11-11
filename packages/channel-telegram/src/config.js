import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 占位符 token 的判定：空、显式占位、或文档里的示例值。 */
const PLACEHOLDER = /^(|placeholder|changeme|change-me|your[_-]?token|123456:[A-Za-z0-9_-]*)$/iu;

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isPlaceholderToken(token) {
  return PLACEHOLDER.test(token.trim());
}

/**
 * @typedef {object} TelegramConfig
 * @property {string} dshHome
 * @property {string} account
 * @property {'simulated'|'http'} transport
 * @property {string} token
 * @property {string} apiBase
 * @property {number} pollIntervalMs
 * @property {number} timeoutMs
 * @property {string} simulateDir
 * @property {string} settingsPath 群/topic 角色配置（可缺失）
 */

/**
 * @param {Record<string, unknown>} [raw]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Readonly<TelegramConfig>}
 */
export function resolveTelegramConfig(raw = {}, env = process.env, home = homedir()) {
  const rawHome = typeof raw.home === 'string' && raw.home.trim() !== '' ? raw.home.trim() : undefined;
  const dshHome = resolve(rawHome ?? env.DSH_HOME ?? join(home, '.dsh-assistant'));
  const token = (typeof raw.token === 'string' && raw.token.trim() !== '' ? raw.token.trim() : (env.TELEGRAM_BOT_TOKEN ?? '').trim());
  const requested = raw.transport === undefined || raw.transport === 'auto'
    ? (isPlaceholderToken(token) ? 'simulated' : 'http')
    : raw.transport;
  if (requested !== 'simulated' && requested !== 'http') {
    throw new Error(`channel-telegram: transport 只能是 auto/simulated/http，收到 ${JSON.stringify(raw.transport)}`);
  }
  if (requested === 'http' && isPlaceholderToken(token)) {
    throw new Error('channel-telegram: transport=http 需要真实的 TELEGRAM_BOT_TOKEN；当前是占位符，请改用 simulated');
  }
  /** @param {string} key @param {number} fallback */
  const positive = (key, fallback) => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`channel-telegram: ${key} 必须是正整数`);
    }
    return value;
  };
  return Object.freeze({
    dshHome,
    account: typeof raw.account === 'string' && raw.account !== '' ? raw.account : 'default',
    transport: requested,
    token,
    apiBase: typeof raw.apiBase === 'string' && raw.apiBase !== '' ? raw.apiBase : 'https://api.telegram.org',
    pollIntervalMs: positive('pollIntervalMs', 1000),
    timeoutMs: positive('timeoutMs', 40000),
    simulateDir: typeof raw.simulateDir === 'string' && raw.simulateDir !== ''
      ? resolve(raw.simulateDir)
      : join(dshHome, 'channels', 'telegram', 'sim'),
    settingsPath: typeof raw.settingsPath === 'string' && raw.settingsPath !== ''
      ? resolve(raw.settingsPath)
      : join(dshHome, 'channels', 'telegram', 'settings.json')
  });
}
