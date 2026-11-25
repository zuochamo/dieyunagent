'use strict';

/**
 * 整轮撤回的 **git 树回滚**：唯一能覆盖「shell 改文件」的撤回机制。
 *
 * ## 为什么需要它（2026-11-25 实测事故）
 *
 * 撤回快照（`turn-undo-service`）的「改前内容」只有一个来源：`fs_edit` / `fs_write_file`
 * 写之前读的那一次（`gateway/rpc.js:captureUndoWrite`）。`host_exec` 里用 shell 改的文件
 * 完全不经过它，于是：
 *
 *   - shell 改过的文件根本没有「改前内容」；
 *   - 同一个文件先被 shell 改、后面又走了一次 fs 编辑时，记下的「改前」已经是**改过之后**的内容。
 *
 * 结果就是「撤回成功、内容没变」：用户点撤回，界面说「已恢复 7 个文件」，代码原封不动
 * （SSH 会话里模型几乎全用 shell：那次一轮 55 次 host_exec）。
 *
 * ## 机制
 *
 * 回合开始时 `git stash create` 拿到一个代表「回合开始工作区」的 commit（见
 * `turn-tree.js:captureTurnStartTree`，不落 ref、不动工作区）。撤回时：
 *
 *   1. `git diff --name-status --no-renames <tree>` = 自回合开始以来工作区的**全部**改动
 *      （shell 改的、fs 工具改的、新增的、删除的都在里面，不需要逐工具埋点）；
 *   2. 逐条回滚：在回合开始树里存在的 → `git checkout <tree> -- <path>`（索引一起回到树里的样子，
 *      否则 SCM 面板里仍显示「有改动」）；回合开始后才出现的 → 删除文件；
 *   3. 再跑一次 (1) 复核：还有剩余 = **真的没撤回干净**，如实报出来而不是装作成功。
 *
 * ## 已知边界
 *
 * 未跟踪文件既不在 stash 里、也不在 `git diff` 里（实测：shell 新建的文件撤回后还在）。
 * 所以额外记一份「回合开始时的未跟踪路径清单」：
 *   - 回合开始时**不在**清单里、现在未跟踪的 → 本轮新建 → 撤回时删除；
 *   - 清单里本来就有的 → 保留；只被 `git add` 过的只撤索引登记（`git rm --cached`）。
 * 清单拿不到（不是仓库 / 命令失败 / 超过上限）时**一律不删文件** ——
 * 宁可留一个多余文件，也不许把用户本来就有的文件删掉。
 *
 * 另一条边界：本轮如果把改动**提交**了（HEAD 变了），`git diff <tree>` 与工作区一致，
 * 看不出差异；所以额外比 HEAD，并把「提交里的改动没被撤回」如实报出来。
 */

const path = require('path');
const { createGitTarget, normalizeGitRelPath, normalizeGitText } = require('./git-target');
const { normalizeRemotePath } = require('../workspace/target');

const GIT_ROLLBACK_TIMEOUT_MS = 120000;
/** 未跟踪路径清单上限：超过就记「未知」，撤回时不动未跟踪文件（宁可少删，不可错删） */
const MAX_UNTRACKED_PATHS = 5000;
/**
 * 回合基线最多收多少个脏文件（本地 / 远端共用这一个数字）。
 * 目的是别让 `undo.turn_begin` 在「几千个脏路径」的仓库上跑几分钟。
 */
const MAX_BASELINE_FILES = 120;
/**
 * 建「回合开始树」的脏文件数闸门。
 *
 * `git stash create` 会把当前工作区的改动**写成对象**（每个脏文件一份 blob）。
 * 脏文件上千的仓库上这一步不便宜，而它跑在 `undo.turn_begin` 里 ——
 * 拖过 90s 就是「本轮根本没有撤回记录」（比「撤回不完整」更糟，且没有任何提示）。
 * 超过闸门就**不建树**：撤回退回快照逻辑，并用 `shellMutated` 那条路如实告知覆盖不到。
 */
const MAX_TURN_START_TREE_FILES = 2000;

/**
 * 撤回目标仓库的 git 执行目标（本地 / SSH 同一份接口，命令拼装只在 `git-target`）。
 *
 * @param {{ workspaceKind?: string, workspaceRoot?: string|null }} plan
 * @param {{ sshExec?: (command: string, cwd: string, timeoutMs?: number) => Promise<any> }} [deps]
 * @returns {ReturnType<typeof createGitTarget>|null} 没有可用根时返回 null
 */
function gitTargetForWorkspace(plan, deps = {}) {
  const root = String((plan && plan.workspaceRoot) || '').trim();
  if (!root) return null;
  if (plan.workspaceKind === 'ssh') {
    if (typeof deps.sshExec !== 'function') return null;
    return createGitTarget({
      kind: 'ssh',
      root: normalizeRemotePath(root),
      sshExec: deps.sshExec
    });
  }
  return createGitTarget({ kind: 'local', root: path.resolve(root) });
}

