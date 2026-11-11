import { randomBytes } from 'node:crypto';

const MAX_WAIT_MS = 600_000;
/** @typedef {'allowed-once'|'rejected'|'cancelled'|'unavailable'} ApprovalOutcome */
/** @typedef {{nonce:string,sessionId:string,routeKey:string,route:any,timer?:ReturnType<typeof setTimeout>,signal?:AbortSignal,resolve:(outcome:ApprovalOutcome)=>void,settled:boolean,settle?:(outcome:ApprovalOutcome)=>boolean}} PendingApproval */

/**
 * Telegram 审批桥：只在当前进程等待，旧进程的按钮不会恢复成有效授权。
 * @param {{resolveRoute: (sessionId:string)=>any, adapterFor:(channel:string)=>any, sendDirect:Function, timeoutMs?:number}} deps
 */
export function createApprovals({ resolveRoute, adapterFor, sendDirect, timeoutMs = MAX_WAIT_MS }) {
  /** @type {Map<string, PendingApproval>} */
  const pending = new Map();
  let disposed = false;

  /** @param {{agent:any,toolName?:string,callId?:string,reason?:string,displayReason?:string|Record<string,string>,signal?:AbortSignal}} req @param {()=>Promise<ApprovalOutcome>} next @returns {Promise<ApprovalOutcome>} */
  async function request(req, next) {
    const sessionId = req?.agent?.id ?? req?.agent?.session?.id;
    if (typeof sessionId !== 'string') return await next();
    const resolved = resolveRoute(sessionId);
    if (resolved === undefined) return await next();
    const route = resolved.route;
    const adapter = adapterFor(route.channel);
    if (adapter?.send === undefined || disposed) return 'unavailable';
    const nonce = randomBytes(12).toString('base64url');
    const data = (/** @type {'y'|'n'} */ decision) => `ap:${nonce}:${decision}`;
    /** @type {PendingApproval} */
    const entry = {
      nonce, sessionId, routeKey: resolved.routeKey, route: { ...route },
      signal: req.signal,
      resolve: /** @type {(outcome:ApprovalOutcome)=>void} */ (() => {}), settled: false
    };
    const promise = new Promise((/** @type {(outcome:ApprovalOutcome)=>void} */ resolve) => { entry.resolve = resolve; });
    pending.set(nonce, entry);
    const settle = (/** @type {ApprovalOutcome} */ outcome) => {
      if (entry.settled) return false;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', onAbort);
      pending.delete(nonce);
      entry.resolve(outcome);
      return true;
    };
    entry.settle = settle;
    const onAbort = () => settle('cancelled');
    if (req.signal?.aborted) settle('cancelled');
    else req.signal?.addEventListener('abort', onAbort, { once: true });
    if (entry.settled) return await promise;
    if (!entry.settled) {
      entry.timer = setTimeout(() => settle('unavailable'), Math.min(timeoutMs, MAX_WAIT_MS));
      entry.timer.unref?.();
    }
    const tool = String(req.toolName ?? '工具');
    const display = req.displayReason;
    const reason = typeof display === 'string' ? display
      : display !== null && typeof display === 'object'
        ? (display['zh-CN'] ?? display.zh ?? display.en ?? req.reason ?? '此操作需要确认')
        : req.reason ?? '此操作需要确认';
    void Promise.resolve().then(async () => {
      if (entry.settled) return;
      const sent = await sendDirect(route, `⚠️ 请求批准：${tool}\n${reason}\n\n仅批准本次操作。`, {
        buttons: [[{ label: '批准一次', data: data('y') }, { label: '拒绝', data: data('n') }]]
      });
      if (sent?.messageId === undefined) settle('unavailable');
    }).catch(() => {
      settle('unavailable');
    });
    return await promise;
  }

  /** @param {any} event @param {any} route */
  async function handleEvent(event, route) {
    const match = /^ap:([A-Za-z0-9_-]{16}):([yn])$/u.exec(event.callback?.data ?? '');
    if (!match) return { handled: false };
    const entry = pending.get(match[1]);
    const adapter = adapterFor(event.channel);
    if (entry === undefined || entry.settled) {
      await adapter?.ackCallback?.(event.callback.id, '此审批已失效');
      return { handled: true, detail: 'approval-expired' };
    }
    const current = resolveRoute(entry.sessionId);
    if (current === undefined || current.routeKey !== entry.routeKey || route.routeKey !== entry.routeKey
      || event.channel !== entry.route.channel || event.account !== entry.route.account
      || event.chatId !== entry.route.chatId || event.threadId !== entry.route.threadId) {
      entry.settle?.('cancelled');
      await adapter?.ackCallback?.(event.callback.id, '此审批已失效');
      return { handled: true, detail: 'approval-route-changed' };
    }
    entry.settle?.(match[2] === 'y' ? 'allowed-once' : 'rejected');
    await adapter?.ackCallback?.(event.callback.id, match[2] === 'y' ? '已批准一次' : '已拒绝');
    await sendDirect(entry.route, match[2] === 'y' ? '✅ 已批准本次操作。' : '⛔ 已拒绝本次操作。');
    return { handled: true, detail: 'approval-decided' };
  }

  /** @param {string} routeKey */
  function skip(routeKey) {
    let count = 0;
    for (const entry of pending.values()) if (entry.routeKey === routeKey && entry.settle?.('rejected')) count += 1;
    return count;
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) entry.settle?.('cancelled');
  }

  return { request, handleEvent, skip, dispose };
}
