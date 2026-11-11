/**
 * 按钮回传的紧凑编码。
 *
 * Telegram 的 `callback_data` 上限 64 字节，因此这里用定长短码：
 * `v1|<记录短码 8>|<题序>|<选项序>|<动作>`，最长约 20 字节。
 * 解码对任何不认识的输入返回 `undefined`——按钮数据来自外部，必须当作不可信输入处理。
 */

const ACTIONS = new Set(['o', 's']);

/**
 * @param {{ recordShortId: string, questionIndex: number, optionIndex: number, action: 'o'|'s' }} input
 * @returns {string}
 */
export function encodeCallback({ recordShortId, questionIndex, optionIndex, action }) {
  return `v1|${recordShortId}|${questionIndex}|${optionIndex}|${action}`;
}

/**
 * @param {string} data
 * @returns {{ recordShortId: string, questionIndex: number, optionIndex: number, action: 'o'|'s' } | undefined}
 */
export function decodeCallback(data) {
  const parts = data.split('|');
  if (parts.length !== 5 || parts[0] !== 'v1') return undefined;
  const [, recordShortId, q, o, action] = parts;
  if (!/^[0-9a-z]{6,12}$/u.test(recordShortId ?? '')) return undefined;
  const questionIndex = Number.parseInt(q ?? '', 10);
  const optionIndex = Number.parseInt(o ?? '', 10);
  if (!Number.isSafeInteger(questionIndex) || questionIndex < 0) return undefined;
  if (!Number.isSafeInteger(optionIndex) || optionIndex < -1) return undefined;
  if (action === undefined || !ACTIONS.has(action)) return undefined;
  return { recordShortId: /** @type {string} */ (recordShortId), questionIndex, optionIndex, action: /** @type {'o'|'s'} */ (action) };
}