/**
 * 解析 `git diff --name-status -z`：`<status>\0<path>\0` 每两条一组。
 *
 * 调用方一律带 `--no-renames`，所以状态只可能是 A / M / D / T —— 没有 R/C 的三字段记录要处理。
 * 路径原样保留（`-z` 下 git 不做 C-quote），非 ASCII / 空格 / 换行文件名都安全。
 *
 * @param {string} stdout
 * @returns {Array<{ status: string, path: string }>}
 */
function parseNameStatus(stdout) {
  const tokens = String(stdout || '').split('\0');
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = String(tokens[i] || '').trim().charAt(0).toUpperCase();
    const rel = normalizeGitRelPath(tokens[i + 1]);
    if (!status || !rel) continue;
    out.push({ status, path: rel });
  }
  return out;
}

/**
 * 「回合开始时的树」的 commit id —— 整轮撤回的**唯一可靠来源**。
 *
 * 为什么必须是它：撤回快照（`undo/turn-undo-service`）只能记「fs 工具写之前读到的原文」，
 * `host_exec`（shell：`sed -i` / `cat >` / 跑脚本）改的文件根本不经过那条路。
 * 于是 shell 改过的文件要么完全没有「改前内容」，要么在之后第一次 fs 编辑时被记成
 * 「已经改过之后」的内容 —— 撤回写回去等于没撤（2026-11-25 用户实测：SSH 会话里
 * 55 次 host_exec 后撤回，界面说「已恢复 7 个文件」，设计原封不动）。
 *
 * `git stash create` 只产出一个 commit 对象（不落 ref、**不动工作区**、不改 index），
 * 工作区干净时它输出空 → 回落到 HEAD，两者都表示「回合开始时的树」。
 * 代价：每个有改动的回合会在对象库里留一个不可达 commit（`git gc` 正常回收）。
 *
 * @param {ReturnType<typeof createGitTarget>} target
 * @returns {Promise<string>} commit id；拿不到时返回空串（调用方退回快照撤回）
 */
async function captureTurnStartTree(target) {
  const stash = (await target.textOrEmpty(['stash', 'create'])).trim();
  if (stash) return stash;
  return (await target.textOrEmpty(['rev-parse', 'HEAD'])).trim();
}

/** 自回合开始（`treeSha`）以来工作区相对该树的全部改动。 */
async function listChangedSinceTree(target, treeSha) {
  // 必须 `-z`：不带它时 git 会把非 ASCII / 带空格的路径 **C-quote** 成
  // `"\344\270\255\346\226\207.js"`（`core.quotepath` 默认开）。拿这串去 checkout
  // 必然匹配不到 → 中文名文件永远撤不回（实测确认）。
  const r = await target.run(['diff', '--name-status', '--no-renames', '-z', String(treeSha)], {
    timeoutMs: GIT_ROLLBACK_TIMEOUT_MS
  });
  if (!r.ok) {
    throw Object.assign(
      new Error(normalizeGitText(r.stdout, r.stderr) || `git diff 失败（${treeSha}）`),
      { code: 'UNDO_GIT_DIFF_FAILED' }
    );
  }
  return parseNameStatus(r.stdout);
}

/**
 * 回合开始的 git 基线的**唯一来源**（本地 / 远端共用同一份字段语义）。
 *
 * 两个字段各自回答一件事，撤回时分工不同：
 *   - `stashSha`：回合开始**树**的 commit → 能覆盖 shell 改的任意文件；
 *   - `untracked`：回合开始时就存在的未跟踪路径 → 撤回时不许删它们。
 *
 * @param {ReturnType<typeof createGitTarget>} target
 * @param {{ dirtyCount?: number }} [opts] 脏条目数（超过闸门就不建树，见 MAX_TURN_START_TREE_FILES）
 * @returns {Promise<{ stashSha: string, untracked: string[]|null }>}
 */
async function captureTurnStartState(target, opts = {}) {
  const dirtyCount = Number(opts.dirtyCount);
  if (Number.isFinite(dirtyCount) && dirtyCount > MAX_TURN_START_TREE_FILES) {
    return { stashSha: '', untracked: null };
  }
  const stashSha = await captureTurnStartTree(target);
  const { paths } = await listUntrackedPaths(target);
  return { stashSha, untracked: paths };
}

/**
 * 当前**未跟踪**（且未被 .gitignore 忽略）的路径。
 *
 * 用途只有两处，语义必须一致，所以只此一份：
 *   - 回合开始：记下「本来就有的未跟踪文件」，撤回时不许碰；
 *   - 撤回时：现在未跟踪、而回合开始时不在清单里的 = 本轮新建 → 删除。
 *
 * @param {ReturnType<typeof createGitTarget>} target
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ paths: string[]|null, truncated: boolean }>} `paths === null` 表示「未知」
 */
async function listUntrackedPaths(target, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || MAX_UNTRACKED_PATHS);
  const r = await target.run(['ls-files', '--others', '--exclude-standard', '-z'], {
    timeoutMs: GIT_ROLLBACK_TIMEOUT_MS
  });
  if (!r.ok) return { paths: null, truncated: false };
  const paths = [];
  for (const raw of String(r.stdout || '').split('\0')) {
    const rel = normalizeGitRelPath(raw);
    if (!rel) continue;
    if (paths.length >= limit) return { paths: null, truncated: true };
    paths.push(rel);
  }
  return { paths, truncated: false };
}

