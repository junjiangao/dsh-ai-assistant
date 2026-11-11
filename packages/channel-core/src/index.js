import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from './audit.js';
import { createApprovals } from './approvals.js';
import { createCommands } from './commands.js';
import { resolveCoreConfig } from './config.js';
import { Heartbeat } from './heartbeat.js';
import { createInbound } from './inbound.js';
import { isAlive, LockHeldError, PidLock } from './lock.js';
import { readJsonIfExists, writeJsonAtomicSync } from './json-store.js';
import { createOutbound } from './outbound.js';
import { createQuestions } from './questions.js';
import { ChatPacer, RateLimitedError } from './rate-limit.js';
import { RuntimeState } from './runtime.js';
import { ChannelStores } from './stores.js';
import { inboxDirFor, parseRouteKey, routeKey as routeKeyOf, safeFileName, systemClock } from './util.js';

/**
 * 通道契约的类型别名：适配器包通过 `import('@junjiangao/channel-core').ChannelHost` 取用，
 * 这样通道包不需要依赖 core 的运行时实现，只依赖它的类型。
 * @typedef {import('./protocol.js').ChannelAdapter} ChannelAdapter
 * @typedef {import('./protocol.js').ChannelHost} ChannelHost
 * @typedef {import('./protocol.js').Button} Button
 * @typedef {import('./protocol.js').ChatRef} ChatRef
 * @typedef {import('./protocol.js').InboundEvent} InboundEvent
 * @typedef {import('./protocol.js').IngestResult} IngestResult
 * @typedef {import('./stores.js').RouteEntry} RouteEntry
 * @typedef {import('./questions.js').RenderableQuestion} RenderableQuestion
 * @typedef {import('./questions.js').Answer} Answer
 */

/** 稳定插件名。 */
export const name = 'channel-core';

/** 会话控制是唯一硬依赖；提问、预设、调度都是可选的（缺失时功能降级而不是崩溃）。 */
export const inject = ['sessionController'];

export const VERSION = '0.1.0';

// 供配套工具（doctor）复用的原语：锁的语义必须只有一份实现。
export { isAlive, LockHeldError, PidLock };

