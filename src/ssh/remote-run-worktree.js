'use strict';

/**
 * 远端（SSH）会话的 **per-run / per-role** worktree。
 *
 * 为什么单独一份（2026-11-19）：`remote-worktree.js` 只管「每个会话一份副本」
 * （`<repo>/.dieyun/worktrees/<会话id>/main`），而 plan 的并行执行器要的是
 * 「每个执行器一份副本」（`<repo>/.dieyun/worktrees/<runId>/<role>`）。两者目录形状一致、
 * 语义不同，所以这里复用同一批脚本原语（`buildEnsureWorktreeScript` / `parseEnsureWorktreeResult`），
 * 只补「按 run+role 派生路径、收尾把各路改动并回会话工作区」。
 *
 * 收尾为什么是「commit + merge 回会话副本」而不是逐文件复制：
 * 1. 用户下一步还是在**会话副本**上审阅/应用（SSH 会话的「变更」面板一直看的是它），
 *    并回去 = 不需要为远端再写一套逐文件应用面板；
 * 2. git 原生 merge 自带冲突检测与 `merge --abort` 回滚，不需要自己做备份/回滚；
 * 3. 每一路留一个提交，出问题能 `git revert`，可审计。
 * 冲突时**不静默覆盖**：`merge --abort` 后把该路标记为 `conflict` 报给上层。
 */

const { normalizeRemotePath } = require('../workspace/target');
const { shellQuoteSingle } = require('./remote-path');
const {
  WORKTREES_DIR,
  AGENT_BRANCH_PREFIX,
  buildEnsureWorktreeScript,
  parseEnsureWorktreeResult
} = require('./remote-worktree');

const MARK_WT_MISSING = 'RW_WT_MISSING';
const MARK_TGT_MISSING = 'RW_TGT_MISSING';
const MARK_NO_CHANGES = 'RW_NO_CHANGES';
const MARK_COMMIT_FAILED = 'RW_COMMIT_FAILED';
const MARK_MERGED = 'RW_MERGED';
const MARK_CONFLICT = 'RW_CONFLICT';
const MARK_PREVIEW_DONE = 'RW_DONE';

const COMMIT_IDENTITY = '-c user.name=dieyun-agent -c user.email=agent@dieyun.local';

/** `<repo>/.dieyun/worktrees/<runId>/<roleId>`；缺参返回 ''（调用方据此报错，不猜路径）。 */
function runWorktreePath(repoPath, runId, roleId) {
  const repo = normalizeRemotePath(repoPath).replace(/\/+$/, '');
  const run = String(runId || '').trim();
  const role = String(roleId || '').trim();
  if (!repo || !run || !role) return '';
  return `${repo}/${WORKTREES_DIR}/${run}/${role}`;
}

/** `<repo>/.dieyun/worktrees/<runId>`（回收时连带删空目录）。 */
function runWorktreeRoot(repoPath, runId) {
  const repo = normalizeRemotePath(repoPath).replace(/\/+$/, '');
  const run = String(runId || '').trim();
  if (!repo || !run) return '';
  return `${repo}/${WORKTREES_DIR}/${run}`;
}

/** 分支名与本地同口径：`dieyun/agent-<runId>-<roleId>`（本地见 worktree-service）。 */
function runWorktreeBranch(runId, roleId) {
  const run = String(runId || '').trim();
  const role = String(roleId || '').trim();
  if (!run || !role) return '';
  return `${AGENT_BRANCH_PREFIX}${run}-${role}`;
}

/**
 * 建副本脚本：原样复用会话级那份（幂等、基线解析成 sha、`-B` 语义都已收口），
 * 只在末尾补一行把基线 sha 报回来（收尾 reset / 变更预览要用）。
 * @param {{ repoPath: string, wtPath: string, branch: string, baseRef?: string }} opts
 * @returns {string[]}
 */
