'use strict';
/**
 * 索引根的单一解析处（`src/remote/index-root.js`）+ 远端 core 的越界拒绝。
 *
 * 守的是一条线：**远端只有一份 index.sqlite，属于 daemon 连接 hello 声明的那个根**。
 * 一条链路上有三个「根」的说法（调用方显式传的 / 本次调用作用域 / daemon hello 声明的），
 * 历史上第 1 个被第 2 个静默丢弃、第 3 个从没被比对过，症状统一表现为
 * 「面板永远未建立、工具调用却都成功」。这里锁死三件事：
 *   1. 归一化：`ssh://user@host/p`、`/p/`、相对路径都要落到同一个 `/p`；
 *   2. 两个根不等 → `WORKSPACE_SCOPE_MISMATCH`（带两个根，否则现场无法判断该改哪边）；
 *   3. 远端 core 收到不属于自己的根 → 起进程之前就拒绝。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const { normalizeIndexRoot, resolveIndexRoot } = require('../../src/remote/index-root');

describe('索引根归一化', () => {
  it('ssh URI 取 remotePath（daemon 只认这个坐标）', () => {
    assert.equal(normalizeIndexRoot('ssh://dieyun@10.0.0.5:2222/srv/app/.dieyun/worktrees/sess-x/main'), '/srv/app/.dieyun/worktrees/sess-x/main');
  });

  it('POSIX 路径去尾斜杠、折叠 . 与 ..', () => {
    assert.equal(normalizeIndexRoot('/srv/app/'), '/srv/app');
    assert.equal(normalizeIndexRoot('/srv/app/./sub/../'), '/srv/app');
  });

  it('相对路径相对作用域根展开（不是相对 / ）', () => {
    assert.equal(normalizeIndexRoot('./src', '/srv/app'), '/srv/app/src');
    assert.equal(normalizeIndexRoot('src', '/srv/app'), '/srv/app/src');
  });

  it('本机 Windows 路径不被猜成远端路径（原样转分隔符，交给比对去报错）', () => {
    assert.equal(normalizeIndexRoot('E:\\proj'), 'E:/proj');
  });

  it('空值 / 形态不合法的 ssh 串 → 视为没给根', () => {
    assert.equal(normalizeIndexRoot(''), '');
    assert.equal(normalizeIndexRoot(null), '');
    assert.equal(normalizeIndexRoot('ssh:user@host:/srv'), '');
  });
});

describe('索引根解析：显式根不许被静默丢弃', () => {
  it('只给作用域 → 用作用域', () => {
    assert.deepEqual(resolveIndexRoot({ scopeRoot: '/srv/app' }), { root: '/srv/app', source: 'scope' });
  });

  it('只给显式 → 用显式', () => {
    assert.deepEqual(resolveIndexRoot({ explicitRoot: '/srv/app' }), { root: '/srv/app', source: 'explicit' });
  });

  it('两者等价（URI vs 裸路径 / 尾斜杠）→ 不算冲突', () => {
    assert.equal(
      resolveIndexRoot({ explicitRoot: 'ssh://u@h/srv/app/', scopeRoot: '/srv/app' }).root,
      '/srv/app'
    );
  });

  it('两者不同 → WORKSPACE_SCOPE_MISMATCH，且错误里必须同时有这两个根', () => {
    let err = null;
    try {
      resolveIndexRoot({ explicitRoot: '/srv/app/worktrees/a', scopeRoot: '/srv/app/worktrees/b', label: 'codebase.status' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '不一致必须抛错，不许静默选一个');
    assert.equal(err.code, 'WORKSPACE_SCOPE_MISMATCH');
    assert.equal(err.retryable, false);
    assert.ok(err.message.includes('/srv/app/worktrees/a'), '错误里要能看见请求的根');
    assert.ok(err.message.includes('/srv/app/worktrees/b'), '错误里要能看见作用域的根');
    assert.match(err.suggestedFix, /runWorkspaceRoot/);
  });

  it('本机路径混进远端调用 → 按不一致处理（不许当成远端根）', () => {
    assert.throws(
      () => resolveIndexRoot({ explicitRoot: 'E:\\proj', scopeRoot: '/srv/app' }),
      (e) => e.code === 'WORKSPACE_SCOPE_MISMATCH'
    );
  });
});

describe('远端 core 拒绝别的工作区的根', () => {
  const { RemoteIndexCoreHost } = require('../../src/remote/remote-index-core');

  function makeHost(root) {
    // packRoot 故意指向不存在的位置：正常路径会得到 REMOTE_INDEX_CORE_MISSING，
    // 这正好证明「根比对」发生在起进程之前。
    return new RemoteIndexCoreHost({ workspaceRoot: root, packRoot: path.join(__dirname, 'no-such-pack') });
  }

  it('请求别的根 → 起进程前就报 WORKSPACE_SCOPE_MISMATCH', async () => {
    const host = makeHost('/srv/app/.dieyun/worktrees/sess-a/main');
    await assert.rejects(
      () => host.invoke('codebase.status', { workspaceRoot: '/srv/app/.dieyun/worktrees/sess-b/main' }),
      (e) => e.code === 'WORKSPACE_SCOPE_MISMATCH'
    );
  });

  it('请求自己的根 / 不带根 → 通过比对，继续走正常的 core 启动（此处因缺二进制失败）', async () => {
    const host = makeHost('/srv/app/.dieyun/worktrees/sess-a/main');
    for (const params of [{ workspaceRoot: '/srv/app/.dieyun/worktrees/sess-a/main' }, {}]) {
      await assert.rejects(
        () => host.invoke('codebase.status', params),
        (e) => e.code !== 'WORKSPACE_SCOPE_MISMATCH'
      );
    }
  });
});
