import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 身份 section 在 system prompt 里的位置：SOUL 最前，SYSTEM 最后（对应设计文档 §5 的 order 0 / 10200）。 */
export const SOUL_ORDER = 0;
export const SYSTEM_ORDER = 10200;
export const SOUL_SECTION = 'assistant:identity-soul';
export const SYSTEM_SECTION = 'assistant:identity-system';

/**
 * @typedef {object} IdentityFile
 * @property {'SOUL'|'SYSTEM'|'AGENTS'} label
 * @property {string} path
 * @property {boolean} exists
 * @property {number} bytes
 * @property {number} braceReferences 出现 `{{` 的次数
 */

/**
 * @typedef {object} Identity
 * @property {IdentityFile[]} files
 * @property {{ name: string, order: number, text: string, interpolate: boolean }[]} sections
 * @property {string[]} warnings
 */

/**
 * 读身份文件并装成可注册的 prompt section。
 *
 * 关键取舍（与设计文档 §5.1 的差别，见 `docs/notes/implementation-notes.md`）：
 * `system-prompt` 的 `personaPrefix/Suffix` 会做 `{{var}}` 插值，未知变量**直接抛错**，
 * 而 `!!js` 表达式里没有 `require`、无法在 patch 里读文件。因此本项目改为由本插件在运行期
 * 注册 section，并断言 `interpolate: false`：身份文件是人写的散文，任何花括号都应原样保留。
 * 仍然检出 `{{` 并给出警告，因为那通常意味着作者以为它会插值。
 *
 * @param {{ dshHome: string }} options
 * @returns {Identity}
 */
export function loadIdentity({ dshHome }) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {IdentityFile[]} */
  const files = [];

  /** @param {'SOUL'|'SYSTEM'|'AGENTS'} label @param {string} path */
  const read = (label, path) => {
    if (!existsSync(path)) {
      warnings.push(`${label} 不存在：${path}（身份层留空，助理仍可运行）`);
      files.push({ label, path, exists: false, bytes: 0, braceReferences: 0 });
      return '';
    }
    const text = readFileSync(path, 'utf8');
    const bytes = statSync(path).size;
    const braceReferences = (text.match(/\{\{/gu) ?? []).length;
    if (braceReferences > 0) {
      warnings.push(`${label} 含 ${braceReferences} 处 {{…}}；身份 section 不做变量插值，这些字符会原样进入提示词`);
    }
    if (bytes > 65536) warnings.push(`${label} 有 ${bytes} 字节，超过 64KiB，可能挤占上下文`);
    if (text.trim() === '') warnings.push(`${label} 是空文件：${path}`);
    files.push({ label, path, exists: true, bytes, braceReferences });
    return text;
  };

  const soul = read('SOUL', join(dshHome, 'identity', 'SOUL.md'));
  const system = read('SYSTEM', join(dshHome, 'identity', 'SYSTEM.md'));
  // AGENTS.md 走 DSH 内建的 agent-instructions 链，这里只做存在性与体积对账。
  read('AGENTS', join(dshHome, 'AGENTS.md'));

  return {
    files,
    warnings,
    sections: [
      { name: SOUL_SECTION, order: SOUL_ORDER, text: soul, interpolate: false },
      { name: SYSTEM_SECTION, order: SYSTEM_ORDER, text: system, interpolate: false }
    ]
  };
}

/**
 * 把身份装进提示词。没有 `systemPrompt` 服务（例如裁剪过的组合）时安静跳过——
 * 身份是能力层之上的装饰，不该让进程起不来。
 * @param {any} ctx
 * @param {Identity} identity
 * @returns {{ registered: string[] }}
 */
export function registerIdentitySections(ctx, identity) {
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined) return { registered: [] };
  /** @type {string[]} */
  const registered = [];
  for (const section of identity.sections) {
    if (section.text.trim() === '') continue;
    systemPrompt.section({ name: section.name, order: section.order, text: section.text, interpolate: section.interpolate });
    registered.push(section.name);
  }
  return { registered };
}

/**
 * 身份文件的 `{{…}}` 检查，供 doctor 复用。
 * @param {Identity} identity
 * @returns {string[]}
 */
export function identityProblems(identity) {
  return identity.files
    .filter((file) => file.braceReferences > 0)
    .map((file) => `${file.label} 有 ${file.braceReferences} 处 {{…}}`);
}