function buildEnsureRunWorktreeScript(opts) {
  const lines = buildEnsureWorktreeScript(opts);
  // 基线要在同一个脚本里**先算**（复用分支会 `exit 0`），解析方按「有 RW_BASE= 就用」处理。
  //
  // 位置必须落在 `BASE=...` **之后**：以前写死 `splice(1, …)`，插在 `BASE=` 之前，
  // `rev-parse "$BASE^{commit}"` 拿到空串 → `RW_BASE=` 永远为空 → 远端副本的 baseSha 恒 ''，
  // 于是「重试前 reset 回基线」退化成 reset 到 HEAD（半成品残留）、变更预览也拿不到基线
  //（2026-11-19 审计）。这里按行内容定位，不再依赖行号。
  const baseIdx = lines.findIndex((l) => typeof l === 'string' && l.startsWith('BASE='));
  const insertAt = baseIdx >= 0 ? baseIdx + 1 : 1;
  lines.splice(insertAt, 0, 'BASE_SHA=$(git -C "$REPO" rev-parse "$BASE^{commit}" 2>/dev/null || true)');
  lines.push('echo "RW_BASE=${BASE_SHA}"');
  // 基线跟着副本自己走（写进**该副本的 gitdir**，不是仓库 config）：
  // 预览/重试 reset 都要按「建副本那一刻的基线」算变更，ref 名会随 HEAD 漂移，不能存 ref。
  // 复用分支时（上面 `exit 0`）不重写：已有文件就是原始基线。
  lines.push(
    'if test -n "$BASE_SHA" && test -d "$WT"; then',
    '  WD=$(git -C "$WT" rev-parse --git-dir 2>/dev/null)',
    '  test -n "$WD" && printf "%s" "$BASE_SHA" > "$WD/dieyun-base" || true',
    'fi'
  );
  return lines;
}

/** @param {string} stdout */
function parseEnsureRunWorktreeResult(stdout) {
  const text = String(stdout || '');
  const parsed = parseEnsureWorktreeResult(text);
  const baseMatch = text.match(/RW_BASE=([0-9a-f]{7,40})/i);
  return { ...parsed, baseSha: baseMatch ? baseMatch[1] : '' };
}

/**
 * 确保远端 per-role 副本存在（幂等）。
 * @param {{ execScript: Function }} sshManager
 * @param {{ repoPath: string, runId: string, roleId: string, baseRef?: string, timeoutMs?: number }} opts
 */
async function ensureRunWorktree(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const wtPath = runWorktreePath(repoPath, opts.runId, opts.roleId);
  const branch = runWorktreeBranch(opts.runId, opts.roleId);
  if (!wtPath || !branch) return { ok: false, error: '缺少 runId / roleId' };
  const res = await sshManager.execScript(
    buildEnsureRunWorktreeScript({ repoPath, wtPath, branch, baseRef: opts.baseRef }).join('\n'),
    opts.timeoutMs || 90000
  );
  const parsed = parseEnsureRunWorktreeResult(res && res.stdout);
  if (!parsed.ok) {
    const detail = String((res && res.stderr) || '').trim().split('\n').slice(-3).join(' / ');
    return {
      ok: false,
      path: wtPath,
      branch,
      error: `远端副本创建失败（${parsed.reason}）${detail ? `：${detail}` : ''}`
    };
  }
  return { ok: true, path: wtPath, branch, baseSha: parsed.baseSha || '', reused: parsed.reused };
}

/**
 * 把副本清回基线（重试前用）：与本地 `resetAgentWorktree` 同语义 —— `reset --hard` 到基线 +
 * 清掉未跟踪文件。**不带 `-x`**：`.gitignore` 里的东西（node_modules / 构建产物）不该被删，
 * 否则一次重试要让用户等一次完整装依赖。
 * @param {{ execScript: Function }} sshManager
 * @param {{ wtPath: string, baseSha?: string, timeoutMs?: number }} opts
 */
async function resetRunWorktree(sshManager, opts) {
  const wt = String(opts.wtPath || '');
  const target = String(opts.baseSha || '').trim() || 'HEAD';
  if (!wt) return { ok: false, error: '缺少副本路径' };
  const script = [
    `WT=${shellQuoteSingle(wt)}`,
    'if ! test -d "$WT"; then echo RW_WT_MISSING; exit 3; fi',
    `git -C "$WT" reset --hard ${shellQuoteSingle(target)} >/dev/null 2>&1 || exit 4`,
    'git -C "$WT" clean -fd >/dev/null 2>&1 || true'
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 60000);
  if (String((res && res.stdout) || '').includes(MARK_WT_MISSING)) {
    return { ok: false, error: '副本目录不存在（可能已被回收）' };
  }
  const code = res && typeof res.code === 'number' ? res.code : 0;
  if (code !== 0) {
    return { ok: false, error: `副本重置失败：${String((res && res.stderr) || '').trim().slice(-200)}` };
  }
  return { ok: true };
}

/**
 * 删一份副本（连带删它的分支与空的 run 目录）。
 * @param {{ execScript: Function }} sshManager
 * @param {{ repoPath: string, runId: string, roleId: string, deleteBranch?: boolean, timeoutMs?: number }} opts
 */
