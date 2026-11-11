import { systemClock } from './clock.js';

/**
 * 跑一个回合、把终稿打印到 stdout 后退出（设计文档 §9.6）。
 *
 * 走 `sessionController` 而不是直连 `ctx.agents.create`：只有前者会挂上 agent preset，
 * 也就是"同一身份、同一套工具"的那份组合（`dsh-headless` 的直连路径会绕过 preset）。
 *
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {string} deps.task
 * @param {number} deps.timeoutMs
 * @param {{ write: (chunk: string) => void }} deps.stdout
 * @param {{ write: (chunk: string) => void }} deps.stderr
 * @param {{ now: () => number }} [deps.clock]
 * @returns {Promise<{ exitCode: number, text: string, sessionId: string, reason?: any, timedOut?: boolean }>}
 */
export async function runOnce({ ctx, task, timeoutMs, stdout, stderr, clock = systemClock }) {
  // 插件 apply 是同步的；其余行（session-controller 等）可能还没挂上。等 Loader 收敛再取服务。
  await ctx.get('loader')?.await?.();
  const sessionController = ctx.get('sessionController');
  if (sessionController === undefined) throw new Error('assistant-startup: --once 需要 sessionController 服务；当前组合没有它');
  const created = await sessionController.create({});
  const sessionId = /** @type {string} */ (created.sessionId);
  stderr.write(`dsh: 一次性回合（session ${sessionId}）\n`);

  /** @type {{ reason?: any }} */
  const terminal = {};
  /** @type {() => void} */
  let stopListener = () => {};
  const turnEnded = new Promise((resolve) => {
    stopListener = ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
      if (session?.id !== sessionId) return;
      if (event.type !== 'turn/end') return;
      terminal.reason = event.data?.reason;
      resolve(undefined);
    }, { global: true });
  });

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    await sessionController.prompt({
      sessionId,
      content: [{ type: 'text', text: task }],
      requestId: `once-${clock.now().toString(36)}`,
      mode: 'queue'
    }, new AbortController().signal);

    const outcome = await Promise.race([turnEnded.then(() => 'done'), timedOut]);
    if (outcome === 'timeout') {
      try {
        sessionController.cancel({ sessionId });
      } catch {
        /* 超时退出优先，取消失败不改变结论 */
      }
      stderr.write(`dsh: 一次性回合在 ${timeoutMs}ms 内没有结束，已请求中断\n`);
      return { exitCode: 124, text: '', sessionId, timedOut: true };
    }

    const resolved = await sessionController.resolveAgent(sessionId).catch((/** @type {any} */ error) => ({ error }));
    const agent = resolved?.agent;
    if (agent !== undefined) {
      const subagents = ctx.get('subagents');
      while (true) {
        await agent.whenIdle();
        const idleSeq = agent.session.seq;
        const busy = await subagents?.waitForTreeWork?.(agent);
        if (!busy && agent.status === 'idle' && agent.session.seq === idleSeq) break;
      }
    }

    const sessionsService = ctx.get('sessions');
    const session = sessionsService?.get(sessionId) ?? agent?.session;
    const folded = session === undefined ? { text: '' } : foldLastTurn(session);
    // 一次性进程说走就走：不 flush 的话这一轮的事件不会落进 JSONL（会话也就查不到）。
    if (sessionsService !== undefined && session !== undefined) {
      await sessionsService.flush?.(session).catch?.(() => undefined);
    }
    const text = folded.text.trim();
    if (text !== '') stdout.write(`${text}\n`);
    const reason = terminal.reason ?? folded.reason;
    if (reason?.kind === 'error') {
      stderr.write(`dsh: ${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? '回合失败'}\n`);
    } else if (reason?.kind === 'interrupted') {
      stderr.write('dsh: 回合被中断\n');
    }
    return {
      exitCode: reason?.kind === 'completed' ? 0 : 1,
      text,
      sessionId,
      ...(reason === undefined ? {} : { reason })
    };
  } finally {
    clearTimeout(timer);
    stopListener();
  }
}

/**
 * 取最后一轮的助手正文（多步之间用空行分隔），以及该轮的结束原因。
 * @param {{ snapshotEvents: (from?: number, to?: number) => any[] }} session
 * @returns {{ text: string, reason?: any }}
 */
export function foldLastTurn(session) {
  const events = session.snapshotEvents();
  let startIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return { text: '' };
  /** @type {Map<number, string>} */
  const steps = new Map();
  /** @type {any} */
  let reason;
  for (const event of events.slice(startIndex)) {
    if (event.type === 'turn/end') reason = event.data?.reason;
    if (event.type !== 'assistant/message') continue;
    const step = typeof event.data?.step === 'number' ? event.data.step : 0;
    const text = (event.data.message?.content ?? [])
      .filter((/** @type {{ type: string }} */ block) => block.type === 'text')
      .map((/** @type {{ text?: string }} */ block) => block.text ?? '')
      .join('');
    if (text.trim() === '') continue;
    steps.set(step, steps.has(step) ? `${steps.get(step)}\n\n${text}` : text);
  }
  const text = [...steps.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('\n\n');
  return { text, ...(reason === undefined ? {} : { reason }) };
}