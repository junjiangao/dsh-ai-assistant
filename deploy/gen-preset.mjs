#!/usr/bin/env node
/**
 * 生成 `preset-standard` 的快照（设计文档 §4.4）。
 *
 * 为什么是"生成"而不是手抄：preset 的插件列表在 `config.plugins` 里，而补丁层只按
 * **顶层行 id** 整段替换 config（`applyPatches` 只把顶层行与 group 行收进 id 表），
 * 所以无法只改其中一项；必须把整行重新声明一遍。手抄一份 60 行的结构迟早会落后。
 *
 * 做法：读安装目录里的 `dsh-web-app/presets/standard.patch.yml`，做三处**文本级**修改：
 *   1. 删除 `persona` 项（身份改由 assistant-startup 注册，preset 里的 persona 会遮蔽全局 section）；
 *   2. `tool-ask-user` 改为 `{ mode: timed, timeout: 600 }`（阻塞模式会在手机上卡死回合）；
 *   3. `tool-plugin-manager` 恒关（它让模型自己装/卸宿主进程里的第三方代码）。
 *
 * 每一处都要求**恰好命中一次**；DSH 改格式或改结构时这里会报错退出，而不是静默漂移。
 * 用法：
 *   node deploy/gen-preset.mjs            # 生成/更新
 *   node deploy/gen-preset.mjs --check    # 只检查（CI/升级时用）
 *   node deploy/gen-preset.mjs --check --strict  # 删除名单必须全部命中（升级核对）
 *   node deploy/gen-preset.mjs --web-app /path/to/dsh-web-app
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outputPath = join(repoRoot, 'packages', 'assistant-bundle', 'generated', 'preset-standard.patch.yml');
const bundlePatchPath = join(repoRoot, 'packages', 'assistant-bundle', 'cordis.patch.yml');

/**
 * @param {string[]} argv
 * @returns {{ check: boolean, strict: boolean, webApp: string | undefined }}
 */