async function removeRunWorktree(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const wtPath = runWorktreePath(repoPath, opts.runId, opts.roleId);
  const branch = runWorktreeBranch(opts.runId, opts.roleId);
  const runRoot = runWorktreeRoot(repoPath, opts.runId);
  if (!wtPath || !branch) return { ok: false, error: '缺少 runId / roleId' };
  const script = [
    `REPO=${shellQuoteSingle(repoPath)}`,
    `WT=${shellQuoteSingle(wtPath)}`,
    `BR=${shellQuoteSingle(branch)}`,
    `ROOT=${shellQuoteSingle(runRoot)}`,
    'git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true',
    opts.deleteBranch === false ? ':' : 'git -C "$REPO" branch -D "$BR" >/dev/null 2>&1 || true',
    'rmdir "$ROOT" >/dev/null 2>&1 || true',
    'git -C "$REPO" worktree prune >/dev/null 2>&1 || true'
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 60000);
  const code = res && typeof res.code === 'number' ? res.code : 0;
  if (code !== 0) {
    return { ok: false, error: `删除副本失败：${String((res && res.stderr) || '').trim().slice(-200)}` };
  }
  return { ok: true };
}

/** 列出某 run 下已有的执行器副本（roleId 列表）。 */
async function listRunWorktreeRoles(sshManager, opts) {
  const root = runWorktreeRoot(normalizeRemotePath(opts.repoPath), opts.runId);
  if (!root) return [];
  const script = [
    `ROOT=${shellQuoteSingle(root)}`,
    'if ! test -d "$ROOT"; then exit 0; fi',
    'for d in "$ROOT"/*; do test -d "$d" && echo "RW_ROLE=$(basename "$d")"; done'
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 30000);
  return String((res && res.stdout) || '')
    .split('\n')
    .map((l) => (l.startsWith('RW_ROLE=') ? l.slice('RW_ROLE='.length).trim() : ''))
    .filter(Boolean);
}

/**
 * 「某 run 下各路副本相对各自基线的变更」脚本：一次 SSH 往返做完所有 role。
 *
 * 与本地 `worktree-service.listWorktreeChangesVsBase` 同口径：
 * `git diff --name-status <base>`（含未提交的工作区改动）+ `ls-files --others`（未跟踪即 added）。
 * 基线优先读副本 gitdir 里的 `dieyun-base`（建副本时写下的那次 sha），缺失才回退 merge-base。
 */
function buildPreviewRunChangesScript(repoPath, runId) {
  const repo = shellQuoteSingle(normalizeRemotePath(repoPath));
  const root = shellQuoteSingle(runWorktreeRoot(repoPath, runId));
  return [
    `REPO=${repo}`,
    `ROOT=${root}`,
    'if ! test -d "$ROOT"; then exit 0; fi',
    'for d in "$ROOT"/*; do',
    '  test -d "$d" || continue',
    '  ROLE=$(basename "$d")',
    '  GITDIR=$(git -C "$d" rev-parse --git-dir 2>/dev/null)',
    '  BASE=""',
    '  if test -n "$GITDIR" && test -f "$GITDIR/dieyun-base"; then BASE=$(cat "$GITDIR/dieyun-base" 2>/dev/null); fi',
    '  if test -z "$BASE"; then BASE=$(git -C "$REPO" merge-base "$(git -C "$d" rev-parse HEAD 2>/dev/null)" HEAD 2>/dev/null); fi',
    '  echo "RW_BASE=$ROLE|$BASE"',
    '  if test -n "$BASE"; then',
    '    git -C "$d" diff --name-status --no-renames "$BASE" 2>/dev/null | while IFS= read -r line; do',
    '      ST=$(printf "%s" "$line" | cut -f1)',
    '      P=$(printf "%s" "$line" | cut -f2-)',
    '      test -n "$P" && echo "RW_CHG=$ROLE|$ST|$P"',
    '    done',
    '  fi',
    '  git -C "$d" ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r p; do',
    '    test -n "$p" && echo "RW_CHG=$ROLE|??|$p"',
    '  done',
    'done',
    `echo ${MARK_PREVIEW_DONE}`
  ].join('\n');
}

/** git 状态码 → 本地同名的 kind（added / deleted / modified）。 */
function kindOfStatus(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'D') return 'deleted';
  if (c === 'A' || c === '??') return 'added';
  return 'modified';
}