/**
 * 把工作区回滚到 `treeSha` 那棵树。
 *
 * @param {ReturnType<typeof createGitTarget>} target
 * @param {string} treeSha
 * @param {{ untrackedAtStart?: string[]|null, headAtStart?: string|null }} [opts]
 *   `untrackedAtStart`：回合开始时的未跟踪清单（`null`/缺失 = 未知）。
 *   `headAtStart`：回合开始时的 HEAD（给了就能发现「本轮改被提交了」）。
 * @returns {Promise<{
 *   restored: number, removed: number, errors: Array<{ path: string, error: string }>,
 *   uncovered: string[], changed: string[], handled: string[], headMoved: boolean
 * }>}
 */
async function rollbackToTree(target, treeSha, opts = {}) {
  const knownUntracked = Array.isArray(opts.untrackedAtStart) ? new Set(opts.untrackedAtStart) : null;
  const headAtStart = String(opts.headAtStart || '').trim();
  const changed = await listChangedSinceTree(target, treeSha);
  const errors = [];
  /** git 已经处置完（内容或存废）的路径：调用方不该再拿快照内容写一遍 */
  const handled = [];
  let restored = 0;
  let removed = 0;

  for (const entry of changed) {
    try {
      if (entry.status === 'A') {
        // 「树里没有、工作区有」有两种来源，绝不能一律删：
        //   1) 本轮新建的（真正要删的）；
        //   2) 回合开始时就存在、只是本轮被 `git add` 了（用户自己的未跟踪稿子）—— 删了就是数据丢失。
        // 判据只有一份：回合开始的未跟踪清单。清单未知时**不删**（宁可少删，不可错删）。
        const wasUntrackedAtStart = knownUntracked ? knownUntracked.has(entry.path) : true;
        if (wasUntrackedAtStart) {
          // 只撤索引登记（回到「未跟踪」），文件留在原地；内容交给快照还原（git 里没有它的「改前」）
          await target.run(['rm', '--cached', '--ignore-unmatch', '--', entry.path], { timeoutMs: 30000 });
          continue;
        }
        await target.removeFile(entry.path);
        await target.run(['rm', '--cached', '--ignore-unmatch', '--', entry.path], { timeoutMs: 30000 });
        handled.push(entry.path);
        removed += 1;
        continue;
      }
      const r = await target.run(['checkout', String(treeSha), '--', entry.path], {
        timeoutMs: GIT_ROLLBACK_TIMEOUT_MS
      });
      if (!r.ok) {
        errors.push({
          path: entry.path,
          error: normalizeGitText(r.stdout, r.stderr) || 'git checkout 失败'
        });
        continue;
      }
      handled.push(entry.path);
      restored += 1;
    } catch (err) {
      errors.push({ path: entry.path, error: (err && err.message) || String(err) });
    }
  }

  // 本轮新建的**未跟踪**文件（shell 建的：`git diff` 看不见它们，只能按清单比）
  if (knownUntracked) {
    const now = await listUntrackedPaths(target);
    for (const rel of now.paths || []) {
      if (knownUntracked.has(rel)) continue;
      try {
        await target.removeFile(rel);
        handled.push(rel);
        removed += 1;
      } catch (err) {
        errors.push({ path: rel, error: (err && err.message) || String(err) });
      }
    }
  }

  // 复核：跑同一份 diff + 同一份未跟踪清单，还有剩余就是真的没撤回干净 —— 不许装作成功
  let uncovered = [];
  try {
    uncovered = (await listChangedSinceTree(target, treeSha)).map((e) => e.path);
    if (knownUntracked) {
      const now = await listUntrackedPaths(target);
      for (const rel of now.paths || []) {
        if (!knownUntracked.has(rel) && !uncovered.includes(rel)) uncovered.push(rel);
      }
    }
  } catch (err) {
    errors.push({ path: '', error: (err && err.message) || String(err) });
  }

  // 工作区回到了回合开始的样子，但**本轮改被提交过**（HEAD 变了）：那些改动还在提交里，
  // 拿 `git diff <tree>` 是看不出来的（树↔工作区一致）。不说出来就是又一次「撤回成功、代码还在」。
  let headMoved = false;
  if (headAtStart) {
    const headNow = (await target.textOrEmpty(['rev-parse', 'HEAD'])).trim();
    headMoved = !!headNow && headNow !== headAtStart;
  }

  return {
    restored,
    removed,
    errors,
    uncovered,
    changed: changed.map((e) => e.path),
    handled,
    headMoved
  };
}

module.exports = {
  GIT_ROLLBACK_TIMEOUT_MS,
  MAX_UNTRACKED_PATHS,
  MAX_BASELINE_FILES,
  MAX_TURN_START_TREE_FILES,
  captureTurnStartTree,
  captureTurnStartState,
  gitTargetForWorkspace,
  parseNameStatus,
  listChangedSinceTree,
  listUntrackedPaths,
  rollbackToTree
};