function parseArgs(argv) {
  /** @type {{ check: boolean, strict: boolean, webApp: string | undefined }} */
  const options = { check: false, strict: false, webApp: process.env.DSH_WEB_APP_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--web-app') options.webApp = argv[++index];
    else if (argument?.startsWith('--web-app=')) options.webApp = argument.slice('--web-app='.length);
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write('用法：node deploy/gen-preset.mjs [--check] [--web-app <dsh-web-app 目录>]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

/**
 * 找 `dsh-web-app` 包目录。找不到就报错并给出明确的解决方式，不做猜测。
 *
 * 定位顺序（与 DSH 自己的模块解析一致：先安装目录、再 profile）：
 *  1. 显式 `--web-app` / `DSH_WEB_APP_DIR` / `DSH_INSTALL_ROOT`；
 *  2. `dsh` 可执行文件里的 `NODE_PATH`（pnpm/npm 的 shim 把它写死在脚本里）；
 *  3. pnpm 全局 store 里的 `@deepseek-ai+dsh-web-app@*`；
 *  4. 本机桌面版的固定位置。
 * @param {string | undefined} explicit
 * @returns {string}
 */
function locateWebApp(explicit) {
  /** @param {string} dir */
  const usable = (dir) => dir !== '' && existsSync(join(dir, 'presets', 'standard.patch.yml'));
  if (explicit !== undefined) {
    const candidate = resolve(explicit);
    if (!usable(candidate)) throw new Error('--web-app 指向的目录里没有 presets/standard.patch.yml：' + candidate);
    return candidate;
  }

  /** @type {string[]} */
  const candidates = [];
  if (process.env.DSH_WEB_APP_DIR) candidates.push(resolve(process.env.DSH_WEB_APP_DIR));
  if (process.env.DSH_INSTALL_ROOT) candidates.push(join(process.env.DSH_INSTALL_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-app'));
  candidates.push(join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app'));

  // `dsh` shim 里写死的 NODE_PATH 就是"DSH 自己怎么找插件"的答案。
  /** @type {string[]} */
  const shimPaths = [];
  try {
    const shim = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim();
    if (shim !== '') {
      const real = realpathSync(shim);
      const text = readFileSync(real === '' ? shim : real, 'utf8');
      const match = /NODE_PATH='([^']+)'/u.exec(text);
      if (match?.[1]) for (const dir of match[1].split(':')) shimPaths.push(dir);
      const target = /# cmd-shim-target=(.+)$/mu.exec(text)?.[1]?.trim();
      if (target) shimPaths.push(join(dirname(target), '..'));
      shimPaths.push(join(dirname(real), '..', 'node_modules'));
      shimPaths.push(join(dirname(real), '..', '..', 'node_modules'));
    }
  } catch {
    /* 没有 dsh 就继续用其它线索 */
  }
  if (process.env.NODE_PATH) shimPaths.push(...process.env.NODE_PATH.split(':'));
  for (const dir of shimPaths) candidates.push(join(dir, '@deepseek-ai', 'dsh-web-app'));

  // pnpm 全局 store 兜底：<pnpm home>/global/*/*/node_modules/.pnpm/@deepseek-ai+dsh-web-app@*/node_modules/@deepseek-ai/dsh-web-app
  for (const pnpmHome of [process.env.PNPM_HOME, join(process.env.HOME ?? '', '.local', 'share', 'pnpm')]) {
    if (!pnpmHome) continue;
    for (const globalRoot of safeReaddir(join(pnpmHome, 'global'))) {
      for (const store of safeReaddir(globalRoot)) {
        const modules = join(globalRoot, store, 'node_modules', '.pnpm');
        for (const entry of safeReaddir(modules)) {
          if (entry.startsWith('@deepseek-ai+dsh-web-app@')) candidates.push(join(modules, entry, 'node_modules', '@deepseek-ai', 'dsh-web-app'));
        }
      }
    }
  }
  candidates.push(join(process.env.HOME ?? '', '.local', 'opt', 'deepseek-harness', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app'));

  for (const candidate of candidates) if (usable(candidate)) return candidate;
  throw new Error([
    '找不到 dsh-web-app 包。请显式指定：',
    '  node deploy/gen-preset.mjs --web-app /path/to/node_modules/@deepseek-ai/dsh-web-app',
    '或设置 DSH_WEB_APP_DIR / DSH_INSTALL_ROOT。',
    '已尝试：\n  ' + candidates.filter(Boolean).join('\n  ')
  ].join('\n'));
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 找到 `- id: <id>` 起始行，返回其缩进与块结束位置（下一条同缩进的 `- id:` 或文件尾）。
 * @param {string[]} lines
 * @param {string} id
 * @returns {{ start: number, end: number, indent: string }}
 */
function findBlock(lines, id) {
  const pattern = new RegExp(`^(\\s*)- id: ${id.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) throw new Error('源文件里没有 "- id: ' + id + '"，无法按预期生成');
  const indent = /** @type {RegExpExecArray} */ (pattern.exec(lines[start]))[1];
  let end = lines.length;
  const nextItem = new RegExp(`^${indent}- id: `, 'u');
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextItem.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end, indent };
}

/**
 * 对源文本做三处修改，每处都要求命中一次。
 * @param {string} source
 * @returns {string}
 */
function transform(source) {
  const lines = source.split('\n');
  let hits = 0;

  // 1) 删除 persona
  {
    const block = findBlock(lines, 'persona');
    lines.splice(block.start, block.end - block.start);
    hits += 1;
  }

  // 2) tool-ask-user → timed/600
  {
    const block = findBlock(lines, 'tool-ask-user');
    const blockLines = lines.slice(block.start, block.end);
    const nameIndex = blockLines.findIndex((line) => /^\s*name: '@deepseek-ai\/dsh-tool-ask-user'$/u.test(line));
    if (nameIndex < 0) throw new Error('tool-ask-user 块的 name 行不匹配预期，拒绝生成');
    if (blockLines.some((line) => /^\s*config:/u.test(line))) {
      throw new Error('tool-ask-user 块已经带 config，生成器的"插入 config"假设失效，请人工确认');
    }
    const indent = /^(\s*)/u.exec(blockLines[nameIndex])?.[1] ?? '';
    lines.splice(block.start + nameIndex + 1, 0, `${indent}config:`, `${indent}  mode: timed`, `${indent}  timeout: 600`);
    hits += 1;
  }

  // 3) tool-plugin-manager 恒关
  {
    const block = findBlock(lines, 'tool-plugin-manager');
    const disabledPattern = /^(\s*)disabled: !!js "!ctx\.get\('profileContext'\)"$/u;
    let replaced = 0;
    for (let index = block.start; index < block.end; index += 1) {
      const match = disabledPattern.exec(lines[index]);
      if (match === null) continue;
      lines[index] = `${match[1]}disabled: true`;
      replaced += 1;
    }
    if (replaced !== 1) throw new Error(`tool-plugin-manager 的 disabled 表达式命中 ${replaced} 次（期望 1 次），请人工确认`);
    hits += 1;
  }

  if (hits !== 3) throw new Error(`生成器只命中 ${hits} 处修改（期望 3 处）`);
  return lines.join('\n');
}

/**
 * 校验生成结果本身：能被 YAML 解析，且三处修改确实生效。
 * @param {string} text
 * @returns {void}
 */
function validateGenerated(text) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (data) => ({ __jsExpr: data })
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([JsExpr]);
  const entries = /** @type {any[]} */ (yaml.load(text, { schema }));
  const insert = entries.flatMap((entry) => entry.insert ?? []);
  const preset = insert.find((entry) => entry.id === 'preset-standard');
  if (preset === undefined) throw new Error('生成结果里没有 preset-standard 行');
  const plugins = preset.config?.plugins;
  if (!Array.isArray(plugins)) throw new Error('preset-standard 缺少 config.plugins');
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  if (byId.has('persona')) throw new Error('生成结果里仍然有 persona（身份会被它遮蔽）');
  const askUser = byId.get('tool-ask-user');
  if (askUser?.config?.mode !== 'timed' || askUser?.config?.timeout !== 600) throw new Error('tool-ask-user 未改成 timed/600');
  if (byId.get('tool-plugin-manager')?.disabled !== true) throw new Error('tool-plugin-manager 未被恒关');
  for (const required of ['tool-bash', 'tool-fs', 'tool-skill', 'tool-schedule', 'tool-goal', 'tool-web', 'present', 'agent-instructions', 'time-context']) {
    if (!byId.has(required)) throw new Error(`生成结果缺少 ${required}，preset 快照不完整`);
  }
}

/**
 * 校验删除名单里的 row id 在当前安装里仍然存在。
 * @param {string} webApp
 * @param {string[]} layers
 * @returns {string[]} 未命中的 id
 */
function validateDeleteList(webApp, layers) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (data) => ({ __jsExpr: data })
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([JsExpr]);
  const bundle = /** @type {any[]} */ (yaml.load(readFileSync(bundlePatchPath, 'utf8'), { schema }));
  const deleteIds = bundle.filter((entry) => entry?.disabled === true).map((entry) => entry.id);
  const known = new Set();
  for (const file of layers) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*- id: (\S+)/u.exec(line);
      if (match) known.add(match[1]);
    }
  }
  return deleteIds.filter((id) => !known.has(id));
}

const options = parseArgs(process.argv.slice(2));
const webApp = locateWebApp(options.webApp);
const sourcePath = join(webApp, 'presets', 'standard.patch.yml');
const source = readFileSync(sourcePath, 'utf8');
const version = JSON.parse(readFileSync(join(webApp, 'package.json'), 'utf8')).version;
const generated = [
  '# 由 deploy/gen-preset.mjs 生成，请勿手工编辑。',
  `# 源：@deepseek-ai/dsh-web-app@${version}/presets/standard.patch.yml`,
  '# 上游 Copyright (c) 2026 DeepSeek，MIT；许可见包内 THIRD_PARTY_NOTICES.md。',
  '# 三处修改：删除 persona；tool-ask-user 改 timed/600；tool-plugin-manager 恒关。',
  '# 升级 DSH 后重跑并看 diff：更改的是"官方能力快照"本身。',
  '',
  transform(source)
].join('\n');

const layers = [
  join(webApp, 'cordis.patch.yml'),
  join(webApp, 'presets', 'standard.patch.yml'),
  join(webApp, 'presets', 'ptc.patch.yml'),
  join(webApp, 'presets', 'minimal.patch.yml'),
  join(webApp, 'presets', 'cordis.patch.yml'),
  join(dirname(webApp), 'dsh-base', 'cordis.patch.yml')
].filter((file) => existsSync(file));
validateGenerated(generated);
const missing = validateDeleteList(webApp, layers);

if (missing.length > 0) {
  // 注意：`0.2.2-rc.1` 的**已发布** npm 包与 Electron 随包副本内容并不完全一致
  // （后者多出 mcp-manager / ui-agent-team 两行）。因此"删不掉"只按告警处理，
  // 而不是让安装失败；`--strict` 供升级核对时显式要求全命中。
  process.stderr.write(`⚠️  删除名单里有 ${missing.length} 个 row id 不在当前安装（${webApp}）里：\n  ${missing.join('\n  ')}\n`);
  process.stderr.write('   这一行会被 profile 忽略（不会崩），但也就"悄悄删不掉"；DSH 升级后请对照更新 cordis.patch.yml。\n');
  if (options.strict) process.exit(1);
}

if (options.check) {
  if (!existsSync(outputPath)) {
    process.stderr.write(`缺少生成文件：${outputPath}；先跑 node deploy/gen-preset.mjs\n`);
    process.exit(1);
  }
  const current = readFileSync(outputPath, 'utf8');
  if (current !== generated) {
    const currentLines = current.split('\n');
    const nextLines = generated.split('\n');
    const index = currentLines.findIndex((line, position) => line !== nextLines[position]);
    process.stderr.write(`生成文件已过期（第一处差异在第 ${index + 1} 行）：\n`);
    process.stderr.write(`  当前：${JSON.stringify(currentLines[index] ?? '')}\n`);
    process.stderr.write(`  期望：${JSON.stringify(nextLines[index] ?? '')}\n`);
    process.stderr.write('跑 node deploy/gen-preset.mjs 更新后看 diff。\n');
    process.exit(1);
  }
  process.stdout.write(`preset 快照与删除名单均通过（dsh-web-app@${version}：${webApp}）。\n`);
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, generated, 'utf8');
process.stdout.write(`已写入 ${outputPath}（dsh-web-app@${version}：${webApp}）\n`);