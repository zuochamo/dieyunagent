'use strict';

/**
 * 源码管理（SCM）语义层：把 git 的 status/diff/stage/commit 语义算好，
 * 对上层（Gateway RPC、UI）只暴露结构化结果。
 *
 * 分工：
 *   - git-target.js  执行 + 工作区读取（本地 / SSH 一套）
 *   - status.js      porcelain 解析 + 工作区状态（唯一来源）
 *   - diff-text.js   新增文件 patch 拼装（与 diff-context 共用）
 *   - 本模块         分组口径、单文件 diff 的 before/after、索引写操作
 *
 * 目标差异全部由 git-target 消化，本模块不做 local/remote 分叉。
 */

const { normalizeGitRelPath, normalizeGitText } = require('./git-target');
const { readGitStatus, isConflictEntry } = require('./status');
const { synthesizeNewFilePatch } = require('./diff-text');

/** 分组口径：与 UI 分组一一对应，避免 UI 再写一份映射 */
const SCM_GROUP_IDS = ['conflicted', 'staged', 'unstaged', 'untracked'];

/** 未跟踪文件上限：首次打开大仓库时不能把几千行塞进侧栏 */
const MAX_UNTRACKED_ROWS = 500;
/** diff 预览文本上限：超过就只给 patch，避免把整文件搬过 WebSocket */
const MAX_DIFF_TEXT_CHARS = 200 * 1024;
const MAX_PATCH_CHARS = 200 * 1024;
/** 提交历史单页上限：滚动加载时每页最多取这么多 */
const MAX_LOG_PAGE = 200;
const DEFAULT_LOG_PAGE = 50;

/**
 * `git log` 的机器可读格式：字段间用 \x1f（unit separator），
 * 提交之间用 \x1e（record separator）。这两个字节不会出现在正常的
 * 提交信息 / 人名 / ref 名里，比按行或按空格切分都稳。
 * 必须用 tformat（每条记录以 \x1e 终止）：format 会在记录之间插 \n，
 * 那个换行会混进下一条记录的第一个字段。
 */
const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e';

const STATUS_TITLE = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪'
};

/**
 * @param {string} code porcelain 状态字母（X 或 Y）
 */
function scmStatusLabel(code) {
  const c = String(code || '').toUpperCase();
  return STATUS_TITLE[c] || c || '修改';
}

/**
 * 归一化 numstat 的路径列。
 * rename 场景 git 会写成 `src/{a => b}.js` 或 `old => new`。
 * @param {string} raw
 */
function normalizeNumstatPath(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^"/, '').replace(/"$/, '');
  if (s.includes('=>')) {
    const brace = /^(.*?)\{(.*?)\s*=>\s*(.*?)\}(.*)$/.exec(s);
    if (brace) s = `${brace[1]}${brace[3]}${brace[4]}`;
    else s = s.split('=>').pop().trim();
  }
  return normalizeGitRelPath(s);
}

/**
 * 解析 `git diff --numstat`，返回 path -> {added, removed}。
 * 二进制文件是 `-\t-\tpath`，统一记 0 行。
 * @param {string} out
 */
function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const removed = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    const p = normalizeNumstatPath(parts.slice(2).join('\t'));
    if (p) map.set(p, { added, removed });
  }
  return map;
}

function makeRow(entry, group, status) {
  const code = String(status || '').toUpperCase();
  return {
    path: entry.path,
    origPath: entry.origPath || '',
    group,
    status: code,
    statusLabel: scmStatusLabel(code),
    untracked: group === 'untracked',
    staged: group === 'staged',
    added: 0,
    removed: 0
  };
}

/**
 * 把 porcelain entries 摊成分组行；同一文件可同时出现在 staged 与 unstaged
 * （索引里一份改动、工作区又叠一份），这正是 git 的真实语义，不做合并。
 * @param {Array<object>} entries
 */
