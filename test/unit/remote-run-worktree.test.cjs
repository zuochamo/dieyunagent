'use strict';

/**
 * 远端（SSH）会话的 **per-run / per-role** worktree（`src/ssh/remote-run-worktree.js`）。
 *
 * 这些断言守两件事：
 * 1. 路径/分支的派生形状与会话级副本、本地副本**同源**（`.dieyun/worktrees/<id>/<role>`、
 *    `dieyun/agent-<id>-<role>`）—— 形状漂了，回收脚本与变更面板就找不到东西；
 * 2. 每一个远端结果标记都能被解析成结构化结论（成功 / 复用 / 冲突 / 缺目录），
 *    冲突必须走 `conflict` 而不是被当成成功（那会静默丢掉一路产出）。
 */

const {
  runWorktreePath,
  runWorktreeRoot,
  runWorktreeBranch,
  buildEnsureRunWorktreeScript,
  parseEnsureRunWorktreeResult,
  ensureRunWorktree,
  mergeRunWorktreeInto
} = require('../../src/ssh/remote-run-worktree');

function fakeSsh(stdout, extra = {}) {
  const calls = [];
  return {
    calls,
    async execScript(script, timeoutMs) {
      calls.push({ script, timeoutMs });
      return { code: extra.code == null ? 0 : extra.code, stdout, stderr: extra.stderr || '' };
    }
  };
}

