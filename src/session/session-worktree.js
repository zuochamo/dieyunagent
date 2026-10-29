'use strict';

const { buildSshUri, normalizeRemotePath } = require('../workspace/target');
const { ensureRemoteWorktree, remoteWorktreePath, repoRemotePathOf } = require('../ssh/remote-worktree');

/**
 * 让 SSH 会话跑在自己的 git worktree 里（方案 C）。
 *
 * 只做一件事：把「会话的远端工作区」指向 `<repo>/.dieyun/worktrees/<会话id>/main`，
 * 并把结果写回会话工作区上下文 —— 于是渲染端、RPC 路径、agent `--workspace`、索引库、
 * 记忆库、沙箱根全部从同一个事实出发，不存在第二份路径。
 *
 * 为什么不在这里记缓存 / 加锁 / 建状态机：
 * - 路径由 sessionId 纯派生，同一会话永远同一份，重连与重启自动复用；
 * - 建库脚本本身幂等（目录在就 `WT_REUSED`），每次多一次 `test -d` 远比重连后
 *   agent 起在已删除目录上要便宜。
 *
 * 建不出来（远端目录不是 git 仓库等）就原样返回旧目标 —— 即今天的行为，不新增降级层。
 *
 * @param {{
 *   localGateway: any,
 *   sshManager: any,
 *   sessionId: string,
 *   target: import('../workspace/target').WorkspaceTarget | null,
 *   log?: (msg: string) => void
 * }} deps
 * @returns {Promise<import('../workspace/target').WorkspaceTarget | null>}
 */
async function ensureSessionWorktree(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const { localGateway, sshManager, target } = deps;
  const sid = String(deps.sessionId || '').trim();
  if (!sid || !target || target.kind !== 'ssh' || !sshManager) return target;

  const repoPath = repoRemotePathOf(target.remotePath);
  const wtPath = remoteWorktreePath(repoPath, sid);
  if (!wtPath) return target;

  let res;
  try {
    res = await ensureRemoteWorktree(sshManager, { repoPath, sessionId: sid });
  } catch (err) {
    log(`session worktree: ${err && err.message ? err.message : err}`);
    return target;
  }
  if (!res.ok) {
    // WT_NOT_GIT 是「这台机器上这个目录本来就不归 git 管」——继续用原目录，不拦会话
    log(
      res.reason === 'WT_NOT_GIT'
        ? `session worktree: ${repoPath} 不是 git 仓库，沿用原目录`
        : `session worktree: ${res.error || res.reason}`
    );
    return target;
  }

  const effective = { ...target, remotePath: normalizeRemotePath(res.path) };
  if (normalizeRemotePath(target.remotePath) === effective.remotePath) return effective;

  const workspacePath = buildSshUri(effective);
  if (localGateway && typeof localGateway.setSessionWorkspaceContext === 'function') {
    localGateway.setSessionWorkspaceContext(sid, workspacePath);
  }
  // 落库：渲染端读 session_get 解析会话工作区，重启后也要回到同一份 worktree
  if (localGateway && typeof localGateway.invokeRpc === 'function') {
    try {
      await localGateway.invokeRpc('memory.session_workspace_set', { sessionId: sid, workspacePath });
    } catch (err) {
      log(`session worktree 持久化失败: ${err && err.message ? err.message : err}`);
    }
  }
  log(`session worktree: ${res.reused ? '复用' : '新建'} ${effective.remotePath}`);
  return effective;
}

module.exports = { ensureSessionWorktree };
