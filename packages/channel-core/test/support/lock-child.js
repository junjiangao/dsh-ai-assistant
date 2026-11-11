import { PidLock } from '../../src/lock.js';

const lock = new PidLock({ path: /** @type {string} */ (process.argv[2]) });
try {
  lock.acquire();
  process.stdout.write('accepted\n');
} catch (error) {
  process.stdout.write(`held:${/** @type {any} */ (error).pid ?? 'unknown'}\n`);
  process.exit(0);
}
// 持有到 stdin 关闭，模拟"整个生命周期"持锁
process.stdin.resume();
process.stdin.on('end', () => {
  lock.release();
  process.exit(0);
});
