'use strict';

/**
 * 默认工作区（`~/.dieyun/workspace`）回收策略：**唯一实现**。
 *
 * 为什么必须有：未选工作空间时，工具产出全都落这个目录（`agent-home.js` 的
 * `dieyunDefaultWorkspaceDir` / README_WORKSPACE，`gateway/server.js` 把它恒定放进
 * 读写白名单，「新对话」也不挂工作空间）。没有任何会话对它负责清理，它只进不出 ——
 * 实测一台开发机半年攒到 7896 个文件 / 717 MB（探针脚本、截图、临时 mp4、clone 下来的仓库）。
 *
 * 为什么只管这一个目录：用户**自选**的工作空间是用户的工程，任何自动删除都是数据事故。
 *
 * 三条规则（数字全在 `src/agent/agent-limits.js`，本文件不写字面量）：
 *   1. 逐条看顶层条目（文件/目录）的「最近活动时间」= 子树里最新的 mtime；
 *   2. 超过保留天数 → 回收；
 *   3. 总量超过容量上限 → 按最旧优先继续回收，直到达标（还是超就把 overBudget 报出去，
 *      不为了达标去删受保护的条目）。
 *
 * 两条永不越过的边界：
 *   - **工程标记**（`.git` / `package.json` / `Cargo.toml` / …）：出现任一即视为用户要的产出，
 *     永不自动删除。这是结构信号，不是按文件名关键词猜意图。
 *   - **宽限期**：最近动过的条目一律不动（多实例 / 长会话可能还在用）。
 *
 * 失败静默：回收属于后台维护，绝不能影响启动、请求或工具执行；单个条目删不掉就跳过。
 */

const fsp = require('fs/promises');
const path = require('path');

const { AGENT_LIMITS_DEFAULTS } = require('./agent/agent-limits');
const { dieyunDefaultWorkspaceDir } = require('./agent-home');

/** 永不自动删除的条目：会话数据（`.dieyun`）与目录说明 */
const PROTECTED_NAMES = new Set(['.dieyun', 'README.md']);

/**
 * 工程标记：子树里出现任一，整条视为「用户要的产出」，永不自动删除。
 * 只放「有它就不是随手可丢的一次性产物」的那种文件。
 */
const PROJECT_MARKERS = new Set([
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'requirements.txt',
  'SKILL.md'
]);

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 把 agent-limits 的天/小时/MB 口径换算成毫秒与字节。 */
function resolveGcLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  const d = AGENT_LIMITS_DEFAULTS;
  return {
    retentionMs:
      toInt(l.defaultWorkspaceRetentionDays, d.defaultWorkspaceRetentionDays) * 24 * 60 * 60 * 1000,
    graceMs: toInt(l.defaultWorkspaceGraceHours, d.defaultWorkspaceGraceHours) * 60 * 60 * 1000,
    maxBytes: toInt(l.defaultWorkspaceMaxMb, d.defaultWorkspaceMaxMb) * 1024 * 1024,
    maxEntries: toInt(l.defaultWorkspaceGcMaxEntries, d.defaultWorkspaceGcMaxEntries)
  };
}

/**
 * 递归统计一个目录：总字节数、子树里的最新 mtime（= 最近活动时间）、是否含工程标记。
 * 不跟随符号链接（避免统计跑出目录树，也避免把链接目标当真）。
 */
