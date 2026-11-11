import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {{ now: () => number }} Clock */

/** 默认时钟；测试注入固定时钟。 @type {Clock} */
export const systemClock = { now: () => Date.now() };

/**
 * 稳定短哈希，用于终稿去重与幂等键。
 * @param {string} text
 * @returns {string} 16 位十六进制
 */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 生成短随机标识（非安全用途，仅用于文件名与记录 id）。
 * @param {string} prefix
 * @returns {string}
 */
export function shortId(prefix = '') {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 可被 AbortSignal 打断的睡眠。定时器不 unref：调用方在 await 它。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    /** @returns {void} */
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Error}
 */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('aborted');
}

/**
 * 以 UTC 计算日键，审计与附件目录都用它，避免夏令时带来的重复/缺日。
 * @param {number} ts
 * @returns {string} YYYY-MM-DD
 */
export function dayKeyUtc(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 文件系统友好的文件名：保留中文与常见符号，替换路径分隔符与控制字符。
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeFileName(name, fallback = 'attachment') {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replaceAll(/[\u0000-\u001f\u007f]/gu, '')
    .replaceAll(/[<>:"|?*]/gu, '_')
    .replace(/^\.+/u, '_')
    .trim();
  const limited = [...cleaned].slice(0, 120).join('');
  return limited === '' ? fallback : limited;
}

/**
 * 截断长文本并留下明确标记，避免把整条消息无声吃掉。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (text.length <= max) return text;
  const head = [...text].slice(0, max).join('');
  return `${head}\n\n…（原文 ${text.length} 字符，已截断至 ${max}）`;
}

/**
 * 把相对观测映射成稳定排序的键，用于路由表的复合键。
 * @param {{channel: string, account: string, chatId: string, threadId?: string}} route
 * @returns {string}
 */
export function routeKey(route) {
  return [route.channel, route.account, route.chatId, route.threadId ?? ''].join(':');
}

/**
 * 反向解析路由键；键内不允许冒号出现在前四段之外的语义里，因此用定界符切四段。
 * @param {string} key
 * @returns {{channel: string, account: string, chatId: string, threadId?: string}}
 */
export function parseRouteKey(key) {
  const [channel, account, chatId, threadId] = key.split(':');
  if (channel === undefined || account === undefined || chatId === undefined) {
    throw new Error(`malformed route key: ${JSON.stringify(key)}`);
  }
  return { channel, account, chatId, ...(threadId === undefined || threadId === '' ? {} : { threadId }) };
}

/**
 * 尽力把目录项落盘：打开目录 fsync，失败不致命（部分文件系统不支持）。
 * @param {string} dir
 * @returns {void}
 */
export function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* 目录 fsync 是加固项，不是正确性前提 */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 日期目录（附件落盘）。 @param {string} root @param {number} ts @returns {string} */
export function inboxDirFor(root, ts) {
  return join(root, dayKeyUtc(ts));
}