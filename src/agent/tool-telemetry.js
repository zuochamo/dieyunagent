'use strict';

const fs = require('fs');
const path = require('path');
const { getRotatingLog, flushLog, truncateLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

function telemetryPath(userDataPath) {
  return path.join(userDataPath || '', 'tool-telemetry.jsonl');
}

/**
 * 「索引工具」分组 —— 使用率统计口径的**唯一来源**。
 *
 * 统计信息页的「索引使用率」直接按这张表算，Renderer 不再各写一份工具名单：
 * 加/减一个索引工具只改这里。
 *
 * 口径说明（写清楚，免得以后拿这个数字随便砍功能）：
 * - **代码索引**只有 `codebase_search` 一个出口（`codebase.status` 之类是面板内部调用，
 *   不经 Agent 工具闸门，不进遥测）；
 * - **结构索引**是 `graph`（模块依赖 / 调用关系 / repo_map）与 `read_symbol`
 *   （符号定位，远端无 LSP 时的兜底）。`grep` 与 `lsp` 不算：前者直读文件系统、
 *   恰恰是索引的**替代品**，后者是语言服务器而不是索引库。
 */
const INDEX_TOOL_GROUPS = [
  { id: 'codebase', label: '代码索引', tools: ['codebase_search'] },
  { id: 'graph', label: '结构索引', tools: ['graph', 'read_symbol'] }
];

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 每次工具调用记一行。
 * 原来这里是 `appendFileSync`（一次 open+write+close 系统调用）且跑在主进程上，
 * 现在走统一闸门批写，高频工具轮次下能省掉大量 syscall。
 * @param {object} row
 */
function recordToolTelemetry(userDataPath, row) {
  if (!userDataPath) return;
  const filePath = telemetryPath(userDataPath);
  const log = getRotatingLog(filePath, { maxBytes: DEFAULT_MAX_BYTES });
  if (!log) return;
  log.write(
    `${JSON.stringify({
      ts: Date.now(),
      ...row
    })}\n`
  );
}

/**
 * 索引工具使用率：**全窗口**（当前遥测文件里的全部记录），不是「近 200 次」。
 *
 * 为什么要单独一个全窗口口径：判断「这个索引值不值得留」看的是周级别的占比
 * （0.05% 那个数字就是 7 天口径）。近 200 次只够看几分钟，拿它评估索引会把
 * 「刚建完索引的一次使用」放大成 50%。
 *
 * @param {Array<object>} rows 已解析的遥测行（时间升序）
 */
function summarizeIndexUsage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const countByTool = new Map();
  for (const row of list) {
    const tool = String(row.tool || '');
    countByTool.set(tool, (countByTool.get(tool) || 0) + 1);
  }
  const groups = INDEX_TOOL_GROUPS.map((group) => {
    const tools = new Set(group.tools);
    let calls = 0;
    let ok = 0;
    const errorMap = new Map();
    for (const row of list) {
      if (!tools.has(String(row.tool || ''))) continue;
      calls += 1;
      if (row.ok) {
        ok += 1;
      } else if (row.errorCode && row.errorCode !== 'err') {
        errorMap.set(row.errorCode, (errorMap.get(row.errorCode) || 0) + 1);
      }
    }
    return {
      id: group.id,
      label: group.label,
      tools: group.tools,
      calls,
      ok,
      failed: calls - ok,
      share: total ? round1((calls / total) * 100) : 0,
      successRate: calls ? round1((ok / calls) * 100) : 0,
      byTool: group.tools.map((tool) => ({ tool, calls: countByTool.get(tool) || 0 })),
      topErrors: [...errorMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([errorCode, count]) => ({ errorCode, count }))
    };
  });
  const first = list.length ? list[0].ts : null;
  const last = list.length ? list[list.length - 1].ts : null;
  return {
    total,
    since: Number.isFinite(first) ? first : null,
    until: Number.isFinite(last) ? last : null,
    indexCalls: groups.reduce((sum, g) => sum + g.calls, 0),
    groups
  };
}

