'use strict';
/**
 * 会话 worktree 的回收规则（`src/session/session-worktree.js` + `src/ssh/remote-worktree.js`）。
 *
 * 背景：乙案下一个会话一份远端 worktree，里面还有一份索引库（实测 19–38 MB / 份）。
 * 会话 worktree 没有任何回收路径 —— 只有 planner 的 worktree 走 `worktree:remove` ——
 * 于是 `…/.dieyun/worktrees/` 会随会话数无限增长（真机上一次测得 13 份）。
 *
 * 这里锁住四件事：
 *   1. 「哪份还活着」只认会话表（`sessions_list` 的 `updatedAt`）+ 在途租约，**不靠远端 mtime**；
 *   2. 保留期内活跃的、正在租用的、当前会话的，一个都不许删；
 *   3. 远端脚本只碰 `sess-*` 我们自己命名的形状，且有未提交改动的直接保留；
 *   4. 键匹配必须是整词（`sess-ab` 不能吃掉 `sess-abc`）。
 */
const assert = require('node:assert/strict');

const {
  sessionKeysToKeep,
  pruneStaleSessionWorktrees,
  ensureSessionWorktree,
  SESSION_WORKTREE_KEEP_DAYS
} = require('../../src/session/session-worktree');
const {
  buildPruneWorktreesScript,
  parsePruneResult,
  remoteWorktreeKey
} = require('../../src/ssh/remote-worktree');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // 固定时间，避免测试跟真实时钟挂钩

const key = (sid) => remoteWorktreeKey(sid);

describe('会话 worktree 回收规则', () => {
  it('保留期内活跃的会话保留，过期的回收', () => {
    const keep = sessionKeysToKeep({
      nowMs: NOW,
      keepDays: 7,
      sessions: [
        { id: 's-recent', updatedAt: NOW - 1 * DAY_MS },
        { id: 's-edge', updatedAt: NOW - 6 * DAY_MS },
        { id: 's-old', updatedAt: NOW - 30 * DAY_MS }
      ]
    });
    assert.ok(keep.includes(key('s-recent')));
    assert.ok(keep.includes(key('s-edge')));
    assert.ok(!keep.includes(key('s-old')));
  });

  it('正在租用与当前会话一定保留（哪怕会话表里已经很久没动）', () => {
    const keep = sessionKeysToKeep({
      nowMs: NOW,
      keepDays: 7,
      sessions: [{ id: 's-idle', updatedAt: NOW - 90 * DAY_MS }],
      leasedSessionIds: ['s-idle'],
      currentSessionId: 's-current'
    });
    assert.ok(keep.includes(key('s-idle')), '租约在，就不能被回收');
    assert.ok(keep.includes(key('s-current')), '当前会话不能删自己');
  });

  it('会话表里已经没有的会话（被删 / 更老）不保留', () => {
    const keep = sessionKeysToKeep({ nowMs: NOW, keepDays: 7, sessions: [] });
    assert.deepEqual(keep, []);
  });

  it('归档不影响保留期：只看最后活跃时间', () => {
    // 归档是侧栏整理动作，不是「这份副本可以立刻删」——
    // 规则只有一个判据，按 archived 分叉会导致刚归档的会话副本被立刻回收。
    const keep = sessionKeysToKeep({
      nowMs: NOW,
      keepDays: 7,
      sessions: [
        { id: 's-archived-recent', updatedAt: NOW - 1 * DAY_MS, archived: true },
        { id: 's-archived-old', updatedAt: NOW - 40 * DAY_MS, archived: true }
      ]
    });
    assert.ok(keep.includes(key('s-archived-recent')));
    assert.ok(!keep.includes(key('s-archived-old')));
  });

  it('保留期可注入，默认 7 天', () => {
    assert.equal(SESSION_WORKTREE_KEEP_DAYS, 7);
    const oneDay = sessionKeysToKeep({
      nowMs: NOW,
      keepDays: 1,
      sessions: [{ id: 's-2d', updatedAt: NOW - 2 * DAY_MS }]
    });
    assert.deepEqual(oneDay, []);
  });

  it('键去重且稳定排序（同一会话既是当前又在租约里）', () => {
    const keep = sessionKeysToKeep({
      nowMs: NOW,
      leasedSessionIds: ['s-b', 's-a'],
      currentSessionId: 's-a',
      sessions: [{ id: 's-c', updatedAt: NOW }]
    });
    assert.deepEqual(keep, [...new Set(keep)]);
    assert.deepEqual(keep, keep.slice().sort());
  });

  it('回收脚本：保留名单按整词匹配，并有未提交改动的保护', () => {
    const script = buildPruneWorktreesScript({
      repoPath: '/srv/项目 with space',
      keepKeys: ['sess-ab', 'sess-cd']
    }).join('\n');
    // 整词匹配的形态：KEEP=',sess-ab,sess-cd,'，两侧都有逗号
    assert.match(script, /KEEP=',sess-ab,sess-cd,'/);
    // 只碰 sess-* 形状
    assert.match(script, /for d in "\$ROOT"\/sess-\*/);
    // 有未提交改动 → 报出来并跳过
    assert.match(script, /git -C "\$WT" status --porcelain/);
    assert.match(script, /WT_KEPT_DIRTY/);
    // 删目录优先走 git（会顺带清 worktree 元数据），失败才兜底 rm
    assert.match(script, /git -C "\$REPO" worktree remove --force/);
    assert.match(script, /worktree prune/);
    // 含中文与空格的路径必须整体加引号
    assert.match(script, /REPO='\/srv\/项目 with space'/);
  });

  it('空保留名单不会产出 `,,` 这种会误匹配的形态', () => {
    const script = buildPruneWorktreesScript({ repoPath: '/srv/r', keepKeys: [] }).join('\n');
    assert.match(script, /KEEP=','/);
    assert.ok(!script.includes(',,'));
  });

  it('脚本输出解析：删了哪些、哪些因为改动被留下', () => {
    const parsed = parsePruneResult(
      ['WT_KEPT_DIRTY sess-dirty', 'WT_PRUNED sess-old1', 'WT_PRUNED sess-old2', 'WT_PRUNE_END'].join(
        '\n'
      )
    );
    assert.deepEqual(parsed.pruned, ['sess-old1', 'sess-old2']);
    assert.deepEqual(parsed.keptDirty, ['sess-dirty']);
    assert.equal(parsed.ok, true);
  });

  it('远端不是 git 仓库时明确不删（报 WT_NOT_GIT）', () => {
    const parsed = parsePruneResult('WT_PRUNE_NOT_GIT\n');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'WT_NOT_GIT');
    assert.deepEqual(parsed.pruned, []);
  });
});

