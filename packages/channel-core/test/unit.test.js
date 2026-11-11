import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCallback, encodeCallback } from '../src/callback.js';
import { resolveCoreConfig } from '../src/config.js';
import { dayKeyUtc, parseRouteKey, routeKey, safeFileName, truncate } from '../src/util.js';

describe('util', () => {
  it('routeKey 与 parseRouteKey 互逆，并把缺失的 thread 归一化为空', () => {
    const route = { channel: 'telegram', account: 'default', chatId: '42' };
    const key = routeKey(route);
    assert.equal(key, 'telegram:default:42:');
    assert.deepEqual(parseRouteKey(key), route);

    const withThread = { channel: 'telegram', account: 'default', chatId: '42', threadId: '7' };
    assert.deepEqual(parseRouteKey(routeKey(withThread)), withThread);
  });

  it('parseRouteKey 拒绝格式错误的键', () => {
    assert.throws(() => parseRouteKey('telegram:default'), /malformed route key/u);
  });

  it('trim 长文本时留下明确标记而不是静默截断', () => {
    const text = 'a'.repeat(50);
    const result = truncate(text, 10);
    assert.ok(result.startsWith('a'.repeat(10)));
    assert.match(result, /已截断至 10/u);
  });

  it('safeFileName 去掉路径与非法字符，但保留中文', () => {
    assert.equal(safeFileName('/etc/passwd'), 'passwd');
    assert.equal(safeFileName('a/b\\c:?.txt'), 'c__.txt');
    assert.equal(safeFileName('报告 2026.pdf'), '报告 2026.pdf');
    assert.equal(safeFileName(''), 'attachment');
    // '.' / '..' 这类名字被压成 '_'，不会变成目录穿越或空名
    assert.equal(safeFileName('..'), '_');
  });

  it('dayKeyUtc 用 UTC 日键，避免本地时区造成重复或缺日', () => {
    assert.equal(dayKeyUtc(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02');
  });
});

describe('callback 编码', () => {
  it('往返一致，且长度远低于 Telegram 的 64 字节上限', () => {
    const data = encodeCallback({ recordShortId: 'abcd1234', questionIndex: 3, optionIndex: 12, action: 'o' });
    assert.ok(Buffer.byteLength(data) <= 64, `callback data too long: ${data}`);
    assert.deepEqual(decodeCallback(data), { recordShortId: 'abcd1234', questionIndex: 3, optionIndex: 12, action: 'o' });
  });

  it('拒绝任何不认识的外部输入', () => {
    for (const data of ['', 'v1|x|0|0|o', 'v2|abcd1234|0|0|o', 'v1|abcd1234|0|0|x', 'v1|abcd1234|-1|0|o', 'v1|abcd1234|0|-2|o', 'v1|abcd1234|a|0|o']) {
      assert.equal(decodeCallback(data), undefined, `should reject ${data}`);
    }
  });
});

describe('config', () => {
  it('缺省的 DSH_HOME 落到 ~/.dsh-assistant，并派生数据布局', () => {
    const config = resolveCoreConfig({}, {}, '/home/tester');
    assert.equal(config.dshHome, '/home/tester/.dsh-assistant');
    assert.equal(config.channelsDir, '/home/tester/.dsh-assistant/channels');
    assert.equal(config.runDir, '/home/tester/.dsh-assistant/run');
    assert.equal(config.workspaceDir, '/home/tester/.dsh-assistant/workspace');
    assert.equal(config.pushIdentityDiff, true);
  });

  it('DSH_HOME 环境变量优先于 home 推导，显式 home 配置优先于环境变量', () => {
    assert.equal(resolveCoreConfig({}, { DSH_HOME: '/env/home' }, '/home/tester').dshHome, '/env/home');
    assert.equal(resolveCoreConfig({ home: '/explicit' }, { DSH_HOME: '/env/home' }, '/home/tester').dshHome, '/explicit');
  });

  it('白名单与数值配置写错时 fail loudly', () => {
    assert.throws(() => resolveCoreConfig({ owners: { telegram: [''] } }), /owners\.telegram/u);
    assert.throws(() => resolveCoreConfig({ owners: ['x'] }), /owners/u);
    assert.throws(() => resolveCoreConfig({ editIntervalMs: 10 }), /editIntervalMs/u);
    assert.throws(() => resolveCoreConfig({ rate: { perMinute: 0 } }), /rate\.perMinute/u);
  });

  it('owners 去重并冻结', () => {
    const config = resolveCoreConfig({ owners: { telegram: ['1', '1', '2'] } });
    assert.deepEqual([...config.owners.telegram], ['1', '2']);
    assert.throws(() => {
      // @ts-expect-error 运行时冻结
      config.owners.telegram.push('3');
    }, TypeError);
  });
});