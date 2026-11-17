'use strict';

const fs = require('fs');
const path = require('path');
const { getRotatingLog, flushLog, truncateLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

/**
 * 上下文折叠遥测（统计信息页「上下文压缩」板块的唯一数据来源）。
 *
 * 为什么单独一条流而不并进 `tool-telemetry.jsonl`：那个文件每一行都是「一次工具调用」，
 * `summarizeTelemetry` 的聚合口径（total / successRate / byTool / REPEAT_BLOCK）全部
 * 建立在 `row.tool` 上。把折叠行混进去会污染工具成功率的分子分母。
 *
 * 记录时机（**唯一入口** `compaction-main.js: maybeCompactMessages`）：
 * 只在**真触发过**（越过触发线或 force）的那一次写一行。未到触发线的早退在每轮 LLM 前
 * 都会发生，记下来只会让文件按轮次膨胀、把成功率稀释成没有意义的数。
 * 判定口径见 `compactionTelemetryRow()`，它是该判定的唯一实现。
 */

const COMPACTION_TELEMETRY_FILE = 'compaction-telemetry.jsonl';

/** 触发来源：auto = 按 token 预算/配额自动触发；force = 手动「立即压缩」或溢出兜底 */
const TRIGGER_AUTO = 'auto';
const TRIGGER_FORCE = 'force';

/** 结果：compacted = 真的折短了 messages；noop = 触发过但这次没有可折的内容 */
const RESULT_COMPACTED = 'compacted';
const RESULT_NOOP = 'noop';

/** 跳过明细入库前的截断长度：够定位病因，又不至于把堆栈灌满日志。 */
const DETAIL_MAX_CHARS = 200;

/** 跳过原因：Rust 折叠器给的 `foldSkipped`，没有就是「没有可折的内容」。 */
function skipReason(payload) {
  const skipped = String((payload && payload.foldSkipped) || '').trim();
  return skipped || 'no_foldable';
}

/** 汇总窗口内返回的失败原因种类上限 */
const MAX_REASONS = 8;

function compactionTelemetryPath(userDataPath) {
  return path.join(userDataPath || '', COMPACTION_TELEMETRY_FILE);
}

/**
 * 会话键归一化：**写入与过滤必须共用这一个口径**。
 * 空值（少数没有会话上下文的调用路径）归一成空串，代表「无会话」这一组。
 * @param {unknown} sessionId
 */
function normalizeTelemetrySessionId(sessionId) {
  return String(sessionId == null ? '' : sessionId).trim();
}

/**
 * 会话过滤用的廉价子串：行是 `JSON.stringify` 的产物（无空格、值后必跟 `"`），
 * 所以这个串不会误配到 `abc` → `abcd` 这类前缀。先用它筛行、再 `JSON.parse`。
 * @param {string} sessionId 已归一化且非空
 */
function sessionNeedle(sessionId) {
  return `"sessionId":${JSON.stringify(sessionId)}`;
}

/**
 * 每次折叠尝试记一行；`row` 为假值时静默跳过（调用点无需自判是否该记）。
 * @param {string} userDataPath
 * @param {object|null} row
 */
function recordCompactionTelemetry(userDataPath, row) {
  if (!userDataPath || !row) return;
  const filePath = compactionTelemetryPath(userDataPath);
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
 * 一次折叠结果 → 遥测行；返回 `null` 表示「这轮没发生折叠」，不记。
 *
 * 行里带 `sessionId` —— 面板要回答的是「**这段对话**压缩了几次」；没有会话标识就
 * 只能统计全机累计，那是另一个问题。
 *
 * @param {{ payload: object|null, force?: boolean, sessionId?: string, startedAt?: number }} input
 * @returns {object|null}
 */
function compactionTelemetryRow(input = {}) {
  const { payload, force, sessionId, startedAt } = input;
  if (!payload || typeof payload !== 'object') return null;
  // 只在真触发过时留痕：`triggered` 由 Rust 折叠器给（越过触发线或 force）
  if (!payload.triggered) return null;
  const compacted = !!payload.compacted;

  const tokensBefore = Number(payload.tokensBefore) || 0;
  const tokensAfter = Number(payload.tokensAfter) || 0;
  // 节省量只在成功且有真实前后值时才有意义
  const savedTokens = compacted && tokensBefore > tokensAfter ? tokensBefore - tokensAfter : 0;
  const ms = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const scopeId = normalizeTelemetrySessionId(sessionId);

  return {
    sessionId: scopeId || undefined,
    trigger: force ? TRIGGER_FORCE : TRIGGER_AUTO,
    result: compacted ? RESULT_COMPACTED : RESULT_NOOP,
    reason: compacted ? undefined : skipReason(payload),
    detail: payload.foldError ? String(payload.foldError).slice(0, DETAIL_MAX_CHARS) : undefined,
    tokensBefore: tokensBefore || undefined,
    tokensAfter: tokensAfter || undefined,
    savedTokens: savedTokens || undefined,
    // 触发口径（usage / estimate）与折叠档位：调预算与触发比时就靠这几列复盘
    triggerSource: payload.triggerSource || undefined,
    level: Number(payload.level) || undefined,
    foldedToolResults: Number(payload.foldedToolResults) || undefined,
    foldedTexts: Number(payload.foldedTexts) || undefined,
    foldedImages: Number(payload.foldedImages) || undefined,
    ms
  };
}

function roundRate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

/**
 * 汇总最近 `limit` 次折叠尝试。
 *
 * 「压缩次数」= 触发的尝试数（本文件的窗口行数）；成功率 = 成功 / 次数。
 * 未触发不入窗口，所以不存在「成功率被空转轮次稀释」的问题。
 *
 * @param {string} userDataPath
 * @param {number} [limit]
 * @param {string} [sessionId]
 */
function summarizeCompactionTelemetry(userDataPath, limit = 200, sessionId = '') {
  const filePath = compactionTelemetryPath(userDataPath);
  const scopeId = normalizeTelemetrySessionId(sessionId);
  const empty = {
    windowRows: limit,
    attempted: 0,
    auto: 0,
    forced: 0,
    ok: 0,
    failed: 0,
    successRate: 0,
    savedTokensTotal: 0,
    savedTokensAvg: 0,
    elapsedMsAvg: 0,
    byReason: []
  };
  try {
    // 日志是批写的，读取前必须先刷缓冲，否则会统计到陈旧数据
    flushLog(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const all = raw.trim().split('\n');
    // 过滤必须发生在取窗口**之前**：先 slice 再筛的话，窗口会被其它会话的记录占满
    const needle = scopeId ? sessionNeedle(scopeId) : '';
    const scoped = needle ? all.filter((line) => line.includes(needle)) : all;
    const lines = scoped.slice(-limit);
    const reasonMap = new Map();
    let auto = 0;
    let forced = 0;
    let ok = 0;
    let failed = 0;
    let savedTokensTotal = 0;
    let savedRows = 0;
    let elapsedMsTotal = 0;

    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.trigger === TRIGGER_FORCE) forced += 1;
      else auto += 1;
      elapsedMsTotal += Number(row.ms) || 0;
      const succeeded = row.result === RESULT_COMPACTED;
      if (succeeded) {
        ok += 1;
        const saved = Number(row.savedTokens) || 0;
        if (saved > 0) {
          savedTokensTotal += saved;
          savedRows += 1;
        }
      } else {
        failed += 1;
        const reason = String(row.reason || 'no_foldable');
        reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
      }
    }

    const attempted = ok + failed;
    const byReason = [...reasonMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REASONS)
      .map(([reason, count]) => ({ reason, count }));

    return {
      windowRows: limit,
      attempted,
      auto,
      forced,
      ok,
      failed,
      successRate: roundRate(ok, attempted),
      savedTokensTotal,
      savedTokensAvg: savedRows ? Math.round(savedTokensTotal / savedRows) : 0,
      elapsedMsAvg: attempted ? Math.round(elapsedMsTotal / attempted) : 0,
      byReason
    };
  } catch {
    return empty;
  }
}

/**
 * 清空折叠遥测（统计信息页「清空」按钮的一路）。
 * 与工具遥测同源：走闸门截断而非删文件，保证缓冲里的行不会在清空后回灌。
 * @param {string} userDataPath
 */
function clearCompactionTelemetry(userDataPath) {
  if (!userDataPath) return false;
  return truncateLog(compactionTelemetryPath(userDataPath));
}

module.exports = {
  recordCompactionTelemetry,
  compactionTelemetryRow,
  summarizeCompactionTelemetry,
  clearCompactionTelemetry,
  compactionTelemetryPath
};
