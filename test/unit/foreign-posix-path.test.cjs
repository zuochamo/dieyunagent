'use strict';
/**
 * 「daemon 侧路径被当成本机路径」这条静默失败线（SSH-MODULE-REVIEW S14）。
 *
 * 现场：远端会话的工作区是 `/run/media/dieyunx/…/worktrees/sess-…/main`，在 Windows 上
 * `path.isAbsolute` 判 true、`path.resolve` 却把盘符沿用 cwd 得到 `E:\run\media\…`。
 * 于是索引报 INVALID_WORKSPACE、读文件 ENOENT、grep 给「ok 但 0 命中」——最后这个最坑：
 * 模型会得出「仓库里没有这段代码」并放弃检索，而真相是根根本没解析成功。
 *
 * 这里锁三件事：
 *   1. 判据只在 win32 成立（非 Windows 上 `/srv/app` 就是合法本地路径，同串无歧义）；
 *   2. 拼出来连父目录都不存在 → 报 `REMOTE_PATH_AS_LOCAL`，不许返回幻觉路径；
 *   3. 「工作区相对写法」（`/src/x.js`，模型常这么写）必须按**工作区相对**解析成功，
 *      包括要新建的深层文件（`/src/new/x.js`）；「/c:/Users/…」这种被 URI 化过的盘符路径还原。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isForeignPosixPath } = require('../../src/workspace/target');
const { normalizeFilePathInput } = require('../../src/gateway/host-control');
const { grepWorkspace, globWorkspace } = require('../../src/gateway/rg-search');

const isWin = process.platform === 'win32';
const itWin = isWin ? it : it.skip;

describe('外来 POSIX 路径判据（isForeignPosixPath）', () => {
  itWin('win32：以 / 开头的 daemon 路径算外来', () => {
    assert.equal(isForeignPosixPath('/run/media/dieyunx/dieyunserver/PixelOfficeMonitor'), true);
    assert.equal(isForeignPosixPath('  /srv/app/.dieyun/worktrees/sess-x/main  '), true);
  });

  itWin('win32：盘符路径 / UNC / ssh URI / 相对路径都不算外来', () => {
    assert.equal(isForeignPosixPath('E:\\dieyunagent'), false);
    assert.equal(isForeignPosixPath('E:/dieyunagent'), false);
    assert.equal(isForeignPosixPath('\\\\srv\\share\\proj'), false);
    assert.equal(isForeignPosixPath('//srv/share/proj'), false);
    assert.equal(isForeignPosixPath('ssh://dieyun@10.0.0.5/srv/app'), false);
    assert.equal(isForeignPosixPath('../src/x.js'), false);
    assert.equal(isForeignPosixPath('src/x.js'), false);
    assert.equal(isForeignPosixPath(''), false);
    assert.equal(isForeignPosixPath(null), false);
  });

  it('非 Windows：/srv/app 是合法本地绝对路径，不做外来判定', () => {
    if (isWin) {
      assert.equal(isForeignPosixPath('/srv/app'), true);
      return;
    }
    assert.equal(isForeignPosixPath('/srv/app'), false);
  });
});

describe('normalizeFilePathInput：daemon 路径不许拼成本机盘符路径', () => {
  const cwd = process.cwd();

  itWin('整棵目录树都不存在 → 报 REMOTE_PATH_AS_LOCAL（旧行为是静默返回 E:\\run\\media\\…）', () => {
    const daemonPath = '/run/media/dieyunx/dieyunserver/PixelOfficeMonitor/.dieyun/worktrees/sess-2d6b/main';
    let err = null;
    try {
      normalizeFilePathInput(daemonPath, cwd);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '必须抛错，不许返回幻觉路径');
    assert.equal(err.code, 'REMOTE_PATH_AS_LOCAL');
    assert.equal(err.retryable, false);
    // 报错要能让现场一眼看出「猜成了哪个本机路径」
    assert.ok(String(err.message).includes(daemonPath));
    assert.ok(String(err.resolvedPath || '').toLowerCase().includes('run\\media'));
  });

  itWin('工作区相对写法（/src/x.js）按工作区解析 —— 包括要新建的深层文件', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-foreign-rel-'));
    try {
      fs.mkdirSync(path.join(ws, 'src'));
      // 首段 src 存在 ⇒ 工作区相对说得通；文件本身还不存在也必须能拼对（写入前就调用）
      assert.equal(
        normalizeFilePathInput('/src/a.js', ws).toLowerCase(),
        path.join(ws, 'src', 'a.js').toLowerCase()
      );
      assert.equal(
        normalizeFilePathInput('/src/new/deep/c.js', ws).toLowerCase(),
        path.join(ws, 'src', 'new', 'deep', 'c.js').toLowerCase()
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  itWin('「/c:/Users/…」这种被 URI 化过的盘符路径要还原（LSP 常见）', () => {
    const resolved = normalizeFilePathInput('/E:/dieyunagent/package.json', cwd);
    assert.equal(resolved, path.resolve('E:\\dieyunagent\\package.json'));
  });

  itWin('工作区里说不通的路径照旧报错（不因为放宽而漏网）', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-foreign-miss-'));
    try {
      fs.mkdirSync(path.join(ws, 'src'));
      let err = null;
      try {
        normalizeFilePathInput('/run/media/dieyunx/app/src/x.js', ws);
      } catch (e) {
        err = e;
      }
      assert.ok(err, '首段 run 不在工作区里 → 必须报错');
      assert.equal(err.code, 'REMOTE_PATH_AS_LOCAL');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('相对路径与盘符路径完全不受影响', () => {
    const rel = normalizeFilePathInput('src/agent/tool-gate.js', cwd);
    assert.equal(rel, path.resolve(cwd, 'src/agent/tool-gate.js'));
    const abs = normalizeFilePathInput(path.join(cwd, 'package.json'), null);
    assert.equal(abs, path.resolve(cwd, 'package.json'));
  });
});

describe('搜索根不存在时 grep / glob 必须报错，不许折成 0 命中', () => {
  it('grepWorkspace：根不存在 → ok:false / SEARCH_ROOT_UNREADABLE', async () => {
    const ghost = path.join(os.tmpdir(), 'dieyun-no-such-root-2d6b', 'main');
    const res = await grepWorkspace(ghost, { pattern: 'import', regex: false });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'SEARCH_ROOT_UNREADABLE');
    assert.equal(res.root, path.resolve(ghost));
    assert.ok(String(res.error).includes('不是「没有匹配」'));
  });

  it('globWorkspace：根不存在 → ok:false / SEARCH_ROOT_UNREADABLE', async () => {
    const ghost = path.join(os.tmpdir(), 'dieyun-no-such-root-2d6b', 'main');
    const res = await globWorkspace(ghost, { pattern: '**/*.js' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'SEARCH_ROOT_UNREADABLE');
  });

  it('根存在时照常搜索（真命中 / 真不命中都还是 ok:true）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-grep-root-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\nimport fs from "fs";\n', 'utf8');
      const hit = await grepWorkspace(dir, { pattern: 'import', regex: false });
      assert.equal(hit.ok, true);
      assert.ok(hit.matches.length >= 1);

      const miss = await grepWorkspace(dir, { pattern: '没有这段代码', regex: false });
      assert.equal(miss.ok, true);
      assert.equal(miss.matches.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
