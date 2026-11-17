'use strict';
/**
 * `fs_list_dir` 的空列表必须是「目录真的空」，不能是「读不到」。
 *
 * 背景（实测，2026-10-23 改进清单 AGT-04）：本地目录明明有文件，工具返回 0 项，
 * 模型据此判「产物未生成」→ 重复生成、重复写入。根因在 `fs.list_dir`：
 * Rust core 返回空数组时直接 `return`，从不校验目录是否真实存在 —— `[]` 于是
 * 同时表示「空目录」和「路径不存在 / 盘符不在 / 无权限」，语义不可区分。
 *
 * 修法（不是加兜底）：空列表必须先用 stat 证明目录存在且是目录，否则抛
 * FS_LIST_FAILED。这里钉住四件事：
 *   1) 真空目录 → 返回 []（合法，不能变成报错）
 *   2) 目录不存在 → 抛 FS_LIST_FAILED 且 message 带路径
 *   3) 路径是文件 → 抛 FS_LIST_FAILED
 *   4) Rust core 不可用（null）→ Node 兜底要正常工作，且同样过 1/2/3 的校验
 */
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createFsHandlers } = require('../../src/gateway/handlers/fs.js');
// 「去哪台机器」的判定用生产那份纯函数（本地会话：无远端、基准是会话工作区根）
const { decideFsTarget } = require('../../src/gateway/host-local.js');

const ROOT = path.resolve(os.tmpdir(), 'dieyun-fs-list-dir-test');

/** 装配一个只关心 list_dir 的最小依赖集；invokeRustCore 由用例注入。 */
function makeHandlers(invokeRustCore) {
  const handlers = createFsHandlers({
    perms: { hostControl: true, fsRead: true, fsWrite: true },
    getRemoteFs: () => null,
    resolveFsTarget: (p) => decideFsTarget(p, { remote: null, defaultCwd: ROOT, sessionCwd: ROOT }),
    resolveHostSidecarLocalPath: () => null,
    sidecarReadOpts: () => ({}),
    readSidecarFileAt: async () => null,
    normalizeFilePathInput: (p) => path.resolve(p),
    cwdForCall: () => ROOT,
    assertAllowedPath: (p) => path.resolve(p),
    readRootsForCall: () => [ROOT],
    writeRootsForCall: () => [ROOT],
    invokeRustCore,
    ctx: {}
  });
  return handlers;
}

async function resetRoot() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });
}

describe('fs_list_dir 空列表必须是真空目录', () => {
  it('真空目录返回 []（不能把合法空目录变成报错）', async () => {
    await resetRoot();
    const handlers = makeHandlers(async () => []);
    const res = await handlers['fs.list_dir']({ dirPath: ROOT });
    assert.deepEqual(res, []);
  });

  it('目录不存在时抛 FS_LIST_FAILED，不再返回 []', async () => {
    await resetRoot();
    const missing = path.join(ROOT, 'nope-not-here');
    const handlers = makeHandlers(async () => []);
    await assert.rejects(
      () => handlers['fs.list_dir']({ dirPath: missing }),
      (err) => {
        assert.equal(err.code, 'FS_LIST_FAILED');
        assert.equal(err.path, path.resolve(missing));
        assert.match(err.message, /不存在/);
        return true;
      }
    );
  });

  it('路径是文件时抛 FS_LIST_FAILED', async () => {
    await resetRoot();
    const file = path.join(ROOT, 'a.txt');
    await fsp.writeFile(file, 'x', 'utf8');
    const handlers = makeHandlers(async () => []);
    await assert.rejects(
      () => handlers['fs.list_dir']({ dirPath: file }),
      (err) => {
        assert.equal(err.code, 'FS_LIST_FAILED');
        assert.match(err.message, /不是目录/);
        return true;
      }
    );
  });

  it('Rust 返回非空时直接透传', async () => {
    const handlers = makeHandlers(async () => [
      { name: 'ghost.txt', isDirectory: false, size: 1, mtimeMs: 1 }
    ]);
    // 路径故意不存在：非空结果不应再走 stat 校验，证明没有给热路径加额外系统调用
    const res = await handlers['fs.list_dir']({ dirPath: path.join(ROOT, 'ghost-dir') });
    assert.equal(res.length, 1);
    assert.equal(res[0].name, 'ghost.txt');
  });

  it('Rust core 不可用时 Node 兜底仍能列出，且同样拦住不存在的路径', async () => {
    await resetRoot();
    await fsp.writeFile(path.join(ROOT, 'b.md'), 'hi', 'utf8');
    const handlers = makeHandlers(async () => null);

    const list = await handlers['fs.list_dir']({ dirPath: ROOT });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'b.md');
    assert.equal(list[0].isDirectory, false);

    await assert.rejects(
      () => handlers['fs.list_dir']({ dirPath: path.join(ROOT, 'gone') }),
      (err) => err.code === 'FS_LIST_FAILED'
    );
  });
});
