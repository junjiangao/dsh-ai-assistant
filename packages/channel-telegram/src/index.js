import { createTelegramAdapter } from './adapter.js';
import { resolveTelegramConfig } from './config.js';
import { normalizeUpdate } from './normalize.js';
import { attachTopic, loadTelegramSettings } from './settings.js';
import { createHttpTransport, createSimulatedTransport } from './transport.js';

/** 稳定插件名。 */
export const name = 'channel-telegram';

/** 通道核心必须先就绪（它拥有路由、收据与账本）。 */
export const inject = ['channelCore'];

export { createTelegramAdapter } from './adapter.js';
export { normalizeUpdate, threadForSend } from './normalize.js';
export { createHttpTransport, createSimulatedTransport } from './transport.js';
export { probeFromEnv } from './probe.js';
export { isPlaceholderToken, resolveTelegramConfig } from './config.js';

/**
 * Telegram 通道（设计文档 §7）。
 *
 * 占位 token 使用本地传输；配置真实 TELEGRAM_BOT_TOKEN 后使用 Bot API。
 * 归一化和通道治理沿用同一组宿主接口。
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  // 兜底：patch 层已按启动参数关掉这些行；即便有人手工改了 patch，也不在 --once/--doctor 里起通道。
  const startup = /** @type {any} */ (ctx.get('assistantStartup'));
  if (startup !== undefined && startup.mode !== 'daemon') return;
  const config = resolveTelegramConfig(rawConfig);
  const settings = loadTelegramSettings(config.settingsPath);
  const transport = config.transport === 'http'
    ? createHttpTransport({ token: config.token, apiBase: config.apiBase, timeoutMs: config.timeoutMs })
    : createSimulatedTransport({ dir: config.simulateDir });

  const adapter = createTelegramAdapter({
    id: 'telegram',
    account: config.account,
    transport,
    pollIntervalMs: config.pollIntervalMs,
    // topic 规则只影响建会话时的 preset/cwd，不改变归一化与门控。
    normalize: (/** @type {any} */ update, /** @type {any} */ context) => attachTopic(normalizeUpdate(update, context), settings),
    logger: {
      info: (message) => ctx.logger.info(`[channel-telegram] ${message}`),
      warn: (message) => ctx.logger.warn(`[channel-telegram] ${message}`),
      error: (message) => ctx.logger.error(`[channel-telegram] ${message}`)
    }
  });

  const channelCore = ctx.get('channelCore');
  const host = channelCore.registerAdapter(adapter);
  ctx.logger.info(`channel-telegram: 传输=${config.transport}${config.transport === 'simulated' ? `（占位符，${config.simulateDir}）` : ''}`);
  if (settings.topics.length > 0) ctx.logger.info(`channel-telegram: 已加载 ${settings.topics.length} 条 topic 规则（${config.settingsPath}）`);

  adapter.start(host).catch((error) => ctx.logger.error(`channel-telegram: 轮询启动失败：${error instanceof Error ? error.message : String(error)}`));

  // 客户端 "/" 菜单：一次启动注册一次。失败只告警——菜单看不到不影响长轮询与命令本身。
  if (typeof channelCore.botCommands === 'function') {
    void adapter.setCommandMenu(channelCore.botCommands())
      .then((count) => ctx.logger.info(`channel-telegram: 已注册 ${count} 条命令菜单`))
      .catch((error) => ctx.logger.warn(`channel-telegram: 命令菜单注册失败：${error instanceof Error ? error.message : String(error)}`));
  }

  ctx.effect(() => async () => {
    await adapter.stop();
  }, 'channel-telegram: poll loop');
}