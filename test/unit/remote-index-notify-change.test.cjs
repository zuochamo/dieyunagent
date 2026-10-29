'use strict';
/**
 * 远端侧「要不要重索引」的判定只有一份：`fs.write_file`（远端自己写）与
 * `index.notify_change`（桌面端走 SFTP 写/删）共用。
 *
 * 这些用例只验判定，不启 dieyun-core：索引调度本身依赖真实 core。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createRemoteGatewayHandlers } = require('../../src/remote/minimal-gateway-host');

function makeHandlers() {
  const root = path.join(os.tmpdir(), 'dieyun-remote-notify-test', 'ws');
  return createRemoteGatewayHandlers(root, { log: () => {} });
}

describe('index.notify_change 的判定', () => {
  it('非 utf8 写入不触发索引（二进制改了源码索引看不出差别）', async () => {
    const h = makeHandlers();
    const r = await h['index.notify_change']({ filePath: '/ws/a.png', encoding: 'base64', op: 'write' });
    assert.deepEqual(r, { scheduled: false, reason: 'non_utf8' });
  });

  it('.dieyun 下的文件不触发（索引库自己在里面）', async () => {
    const h = makeHandlers();
    const root = path.join(os.tmpdir(), 'dieyun-remote-notify-test', 'ws');
    const r = await h['index.notify_change']({ filePath: path.join(root, '.dieyun', 'x.json'), encoding: 'utf8' });
    assert.deepEqual(r, { scheduled: false, reason: 'ignored_path' });
  });

  it('不在任何可用根里（如 /etc）：out_of_root', async () => {
    const h = makeHandlers();
    // 用「文件系统根 + 名字」而不是硬编码 /etc：可用根是「工作空间 + HOME + /tmp」，
    // 这两条断言在 POSIX 与 Windows 上都得成立。
    const fsRoot = path.parse(os.tmpdir()).root;
    const outside = path.join(fsRoot, 'dieyun-notify-outside-probe', 'a.ts');
    const r = await h['index.notify_change']({ filePath: outside, encoding: 'utf8' });
    assert.deepEqual(r, { scheduled: false, reason: 'out_of_root' });
  });

  it('可用根内但不在工作空间（/tmp）→ 不索引，但不算越界', async () => {
    const h = makeHandlers();
    // 可用根与桌面端同一份（工作空间 + HOME + /tmp）：写 /tmp 是允许的；
    // 索引范围仍然只有工作空间，所以这里是「允许但不索引」。
    const outside = path.join(os.tmpdir(), 'dieyun-remote-notify-test', 'outside.ts');
    const r = await h['index.notify_change']({ filePath: outside, encoding: 'utf8' });
    assert.deepEqual(r, { scheduled: false, reason: 'ignored_path' });
  });

  it('路径合法但 core 没起：不报错，返回 core_not_ready（首轮索引由状态轮询触发）', async () => {
    const h = makeHandlers();
    const root = path.join(os.tmpdir(), 'dieyun-remote-notify-test', 'ws');
    const r = await h['index.notify_change']({ filePath: path.join(root, 'src', 'a.ts'), encoding: 'utf8' });
    assert.deepEqual(r, { scheduled: false, reason: 'core_not_ready' });
  });

  it('删除也是一种变更：给了路径就按源码与否决定要不要动图谱', async () => {
    const h = makeHandlers();
    const root = path.join(os.tmpdir(), 'dieyun-remote-notify-test', 'ws');
    const r = await h['index.notify_change']({ filePath: path.join(root, 'src', 'a.ts'), op: 'delete' });
    assert.equal(r.reason, 'core_not_ready', '删源码文件应当走到调度这一步（此处只因 core 未就绪而停）');
  });

  it('空的 params 也不炸（fire-and-forget 的容错）', async () => {
    const h = makeHandlers();
    const r = await h['index.notify_change']({});
    assert.deepEqual(r, { scheduled: false, reason: 'core_not_ready' });
  });
});