function summarizeTelemetry(userDataPath, limit = 200) {
  const filePath = telemetryPath(userDataPath);
  const empty = {
    windowRows: limit,
    total: 0,
    ok: 0,
    failed: 0,
    successRate: 0,
    repeatBlocks: 0,
    retries: 0,
    byTool: [],
    topErrors: [],
    rows: [],
    indexUsage: summarizeIndexUsage([])
  };
  try {
    // 日志是批写的，读取前必须先刷缓冲，否则会统计到陈旧数据
    flushLog(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    // 一次解析全量：`indexUsage` 要全窗口，「近 200 次」只是同一批行的一个切片。
    // 文件有 2 MB 上限（DEFAULT_MAX_BYTES），全量解析是毫秒级。
    const allRows = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try {
        allRows.push(JSON.parse(line));
      } catch {
        // 半行 / 损坏行跳过
      }
    }
    const indexUsage = summarizeIndexUsage(allRows);
    const lines = allRows.slice(-limit);
    const byKey = new Map();
    const byToolMap = new Map();
    const errorMap = new Map();
    let ok = 0;
    let failed = 0;
    let repeatBlocks = 0;
    let retries = 0;

    for (const row of lines) {
      const tool = String(row.tool || '?');
      const errorCode = row.errorCode || (row.ok ? 'ok' : 'err');
      const key = `${tool}::${errorCode}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);

      if (row.ok) ok += 1;
      else failed += 1;
      if (errorCode === 'REPEAT_BLOCK') repeatBlocks += 1;
      if (typeof row.attempt === 'number' && row.attempt > 0) retries += 1;

      if (!byToolMap.has(tool)) {
        byToolMap.set(tool, { tool, total: 0, ok: 0, failed: 0, repeatBlocks: 0 });
      }
      const tb = byToolMap.get(tool);
      tb.total += 1;
      if (row.ok) tb.ok += 1;
      else tb.failed += 1;
      if (errorCode === 'REPEAT_BLOCK') tb.repeatBlocks += 1;

      if (!row.ok && errorCode && errorCode !== 'err') {
        errorMap.set(errorCode, (errorMap.get(errorCode) || 0) + 1);
      }
    }

    const total = ok + failed;
    const rows = [...byKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, n]) => ({ key: k, count: n }));

    const byTool = [...byToolMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
      .map((t) => ({
        ...t,
        successRate: t.total ? Math.round((t.ok / t.total) * 1000) / 10 : 0
      }));

    const topErrors = [...errorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([errorCode, count]) => ({ errorCode, count }));

    return {
      windowRows: limit,
      total,
      ok,
      failed,
      successRate: total ? Math.round((ok / total) * 1000) / 10 : 0,
      repeatBlocks,
      retries,
      byTool,
      topErrors,
      rows,
      indexUsage
    };
  } catch {
    return empty;
  }
}

/**
 * 「索引内容被自动塞进上下文的次数」—— 与上面「工具调用占比」互补的**另一半口径**。
 *
 * 为什么必须两个数字一起看：工具遥测只记**主动调用**（`codebase_search` / `graph` /
 * `read_symbol`），而 `repo_map`（【仓库结构图】）与【相关代码】是 prep 的**自动注入**，
 * 走 RPC、根本不进遥测。只看调用占比，会把「一直在注入、所以不必再调工具」读成
 * 「模型不用索引」——2026-11-03 实机就是这个形态：调用 0.6%，同期注入 833/1771 轮。
 * 详见 `docs/INDEX-VALUE-REVIEW.md` §7.5。
 *
 * 事实来源只有一个：`request_snapshots.context_audit_json.index`
 * （写入方 `src/agent/system-prompt-prep.js:IndexInjectionAudit`，聚合方
 * `crates/dieyun-memory/src/memory/snapshot.rs:count_index_injections`）。
 * 这里只做**展示口径**（占比、空值），不重新判定「什么算注入」。
 *
 * @param {object | null} raw RPC `memory.request_snapshot_index_audit` 的返回
 */
function describeIndexInjections(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rounds = Number(raw.rounds) || 0;
  const shareOf = (n) => (rounds ? round1((Number(n) / rounds) * 100) : 0);
  const asCount = (v) => Number(v) || 0;
  const asTs = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const repoMap = asCount(raw.repoMap);
  const codeAuto = asCount(raw.codeAuto);
  const codeExplicit = asCount(raw.codeExplicit);
  const code = codeAuto + codeExplicit;
  return {
    // 有索引审计事实的轮次 = 两个占比的分母
    rounds,
    // 窗口内全部快照（含改造前没有索引审计的历史行）：用来说明「不是没数据，是旧数据没这项」
    total: asCount(raw.total),
    since: asTs(raw.since),
    until: asTs(raw.until),
    repoMap,
    repoMapShare: shareOf(repoMap),
    code,
    codeAuto,
    codeExplicit,
    codeShare: shareOf(code)
  };
}

/**
 * 清空工具调用遥测（统计信息页「清空」按钮的一路）。
 * 走闸门截断而不是直接删文件：删文件会让正在跑的工具轮次在下次写入时重建它，
 * 而闸门截断能一并排掉尚未落盘的缓冲，避免清空后旧数据回灌。
 * @param {string} userDataPath
 */
function clearToolTelemetry(userDataPath) {
  if (!userDataPath) return false;
  return truncateLog(telemetryPath(userDataPath));
}

module.exports = {
  recordToolTelemetry,
  summarizeTelemetry,
  summarizeIndexUsage,
  describeIndexInjections,
  clearToolTelemetry,
  telemetryPath,
  INDEX_TOOL_GROUPS
};
