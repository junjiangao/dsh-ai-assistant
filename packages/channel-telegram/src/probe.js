import { createHttpTransport } from './transport.js';
import { isPlaceholderToken } from './config.js';

/**
 * `--doctor` 用的探活：没有真实 token 时如实说明"占位符传输"，而不是报失败。
 *
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
export async function probeFromEnv({ env = process.env, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (isPlaceholderToken(token)) {
    return { ok: true, detail: '占位符传输（未配置真实 TELEGRAM_BOT_TOKEN；消息走本地 sim/inbox.jsonl）' };
  }
  const transport = createHttpTransport({ token, fetchImpl, timeoutMs });
  try {
    const me = await transport.getMe();
    return { ok: true, detail: `@${me.username ?? 'unknown'}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
