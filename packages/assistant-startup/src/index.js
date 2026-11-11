import { resolveStartupConfig } from './config.js';
import { helpText, parseArgs } from './argv.js';
import { runDoctor } from './doctor.js';
import { identityProblems, loadIdentity, registerIdentitySections } from './identity.js';
import { runOnce } from './once.js';

/** 稳定插件名。 */
export const name = 'assistant-startup';

/** 只依赖启动器交给被启动树的参数快照。 */
export const inject = ['cmdlineArgs'];

/**
 * 进程级可替换项（测试用）；与 DSH 自己的 `internals` 约定一致，
 * 不把 stream 塞进插件 config（YAML 表达不了，也没有必要）。
 */
export const internals = {
  /** @type {{ write: (chunk: string) => void }} */
  stdout: process.stdout,
  /** @type {{ write: (chunk: string) => void }} */
  stderr: process.stderr,
  /** @type {NodeJS.ProcessEnv} */
  env: process.env,
  /** @type {() => number} */
  now: () => Date.now()
};

/**
 * 启动器（设计文档 §9.6）。
 *
 * 三种模式由参数决定，通道/调度的行在 patch 层用 `!!js ctx.assistantStartup.mode` 门控：
 * - `daemon`（默认）：什么都不做，把常驻交给 channel-core 与启动器；
 * - `--once <任务>`：跑一个回合打印结果退出（不挂通道、不挂调度、**不取 pid 锁**）；
 * - `--doctor`：打印一页诊断退出。
 *
 * 身份 section 在三种模式下都会注册：`--once` 用的是同一个身份、同一套工具。
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveStartupConfig(rawConfig);
  const args = /** @type {string[]} */ (ctx.get('cmdlineArgs')?.get?.() ?? []);
  const parsed = parseArgs(args);
  const exit = /** @type {((code: number) => void) | undefined} */ (ctx.get('appExit')) ?? (() => {});

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) internals.stderr.write(`dsh: ${error}\n`);
    internals.stderr.write(`\n${helpText()}`);
    exit(2);
    return;
  }

  if (parsed.mode === 'help') {
    internals.stdout.write(helpText());
    exit(0);
    return;
  }

  const identity = loadIdentity({ dshHome: config.dshHome });
  for (const warning of identity.warnings) ctx.logger.warn(`assistant-startup: ${warning}`);
  const problems = identityProblems(identity);
  if (problems.length > 0) ctx.logger.warn(`assistant-startup: ${problems.join('；')}`);

  ctx.provide('assistantStartup', {
    mode: parsed.mode,
    ...(parsed.task === undefined ? {} : { task: parsed.task }),
    identity: {
      files: identity.files,
      warnings: identity.warnings
    },
    config
  });

  registerIdentitySections(ctx, identity);

  if (parsed.mode === 'once') {
    runOnce({
      ctx,
      task: /** @type {string} */ (parsed.task),
      timeoutMs: config.onceTimeoutMs,
      stdout: internals.stdout,
      stderr: internals.stderr
    })
      .then((outcome) => exit(outcome.exitCode))
      .catch((error) => {
        internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
        exit(1);
      });
    return;
  }

  if (parsed.mode === 'doctor') {
    const runDoctored = (async () => {
      // 诊断要看到真实的组合：等 Loader 收敛后再读服务。
      await ctx.get('loader')?.await?.();
      return await runDoctor({
        ctx,
        config,
        env: internals.env,
        now: internals.now(),
        probeTelegram: async () => await probeTelegram(config)
      });
    })();
    runDoctored
      .then((report) => {
        internals.stdout.write(report.text);
        exit(report.ok ? 0 : 1);
      })
      .catch((error) => {
        internals.stderr.write(`dsh: 诊断失败：${error instanceof Error ? error.message : String(error)}\n`);
        exit(1);
      });
    return;
  }

  ctx.logger.info(`assistant-startup: daemon 模式（DSH_HOME=${config.dshHome}）`);
}

/**
 * 用通道包探活；通道包没装（或只是占位符）都不该让诊断崩掉。
 * @param {{ probeTimeoutMs: number }} config
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
async function probeTelegram(config) {
  const module = await import('@junjiangao/channel-telegram').catch(() => undefined);
  if (module?.probeFromEnv === undefined) return { ok: false, detail: '未安装 @junjiangao/channel-telegram' };
  return await module.probeFromEnv({ env: internals.env, timeoutMs: config.probeTimeoutMs });
}