describe('远端 per-role worktree', () => {
  it('路径与分支形状与本地/会话级同源', () => {
    expect(runWorktreePath('/srv/app', 'run-1', 'A')).toBe('/srv/app/.dieyun/worktrees/run-1/A');
    expect(runWorktreeRoot('/srv/app', 'run-1')).toBe('/srv/app/.dieyun/worktrees/run-1');
    expect(runWorktreeBranch('run-1', 'A')).toBe('dieyun/agent-run-1-A');
    // 缺参不猜路径
    expect(runWorktreePath('/srv/app', '', 'A')).toBe('');
    expect(runWorktreeBranch('run-1', '')).toBe('');
  });

  it('建副本脚本：幂等 + 把基线 sha 报回来', () => {
    const lines = buildEnsureRunWorktreeScript({
      repoPath: '/srv/app',
      wtPath: '/srv/app/.dieyun/worktrees/run-1/A',
      branch: 'dieyun/agent-run-1-A'
    }).join('\n');
    expect(lines).toContain('BASE_SHA=$(git -C "$REPO" rev-parse');
    expect(lines).toContain('RW_BASE=');
    expect(lines).toContain('WT_REUSED');
  });

  it('解析：新建 / 复用 / 坏基线，都带基线 sha', () => {
    expect(parseEnsureRunWorktreeResult('WT_CREATED\nRW_BASE=abc1234')).toEqual({
      ok: true,
      reused: false,
      reason: 'WT_CREATED',
      baseSha: 'abc1234'
    });
    expect(parseEnsureRunWorktreeResult('WT_REUSED\nRW_BASE=deadbee')).toMatchObject({
      ok: true,
      reused: true,
      baseSha: 'deadbee'
    });
    expect(parseEnsureRunWorktreeResult('WT_BAD_BASE').ok).toBe(false);
    expect(parseEnsureRunWorktreeResult('').ok).toBe(false);
  });

  it('ensureRunWorktree 走远端并在失败时给可读原因', async () => {
    const ok = fakeSsh('WT_CREATED\nRW_BASE=abcdef1');
    const created = await ensureRunWorktree(ok, { repoPath: '/srv/app', runId: 'r1', roleId: 'A' });
    expect(created).toMatchObject({
      ok: true,
      path: '/srv/app/.dieyun/worktrees/r1/A',
      branch: 'dieyun/agent-r1-A',
      baseSha: 'abcdef1',
      reused: false
    });
    expect(ok.calls[0].script).toContain('"$REPO"');

    const bad = fakeSsh('WT_NOT_GIT', { code: 3, stderr: 'fatal: not a git repository' });
    const failed = await ensureRunWorktree(bad, { repoPath: '/srv/app', runId: 'r1', roleId: 'A' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('远端副本创建失败');
  });

  it('并回会话副本：合并 / 无改动 / 冲突三种结论各自可辨', async () => {
    const merged = await mergeRunWorktreeInto(fakeSsh('RW_MERGED'), {
      wtPath: '/srv/app/.dieyun/worktrees/r1/A',
      branch: 'dieyun/agent-r1-A',
      targetWtPath: '/srv/app/.dieyun/worktrees/sess-x/main'
    });
    expect(merged).toEqual({ ok: true, merged: true });

    const noop = await mergeRunWorktreeInto(fakeSsh('RW_NO_CHANGES'), {
      wtPath: '/w',
      branch: 'b',
      targetWtPath: '/t'
    });
    expect(noop).toEqual({ ok: true, merged: false });

    const conflict = await mergeRunWorktreeInto(fakeSsh('RW_CONFLICT'), {
      wtPath: '/w',
      branch: 'b',
      targetWtPath: '/t'
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.error).toContain('冲突');
  });

  it('并回脚本会先提交副本改动，再 merge 到目标，冲突时 abort', async () => {
    const ssh = fakeSsh('RW_MERGED');
    await mergeRunWorktreeInto(ssh, { wtPath: '/w', branch: 'b', targetWtPath: '/t' });
    const script = ssh.calls[0].script;
    expect(script).toContain('git -C "$WT" add -A');
    expect(script).toContain('commit -m "$MSG"');
    expect(script).toContain('merge --no-ff "$BR"');
    expect(script).toContain('merge --abort');
  });

  it('缺参数直接拒绝（不猜路径）', async () => {
    const ssh = fakeSsh('RW_MERGED');
    const r = await mergeRunWorktreeInto(ssh, { wtPath: '/w', branch: '' });
    expect(r.ok).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('远端 per-role worktree · 基线 & 变更预览（2026-11-19）', () => {
  const {
    buildPreviewRunChangesScript,
    parsePreviewRunChanges,
    previewRunWorktreeChanges
  } = require('../../src/ssh/remote-run-worktree');

  it('基线赋值必须先于 BASE_SHA（回归：以前插在 BASE= 之前 → 基线恒空）', () => {
    const lines = buildEnsureRunWorktreeScript({
      repoPath: '/srv/app',
      wtPath: '/srv/app/.dieyun/worktrees/run-1/A',
      branch: 'dieyun/agent-run-1-A'
    });
    const baseIdx = lines.findIndex((l) => l.startsWith('BASE='));
    const shaIdx = lines.findIndex((l) => l.startsWith('BASE_SHA='));
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(shaIdx).toBeGreaterThan(baseIdx);
    // 基线还要写进副本自己的 gitdir：预览/重试 reset 都按「建副本那一刻的基线」算
    expect(lines.join('\n')).toContain('dieyun-base');
  });

  it('预览脚本一次往返列出各路 diff 与未跟踪文件', () => {
    const script = buildPreviewRunChangesScript('/srv/app', 'run-1');
    expect(script).toContain('git -C "$d" diff --name-status --no-renames "$BASE"');
    expect(script).toContain('git -C "$d" ls-files --others --exclude-standard');
    expect(script).toContain('dieyun-base');
    expect(script).toContain('RW_DONE');
  });

  it('预览解析：kind 映射、同一路径多路 → conflict', () => {
    const stdout = [
      'RW_BASE=A|abc1234',
      'RW_CHG=A|M|internal/api/x.go',
      'RW_CHG=A|A|internal/api/new.go',
      'RW_CHG=A|??|scratch.txt',
      'RW_BASE=B|abc1234',
      'RW_CHG=B|M|internal/api/x.go',
      'RW_CHG=B|D|internal/api/old.go',
      'RW_DONE'
    ].join('\n');
    const r = parsePreviewRunChanges(stdout, 'run-1');
    expect(r.ok).toBe(true);
    expect(r.empty).toBe(false);
    expect(r.changes).toHaveLength(5);
    const byId = new Map(r.changes.map((c) => [c.changeId, c]));
    expect(byId.get('A::internal/api/x.go')).toMatchObject({
      repoPath: 'internal/api/x.go',
      kind: 'modified',
      roleId: 'A',
      baseSha: 'abc1234',
      conflict: true
    });
    expect(byId.get('A::internal/api/new.go').kind).toBe('added');
    expect(byId.get('A::scratch.txt').kind).toBe('added');
    expect(byId.get('B::internal/api/old.go').kind).toBe('deleted');
    // 远端没有本机可读的副本路径：不许填一个假的本地路径
    expect(byId.get('A::internal/api/x.go').worktreePath).toBe('');
    expect(byId.get('B::internal/api/old.go').conflict).toBeUndefined();
  });

  it('空 run 目录 → 空 changes（不是错误）', async () => {
    const ssh = fakeSsh('');
    const r = await previewRunWorktreeChanges(ssh, { repoPath: '/srv/app', runId: 'run-1' });
    expect(r).toMatchObject({ ok: true, empty: true });
    expect(r.changes).toEqual([]);
  });

  it('缺 repoPath/runId 直接拒绝（不猜路径、不打远端）', async () => {
    const ssh = fakeSsh('RW_DONE');
    const r = await previewRunWorktreeChanges(ssh, { repoPath: '/srv/app', runId: '' });
    expect(r.ok).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('远端副本归档 / 回收 / 冲突路径（2026-11-19）', () => {
  const {
    archiveRunWorktree,
    pruneRunWorktreeRoots,
    mergeRunWorktreeInto
  } = require('../../src/ssh/remote-run-worktree');

  /** 按脚本内容分派的假 SSH：prune 一次要跑好几种脚本。 */
  function scriptedSsh(answer) {
    const calls = [];
    return {
      calls,
      async execScript(script, timeoutMs) {
        calls.push({ script, timeoutMs });
        const out = answer(script) || '';
        return { code: 0, stdout: out, stderr: '' };
      }
    };
  }

  it('归档：有改动→提交并回报 sha；提交失败→保留副本并报错', async () => {
    const ok = await archiveRunWorktree(fakeSsh('RW_ARCHIVED=abc1234'), {
      wtPath: '/srv/app/.dieyun/worktrees/r1/A'
    });
    expect(ok).toEqual({ ok: true, committed: true, sha: 'abc1234' });

    const nothing = await archiveRunWorktree(fakeSsh('RW_NOTHING'), { wtPath: '/w' });
    expect(nothing).toEqual({ ok: true, committed: false });

    const failed = await archiveRunWorktree(fakeSsh('RW_COMMIT_FAILED'), { wtPath: '/w' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('归档失败');

    const ssh = fakeSsh('RW_NOTHING');
    const missing = await archiveRunWorktree(ssh, { wtPath: '' });
    expect(missing.ok).toBe(false);
    expect(ssh.calls).toHaveLength(0);
  });

  it('归档脚本先 add -A 再 commit（与本地 cleanup 的 archive 同口径）', async () => {
    const ssh = fakeSsh('RW_ARCHIVED=abc1234');
    await archiveRunWorktree(ssh, { wtPath: '/w', message: 'm' });
    const script = ssh.calls[0].script;
    expect(script).toContain('git -C "$WT" add -A');
    expect(script).toContain('commit -m "$MSG"');
  });

  it('回收：只留最新 N 个、先归档再删、**保留分支**（不 branch -D）、受保护的不动', async () => {
    const ssh = scriptedSsh((script) => {
      if (script.includes('ls -1dt')) return 'run-e\nrun-d\nrun-c\nrun-b\nrun-a\n';
      if (script.includes('RW_ROLE=')) return 'RW_ROLE=A\n';
      if (script.includes('status --porcelain')) return 'RW_ARCHIVED=deadbee\n';
      return '';
    });
    const r = await pruneRunWorktreeRoots(ssh, {
      repoPath: '/srv/app',
      keep: 2,
      protectRunIds: ['run-c']
    });
    expect(r.ok).toBe(true);
    // 非受保护里最新 2 个（e/d）保留；c 受保护；b/a 过期
    expect(r.removed.sort()).toEqual(['run-a', 'run-b']);
    expect(r.blocked).toEqual([]);
    const all = ssh.calls.map((c) => c.script).join('\n');
    expect(all).toContain('dieyun/worktrees/run-a/A'.replace(/\//g, '/'));
    // 删目录必须保留分支：不允许出现 branch -D
    expect(all).not.toContain('branch -D');
    // 且必须先归档（commit）再删
    const archiveIdx = all.indexOf('commit -m "$MSG"');
    const removeIdx = all.indexOf('worktree remove --force');
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(archiveIdx);
  });

  it('合并冲突：返回冲突文件清单（abort 之前取）', async () => {
    const ssh = fakeSsh('RW_CONFLICT_PATH=internal/api/x.go\nRW_CONFLICT_PATH=ui/app.js\nRW_CONFLICT');
    const r = await mergeRunWorktreeInto(ssh, {
      wtPath: '/w',
      branch: 'dieyun/agent-r1-A',
      targetWtPath: '/t'
    });
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.paths).toEqual(['internal/api/x.go', 'ui/app.js']);
    // 取清单必须在 abort 之前
    const script = ssh.calls[0].script;
    expect(script.indexOf('diff --name-only --diff-filter=U')).toBeLessThan(
      script.indexOf('merge --abort')
    );
  });
});
