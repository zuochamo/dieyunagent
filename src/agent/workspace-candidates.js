'use strict';

/**
 * 「本机已用过的项目」候选与匹配：**纯函数，零依赖**（会被打进 Renderer 的 agent-bundle）。
 *
 * 为什么要有这一份：同一个 `session_set_workspace` 有两个执行现场 ——
 * 频道（`src/channels/workspace-switch.js`，Main）与桌面（`src/renderer/renderer-workspace-ssh.js`，
 * Renderer）。候选来源是同一张表（`memory.sessions_list` 的会话行），匹配规则也该是同一份：
 * 目录名精确 → 目录名唯一子串 → 歧义（要求指明）。曾经只有频道那份，桌面侧只能让模型猜路径，
 * 猜错的代价是「切成功了但什么都读不到」。
 *
 * 这里只做三件事：**收候选、归一路径、按名字匹配**。不做存在性校验、不做上限之外的策略、
 * 不判「该不该切」。
 */

/** 候选上限：与频道侧原来的 200 一致（会话再多也只是给人/模型看一眼的项目名列表）。 */
const KNOWN_WORKSPACE_LIMIT = 200;

/**
 * 路径归一：只用于**比较**（去尾分隔符、统一分隔符、Windows 下不分大小写）。
 * 不用于展示，也不用于落盘。
 * @param {string} p
 * @returns {string}
 */
function normalizePathKey(p) {
  return String(p || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 路径最后一段（项目名）。`F:\a\b\` → `b`。
 * @param {string} p
 * @returns {string}
 */
function baseNameOf(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const parts = s.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

/**
 * 会话行 → 候选清单（去重、保持顺序）。
 *
 * `workspaceProjectPath` 优先于 `workspacePath`：远端/并行会话的 `workspacePath` 是它自己那份
 * worktree（`…/.dieyun/worktrees/sess-xxx/main`），按原值当候选会多出一堆叫 `main` 的假项目；
 * 项目身份由 Main 侧给出（`workspaceProjectPath`）。这条口径与桌面左侧目录树完全一致。
 *
 * @param {Array<object>|null|undefined} rows `memory.sessions_list` 的行
 * @param {string[]} [extraPaths] 额外候选（频道默认目录 / 当前视图目录）
 * @returns {Array<{ path: string, name: string }>}
 */
function candidatesFromSessionRows(rows, extraPaths) {
  /** @type {Array<{ path: string, name: string }>} */ const list = [];
  const seen = new Set();
  const push = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizePathKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ path: raw, name: baseNameOf(raw) || raw });
  };
  for (const p of Array.isArray(extraPaths) ? extraPaths : []) push(p);
  for (const row of Array.isArray(rows) ? rows : []) {
    push(row && (row.workspaceProjectPath || row.workspacePath));
  }
  return list;
}

/**
 * 把输入对到候选上：绝对路径精确命中 > 目录名精确 > 目录名唯一子串。
 *
 * 返回四种结果（调用方据此决定「切 / 要它指明 / 列出候选」）：
 * - `{ hit }` 唯一命中
 * - `{ ambiguous: [...] }` 子串命中多个
 * - `null` 没命中
 *
 * @param {string} input 模型/用户给的 workspace 值
 * @param {Array<{ path: string, name: string }>} candidates
 * @returns {{ path: string, name: string } | { ambiguous: Array<{ path: string, name: string }> } | null}
 */
function matchCandidate(input, candidates) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const key = normalizePathKey(raw);
  const exact = list.find((c) => normalizePathKey(c.path) === key);
  if (exact) return exact;
  const byName = list.filter((c) => String(c.name || '').toLowerCase() === raw.toLowerCase());
  if (byName.length === 1) return byName[0];
  // 子串匹配只在「唯一」时才认：两个项目都含这个词时认哪个都是猜。
  const byPart = list.filter((c) => String(c.name || '').toLowerCase().includes(raw.toLowerCase()));
  if (byPart.length === 1) return byPart[0];
  if (byPart.length > 1) return { ambiguous: byPart };
  return null;
}

/**
 * 候选清单的一行话（给模型/用户看）。**唯一文案**：频道与桌面共用，免得两处各写一句。
 * @param {Array<{ path: string, name: string }>} candidates
 * @returns {string}
 */
function candidateText(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return '（本机还没有可用的工作空间）';
  return list.map((c) => `${c.name}（${c.path}）`).join('、');
}

module.exports = {
  KNOWN_WORKSPACE_LIMIT,
  normalizePathKey,
  baseNameOf,
  candidatesFromSessionRows,
  matchCandidate,
  candidateText
};
