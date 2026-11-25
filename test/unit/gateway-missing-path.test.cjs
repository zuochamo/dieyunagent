'use strict';
/**
 * 「这条路径确实不存在」与「读不出来」必须分开（2026-11-21 防御性代码审计 §2.2 / §2.3）。
 *
 * 两处旁路读都是「先读一次原文」，读不到就退回 `null`：
 *   1) `fs.write_file` 的撤回快照 —— 撤回侧对 `before == null` 走**删除分支**（`rpc.js:restoreUndoFile`），
 *      把「读失败」当 `null` 的后果是**撤回删掉用户文件**；
 *   2) `browser.visual_diff` 的基准 —— 把「读失败」当「还没有基准」的后果是**回写新基准覆盖用户文件**，
 *      并报「已保存为新基准」（browser 处理器文件头记的正是这桩事故）。
 *
 * 这里钉住：判据 `isPathMissingError` 只把三种方言的「不存在」当不存在，其余错误一律上抛。
 */
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createFsHandlers } = require('../../src/gateway/handlers/fs.js');
const { createBrowserHandlers } = require('../../src/gateway/handlers/browser.js');
const { decideFsTarget } = require('../../src/gateway/host-local.js');
const { isPathMissingError } = require('../../src/gateway/path-policy.js');
const { defaultBaselineName, withEngineTag } = require('../../src/browser/visual-diff.js');
const { ensureExtension } = require('../../src/browser/service.js');

const ROOT = path.resolve(os.tmpdir(), 'dieyun-missing-path-test');

function enoent() {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

function fsHandlers({ captureUndoWrite = () => {} } = {}) {
  return createFsHandlers({
    perms: { hostControl: true, fsRead: true, fsWrite: true },
    getRemoteFs: () => null,
    resolveFsTarget: (p) => decideFsTarget(p, { remote: null, defaultCwd: ROOT, sessionCwd: ROOT }),
    resolveHostSidecarLocalPath: () => null,
    sidecarReadOpts: () => ({}),
    readSidecarFileAt: async () => null,
    normalizeFilePathInput: (p) => path.resolve(p),
    cwdForCall: () => ROOT,
    resolveCallWorkspaceTarget: () => ({ remote: null }),
    assertAllowedPath: (p) => path.resolve(p),
    readRootsForCall: () => [ROOT],
    writeRootsForCall: () => [ROOT],
    invokeRustCore: async () => null,
    readAllowedTextFile: async () => ({ data: '' }),
    assertHostEnabled: () => {},
    ctx: {},
    captureUndoWrite,
    assertSandboxWritable: async () => {},
    lspDiagnostics: null,
    summarizeLineDiff: () => ({ added: 1, removed: 0 }),
    isSshConnectedForCall: () => false,
    requireSshForCall: () => {
      throw new Error('ssh 不该被用到');
    }
  });
}

describe('「路径不存在」的判据只有一份（gateway/path-policy.isPathMissingError）', () => {
  it('三种方言的「不存在」都算', () => {
    assert.equal(isPathMissingError(enoent()), true);
    // SFTP 原样透出的数字状态码 2 / 11 与 NO_SUCH_FILE
    assert.equal(isPathMissingError({ code: 2 }), true);
    assert.equal(isPathMissingError({ code: 11 }), true);
    assert.equal(isPathMissingError({ code: 'NO_SUCH_FILE' }), true);
    assert.equal(isPathMissingError({ status: 2 }), true);
    // ssh2 有时只给文案
    assert.equal(isPathMissingError(new Error('No such file')), true);
  });

  it('其它读失败不算（否则又变回「读失败＝不存在」）', () => {
    assert.equal(isPathMissingError(Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' })), false);
    assert.equal(isPathMissingError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
    assert.equal(isPathMissingError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })), false);
    assert.equal(isPathMissingError(null), false);
    assert.equal(isPathMissingError(undefined), false);
  });
});

describe('fs.write_file：撤回快照读不到就不许照常写', () => {
  it('原文读失败 → UNDO_SNAPSHOT_UNAVAILABLE，且这次写没有发生', async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
    await fsp.mkdir(ROOT, { recursive: true });
    // 目标是个目录：`existsSync` 为真，`readFile` 必然失败（EISDIR）——
    // 正是「文件在、但读不出来」，以前会被当成 before=null（= 撤回时删文件）。
    const target = path.join(ROOT, 'not-a-file');
    await fsp.mkdir(target, { recursive: true });

    const handlers = fsHandlers();
    await assert.rejects(
      () => handlers['fs.write_file']({ filePath: target, data: 'x', encoding: 'utf8' }),
      (err) => {
        assert.equal(err.code, 'UNDO_SNAPSHOT_UNAVAILABLE');
        assert.equal(err.path, path.resolve(target));
        return true;
      }
    );
    // 目录还在，说明这次「写」没有在半途留下痕迹
    assert.equal((await fsp.stat(target)).isDirectory(), true);
  });

  it('目标不存在（首次新建）照旧放行，且撤回快照记的是 null', async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
    await fsp.mkdir(ROOT, { recursive: true });
    const target = path.join(ROOT, 'brand-new.txt');
    const undoWrites = [];
    const handlers = fsHandlers({ captureUndoWrite: (payload) => undoWrites.push(payload) });

    const res = await handlers['fs.write_file']({ filePath: target, data: 'x', encoding: 'utf8' });
    assert.equal(res.ok !== false, true);
    assert.equal(await fsp.readFile(target, 'utf8'), 'x');
    assert.equal(undoWrites.length, 1);
    assert.equal(undoWrites[0].beforeText, null, '新建文件的 before 就该是 null');
  });

  it('已存在的可读文件：撤回快照记下真实原文', async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
    await fsp.mkdir(ROOT, { recursive: true });
    const target = path.join(ROOT, 'existing.txt');
    await fsp.writeFile(target, '旧内容', 'utf8');
    const undoWrites = [];
    const handlers = fsHandlers({ captureUndoWrite: (payload) => undoWrites.push(payload) });

    await handlers['fs.write_file']({ filePath: target, data: '新内容', encoding: 'utf8' });
    assert.equal(await fsp.readFile(target, 'utf8'), '新内容');
    assert.equal(undoWrites[0].beforeText, '旧内容');
  });
});