/**
 * 通道无关的治理层（设计文档 §7.1）。
 *
 * 提供 `channelCore` 服务，适配器（`@junjiangao/channel-telegram`）通过 `registerAdapter` 接入；
 * 会话、路由、去重、账本、限速、提问、心跳与单实例锁都在这里，适配器一律不重复实现。
 *
 * 生命周期：持有 pid 锁 → 起心跳 → 恢复账本 → 等适配器注册 → 收事件。dispose 时逆序释放，
 * 且**不注册**自己的 signal handler / `process.exit`（设计文档 §9.5，信号由启动器兜底）。
 *
 * @param {any} ctx Cordis 插件上下文
 * @param {Record<string, unknown>} [rawConfig]
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  // 兜底：patch 层已按启动参数关掉这些行；即便有人手工改了 patch，也不在 --once/--doctor 里起通道。
  const startup = /** @type {any} */ (ctx.get('assistantStartup'));
  if (startup !== undefined && startup.mode !== 'daemon') return;
  const config = resolveCoreConfig(rawConfig);
  const clock = systemClock;
  const logger = {
    debug: (/** @type {string} */ message) => ctx.logger.debug(`[channel-core] ${message}`),
    info: (/** @type {string} */ message) => ctx.logger.info(`[channel-core] ${message}`),
    warn: (/** @type {string} */ message) => ctx.logger.warn(`[channel-core] ${message}`),
    error: (/** @type {string} */ message) => ctx.logger.error(`[channel-core] ${message}`)
  };

  for (const dir of [config.runDir, config.channelsDir, config.auditDir, config.workspaceDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // ── 单实例锁 ────────────────────────────────────────────────────────────────
  const lock = new PidLock({ path: join(config.runDir, 'host.pid') });
  try {
    const result = lock.acquire();
    if (result.stolenFrom !== undefined) logger.warn(`接管了已死进程 ${result.stolenFrom} 遗留的 pid 锁`);
  } catch (error) {
    if (error instanceof LockHeldError) {
      // appExit 可能在日志刷出前就结束进程，所以先同步写 stderr，再请求退出。
      process.stderr.write(`dsh: ${error.message}\n`);
      logger.error(error.message);
      ctx.get('appExit')?.(1);
      throw error;
    }
    throw error;
  }

  const state = new RuntimeState({ clock });
  const heartbeat = new Heartbeat({ path: join(config.runDir, 'heartbeat.json'), intervalMs: config.heartbeatIntervalMs, clock });
  const audit = new AuditLog({ dir: config.auditDir, logger });
  const pacer = new ChatPacer({ ...config.rate, clock });

  /** @type {Map<string, ChannelStores>} */
  const stores = new Map();
  /** @type {Map<string, import('./protocol.js').ChannelAdapter>} */
  const adapters = new Map();

  /**
   * @param {string} channel
   * @returns {ChannelStores}
   */
  function storeFor(channel) {
    let store = stores.get(channel);
    if (store === undefined) {
      store = new ChannelStores({
        dir: join(config.channelsDir, channel),
        channel,
        clock,
        logger,
        receiptLimit: config.receiptLimit
      });
      stores.set(channel, store);
      if (store.recoveredFiles > 0) {
        logger.warn(`通道 ${channel} 有 ${store.recoveredFiles} 个状态文件损坏，已隔离并从空状态继续`);
        audit.record('store-recovered', { channel, files: store.recoveredFiles });
      }
    }
    return store;
  }

  /** @type {(sessionId: string) => { routeKey: string, route: { channel: string, account: string, chatId: string, threadId?: string }, entry: import('./stores.js').RouteEntry, stores: ChannelStores } | undefined} */
  function resolveRoute(sessionId) {
    for (const [channel, store] of stores) {
      const found = store.routes.bySession(sessionId);
      if (found === undefined) continue;
      const route = parseRouteKey(found.key);
      if (route.channel !== channel) continue;
      return { routeKey: found.key, route, entry: found.entry, stores: store };
    }
    return undefined;
  }

  /** @returns {Array<{ routeKey: string, route: { channel: string, account: string, chatId: string, threadId?: string }, entry: import('./stores.js').RouteEntry, stores: ChannelStores }>} */
  function allRoutes() {
    const list = [];
    for (const store of stores.values()) {
      for (const key of store.routes.keys()) {
        const entry = store.routes.get(key);
        if (entry === undefined) continue;
        list.push({ routeKey: key, route: parseRouteKey(key), entry, stores: store });
      }
    }
    return list;
  }

  /** @param {string} channel @returns {import('./protocol.js').ChannelAdapter | undefined} */
  function adapterFor(channel) {
    return adapters.get(channel);
  }

  const outbound = createOutbound({ config, clock, logger, audit, state, heartbeat, pacer, resolveRoute, adapterFor, allRoutes });
  const questions = createQuestions({
    config,
    clock,
    logger,
    audit,
    resolveRoute,
    adapterFor,
    userQuestions: () => /** @type {any} */ (ctx.get('userQuestions')),
    sessionController: /** @type {any} */ (ctx.get('sessionController')),
    sendDirect: outbound.sendDirect
  });
  const approvals = createApprovals({ resolveRoute, adapterFor, sendDirect: outbound.sendDirect });
  ctx.on('approval/request', (/** @type {any} */ request, /** @type {any} */ next) => approvals.request(request, next), { global: true });
  const commands = createCommands({
    logger,
    audit,
    state,
    sessionController: /** @type {any} */ (ctx.get('sessionController')),
    agentPresets: () => /** @type {any} */ (ctx.get('agentPresets')),
    commandsService: () => /** @type {any} */ (ctx.get('commands')),
    questions,
    approvals,
    report: (context) => buildStatus(context?.routeKey),
    sendDirect: outbound.sendDirect
  });
  const inbound = createInbound({
    config,
    clock,
    logger,
    audit,
    state,
    heartbeat,
    storeFor,
    sessionController: /** @type {any} */ (ctx.get('sessionController')),
    questions,
    approvals,
    commands
  });

  // ── 事件接线：必须 global，否则会被 agent/session 作用域过滤掉 ──────────────
  ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    void outbound.onSessionEvent(session, event).catch((error) => logger.warn(`session/event 处理失败：${String(error)}`));
  }, { global: true });

  ctx.on('agent/assistant-stream', (/** @type {any} */ payload) => {
    try {
      outbound.onAssistantStream(payload);
    } catch (error) {
      logger.warn(`assistant-stream 处理失败：${String(error)}`);
    }
  }, { global: true });

  ctx.on('user-questions/request', (/** @type {any} */ request, /** @type {any} */ next) => questions.handleRequest(request, next), { global: true });

  // ── 服务面 ────────────────────────────────────────────────────────────────
  /**
   * 适配器注册入口。
   * @param {import('./protocol.js').ChannelAdapter} adapter
   * @returns {import('./protocol.js').ChannelHost}
   */
  function registerAdapter(adapter) {
    if (typeof adapter?.id !== 'string' || adapter.id.trim() === '') throw new TypeError('channel-core: adapter.id 必须是非空字符串');
    if (adapters.has(adapter.id)) throw new Error(`channel-core: 通道 ${adapter.id} 已经注册过`);
    const store = storeFor(adapter.id);
    adapters.set(adapter.id, adapter);
    audit.record('adapter-registered', { channel: adapter.id });
    logger.info(`通道 ${adapter.id} 已注册`);

    /** @type {import('./protocol.js').ChannelHost} */
    const host = {
      ingest: (event, options) => inbound.ingest(event, options),
      cursor: { get: () => store.cursor.get() },
      advanceCursor: async (next) => await store.cursor.advance(next),
      reportPoll: (ts) => {
        state.recordPoll(ts);
        heartbeat.update({ lastPoll: ts });
      },
      reportError: (error) => {
        state.recordError(error);
        heartbeat.update({ lastError: state.lastError });
        audit.record('adapter-error', { channel: adapter.id, error: error instanceof Error ? error.message : String(error) });
      },
      reportHealth: (detail) => {
        heartbeat.report(adapter.id, detail);
        if (typeof detail?.ok === 'boolean') {
          state.lastGetMeOk = detail.ok;
          heartbeat.update({ lastGetMeOk: detail.ok });
        }
      },
      saveAttachment: async ({ name: fileName, bytes }) => await saveAttachment(adapter.id, { name: fileName, bytes }),
      inboxDir: join(config.workspaceDir, 'inbox'),
      stats: () => ({ inFlight: state.inFlightCount, queueDepth: pacer.totalDepth }),
      log: { info: (message) => logger.info(`[${adapter.id}] ${message}`), warn: (message) => logger.warn(`[${adapter.id}] ${message}`) }
    };

    // 恢复必须等适配器注册后做：否则没有出站通道，中断提示发不出去。
    void (async () => {
      try {
        await outbound.recoverInterrupted(adapter.id);
        await questions.expireStale(store);
        await notifyIdentityChange(adapter.id);
      } catch (error) {
        logger.warn(`通道 ${adapter.id} 的启动对账失败：${String(error)}`);
      }
    })();
    return host;
  }

  /**
   * @param {string} channel
   * @param {{ name?: string, bytes: Uint8Array }} input
   * @returns {Promise<string>}
   */
  async function saveAttachment(channel, { name: fileName, bytes }) {
    const dir = inboxDirFor(join(config.workspaceDir, 'inbox'), clock.now());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = safeFileName(fileName ?? 'attachment');
    const stem = safe.includes('.') ? safe.slice(0, safe.lastIndexOf('.')) : safe;
    const extension = safe.includes('.') ? safe.slice(safe.lastIndexOf('.')) : '';
    for (let index = 0; index < 1000; index += 1) {
      const candidate = join(dir, index === 0 ? safe : `${stem}-${index}${extension}`);
      try {
        writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 });
        audit.record('attachment-saved', { channel, path: candidate, bytes: bytes.byteLength });
        return candidate;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`channel-core: 附件目录 ${dir} 中无法分配唯一文件名`);
  }

  /**
   * 身份变更推送：`identity-snapshot.sh` 在启动前写好快照与 DIFF，这里把非空 DIFF 推给 owner。
   * 每个快照目录只推一次（`.notified` 标记）。
   * @param {string} channel
   * @returns {Promise<void>}
   */
  async function notifyIdentityChange(channel) {
    if (!config.pushIdentityDiff) return;
    const latest = latestIdentitySnapshot();
    if (latest === undefined) return;
    const diffPath = join(latest, 'DIFF.txt');
    if (!existsSync(diffPath)) return;
    const diff = readFileSync(diffPath, 'utf8').trim();
    if (diff === '') return;
    const marker = join(latest, '.notified');
    if (existsSync(marker)) return;
    const owners = config.owners[channel] ?? [];
    const route = allRoutes()
      .filter((candidate) => candidate.route.channel === channel && candidate.entry.userId !== undefined && owners.includes(candidate.entry.userId))
      .sort((left, right) => right.entry.updatedAt - left.entry.updatedAt)[0];
    if (route === undefined) return;
    const sent = await outbound.sendDirect(
      { channel, chatId: route.route.chatId, ...(route.route.threadId === undefined ? {} : { threadId: route.route.threadId }) },
      `🪞 身份文件在启动前有变更（${latest.split('/').pop()}）：\n\n${diff.slice(0, 3500)}`
    );
    if (sent.messageId !== undefined) {
      writeFileSync(marker, `${new Date(clock.now()).toISOString()}\n`, { flag: 'wx', mode: 0o600 });
      audit.record('identity-diff-pushed', { channel, snapshot: latest.split('/').pop() });
    }
  }

  /** @returns {string | undefined} */
  function latestIdentitySnapshot() {
    if (!existsSync(config.identityHistoryDir)) return undefined;
    const entries = readdirSync(config.identityHistoryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const latest = entries.at(-1);
    return latest === undefined ? undefined : join(config.identityHistoryDir, latest);
  }

  /**
   * @param {string} [routeKeyValue]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function buildStatus(routeKeyValue) {
    const heartbeatSnapshot = heartbeat.snapshot();
    const ageMs = Math.max(0, clock.now() - heartbeatSnapshot.ts);
    /** @type {Record<string, string>} */
    const channels = {};
    for (const [id, adapter] of adapters) {
      try {
        const probe = await adapter.probe();
        channels[id] = probe.ok ? `连通${probe.detail === undefined ? '' : `（${probe.detail}）`}` : `不可用：${probe.detail ?? '未知'}`;
      } catch (error) {
        channels[id] = `探活失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let scheduleCount = '—';
    const schedule = /** @type {any} */ (ctx.get('schedule'));
    if (schedule !== undefined) {
      try {
        const tasks = await schedule.list({});
        scheduleCount = String((tasks?.items ?? tasks ?? []).length ?? '—');
      } catch (error) {
        scheduleCount = `读取失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const routes = allRoutes();
    const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY;
    const currentSession = routeKeyValue === undefined ? undefined : [...stores.values()].map((store) => store.routes.get(routeKeyValue)?.sessionId).find((value) => value !== undefined);
    return {
      版本: `channel-core ${VERSION} / DSH_HOME=${config.dshHome}`,
      进程: `pid ${process.pid}，已运行 ${Math.round((clock.now() - heartbeatSnapshot.startedAt) / 1000)}s`,
      通道: channels,
      代理: proxy === undefined || proxy === '' ? '未设置（Telegram 需要出网代理）' : `${proxy}${process.env.NODE_USE_ENV_PROXY === '1' ? '' : '（NODE_USE_ENV_PROXY 未开）'}`,
      本会话: currentSession ?? '—',
      路由: `${routes.length} 条`,
      在途回合: state.inFlightCount,
      队列深度: pacer.totalDepth,
      未投递: state.droppedCount,

      待答提问: questions.activeCount(),
      心跳年龄: `${Math.round(ageMs / 1000)}s`,
      最近轮询: heartbeatSnapshot.lastPoll === null ? '—' : `${Math.round((clock.now() - heartbeatSnapshot.lastPoll) / 1000)}s 前`,
      定时任务: scheduleCount,
      最近错误: state.lastError ?? '—'
    };
  }

  // ── 心跳 ──────────────────────────────────────────────────────────────────
  const stopHeartbeat = heartbeat.start();
  heartbeat.update({ inFlight: 0, queueDepth: 0 });

  ctx.provide('channelCore', {
    version: VERSION,
    config,
    registerAdapter,
    /** 供 `--doctor`/测试读取的只读状态。 @param {string} [routeKeyValue] @returns {Promise<Record<string, unknown>>} */
    status: buildStatus,
    /**
     * 主动给 owner 发一条消息（无人值守：身份 diff、健康告警等）。
     * @param {string} text
     * @returns {Promise<number>} 实际投递条数
     */
    async notifyOwner(text) {
      let sent = 0;
      const seen = new Set();
      for (const [channel, store] of stores) {
        const owners = config.owners[channel] ?? [];
        for (const route of allRoutes().filter((candidate) => candidate.stores === store && candidate.entry.userId !== undefined && owners.includes(candidate.entry.userId))) {
          const key = routeKeyOf(route.route);
          if (seen.has(key)) continue;
          seen.add(key);
          const result = await outbound.sendDirect(
            { channel, chatId: route.route.chatId, ...(route.route.threadId === undefined ? {} : { threadId: route.route.threadId }) },
            text
          );
          if (result.messageId !== undefined) sent += 1;
        }
      }
      return sent;
    },
    /** 供适配器注册客户端菜单：与 /help 同源，避免两处文案漂移。 @returns {{ name: string, description: string }[]} */
    botCommands: () => commands.list(),
    /** @returns {number} */
    inFlightCount: () => state.inFlightCount,
    /** @returns {import('./rate-limit.js').RateLimitedError} */
    rateLimited: (/** @type {number} */ retryAfterMs, /** @type {string} */ detail) => new RateLimitedError(retryAfterMs, detail)
  });

  ctx.effect(() => async () => {
    for (const adapter of adapters.values()) {
      try {
        await adapter.stop();
      } catch (error) {
        logger.warn(`停止通道 ${adapter.id} 失败：${String(error)}`);
      }
    }
    approvals.dispose();
    questions.dispose();
    outbound.dispose();
    stopHeartbeat();
    try {
      await Promise.all([...stores.values()].map(async (store) => await store.settled()));
    } finally {
      lock.release();
    }
  }, 'channel-core: lifecycle');
}

/**
 * 只读读取心跳（doctor 用；不启动插件）。
 * @param {string} path
 * @returns {{ ts?: number, pid?: number, lastPoll?: number | null, lastGetMeOk?: boolean | null, inFlight?: number, queueDepth?: number, lastError?: string | null } | undefined}
 */
export function readHeartbeat(path) {
  const value = readJsonIfExists(path);
  if (typeof value !== 'object' || value === null) return undefined;
  return /** @type {any} */ (value);
}

/**
 * 身份变更快照目录（doctor 用）。
 * @param {string} dshHome
 * @returns {string | undefined}
 */
export function latestIdentitySnapshotDir(dshHome) {
  const root = join(dshHome, 'identity-history');
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const latest = entries.at(-1);
  return latest === undefined ? undefined : join(root, latest);
}

/** @type {import('./protocol.js').ChannelAdapter | undefined} */ undefined;