describe('触发点：只在新建 worktree 时扫一次', () => {
  const tick = () => new Promise((r) => setTimeout(r, 50));

  function fakes(createStdout) {
    const rpc = [];
    const scripts = [];
    const gw = {
      setSessionWorkspaceContext() {},
      async invokeRpc(method, params) {
        rpc.push({ method, params });
        return [];
      }
    };
    const ssh = {
      async execScript(script) {
        scripts.push(script);
        return { code: 0, stdout: createStdout };
      }
    };
    return { gw, ssh, rpc, scripts };
  }

  const target = { kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: '/srv/proj' };

  it('新建 → 下发回收脚本，保留名单含当前会话', async () => {
    const { gw, ssh, scripts } = fakes('WT_CREATED\n');
    await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: 's-new', target });
    await tick();
    const prune = scripts.find((s) => s.includes('WT_KEPT_DIRTY'));
    assert.ok(prune, '应下发回收脚本');
    assert.ok(prune.includes(`KEEP=',${key('s-new')},'`), '当前会话必须在保留名单里');
  });

  it('复用 → 不扫（复用不会让目录数变多）', async () => {
    const { gw, ssh, scripts } = fakes('WT_REUSED\n');
    await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: 's-old', target });
    await tick();
    assert.equal(scripts.filter((s) => s.includes('WT_KEPT_DIRTY')).length, 0);
  });

  it('回收失败只吞在日志里，不影响会话（本地 core 没起来也算失败）', async () => {
    const logged = [];
    const gw = {
      setSessionWorkspaceContext() {},
      async invokeRpc() {
        throw new Error('core not ready');
      }
    };
    const res = await pruneStaleSessionWorktrees({
      localGateway: gw,
      sshManager: { execScript: async () => ({ code: 0, stdout: 'WT_PRUNE_END\n' }) },
      repoPath: '/srv/proj',
      sessionId: 's-x',
      log: (m) => logged.push(m)
    });
    assert.equal(res.ok, false);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /回收失败/);
  });

  it('保留名单同时覆盖「活跃」和「已归档」两份列表', async () => {
    const nowMs = Date.now();
    const gw = {
      setSessionWorkspaceContext() {},
      async invokeRpc(_method, params) {
        return params && params.archived
          ? [{ id: 's-archived', updatedAt: nowMs - 1 * DAY_MS, archived: true }]
          : [{ id: 's-active', updatedAt: nowMs - 1 * DAY_MS }];
      }
    };
    let script = '';
    const res = await pruneStaleSessionWorktrees({
      localGateway: gw,
      sshManager: {
        async execScript(s) {
          script = s;
          return { code: 0, stdout: 'WT_PRUNE_END\n' };
        }
      },
      repoPath: '/srv/proj',
      sessionId: 's-current'
    });
    assert.equal(res.ok, true);
    for (const sid of ['s-active', 's-archived', 's-current']) {
      assert.ok(script.includes(key(sid)), `${sid} 必须在保留名单里`);
    }
  });
});
