/**
 * 轮询等待条件成立；用于等待"fire-and-forget"的出站编排完成。
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function eventually(predicate, { timeoutMs = 2000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * 让出若干轮事件循环（microtask + macrotask），用于断言"没有发生"。
 * @param {number} [rounds]
 * @returns {Promise<void>}
 */
export async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