/**
 * SSH 输出 → 与本地 `previewRunWorktreeChanges` 同形状的 changes。
 * 路径按 role 分条，同一路径出现在多个 role 时标 conflict（与本地口径一致）。
 */
function parsePreviewRunChanges(stdout, runId) {
  const bases = new Map();
  const byKey = new Map();
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('RW_BASE=')) {
      const rest = line.slice('RW_BASE='.length);
      const i = rest.indexOf('|');
      if (i > 0) bases.set(rest.slice(0, i), rest.slice(i + 1).trim());
      continue;
    }
    if (!line.startsWith('RW_CHG=')) continue;
    const rest = line.slice('RW_CHG='.length);
    const a = rest.indexOf('|');
    if (a <= 0) continue;
    const b = rest.indexOf('|', a + 1);
    if (b < 0) continue;
    const roleId = rest.slice(0, a);
    const code = rest.slice(a + 1, b).trim();
    const rel = rest.slice(b + 1).trim().replace(/\\/g, '/');
    if (!rel) continue;
    byKey.set(`${roleId}::${rel}`, { roleId, code, rel });
  }
  const changes = [];
  const rolesByPath = new Map();
  for (const { roleId, code, rel } of byKey.values()) {
    changes.push({
      changeId: `${roleId}::${rel}`,
      repoPath: rel,
      kind: kindOfStatus(code),
      status: code,
      roleId,
      // 远端**没有**本机可读的副本路径：逐文件 diff 请在会话副本上审阅（收尾会把各路并回去）。
      worktreePath: '',
      baseSha: bases.get(roleId) || '',
      mainDirty: false
    });
    if (!rolesByPath.has(rel)) rolesByPath.set(rel, []);
    rolesByPath.get(rel).push(roleId);
  }
  for (const ch of changes) {
    const roles = [...new Set(rolesByPath.get(ch.repoPath) || [])];
    if (roles.length > 1) {
      ch.conflict = true;
      ch.conflictRoles = roles;
    }
  }
  changes.sort((x, y) => {
    const byPath = x.repoPath.localeCompare(y.repoPath);
    return byPath || String(x.roleId).localeCompare(String(y.roleId), undefined, { numeric: true });
  });
  return { ok: true, runId: String(runId || ''), changes, empty: changes.length === 0 };
}

/**
 * 远端版变更预览（验收 prompt 的 `worktreeChanges` 与「变更」面板用）。
 * 以前远端一律走本地 `worktreeService`（读到的是本机不存在的路径）⇒ 空 diff，
 * 「声称改了却零 diff 就判失败」这条验收规则在 SSH 会话里整条失效（2026-11-19 审计）。
 */
async function previewRunWorktreeChanges(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const runId = String(opts.runId || '').trim();
  if (!repoPath || !runId) return { ok: false, error: '缺少 repoPath / runId', changes: [] };
  const res = await sshManager.execScript(
    buildPreviewRunChangesScript(repoPath, runId),
    opts.timeoutMs || 60000
  );
  const out = String((res && res.stdout) || '');
  const code = res && typeof res.code === 'number' ? res.code : 0;
  if (code !== 0 && !out.includes(MARK_PREVIEW_DONE)) {
    return {
      ok: false,
      error: `远端变更预览失败：${String((res && res.stderr) || '').trim().slice(-200) || '未知原因'}`,
      changes: []
    };
  }
  return parsePreviewRunChanges(out, runId);
}

/**
 * 归档一份副本：把未提交的改动提交成该 role 分支上的一个 commit。
 *
 * 与本地 `worktree-service.cleanupRunWorktrees` 的 `archive` 同口径 —— **先归档再删目录，
 * 分支保留**。为什么必须有：远端收尾清理以前直接 `branch -D`，于是一次「停止」就把各路
 * 未合并的产出连分支一起删了；而 UI 的「停止」是**暂停**（续跑复用同一 runId），
 * 副本没了只能从 HEAD 重建、活重做一遍（2026-11-19 实测的返工就是这个）。
 *
 * @param {{ execScript: Function }} sshManager
 * @param {{ wtPath: string, message?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, committed?: boolean, sha?: string, error?: string }>}
 */