async function measureDir(dir, dirStat) {
  let bytes = 0;
  let lastActivityMs = dirStat ? dirStat.mtimeMs : 0;
  let hasMarker = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue; // 目录消失/无权限：其余部分照常统计
    }
    for (const ent of entries) {
      if (PROJECT_MARKERS.has(ent.name)) hasMarker = true;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = await fsp.stat(full);
        bytes += st.size;
        if (st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs;
      } catch {
        /* 单个文件 stat 失败不影响整体 */
      }
    }
    // 目录自身 mtime 也算活动（增删子项会更新它，可能是「刚被用过」的唯一痕迹）
    try {
      const st = await fsp.stat(current);
      if (st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return { bytes, lastActivityMs, hasMarker };
}

/**
 * 扫描默认工作区的顶层条目。
 * @param {string} root
 * @param {{ maxEntries: number }} cfg
 * @returns {Promise<Array<{ name: string, full: string, kind: 'file'|'dir', bytes: number, lastActivityMs: number, protectedByName: boolean, protectedByMarker: boolean }>>}
 */
async function scanWorkspaceEntries(root, cfg) {
  let dirents;
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const maxEntries = cfg.maxEntries > 0 ? cfg.maxEntries : 0;
  for (const ent of dirents) {
    if (maxEntries && out.length >= maxEntries) break;
    if (ent.isSymbolicLink()) continue;
    const full = path.join(root, ent.name);
    const protectedByName = PROTECTED_NAMES.has(ent.name);
    if (ent.isDirectory()) {
      let st = null;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      const m = await measureDir(full, st);
      out.push({
        name: ent.name,
        full,
        kind: 'dir',
        bytes: m.bytes,
        lastActivityMs: m.lastActivityMs,
        protectedByName,
        protectedByMarker: m.hasMarker
      });
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      const st = await fsp.stat(full);
      out.push({
        name: ent.name,
        full,
        kind: 'file',
        bytes: st.size,
        lastActivityMs: st.mtimeMs,
        protectedByName,
        protectedByMarker: false
      });
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return out;
}

/**
 * 纯函数：给定条目清单与预算，算出该删哪些。
 * 拆出来是为了测试能脱离盘上时间戳直接验规则。
 *
 * @param {ReturnType<typeof scanWorkspaceEntries> extends Promise<infer T> ? T : never} entries
 * @param {{ retentionMs: number, graceMs: number, maxBytes: number }} cfg
 * @param {number} now 毫秒时间戳
 */
function planReclaim(entries, cfg, now) {
  const list = Array.isArray(entries) ? entries : [];
  const totalBytes = list.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
  const keptProtected = [];
  const keptFresh = [];
  /** @type {Array<{name: string, full: string, bytes: number, lastActivityMs: number}>} */
  const candidates = [];

  for (const e of list) {
    if (e.protectedByName || e.protectedByMarker) {
      keptProtected.push(e.name);
      continue;
    }
    if (cfg.graceMs > 0 && now - e.lastActivityMs < cfg.graceMs) {
      keptFresh.push(e.name);
      continue;
    }
    candidates.push(e);
  }
  // 最旧优先；mtime 相同时按名字兜底，保证结果稳定可复现
  candidates.sort((a, b) => a.lastActivityMs - b.lastActivityMs || a.name.localeCompare(b.name));

  const reclaim = [];
  const reclaimNames = new Set();
  let reclaimBytes = 0;
  const keptBytes = () => totalBytes - reclaimBytes;

  for (const e of candidates) {
    if (!(cfg.retentionMs > 0) || now - e.lastActivityMs <= cfg.retentionMs) continue;
    reclaim.push(e);
    reclaimNames.add(e.name);
    reclaimBytes += Number(e.bytes) || 0;
  }
  // 容量上限：先按最旧优先补刀，直到达标；仍超限就如实报出去
  if (cfg.maxBytes > 0 && keptBytes() > cfg.maxBytes) {
    for (const e of candidates) {
      if (keptBytes() <= cfg.maxBytes) break;
      if (reclaimNames.has(e.name)) continue;
      reclaim.push(e);
      reclaimNames.add(e.name);
      reclaimBytes += Number(e.bytes) || 0;
    }
  }

  reclaim.sort((a, b) => a.lastActivityMs - b.lastActivityMs || a.name.localeCompare(b.name));
  return {
    totalBytes,
    reclaim,
    reclaimBytes,
    keptBytes: totalBytes - reclaimBytes,
    keptProtected,
    keptFresh,
    overBudget: cfg.maxBytes > 0 && totalBytes - reclaimBytes > cfg.maxBytes
  };
}

/**
 * 回收默认工作区。`root` 缺省就是 `~/.dieyun/workspace`。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 目标目录（测试用；生产永远走默认工作区）
 * @param {object} [opts.limits] agent-limits 解析结果
 * @param {boolean} [opts.dryRun] 只算不删
 * @param {number} [opts.now] 毫秒时间戳（测试用）
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
async function pruneDefaultWorkspace(opts = {}) {
  const root = opts.root ? path.resolve(String(opts.root)) : dieyunDefaultWorkspaceDir();
  const cfg = resolveGcLimits(opts.limits);
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const log = opts.log || null;
  const base = { root, checked: 0, deleted: 0, deletedBytes: 0, totalBytes: 0, keptBytes: 0, overBudget: false };

  const entries = await scanWorkspaceEntries(root, cfg);
  if (!entries.length) return base;

  const plan = planReclaim(entries, cfg, now);
  if (opts.dryRun) {
    return {
      ...base,
      checked: entries.length,
      totalBytes: plan.totalBytes,
      keptBytes: plan.keptBytes,
      overBudget: plan.overBudget,
      wouldDelete: plan.reclaim.map((e) => e.name),
      wouldFreeBytes: plan.reclaimBytes,
      keptProtected: plan.keptProtected,
      keptFresh: plan.keptFresh
    };
  }

  let deleted = 0;
  let deletedBytes = 0;
  for (const e of plan.reclaim) {
    try {
      await fsp.rm(e.full, { recursive: true, force: true });
      deleted += 1;
      deletedBytes += Number(e.bytes) || 0;
    } catch (err) {
      // 单个条目删不掉（被占用/权限）就跳过，别让整趟回收失败
      if (log && typeof log.warn === 'function') {
        log.warn(`[dieyun:agent] 默认工作区回收跳过 ${e.name}: ${(err && err.message) || err}`);
      }
    }
  }

  const result = {
    ...base,
    checked: entries.length,
    deleted,
    deletedBytes,
    totalBytes: plan.totalBytes,
    keptBytes: plan.totalBytes - deletedBytes,
    overBudget: cfg.maxBytes > 0 && plan.totalBytes - deletedBytes > cfg.maxBytes
  };
  if (deleted > 0 && log && typeof log.info === 'function') {
    log.info(
      `[dieyun:agent] 默认工作区回收：删除 ${deleted} 项，释放 ${mb(deletedBytes)} MB，` +
        `当前 ${mb(result.keptBytes)} MB（保留 ${plan.keptProtected.length} 项工程/受保护条目）`
    );
  }
  if (result.overBudget && log && typeof log.warn === 'function') {
    log.warn(
      `[dieyun:agent] 默认工作区仍超上限（${mb(result.keptBytes)} MB），` +
        '剩下的都是受保护条目或宽限期内的新文件，需人工确认'
    );
  }
  return result;
}

function mb(bytes) {
  return Math.round(((Number(bytes) || 0) / (1024 * 1024)) * 10) / 10;
}

/**
 * 装配入口：**桌面与 headless 各调一次**，回收语义全在本模块，调用方只负责给 log 与 limits。
 * 启动先跑一趟，之后每 `defaultWorkspaceGcIntervalMs` 跑一趟（长跑进程也要收）。
 *
 * @param {object} [opts]
 * @param {string} [opts.root]
 * @param {object} [opts.limits]
 * @param {{ info: Function, warn: Function }} [opts.log]
 * @returns {{ stop: () => void }}
 */
function scheduleDefaultWorkspaceGc(opts = {}) {
  const intervalMs =
    toInt(
      opts.limits && opts.limits.defaultWorkspaceGcIntervalMs,
      AGENT_LIMITS_DEFAULTS.defaultWorkspaceGcIntervalMs
    ) || 6 * 60 * 60 * 1000;
  // 不 await：回收不能拖慢启动。失败静默，最多留一条 warn（pruneDefaultWorkspace 内部处理）。
  const run = () => {
    pruneDefaultWorkspace(opts).catch((err) => {
      if (opts.log && typeof opts.log.warn === 'function') {
        opts.log.warn(`[dieyun:agent] 默认工作区回收失败: ${(err && err.message) || err}`);
      }
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      clearInterval(timer);
    }
  };
}

module.exports = {
  PROTECTED_NAMES,
  PROJECT_MARKERS,
  resolveGcLimits,
  scanWorkspaceEntries,
  planReclaim,
  pruneDefaultWorkspace,
  scheduleDefaultWorkspaceGc
};
