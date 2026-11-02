'use strict';

const { buildSshUri, normalizeRemotePath } = require('../workspace/target');
const {
  ensureRemoteWorktree,
  remoteWorktreePath,
  remoteWorktreeKey,
  repoRemotePathOf,
  pruneRemoteWorktrees
} = require('../ssh/remote-worktree');

/**
 * 会话 worktree 的保留期：多久没活动的会话，其远端 worktree（含索引库）在下次建新
 * worktree 时被回收。每份 worktree 带一份 19–38 MB 的索引库，不回收就是无限增长。
 */
const SESSION_WORKTREE_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `memory.sessions_list` 的上限就是 100（core 侧 clamp） */
const SESSIONS_QUERY_LIMIT = 100;

/**
 * 哪些会话键必须留着：当前会话 + 正在租用远端端点的 + 保留期内活跃过的。
 *
 * 「哪份会话还活着」的唯一来源是**会话表**（`memory.sessions_list` 的 `updatedAt`），
 * 不靠远端目录 mtime 猜 —— 只读的会话几天不写文件，按 mtime 会把正在用的 worktree 当旧的删掉。
 * @param {{
 *   sessions?: Array<{ id?: string, updatedAt?: number }>,
 *   nowMs?: number,
 *   keepDays?: number,
 *   leasedSessionIds?: string[],
 *   currentSessionId?: string
 * }} opts
 * @returns {string[]} 排序后的 `sess-xxxxxxxx` 键
 */
function sessionKeysToKeep(opts = {}) {
  const keepDays = Number(opts.keepDays) > 0 ? Number(opts.keepDays) : SESSION_WORKTREE_KEEP_DAYS;
  const cutoff = Number(opts.nowMs || Date.now()) - keepDays * DAY_MS;
  const keys = new Set();
  const add = (sid) => {
    const k = remoteWorktreeKey(sid);
    if (k) keys.add(k);
  };
  for (const sid of opts.leasedSessionIds || []) add(sid);
  add(opts.currentSessionId);
  for (const row of opts.sessions || []) {
    if (Number(row && row.updatedAt) >= cutoff) add(row && row.id);
  }
  return [...keys].sort();
}

/**
 * @param {any} localGateway
 * @returns {Promise<Array<object> | null>} **null = 拿不到会话表**（≠「没有会话」）。
 *   两者必须分开：拿不到时按「谁都不留」去回收，会把还活着的会话副本（连同索引库、
 *   未提交改动之外的一切）一次性删掉 —— 回收是删目录，宁可这一轮不回收。
 */
async function listRecentSessions(localGateway) {
  if (!localGateway || typeof localGateway.invokeRpc !== 'function') return null;
  // 归档的会话也必须算进来：归档是侧栏整理动作，不是「这份副本可以立刻删」。
  // 保留期只有一个判据 —— 最后活跃时间（`updatedAt`），不按 archived 分叉。
  // 两份列表各取 core 的上限 100 条。已知缺口：**排不进前 100 的会话不在名单里**，
  // 理论上可能被提前回收（有未提交改动的那份仍会被跳过并报出来）。要彻底消除，
  // 得让 core 的 sessions_list 支持「按 updatedAt 窗口查」而不是只给最新 100 条。
  try {
    const [active, archived] = await Promise.all([
      localGateway.invokeRpc('memory.sessions_list', { limit: SESSIONS_QUERY_LIMIT, archived: false }),
      localGateway.invokeRpc('memory.sessions_list', { limit: SESSIONS_QUERY_LIMIT, archived: true })
    ]);
    if (!Array.isArray(active) || !Array.isArray(archived)) return null;
    return [...active, ...archived];
  } catch {
    return null;
  }
}

/**
 * 回收过期会话的远端 worktree（连同里面的索引库）。
 *
 * 只在**新建** worktree 时调用：目录数就是在那时候增长的，不需要定时器，也不需要状态。
 * 失败只记日志 —— 缓存清不掉不该拦住会话。
 * @param {{
 *   localGateway: any,
 *   sshManager: any,
 *   repoPath: string,
 *   sessionId: string,
 *   listLeasedSessionIds?: () => string[],
 *   log?: (msg: string) => void
 * }} deps
 */
async function pruneStaleSessionWorktrees(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  try {
    const sessions = await listRecentSessions(deps.localGateway);
    if (!sessions) {
      // fail-closed：拿不到会话表就不回收。删目录是不可逆的，下一轮再删也不迟。
      log('session worktree: 回收跳过（拿不到会话表，宁可不删）');
      return { ok: false, reason: 'SESSIONS_UNAVAILABLE', pruned: [], keptDirty: [] };
    }
    const leased =
      typeof deps.listLeasedSessionIds === 'function' ? deps.listLeasedSessionIds() : [];
    const keepKeys = sessionKeysToKeep({
      sessions,
      nowMs: Date.now(),
      keepDays: SESSION_WORKTREE_KEEP_DAYS,
      leasedSessionIds: [...(leased || []), deps.sessionId],
      currentSessionId: deps.sessionId
    });
    const res = await pruneRemoteWorktrees(deps.sshManager, { repoPath: deps.repoPath, keepKeys });
    if (!res.ok) {
      log(`session worktree: 回收跳过（${res.reason || '未知原因'}）`);
      return res;
    }
    if (res.pruned.length) {
      log(`session worktree: 回收 ${res.pruned.length} 份过期 worktree（${res.pruned.join(', ')}）`);
    }
    if (res.keptDirty.length) {
      log(
        `session worktree: ${res.keptDirty.length} 份有未提交改动，保留（${res.keptDirty.join(', ')}）`
      );
    }
    return res;
  } catch (err) {
    log(`session worktree 回收失败: ${err && err.message ? err.message : err}`);
    return { ok: false, reason: 'PRUNE_FAILED', pruned: [], keptDirty: [] };
  }
}

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
  // 新建 = 目录数在增长的那一刻：顺手回收过期会话的 worktree（不 await，失败只记日志）。
  // 复用分支不扫：复用不会让目录数变多，扫了只是白跑一次远端脚本。
  if (!res.reused) {
    void pruneStaleSessionWorktrees({
      localGateway,
      sshManager,
      repoPath,
      sessionId: sid,
      listLeasedSessionIds: deps.listLeasedSessionIds,
      log
    });
  }
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

module.exports = {
  ensureSessionWorktree,
  sessionKeysToKeep,
  pruneStaleSessionWorktrees,
  SESSION_WORKTREE_KEEP_DAYS
};