describe('browser.visual_diff：基准读不出来不许当成「还没有基准」', () => {
  function browserHandlers() {
    const writeArtifactCalls = [];
    const handlers = createBrowserHandlers({
      assertBrowserEnabled: () => {},
      resolveFsTarget: (p) => decideFsTarget(p, { remote: null, defaultCwd: ROOT, sessionCwd: ROOT }),
      normalizeFilePathInput: (p) => path.resolve(ROOT, p),
      assertAllowedPath: (p) => path.resolve(p),
      readRootsForCall: () => [ROOT],
      writeRootsForCall: () => [ROOT],
      assertSandboxWritable: async () => {},
      getRemoteFs: () => null,
      cwdForCall: () => ROOT,
      defaultCwd: ROOT,
      roots: [ROOT],
      writable: [ROOT],
      writeArtifactCalls,
      browser: {
        resolveEngine: () => 'browser',
        // 只要基准是 null，就会走「已保存为新基准」这条 —— 断言里不许出现它
        visualDiff: async ({ baselineBuffer }) => ({
          ok: true,
          baselineCreated: baselineBuffer == null,
          baselinePng: baselineBuffer == null ? 'iVBORw0KGgo=' : null
        })
      }
    });
    return { handlers, writeArtifactCalls };
  }

  it('基准路径是个目录（存在但读不出来）→ 直接报错，不返回 baselineCreated', async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
    await fsp.mkdir(ROOT, { recursive: true });
    // 基准文件名会带引擎标记（`withEngineTag`），按生产同一口径算出真实落点再建目录
    const ref = withEngineTag(ensureExtension('baseline', 'png'), 'browser');
    const baselineDir = path.join(ROOT, ref);
    await fsp.mkdir(baselineDir, { recursive: true });
    const { handlers } = browserHandlers();

    await assert.rejects(
      () => handlers['browser.visual_diff']({ baselinePath: ref }),
      (err) => {
        assert.notEqual(err.code, 'ENOENT');
        // 报错必须指向真实原因（不是「没有基准」）
        assert.match(String(err.message || err), /directory|EISDIR|illegal/i);
        return true;
      }
    );
  });

  it('基准确实不存在 → 仍然按「首次」新建（合法缺省，不能变成报错）', async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
    await fsp.mkdir(ROOT, { recursive: true });
    const { handlers } = browserHandlers();
    const res = await handlers['browser.visual_diff']({ baselinePath: 'missing-baseline.png' });
    assert.equal(res.baselineCreated, true);
  });
});
