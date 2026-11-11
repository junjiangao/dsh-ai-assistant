/**
 * 启动参数解析（设计文档 §9.6）。
 *
 * 启动器只解析自己的 flag，其余原样交给被启动的树；因此这里自己解析，不引入 commander，
 * 也不依赖 dsh-cmdline 的解析器（它在 help/错误路径上会自行 exit，反而不利于单测）。
 *
 * @typedef {{ mode: 'daemon'|'once'|'doctor'|'help', task?: string, errors: string[] }} ParsedArgs
 */

const HELP = `用法：dsh --profile assistant [选项] [任务]

选项：
  --once, -o <任务>   跑一个回合、把结果打印到 stdout 后退出（不挂 Telegram、不挂 schedule、不取 pid 锁）
  --doctor            打印一页诊断后退出
  --help, -h          这条说明

无参数时以 daemon 模式常驻：挂 Telegram 通道与定时任务，由 systemd 守护。
`;

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const result = { mode: 'daemon', errors: [] };
  const tasks = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--help' || argument === '-h') {
      setMode(result, 'help');
      continue;
    }
    if (argument === '--doctor') {
      setMode(result, 'doctor');
      continue;
    }
    if (argument === '--once' || argument === '-o') {
      setMode(result, 'once');
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        tasks.push(value);
        index += 1;
      }
      continue;
    }
    if (argument.startsWith('--once=')) {
      setMode(result, 'once');
      tasks.push(argument.slice('--once='.length));
      continue;
    }
    if (argument.startsWith('-')) {
      result.errors.push(`未知选项：${argument}`);
      continue;
    }
    tasks.push(argument);
  }
  if (tasks.length > 0) {
    const task = tasks.join(' ').trim();
    if (result.mode === 'once') {
      if (task === '') result.errors.push('--once 需要一个非空任务，例如：--once "报一下时间"');
      else result.task = task;
    } else if (result.mode === 'daemon') {
      result.errors.push(`daemon 模式不接受任务参数（收到 ${JSON.stringify(task)}）；一次性的问题请用 --once`);
    } else {
      result.errors.push(`${result.mode} 模式不接受任务参数（收到 ${JSON.stringify(task)}）`);
    }
  }
  if (result.mode === 'once' && result.task === undefined && !result.errors.some((error) => error.includes('--once'))) {
    result.errors.push('--once 需要一个非空任务，例如：--once "报一下时间"');
  }
  return result;
}

/**
 * @param {ParsedArgs} result
 * @param {'daemon'|'once'|'doctor'|'help'} mode
 * @returns {void}
 */
function setMode(result, mode) {
  if (result.mode !== 'daemon' && result.mode !== mode) {
    result.errors.push(`--once、--doctor、--help 互斥（先选了 --${result.mode}，又选了 --${mode}）`);
    return;
  }
  result.mode = mode;
}

/** @returns {string} */
export function helpText() {
  return HELP;
}