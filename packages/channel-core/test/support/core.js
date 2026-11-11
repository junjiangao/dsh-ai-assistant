import { createFakeAdapter, createFakeDsh } from './fake-dsh.js';
import { apply } from '../../src/index.js';

/**
 * 起一个真实的 channel-core 插件实例（跑在假宿主上）。
 * @param {{ owners?: Record<string, string[]>, config?: Record<string, unknown> }} [options]
 */
export async function startCore({ owners = { telegram: ['7'] }, config = {} } = {}) {
  const fake = createFakeDsh();
  apply(fake.ctx, {
    home: fake.home,
    owners,
    editIntervalMs: 300,
    heartbeatIntervalMs: 1000,
    ...config
  });
  const core = /** @type {any} */ (fake.ctx.get('channelCore'));
  const adapter = createFakeAdapter();
  const host = core.registerAdapter(adapter.adapter);
  await adapter.adapter.start(host);
  return { fake, core, adapter, host };
}

/**
 * 造一条归一化的 Telegram 入站事件。
 * @param {Partial<import('../../src/protocol.js').InboundEvent>} [overrides]
 * @returns {any}
 */
export function inboundEvent(overrides = {}) {
  const updateId = overrides.rawId ?? String(nextUpdateId());
  return {
    channel: 'telegram',
    account: 'default',
    rawId: updateId,
    userId: '7',
    chatId: '42',
    kind: 'message',
    text: '你好',
    nextCursor: Number(updateId) + 1,
    receivedAt: Date.now(),
    ...overrides
  };
}

let updateCounter = 100;
/** @returns {number} */
export function nextUpdateId() {
  updateCounter += 1;
  return updateCounter;
}