function buildScmRows(entries) {
  const groups = { conflicted: [], staged: [], unstaged: [], untracked: [] };
  for (const entry of entries || []) {
    if (entry.untracked) {
      groups.untracked.push(makeRow(entry, 'untracked', '?'));
      continue;
    }
    if (isConflictEntry(entry)) {
      groups.conflicted.push(makeRow(entry, 'conflicted', 'U'));
      continue;
    }
    if (entry.x !== ' ' && entry.x !== '?') groups.staged.push(makeRow(entry, 'staged', entry.x));
    if (entry.y !== ' ' && entry.y !== '?') groups.unstaged.push(makeRow(entry, 'unstaged', entry.y));
  }
  return groups;
}

function attachNumstat(rows, map) {
  for (const row of rows || []) {
    const stat = map.get(row.path);
    row.added = stat ? stat.added : 0;
    row.removed = stat ? stat.removed : 0;
  }
}

function clipText(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MAX_DIFF_TEXT_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_DIFF_TEXT_CHARS), truncated: true };
}

function normalizePathList(paths) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(paths) ? paths : []) {
    const rel = normalizeGitRelPath(p);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

async function readWorktreeSafe(git, rel, opts) {
  try {
    return await git.readText(rel, opts);
  } catch {
    // 文件被删 / 无权限：按「内容为空」处理，让 diff 仍能显示删除
    return { ok: false, binary: false, truncated: false, text: '' };
  }
}

/** 读取 git object（`HEAD:path` / `:path`）；二进制或不存在时返回空文本 */
async function readGitBlob(git, spec) {
  const r = await git.run(['show', spec]);
  if (!r.ok) return { binary: false, text: '' };
  const raw = String(r.stdout || '');
  if (raw.includes('\u0000')) return { binary: true, text: '' };
  return { binary: false, text: raw };
}

/**
 * 工作区 git 状态。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 */
async function getScmStatus(git) {
  const status = await readGitStatus(git, { untrackedMode: 'all' });
  if (!status.isRepo) {
    return {
      ...status,
      total: 0,
      untrackedTruncated: false,
      groups: { conflicted: [], staged: [], unstaged: [], untracked: [] }
    };
  }

  const [stagedStatOut, unstagedStatOut] = await Promise.all([
    git.textOrEmpty(['diff', '--numstat', '--cached', '--']),
    git.textOrEmpty(['diff', '--numstat', '--'])
  ]);

  const groups = buildScmRows(status.entries);
  attachNumstat(groups.staged, parseNumstat(stagedStatOut));
  attachNumstat(groups.unstaged, parseNumstat(unstagedStatOut));
  // 未跟踪文件不在 `git diff` 里，行数要靠 --no-index 逐个算，代价不值当
  for (const row of groups.untracked) {
    row.added = null;
    row.removed = 0;
  }

  let untrackedTruncated = false;
  if (groups.untracked.length > MAX_UNTRACKED_ROWS) {
    groups.untracked = groups.untracked.slice(0, MAX_UNTRACKED_ROWS);
    untrackedTruncated = true;
  }

  return {
    ok: true,
    isRepo: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    detached: status.detached,
    unborn: status.unborn,
    total:
      groups.conflicted.length + groups.staged.length + groups.unstaged.length + groups.untracked.length,
    untrackedTruncated,
    groups
  };
}

/**
 * 单文件 diff。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ path: string, group?: string, status?: string, origPath?: string }} params
 */
async function getScmFileDiff(git, params) {
  const rel = normalizeGitRelPath(params && params.path);
  if (!rel) return { ok: false, error: '缺少有效的文件路径' };
  const group = SCM_GROUP_IDS.includes(String(params && params.group))
    ? String(params.group)
    : 'unstaged';
  const status = String((params && params.status) || '').toUpperCase();

  const base = {
    ok: true,
    path: rel,
    origPath: normalizeGitRelPath(params && params.origPath) || '',
    group,
    status,
    statusLabel: scmStatusLabel(status),
    added: 0,
    removed: 0,
    created: false,
    binary: false,
    truncated: false,
    patch: '',
    beforeText: '',
    afterText: ''
  };

  if (group === 'untracked') {
    const read = await readWorktreeSafe(git, rel);
    if (read.binary) return { ...base, binary: true, created: true };
    const full = String(read.text || '');
    const clipped = clipText(full);
    return {
      ...base,
      created: true,
      truncated: !!read.truncated || clipped.truncated,
      afterText: clipped.text,
      added: clipped.text ? clipped.text.split('\n').length : 0,
      // 与 diff-context 共用同一份拼装，避免「新增文件」在两条路径上表达不同
      patch: synthesizeNewFilePatch(rel, full)
    };
  }

  const staged = group === 'staged';
  const patchOut = await git.textOrEmpty(
    staged ? ['diff', '--cached', '--no-color', '--', rel] : ['diff', '--no-color', '--', rel]
  );
  const statOut = await git.textOrEmpty(
    staged ? ['diff', '--numstat', '--cached', '--', rel] : ['diff', '--numstat', '--', rel]
  );
  const stat = parseNumstat(statOut).get(rel) || { added: 0, removed: 0 };

  const before = staged ? await readGitBlob(git, `HEAD:${rel}`) : await readGitBlob(git, `:${rel}`);
  const after = staged ? await readGitBlob(git, `:${rel}`) : await readWorktreeSafe(git, rel);

  const beforeClipped = clipText(before.text);
  const afterClipped = clipText(after.text);

  return {
    ...base,
    added: stat.added,
    removed: stat.removed,
    created: !before.text && !!after.text,
    binary: !!(before.binary || after.binary),
    truncated: patchOut.length > MAX_PATCH_CHARS || beforeClipped.truncated || afterClipped.truncated,
    patch: patchOut.length > MAX_PATCH_CHARS ? patchOut.slice(0, MAX_PATCH_CHARS) : patchOut,
    beforeText: beforeClipped.text,
    afterText: afterClipped.text
  };
}

function gitFailure(r, fallback) {
  return normalizeGitText((r && r.stdout) || '', (r && r.stderr) || '') || fallback;
}

/** 暂存：`git add` 在 git >= 2.0 也会记录删除，不需要额外的 rm 分支 */
async function scmStage(git, paths) {
  const list = normalizePathList(paths);
  if (!list.length) return { ok: false, error: '未选择文件' };
  const r = await git.run(['add', '--', ...list]);
  if (!r.ok) return { ok: false, error: gitFailure(r, 'git add 失败'), paths: list };
  return { ok: true, paths: list };
}

/** 取消暂存：有 HEAD 走 reset，初始提交（无 HEAD）走 rm --cached */
async function scmUnstage(git, paths) {
  const list = normalizePathList(paths);
  if (!list.length) return { ok: false, error: '未选择文件' };
  const hasHead = (await git.run(['rev-parse', '--verify', '-q', 'HEAD'])).ok;
  const args = hasHead
    ? ['reset', '-q', 'HEAD', '--', ...list]
    : ['rm', '--cached', '-r', '-q', '--', ...list];
  const r = await git.run(args);
  if (!r.ok) return { ok: false, error: gitFailure(r, '取消暂存失败'), paths: list };
  return { ok: true, paths: list };
}

async function deleteWorktreeFile(git, rel) {
  await git.removeFile(rel);
}

/**
 * 丢弃单个文件。
 *
 * 判定完全由 git 实际状态推出，不信 UI 传来的 group：UI 快照与实际状态之间可能隔着
 * Agent 写入或用户连点，按过期分组决定「删文件还是还原」会误删。
 *   - HEAD 里有（含冲突 / 删除）                    → 取消暂存 + 工作区还原到 HEAD
 *   - 名字不在 HEAD 但 origPath 在（已暂存的重命名）  → 撤销重命名（旧名回归、新名清掉）
 *   - 都不在 HEAD（未跟踪 / 新增未提交）             → 取消暂存 + 删除文件
 */
async function discardOneEntry(git, rel, opts) {
  const allowDelete = !!(opts && opts.allowDelete);
  const origPath = (opts && opts.origPath) || '';
  const inIndex = (await git.run(['cat-file', '-e', `:${rel}`])).ok;
  const inHead = (await git.run(['cat-file', '-e', `HEAD:${rel}`])).ok;
  const origInHead = origPath ? (await git.run(['cat-file', '-e', `HEAD:${origPath}`])).ok : false;

  if (inHead || origInHead) {
    // 重命名要连旧名一起 unstage：只 reset 新名会留下「旧名被删除」的已暂存删除记录
    const unstageTargets = origPath && origPath !== rel ? [rel, origPath] : [rel];
    const un = await scmUnstage(git, unstageTargets);
    if (!un.ok) return { path: rel, ok: false, action: 'unstage', error: un.error };

    const restoreTarget = inHead ? rel : origPath;
    if (!inHead && allowDelete) await deleteWorktreeFile(git, rel);

    let r = await git.run(['restore', '--source=HEAD', '--worktree', '--', restoreTarget]);
    if (!r.ok) {
      // git < 2.23 没有 restore，回落到 checkout
      r = await git.run(['checkout', 'HEAD', '--', restoreTarget]);
    }
    if (!r.ok) return { path: rel, ok: false, action: 'restore', error: gitFailure(r, '还原失败') };
    return { path: rel, ok: true, action: 'restored' };
  }

  if (!allowDelete) {
    return { path: rel, ok: false, action: 'skipped', error: '未启用删除未跟踪 / 新增文件' };
  }
  if (inIndex) {
    const un = await scmUnstage(git, [rel]);
    if (!un.ok) return { path: rel, ok: false, action: 'unstage', error: un.error };
  }
  await deleteWorktreeFile(git, rel);
  return { path: rel, ok: true, action: 'deleted' };
}

/**
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ entries?: Array<{path: string, origPath?: string}>, deleteUntracked?: boolean }} params
 */
async function scmDiscard(git, params) {
  const rawEntries = Array.isArray(params && params.entries) ? params.entries : [];
  const allowDelete = !(params && params.deleteUntracked === false);
  if (!rawEntries.length) return { ok: false, error: '未选择文件', results: [] };

  const results = [];
  for (const rawEntry of rawEntries) {
    const rel = normalizeGitRelPath(rawEntry && rawEntry.path);
    if (!rel) continue;
    try {
      results.push(
        await discardOneEntry(git, rel, {
          allowDelete,
          origPath: normalizeGitRelPath(rawEntry && rawEntry.origPath)
        })
      );
    } catch (err) {
      results.push({ path: rel, ok: false, action: 'error', error: String((err && err.message) || err) });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results, failed };
}

/**
 * 提交。默认提交整个索引；给了 paths 就先暂存这些文件再提交。
 * 故意不注入伪造的 user.name/email：用户仓库里提交应当记在用户自己名下，
 * 身份缺失时明确报错，由 UI 提示去配置，而不是悄悄造出「Dieyun Agent」的提交。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ message?: string, paths?: string[] }} params
 */
async function scmCommit(git, params) {
  const message = String((params && params.message) || '').trim();
  if (!message) return { ok: false, code: 'EMPTY_MESSAGE', error: '提交信息不能为空' };

  const list = normalizePathList(params && params.paths);
  if (list.length) {
    const staged = await scmStage(git, list);
    if (!staged.ok) return { ok: false, code: 'STAGE_FAILED', error: staged.error, paths: list };
  }

  const r = await git.run(['commit', '-m', message]);
  if (!r.ok) {
    const detail = normalizeGitText(r.stdout, r.stderr);
    if (/Please tell me who you are|empty ident|user\.email|user\.name/i.test(detail)) {
      return {
        ok: false,
        code: 'GIT_IDENTITY_MISSING',
        error: 'git 未配置提交身份，请先执行：git config user.name / user.email'
      };
    }
    if (/nothing to commit|no changes added to commit/i.test(detail)) {
      return { ok: false, code: 'NOTHING_TO_COMMIT', error: '没有可提交的改动' };
    }
    return { ok: false, code: 'COMMIT_FAILED', error: detail || 'git commit 失败' };
  }

  const sha = await git.textOrEmpty(['rev-parse', '--short', 'HEAD']);
  return { ok: true, sha, summary: normalizeGitText(r.stdout, '') };
}

/* ------------------------------------------------------------------ *
 * 提交历史（时间线 / 泳道图）
 * ------------------------------------------------------------------ */

/**
 * 解析 %D 装饰字段（形如 `HEAD -> main, origin/main, tag: v1`）。
 * 本地分支与远端分支靠 `git remote` 的名字区分：分支名里也可能带 `/`，
 * 光看字符串分不出来。认不出的归为本地分支，只是徽标配色差异，不影响正确性。
 * @param {string} raw
 * @param {Set<string>} remotes
 */
function parseLogDecorations(raw, remotes) {
  const refs = { head: '', branches: [], remotes: [], tags: [] };
  for (const part of String(raw || '').split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (name.startsWith('HEAD -> ')) {
      refs.head = name.slice(8);
      refs.branches.push(refs.head);
    } else if (name.startsWith('tag: ')) {
      refs.tags.push(name.slice(5));
    } else if (name.startsWith('refs/')) {
      continue;
    } else {
      const remoteName = name.split('/')[0];
      if (remotes.has(remoteName)) refs.remotes.push(name);
      else refs.branches.push(name);
    }
  }
  return refs;
}

/**
 * 把 `git log --date-order` 输出解析成结构化提交列表。
 * 顺序契约：git 任何排序模式下都保证子提交先于父提交出现，
 * 这是泳道布局（layoutCommitLanes）能用单遍扫描的前提。
 * @param {string} out
 * @param {Set<string>} remotes 远端名集合，用于装饰分类
 */
function parseGitLog(out, remotes) {
  const commits = [];
  for (const raw of String(out || '').split('\x1e')) {
    const record = raw.trim();
    if (!record) continue;
    const f = record.split('\x1f');
    if (f.length < 7 || !f[0]) continue;
    commits.push({
      sha: f[0],
      shortSha: f[1] || f[0].slice(0, 7),
      parents: f[2] ? f[2].trim().split(/\s+/).filter(Boolean) : [],
      author: f[3] || '',
      time: Number(f[4]) || 0,
      subject: f[5] || '',
      refs: parseLogDecorations(f[6], remotes)
    });
  }
  return commits;
}

/**
 * 泳道布局：给每条提交算出画布坐标（lane 列号 + 进出线段）。
 *
 * 单遍扫描，依赖 date-order 的「子先于父」契约：
 *   - active 维护所有仍在向下延伸的分支线（下一站是哪条提交）；
 *   - 遇到提交 C：C 必然已由某个子提交占好线（没有则说明子提交在
 *     分页窗口外，新开一条并标 appears，渲染端不画进入线）；
 *   - C 的第一条父线沿原 lane 直行；其余父线从 C 节点弯出——目标 lane
 *     已有线就并入，没有就新开一条。
 *
 * 每条线创建前都先 findIndex 查重，因此 active 里不会有同 sha 双线，
 * 也不需要折行/压缩逻辑。渲染端只需要：lane（节点列）、inRails（上方
 * 垂线）、appears（是否窗口边界新线）、edges（节点引出的线）、columns（总列数）。
 *
 * 返回 active（扫描结束仍在延伸的线）供分页续算：下一页把它作为
 * activeInit 传回来，泳道才能跨页连续，而不是每页开头都重新长线。
 * @param {Array<object>} commits parseGitLog 输出
 * @param {Array<{sha: string}>} [activeInit] 上一页页尾的延伸线
 */
function layoutCommitLanes(commits, activeInit) {
  const active = (activeInit || []).map((e) => ({ sha: String(e.sha || e) }));
  for (const c of commits) {
    let lane = active.findIndex((e) => e.sha === c.sha);
    const appears = lane === -1;
    if (appears) {
      lane = active.length;
      active.push({ sha: c.sha });
    }
    c.lane = lane;
    c.appears = appears;
    c.inRails = active.map((_, i) => i);
    c.edges = [];

    active.splice(lane, 1);
    (c.parents || []).forEach((p, pi) => {
      const existing = active.findIndex((e) => e.sha === p);
      if (existing !== -1) {
        c.edges.push({ from: lane, to: existing });
        return;
      }
      if (pi === 0) {
        active.splice(lane, 0, { sha: p });
        c.edges.push({ from: lane, to: lane });
      } else {
        active.push({ sha: p });
        c.edges.push({ from: lane, to: active.length - 1 });
      }
    });

    let columns = active.length;
    for (const e of c.edges) columns = Math.max(columns, e.from + 1, e.to + 1);
    columns = Math.max(columns, lane + 1);
    c.columns = columns;
  }
  // commits 上的布局字段是原地写入的；active 单独返回给分页续算
  return { commits, active: active.map((e) => e.sha) };
}

function clampLogLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_PAGE;
  return Math.min(MAX_LOG_PAGE, Math.max(1, Math.floor(n)));
}

/**
 * 提交历史。默认展示全部本地分支（含 HEAD），不含远端跟踪分支——
 * 后者的提交几乎总在某个本地分支上有镜像，混进来只会让泳道变密。
 * 分页用 skip；泳道布局跨页需要连续，上一页返回的 active 要通过
 * resume 原样传回（跳页/乱序传参最多导致泳道重新长线，不会崩）。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ limit?: number, skip?: number, resume?: string[] }} [params]
 */
async function getScmLog(git, params) {
  const limit = clampLogLimit(params && params.limit);
  const skip = Math.max(0, Math.floor(Number(params && params.skip) || 0));
  const resume = (Array.isArray(params && params.resume) ? params.resume : [])
    .filter((s) => SHA_RE.test(String(s)))
    .slice(0, 64)
    .map((sha) => ({ sha }));

  const remotesOut = await git.textOrEmpty(['remote']);
  const remotes = new Set(remotesOut.split('\n').map((s) => s.trim()).filter(Boolean));

  const args = [
    'log',
    '--date-order',
    `--max-count=${limit}`,
    `--skip=${skip}`,
    `--pretty=tformat:${LOG_FORMAT}`,
    '--branches',
    'HEAD'
  ];
  const r = await git.run(args);
  if (!r.ok) {
    return { ok: false, error: gitFailure(r, '无法读取提交历史') };
  }
  const { commits, active } = layoutCommitLanes(parseGitLog(r.stdout, remotes), resume);
  return {
    ok: true,
    commits,
    active,
    done: commits.length < limit,
    total: skip + commits.length
  };
}

const SHA_RE = /^[0-9a-fA-F]{4,40}$/;

/**
 * 单条提交的变更文件列表（展开行用）。
 * name-status 给状态、numstat 给行数，两次调用；rename 在两边都归到新路径。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ sha?: string }} params
 */
async function getScmCommitFiles(git, params) {
  const sha = String((params && params.sha) || '').trim();
  if (!SHA_RE.test(sha)) return { ok: false, error: '无效的提交' };

  const [statusOut, numstatOut] = await Promise.all([
    git.textOrEmpty(['show', '--no-color', '--format=', '--name-status', '-z', sha]),
    git.textOrEmpty(['show', '--no-color', '--format=', '--numstat', sha])
  ]);
  if (!statusOut && !numstatOut) {
    return { ok: false, error: '无法读取提交内容' };
  }

  const files = [];
  const tokens = statusOut.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const head = tokens[i];
    if (!head) continue;
    const code = head[0].toUpperCase();
    const origPath = 'RCT'.includes(code) ? normalizeGitRelPath(tokens[++i]) : '';
    const path = normalizeGitRelPath(tokens[++i] || '') || origPath;
    if (!path) continue;
    files.push({
      path,
      origPath,
      status: code,
      statusLabel: scmStatusLabel(code)
    });
  }

  const stats = parseNumstat(numstatOut);
  for (const file of files) {
    const stat = stats.get(file.path) || { added: 0, removed: 0 };
    file.added = stat.added;
    file.removed = stat.removed;
  }
  return { ok: true, sha, files };
}

