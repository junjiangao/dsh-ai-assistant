import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * @typedef {object} StartupConfig
 * @property {string} dshHome
 * @property {number} onceTimeoutMs
 * @property {number} probeTimeoutMs
 * @property {string} workspaceDir
 */

/**
 * @param {Record<string, unknown>} [raw]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Readonly<StartupConfig>}
 */
export function resolveStartupConfig(raw = {}, env = process.env, home = homedir()) {
  const rawHome = typeof raw.home === 'string' && raw.home.trim() !== '' ? raw.home.trim() : undefined;
  const dshHome = resolve(rawHome ?? env.DSH_HOME ?? join(home, '.dsh-assistant'));
  /** @param {string} key @param {number} fallback */
  const positive = (key, fallback) => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`assistant-startup: 配置项 ${key} 必须是正整数，收到 ${JSON.stringify(value)}`);
    }
    return value;
  };
  return Object.freeze({
    dshHome,
    workspaceDir: join(dshHome, 'workspace'),
    onceTimeoutMs: positive('onceTimeoutMs', 600000),
    probeTimeoutMs: positive('probeTimeoutMs', 5000)
  });
}