async function archiveRunWorktree(sshManager, opts) {
  const wt = String(opts.wtPath || '');
  if (!wt) return { ok: false, error: '缺少副本路径' };
  const message = String(opts.message || 'dieyun: 归档执行器产出');
  const script = [
    `WT=${shellQuoteSingle(wt)}`,
    `MSG=${shellQuoteSingle(message)}`,
    'if ! test -d "$WT"; then echo RW_WT_MISSING; exit 3; fi',
    'if test -n "$(git -C "$WT" status --porcelain 2>/dev/null)"; then',
    `  git -C "$WT" add -A >/dev/null 2>&1 || { echo ${MARK_COMMIT_FAILED}; exit 5; }`,
    `  git -C "$WT" ${COMMIT_IDENTITY} commit -m "$MSG" >/dev/null 2>&1 || { echo ${MARK_COMMIT_FAILED}; exit 5; }`,
    '  echo "RW_ARCHIVED=$(git -C "$WT" rev-parse HEAD 2>/dev/null)"',
    '  exit 0',
    'fi',
    'echo RW_NOTHING'
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 60000);
  const out = String((res && res.stdout) || '');
  if (out.includes(MARK_COMMIT_FAILED)) {
    return { ok: false, error: '副本内提交失败（归档失败，已保留副本）' };
  }
  if (out.includes(MARK_WT_MISSING)) {
    return { ok: false, missing: true, error: '副本目录不存在（可能已被回收）' };
  }
  if (out.includes('RW_NOTHING')) return { ok: true, committed: false };
  const m = out.match(/RW_ARCHIVED=([0-9a-f]{7,40})/i);
  if (m) return { ok: true, committed: true, sha: m[1] };
  return { ok: true, committed: false };
}

/**
 * 回收远端 per-run 副本目录：按 mtime 只保留最新 `keep` 个 run。
 *
 * 先**归档**（把未提交改动提交进各自分支）再删目录、**保留分支** —— 分支是产出的存档
 * （与本地 `pruneRunBranches` 的语义一致），一个 checkout 才是有成本的那个东西。
 * 已在跑的那一批由调用方通过 `protectRunIds` 排除。
 *
 * @param {{ execScript: Function }} sshManager
 * @param {{ repoPath: string, keep: number, protectRunIds?: string[], timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, runs: string[], removed: string[], blocked: string[], error?: string }>}
 */