/**
 * 提交内单文件的 diff，返回结构与 scm.file_diff 完全一致，
 * 渲染端沿用同一套 diff 预览，不写第二份。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ sha?: string, path?: string }} params
 */
async function getScmCommitDiff(git, params) {
  const sha = String((params && params.sha) || '').trim();
  const rel = normalizeGitRelPath(params && params.path);
  if (!SHA_RE.test(sha)) return { ok: false, error: '无效的提交' };
  if (!rel) return { ok: false, error: '缺少有效的文件路径' };

  const patchOut = await git.textOrEmpty(['show', '--no-color', '--format=', sha, '--', rel]);
  const statOut = await git.textOrEmpty(['show', '--no-color', '--format=', '--numstat', sha, '--', rel]);
  const stat = parseNumstat(statOut).get(rel) || { added: 0, removed: 0 };

  // rename 时旧内容在 origPath 下；根提交没有父版本，读不到就当「新建」
  const showOut = await git.textOrEmpty(['show', '--no-color', '--format=', '--name-status', '-z', sha]);
  let origPath = '';
  {
    const tokens = showOut.split('\0');
    for (let i = 0; i < tokens.length; i += 1) {
      const head = tokens[i];
      if (!head) continue;
      const code = head[0].toUpperCase();
      const oldP = 'RCT'.includes(code) ? normalizeGitRelPath(tokens[++i]) : '';
      const newP = normalizeGitRelPath(tokens[++i] || '');
      if (newP === rel) {
        origPath = oldP;
        break;
      }
    }
  }
  const before = origPath
    ? await readGitBlob(git, `${sha}^:${origPath}`)
    : await readGitBlob(git, `${sha}^:${rel}`);
  const after = await readGitBlob(git, `${sha}:${rel}`);

  const beforeClipped = clipText(before.text);
  const afterClipped = clipText(after.text);
  const status = origPath ? 'R' : !before.text && after.text ? 'A' : !after.text && before.text ? 'D' : 'M';

  return {
    ok: true,
    sha,
    path: rel,
    origPath,
    group: 'commit',
    status,
    statusLabel: scmStatusLabel(status),
    added: stat.added,
    removed: stat.removed,
    created: !before.text && !!after.text,
    binary: !!(before.binary || after.binary),
    truncated: patchOut.length > MAX_PATCH_CHARS || beforeClipped.truncated || afterClipped.truncated,
    patch: patchOut.length > MAX_PATCH_CHARS ? patchOut.slice(0, MAX_PATCH_CHARS) : patchOut,
    beforeText: beforeClipped.text,
    afterText: afterClipped.text
  };
}

module.exports = {
  SCM_GROUP_IDS,
  scmStatusLabel,
  normalizeNumstatPath,
  parseNumstat,
  buildScmRows,
  getScmStatus,
  getScmFileDiff,
  scmStage,
  scmUnstage,
  scmDiscard,
  scmCommit,
  parseGitLog,
  parseLogDecorations,
  layoutCommitLanes,
  getScmLog,
  getScmCommitFiles,
  getScmCommitDiff
};
