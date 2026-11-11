import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, PidLock, readHeartbeat } from '@junjiangao/channel-core';
import { identityProblems, loadIdentity } from './identity.js';

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {'ok'|'warn'|'fail'} status
 * @property {string} detail
 */

/**
 * 一页诊断（设计文档 §9.3）。
 *
 * 只读：不取 pid 锁、不启动通道、不写任何状态。因此在助理正在运行时也可以安全地跑。
 * 判定口径是"能不能用"，不是"配置是否齐全"：占位符传输缺 token 记 warn，真正的运行障碍才记 fail。
 *
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {{ dshHome: string, probeTimeoutMs: number }} deps.config
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {number} [deps.now]
 * @param {() => Promise<{ ok: boolean, detail?: string }>} [deps.probeTelegram]
 * @param {number} [deps.heartbeatStaleMs] 心跳超过这个年龄记 warn（默认 90s）
 * @returns {Promise<{ checks: Check[], ok: boolean, text: string }>}
 */
export async function runDoctor({ ctx, config, env = process.env, now = Date.now(), probeTelegram, heartbeatStaleMs = 90000 }) {
  /** @type {Check[]} */
  const checks = [];
  /** @param {string} name @param {'ok'|'warn'|'fail'} status @param {string} detail */
  const add = (name, status, detail) => checks.push({ name, status, detail: redactDetail(detail, env) });

  // 1. 数据根
  if (!existsSync(config.dshHome)) {
    add('数据根', 'fail', `${config.dshHome} 不存在；先跑 deploy/install.sh`);
  } else {
    try {
      accessSync(config.dshHome, constants.W_OK);
      add('数据根', 'ok', config.dshHome);
    } catch {
      add('数据根', 'fail', `${config.dshHome} 不可写`);
    }
  }

  // 2. 身份文件
  const identity = loadIdentity({ dshHome: config.dshHome });
  const missing = identity.files.filter((file) => !file.exists).map((file) => file.label);
  const problems = identityProblems(identity);
  const present = identity.files.filter((file) => file.exists);
  if (missing.includes('SOUL') && missing.includes('SYSTEM')) {
    add('身份', 'warn', `SOUL/SYSTEM 都不存在（${config.dshHome}/identity/）；助理会以默认人格运行`);
  } else {
    add('身份', problems.length > 0 ? 'warn' : 'ok', problems.length > 0
      ? `${present.map((file) => `${file.label} ${file.bytes}B`).join('、')}；${problems.join('；')}`
      : present.map((file) => `${file.label} ${file.bytes}B`).join('、'));
  }

  // 3. 心跳
  const heartbeat = readHeartbeat(join(config.dshHome, 'run', 'heartbeat.json'));
  if (heartbeat === undefined) {
    add('心跳', 'warn', '没有 heartbeat.json（助理可能没在运行，或还没写过一次）');
  } else {
    const ageMs = heartbeat.ts === undefined ? Number.POSITIVE_INFINITY : now - heartbeat.ts;
    const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s 前` : '时间戳不可读';
    add('心跳', ageMs > heartbeatStaleMs ? 'warn' : 'ok', `${age}；在途 ${heartbeat.inFlight ?? 0}，队列 ${heartbeat.queueDepth ?? 0}${heartbeat.lastError === null || heartbeat.lastError === undefined ? '' : `；最近错误：${heartbeat.lastError}`}`);
  }

  // 4. 单实例
  const lock = new PidLock({ path: join(config.dshHome, 'run', 'host.pid') });
  const holder = lock.holder();
  if (holder === undefined) add('单实例', 'ok', '没有 pid 锁；当前没有常驻进程');
  else if (isAlive(holder.pid)) add('单实例', 'ok', `pid ${holder.pid} 存活并持锁`);
  else add('单实例', 'warn', `pid ${holder.pid} 的锁是陈旧的（进程已不存在），下次启动会自动接管`);

  // 5. 代理（Telegram 只能出网，代理是显式依赖）
  const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY;
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  const proxyIssues = [];
  if (proxy === undefined || proxy === '') proxyIssues.push('未设置 http(s)_proxy');
  if (noProxy === undefined || !noProxy.includes('localhost')) proxyIssues.push('no_proxy 未包含 localhost');
  if (env.NODE_USE_ENV_PROXY !== '1') proxyIssues.push('NODE_USE_ENV_PROXY 未设为 1（Node fetch 默认不读代理）');
  add('代理', proxyIssues.length === 0 ? 'ok' : 'warn', proxyIssues.length === 0 ? '已配置出站代理，Node 环境代理已启用' : proxyIssues.join('；'));

  // 6. 通道连通性
  if (probeTelegram === undefined) {
    add('通道', 'warn', '没有可用的探活实现');
  } else {
    try {
      const probe = await probeTelegram();
      add('通道', probe.ok ? 'ok' : 'fail', probe.detail ?? (probe.ok ? '连通' : '不可用'));
    } catch (error) {
      add('通道', 'fail', `探活失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 7. 调度存储与任务数
  const scheduleFile = join(config.dshHome, 'storages', 'schedule.json');
  const scheduleService = /** @type {any} */ (ctx.get?.('schedule'));
  if (existsSync(scheduleFile)) {
    let detail = `${scheduleFile}（${statSync(scheduleFile).size}B）`;
    if (scheduleService !== undefined) {
      try {
        const tasks = await scheduleService.list({});
        detail = `${(tasks?.items ?? []).length} 个任务；${detail}`;
      } catch (error) {
        detail = `任务数读取失败：${String(error)}`;
      }
    }
    add('调度', 'ok', detail);
  } else {
    add('调度', 'ok', '还没有 schedule.json（没有创建过定时任务）');
  }

  // 8. 预设
  const presets = /** @type {any} */ (ctx.get?.('agentPresets'));
  if (presets === undefined) {
    add('预设', 'warn', '当前组合没有 agentPresets 服务');
  } else {
    try {
      const list = await presets.list();
      const ids = list.map((/** @type {{ id: string }} */ item) => item.id);
      add('预设', ids.includes('standard') ? 'ok' : 'warn', ids.length === 0 ? '没有任何预设' : ids.join('、'));
    } catch (error) {
      add('预设', 'warn', `读取失败：${String(error)}`);
    }
  }

  // 9. 会话目录
  const sessionsDir = join(config.dshHome, 'sessions');
  if (!existsSync(sessionsDir)) {
    add('会话', 'warn', `${sessionsDir} 不存在（还没有会话）`);
  } else {
    const count = readdirSync(sessionsDir).length;
    add('会话', 'ok', `${count} 项；${sessionsDir}`);
  }

  // 10. 身份留痕
  const historyDir = join(config.dshHome, 'identity-history');
  if (!existsSync(historyDir)) {
    add('留痕', 'warn', `${historyDir} 不存在；ExecStartPre 的 identity-snapshot.sh 还没跑过`);
  } else {
    const entries = readdirSync(historyDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const latest = entries.at(-1);
    if (latest === undefined) {
      add('留痕', 'warn', 'identity-history 为空');
    } else {
      const diffPath = join(historyDir, latest, 'DIFF.txt');
      const diff = existsSync(diffPath) ? readFileSync(diffPath, 'utf8').trim() : '';
      add('留痕', 'ok', `最近快照 ${latest}${diff === '' ? '（与上一版无差异）' : '（有变更，已在下次启动时推送）'}`);
    }
  }

  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  const lines = [
    `助理诊断（DSH_HOME=${config.dshHome}）`,
    ...checks.map((check) => `  ${icon(check.status)} ${check.name}：${check.detail}`),
    '',
    failed.length === 0
      ? `结论：可运行${warned.length === 0 ? '' : `（${warned.length} 项提示，不阻塞）`}`
      : `结论：有 ${failed.length} 项需要处理`
  ];
  return { checks, ok: failed.length === 0, text: `${lines.join('\n')}\n` };
}

/** @param {'ok'|'warn'|'fail'} status @returns {string} */
function icon(status) {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠️';
  return '❌';
}
/** 诊断可被复制到聊天或问题报告，凭据不应进入展示字段。 @param {string} text @param {NodeJS.ProcessEnv} env */
function redactDetail(text, env) {
  let result = text;
  for (const key of ['TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY', env.ASSISTANT_MODEL_KEY_ENV]) {
    const value = key === undefined ? undefined : env[key];
    if (value && value !== 'placeholder') {
      result = result.replaceAll(value, '[已隐藏]').replaceAll(encodeURIComponent(value), '[已隐藏]');
    }
  }
  return result
    .replace(/(https?:\/\/)[^\s/@]+@/gu, '$1[已隐藏]@')
    .replace(/(\/bot)\d+:[A-Za-z0-9_-]+/gu, '$1[已隐藏]');
}