async function pruneRunWorktreeRoots(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const keep = Math.max(0, Math.floor(Number(opts.keep) || 0));
  if (!repoPath) return { ok: false, runs: [], removed: [], blocked: [], error: '缺少 rootPath' };
  const dir = `${repoPath}/${WORKTREES_DIR}`;
  const script = [
    `DIR=${shellQuoteSingle(dir)}`,
    'if ! test -d "$DIR"; then exit 0; fi',
    'for d in $(ls -1dt "$DIR"/* 2>/dev/null); do test -d "$d" && basename "$d"; done'
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 30000);
  const code = res && typeof res.code === 'number' ? res.code : 0;
  const runs = String((res && res.stdout) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (code !== 0) {
    return { ok: false, runs, removed: [], blocked: [], error: '列出副本目录失败' };
  }
  const protect = new Set((opts.protectRunIds || []).map(String));
  const stale = runs.filter((r) => !protect.has(r)).slice(keep);
  const removed = [];
  const blocked = [];
  for (const runId of stale) {
    const roles = await listRunWorktreeRoles(sshManager, { repoPath, runId });
    let okRun = true;
    for (const roleId of roles) {
      const wtPath = runWorktreePath(repoPath, runId, roleId);
      const archived = await archiveRunWorktree(sshManager, {
        wtPath,
        message: `dieyun: plan ${runId} · ${roleId}（过期副本归档）`
      });
      if (!archived.ok && !archived.missing) {
        okRun = false;
        continue;
      }
      // deleteBranch:false —— 归档出来的产出留在分支上，删的只是 checkout
      const r = await removeRunWorktree(sshManager, {
        repoPath,
        runId,
        roleId,
        deleteBranch: false
      });
      if (!r.ok) okRun = false;
    }
    if (roles.length === 0) {
      // 空目录（没有 role）：直接删掉，不留空壳
      const rm = await sshManager.execScript(
        [`ROOT=${shellQuoteSingle(runWorktreeRoot(repoPath, runId))}`, 'rmdir "$ROOT" >/dev/null 2>&1 || true'].join('\n'),
        30000
      );
      if (rm && typeof rm.code === 'number' && rm.code !== 0) okRun = false;
    }
    if (okRun) removed.push(runId);
    else blocked.push(runId);
  }
  return { ok: blocked.length === 0, runs, removed, blocked };
}

/**
 * 收尾：把一个执行器副本提交，然后**并回会话副本**（冲突则 abort 并报 conflict）。
 * @param {{ execScript: Function }} sshManager
 * @param {{ wtPath: string, branch: string, targetWtPath: string, message?: string, timeoutMs?: number }} opts
 */
async function mergeRunWorktreeInto(sshManager, opts) {
  const wt = String(opts.wtPath || '');
  const branch = String(opts.branch || '');
  const target = String(opts.targetWtPath || '');
  if (!wt || !branch || !target) return { ok: false, error: '缺少副本 / 分支 / 目标副本路径' };
  const message = String(opts.message || `dieyun: ${branch}`);
  const script = [
    `WT=${shellQuoteSingle(wt)}`,
    `BR=${shellQuoteSingle(branch)}`,
    `TGT=${shellQuoteSingle(target)}`,
    `MSG=${shellQuoteSingle(message)}`,
    'if ! test -d "$WT"; then echo RW_WT_MISSING; exit 3; fi',
    'if ! test -d "$TGT"; then echo RW_TGT_MISSING; exit 4; fi',
    // 副本里有改动就提交成一个 commit（没有改动就跳过提交，直接合并分支）
    'if test -n "$(git -C "$WT" status --porcelain 2>/dev/null)"; then',
    `  git -C "$WT" add -A >/dev/null 2>&1 || { echo ${MARK_COMMIT_FAILED}; exit 5; }`,
    `  git -C "$WT" ${COMMIT_IDENTITY} commit -m "$MSG" >/dev/null 2>&1 || { echo ${MARK_COMMIT_FAILED}; exit 5; }`,
    'fi',
    // 没有 commit 的副本合并过来是空操作：先判一下，免得在目标里留下一个空 merge 提交
    'if ! git -C "$TGT" merge-base --is-ancestor "$BR" HEAD 2>/dev/null; then',
    `  if git -C "$TGT" merge --no-ff "$BR" -m "$MSG" >/dev/null 2>&1; then echo ${MARK_MERGED}; exit 0; fi`,
    // 冲突文件清单：abort 之前先报出来 —— 只说「冲突」用户没法自查，得给到具体路径。
    '  git -C "$TGT" diff --name-only --diff-filter=U 2>/dev/null | while IFS= read -r p; do',
    '    test -n "$p" && echo "RW_CONFLICT_PATH=$p"',
    '  done',
    '  git -C "$TGT" merge --abort >/dev/null 2>&1 || true',
    `  echo ${MARK_CONFLICT}; exit 6`,
    'fi',
    `echo ${MARK_NO_CHANGES}; exit 0`
  ].join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 120000);
  const out = String((res && res.stdout) || '');
  if (out.includes(MARK_MERGED)) return { ok: true, merged: true };
  if (out.includes(MARK_NO_CHANGES)) return { ok: true, merged: false };
  if (out.includes(MARK_CONFLICT)) {
    const paths = out
      .split('\n')
      .filter((l) => l.startsWith('RW_CONFLICT_PATH='))
      .map((l) => l.slice('RW_CONFLICT_PATH='.length).trim())
      .filter(Boolean);
    return {
      ok: false,
      conflict: true,
      paths,
      // 两种情况都走 abort，但原因不同：真冲突（有 unmerged 文件）vs 会话副本自己脏、
      // 被 git 拒绝合并（没有冲突文件）。分开说，否则排障时会往「冲突」的方向白查。
      error: paths.length
        ? '这一路的改动与会话副本冲突（已自动 abort，未覆盖任何内容）'
        : '并回会话副本被拒（会话副本可能有未提交改动，没产生冲突文件；已自动 abort，未覆盖任何内容）'
    };
  }
  if (out.includes(MARK_COMMIT_FAILED)) return { ok: false, error: '副本内提交失败' };
  if (out.includes(MARK_WT_MISSING)) return { ok: false, error: '副本目录不存在（可能已被回收）' };
  if (out.includes(MARK_TGT_MISSING)) return { ok: false, error: '会话副本目录不存在' };
  return {
    ok: false,
    error: `合并失败：${String((res && res.stderr) || '').trim().slice(-200) || '未知原因'}`
  };
}

module.exports = {
  runWorktreePath,
  runWorktreeRoot,
  runWorktreeBranch,
  buildEnsureRunWorktreeScript,
  parseEnsureRunWorktreeResult,
  ensureRunWorktree,
  resetRunWorktree,
  removeRunWorktree,
  listRunWorktreeRoles,
  buildPreviewRunChangesScript,
  parsePreviewRunChanges,
  previewRunWorktreeChanges,
  archiveRunWorktree,
  pruneRunWorktreeRoots,
  mergeRunWorktreeInto
};
