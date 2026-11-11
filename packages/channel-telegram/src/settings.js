import { existsSync, readFileSync } from 'node:fs';

/**
 * 频道运行期配置：群/topic → 角色（preset）与工作目录。
 *
 * 放在 `$DSH_HOME/channels/telegram/settings.json`，与 bundle patch 分开：
 * 改群配置不需要重装 profile，也不会把运行期状态写回仓库。
 *
 * 话题用 `(chatId, threadId)` 匹配；General 没有 thread id，按 `'1'` 匹配
 * （与路由/发送两侧的约定一致）。没有配置的项目按默认预设与默认目录运行。
 *
 * @typedef {object} TopicRule
 * @property {string} chatId
 * @property {string} [threadId]
 * @property {string} [name] 展示名，只在该话题的第一个回合写进对话
 * @property {string} [preset] 该话题新会话使用的 agent preset
 * @property {string} [cwd] 该话题新会话的工作目录
 */

/**
 * @typedef {object} TelegramSettings
 * @property {readonly TopicRule[]} topics
 * @property {(chatId: string, threadId?: string) => TopicRule | undefined} topicFor
 */

/** @returns {TelegramSettings} */
export function emptyTelegramSettings() {
  return Object.freeze({ topics: Object.freeze([]), topicFor: () => undefined });
}

/** @param {string} chatId @param {string} [threadId] @returns {string} */
function keyOf(chatId, threadId) {
  return `${chatId}:${threadId ?? '1'}`;
}

/**
 * 读取并校验 settings.json。文件不存在视为"没有配置"；
 * 存在但写错则抛错——宁可启动失败，也不要带着半套角色跑。
 * @param {string} filePath
 * @returns {TelegramSettings}
 */
export function loadTelegramSettings(filePath) {
  if (!existsSync(filePath)) return emptyTelegramSettings();
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`channel-telegram: 无法解析 ${filePath}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`channel-telegram: ${filePath} 顶层必须是对象`);
  }
  const rawTopics = /** @type {{ topics?: unknown }} */ (raw).topics ?? [];
  if (!Array.isArray(rawTopics)) throw new TypeError(`channel-telegram: ${filePath} 的 topics 必须是数组`);

  /** @type {Map<string, TopicRule>} */
  const index = new Map();
  /** @type {TopicRule[]} */
  const topics = [];
  rawTopics.forEach((item, position) => {
    const where = `topics[${position}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`channel-telegram: ${filePath} 的 ${where} 必须是对象`);
    }
    const record = /** @type {Record<string, unknown>} */ (item);
    const chatId = requiredString(record.chatId, where, 'chatId');
    if (!/^-?\d+$/u.test(chatId)) throw new TypeError(`channel-telegram: ${filePath} 的 ${where}.chatId 必须是整数`);
    const threadId = optionalString(record.threadId, where, 'threadId');
    if (threadId !== undefined && !/^\d+$/u.test(threadId)) {
      throw new TypeError(`channel-telegram: ${filePath} 的 ${where}.threadId 必须是非负整数`);
    }
    const name = optionalString(record.name, where, 'name');
    const preset = optionalString(record.preset, where, 'preset');
    const cwd = optionalString(record.cwd, where, 'cwd');
    /** @type {TopicRule} */
    const topic = Object.freeze({
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
      ...(name === undefined ? {} : { name }),
      ...(preset === undefined ? {} : { preset }),
      ...(cwd === undefined ? {} : { cwd })
    });
    const key = keyOf(topic.chatId, topic.threadId);
    if (index.has(key)) throw new Error(`channel-telegram: ${filePath} 里 ${where} 与前面的条目重复（${key}）`);
    index.set(key, topic);
    topics.push(topic);
  });

  return Object.freeze({
    topics: Object.freeze(topics),
    /** @param {string} chatId @param {string} [threadId] @returns {TopicRule | undefined} */
    topicFor(chatId, threadId) {
      return index.get(keyOf(chatId, threadId));
    }
  });
}

/**
 * 把命中的 topic 规则挂到归一化事件上；core 只在建会话时读它。
 * @param {any} event
 * @param {TelegramSettings} settings
 * @returns {any}
 */
export function attachTopic(event, settings) {
  if (event === null || typeof event !== 'object' || event.unsupported === true) return event;
  const topic = settings.topicFor(String(event.chatId ?? ''), event.threadId === undefined ? undefined : String(event.threadId));
  if (topic === undefined || (topic.name === undefined && topic.preset === undefined && topic.cwd === undefined)) return event;
  return {
    ...event,
    topic: {
      ...(topic.name === undefined ? {} : { name: topic.name }),
      ...(topic.preset === undefined ? {} : { preset: topic.preset }),
      ...(topic.cwd === undefined ? {} : { cwd: topic.cwd })
    }
  };
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {string} field
 * @returns {string}
 */
function requiredString(value, where, field) {
  const parsed = optionalString(value, where, field);
  if (parsed === undefined) throw new TypeError(`channel-telegram: settings.json 的 ${where}.${field} 必填`);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {string} field
 * @returns {string | undefined}
 */
function optionalString(value, where, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`channel-telegram: settings.json 的 ${where}.${field} 必须是非空字符串`);
  }
  return value.trim();
}
