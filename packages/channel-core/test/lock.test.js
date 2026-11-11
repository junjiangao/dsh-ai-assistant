import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isAlive, LockHeldError, PidLock } from '../src/lock.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 起一个子进程，拿到它的第一行输出后返回句柄。
 * @param {string} lockPath
 * @returns {Promise<{ line: string, close: () => Promise<void> }>}
 */
function startChild(lockPath) {
  const proc = spawn(process.execPath, [join(here, 'support', 'lock-child.js'), lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  // 必须在 spawn 时就挂好 exit 监听：落败的子进程可能在父进程读到输出之前就退出了，
  // 之后再 once('exit') 会永远等不到（这正是 "Promise resolution is still pending" 的来源）。
  const exited = new Promise((resolve) => proc.once('exit', () => resolve(undefined)));
  return new Promise((resolve, reject) => {
    /** @type {string} */
    let buffer = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`child did not report within 5s; stderr=${''}`));
    }, 5000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      const line = buffer.split('\n')[0];
      resolve({
        line,
        async close() {
          if (proc.exitCode === null && proc.signalCode === null) proc.stdin.end();
          await exited;
        }
      });
    });
    proc.on('error', reject);
  });
}

describe('PidLock', () => {
  it('取得锁后写入 pid，释放后删除', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'assistant-lock-')), 'host.pid');
    const lock = new PidLock({ path });
    assert.deepEqual(lock.acquire(), {});
    assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
    assert.deepEqual(lock.holder(), { pid: process.pid });
    lock.release();
    assert.equal(lock.holder(), undefined);
  });

  it('存活进程持锁时拒绝启动，并报出持有者 pid', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'assistant-lock-')), 'host.pid');
    const first = new PidLock({ path, pid: process.pid });
    first.acquire();
    const second = new PidLock({ path, pid: process.pid + 1 });
    assert.throws(() => second.acquire(), (error) => {
      assert.ok(error instanceof LockHeldError);
      assert.equal(error.pid, process.pid);
      assert.match(error.message, /已在运行/u);
      return true;
    });
    first.release();
  });

  it('只对确认不存在的 pid 抢占（ESRCH）', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'assistant-lock-')), 'host.pid');
    const deadPid = 2 ** 22 + 12345;
    assert.equal(isAlive(deadPid), false);
    writeFileSync(path, `${deadPid}\n`);
    const lock = new PidLock({ path });
    const result = lock.acquire();
    assert.equal(result.stolenFrom, deadPid);
    assert.equal(lock.holder()?.pid, process.pid);
    lock.release();
  });

  it('两个真实进程同时抢锁，只有一个成功', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'assistant-lock-')), 'host.pid');
    const children = await Promise.all([startChild(path), startChild(path), startChild(path)]);
    const accepted = children.filter((child) => child.line === 'accepted');
    const held = children.filter((child) => child.line.startsWith('held:'));
    assert.equal(accepted.length, 1, `期望恰好一个成功，实际 ${JSON.stringify(children.map((child) => child.line))}`);
    assert.equal(held.length, 2);
    await Promise.all(children.map(async (child) => await child.close()));
    assert.equal(new PidLock({ path }).holder(), undefined, '全部退出后锁应被释放');
  });
});