/**
 * 出站渲染：core 只给纯文本与按钮，Telegram 的形状在这里落地。
 *
 * 刻意**不用** Markdown 解析模式：模型输出里的下划线、星号会把消息打乱，
 * 而"发错格式"比"少一点装饰"严重得多。
 */

/**
 * @param {import('@junjiangao/channel-core').Button[][] | undefined} buttons
 * @returns {{ inline_keyboard: { text: string, callback_data: string }[][] } | undefined}
 */
export function inlineKeyboard(buttons) {
  if (buttons === undefined || buttons.length === 0) return undefined;
  const rows = buttons
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((button) => {
      if (Buffer.byteLength(button.data, 'utf8') > 64) throw new Error(`callback_data 超过 64 字节：${button.data}`);
      return { text: button.label, callback_data: button.data };
    }));
  return rows.length === 0 ? undefined : { inline_keyboard: rows };
}

/**
 * 把通道的命令注册表翻成 Bot API 的 `setMyCommands` 形状。
 *
 * 命令名与描述是**对外可见**的（客户端 `/` 菜单），所以非法值直接抛错，
 * 让启动时的注册失败可见，而不是被 Telegram 静默拒绝。
 * @param {Array<{ name: string, description: string }>} commands
 * @returns {Array<{ command: string, description: string }>}
 */
export function commandMenu(commands) {
  /** @type {Set<string>} */
  const seen = new Set();
  return commands.map(({ name, description }) => {
    const command = name.toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/u.test(command)) throw new TypeError(`Telegram 命令名不合法：${JSON.stringify(name)}`);
    if (typeof description !== 'string' || description.trim().length < 3 || description.length > 256) {
      throw new TypeError(`Telegram 命令描述必须是 3–256 字符：${JSON.stringify(name)}`);
    }
    if (seen.has(command)) throw new TypeError(`Telegram 命令重复：${command}`);
    seen.add(command);
    return { command, description: description.trim() };
  });
}

/**
 * Telegram 单条消息上限 4096 字符；core 已经截断到更小的预算，这里再兜一次底。
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function clampText(text, limit = 4096) {
  if (text.length <= limit) return text;
  return `${[...text].slice(0, limit).join('')}\n…（已截断）`;
}
