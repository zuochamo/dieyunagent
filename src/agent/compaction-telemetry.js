'use strict';

const fs = require('fs');
const path = require('path');
const { getRotatingLog, flushLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

/**
 * 上下文压缩遥测（统计信息页「上下文压缩」板块的唯一数据来源）。
 *
 * 为什么单独一条流而不并进 `tool-telemetry.jsonl`：
 * 那个文件的每一行都是一次「工具调用」，`summarizeTelemetry` 的聚合口径
 * （total / successRate / byTool / REPEAT_BLOCK）全部建立在 `row.tool` 上。
 * 把压缩行混进去会让工具成功率的分母被污染，再靠 `kind` 字段在读取侧过滤
 * —— 那就是「同一份数据两套口径」，不如各自一条流、各自一个汇总函数干净。
 *
 * 记录时机（**唯一入口** `compaction-main.js: maybeCompactMessages`）：
 * 只在「真正发起过摘要 LLM 的一次压缩尝试」时写一行。未触发（未达触发线 /
 * 仍在冷却 / 可折叠原子不足）与「未配置 LLM」的早退在每轮 LLM 前都会发生，
 * 记下来只会让文件按轮次膨胀，且不构成一次压缩。分类口径见
 * `compactionTelemetryRow()`，它是该判定的唯一实现。
 */

const COMPACTION_TELEMETRY_FILE = 'compaction-telemetry.jsonl';

/** 触发来源：auto = 按 token 预算/配额自动触发；force = 手动「立即压缩」或溢出兜底 */
const TRIGGER_AUTO = 'auto';
const TRIGGER_FORCE = 'force';

/** 结果：compacted = 摘要成功并改写 messages；failed = 发起过但没压成 */
const RESULT_COMPACTED = 'compacted';
const RESULT_FAILED = 'failed';

/** 失败明细（llmError）入库前的截断长度：够定位病因，又不至于把堆栈灌满日志。 */
const DETAIL_MAX_CHARS = 200;

/**
 * 失败原因码前缀。Rust `compaction/mod.rs` 把 `CoreError` 拼成 `{code}: {message}`，
 * 其中 code 回答「谁的锅」（`LLM_UPSTREAM_TIMEOUT` = 代理往上游写超时、
 * `LLM_REASONING_ONLY` = 模型只输出思考…）。这里只做**提取**，绝不重新判定 ——
 * 分类口径的唯一来源在 `crates/dieyun-core/src/compaction/llm.rs`，
 * 在 Node 侧再判一次就等于两份口径，早晚会漂移。
 */
const REASON_CODE_RE = /^([A-Z][A-Z0-9_]{2,40})\s*:/;

/**
 * 失败原因：优先用 Rust 给的分类码，取不到才回落到 `compactionSkipped`
 * （`content_policy` 这类由 Node 侧判定、不经过 LLM 调用的跳过原因）。
 * @param {string} skipped
 * @param {string} llmError
 */
function failureReason(skipped, llmError) {
  const matched = REASON_CODE_RE.exec(llmError);
  return matched ? matched[1] : skipped || 'llm_error';
}

/** 汇总窗口内返回的失败原因种类上限 */
const MAX_REASONS = 8;

function compactionTelemetryPath(userDataPath) {
  return path.join(userDataPath || '', COMPACTION_TELEMETRY_FILE);
}

/**
 * 每次压缩尝试记一行；`row` 为假值时静默跳过（调用点无需自判是否该记）。
 * 走统一落盘闸门批写，压缩虽低频，但这里图的是「轮转上限 + 退出前 flush」这两条
 * 与 tool-telemetry 同源的保证，而不是为了省 syscall。
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
 * 一次压缩结果 → 遥测行；返回 `null` 表示「本轮没有发生压缩」，不记。
 *
 * 判据只有一条：**是否发起过摘要 LLM**。Rust `maybe_compact` 的四类返回里，
 * 成功（`compacted`）与失败（`compactionSkipped` / `llmError`）都发起过；
 * 未达触发线 / 冷却中 / 可折叠原子不足只走 `prepare` 早退，没调 LLM。
 * 未配置 baseUrl 的早退同样不是压缩，一并排除。
 *
 * @param {{ payload: object|null, force?: boolean, model?: string, startedAt?: number }} input
 * @returns {object|null}
 */
function compactionTelemetryRow(input = {}) {
  const { payload, force, model, startedAt } = input;
  if (!payload || typeof payload !== 'object') return null;
  const compacted = !!payload.compacted;
  const skipped = String(payload.compactionSkipped || '');
  const llmError = String(payload.llmError || '');
  if (!compacted && !skipped && !llmError) return null;

  const tokensBefore = Number(payload.tokensBefore) || 0;
  const tokensAfter = Number(payload.tokensAfter) || 0;
  // 节省量只在成功且有真实前后值时才有意义：失败返回的 tokensAfter 是 prepare 的预估，
  // 拿它算「节省」会造出「失败却省了 token」这种假象。
  const savedTokens = compacted && tokensBefore > tokensAfter ? tokensBefore - tokensAfter : 0;
  const ms = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;

  return {
    trigger: force ? TRIGGER_FORCE : TRIGGER_AUTO,
    result: compacted ? RESULT_COMPACTED : RESULT_FAILED,
    reason: compacted ? undefined : failureReason(skipped, llmError),
    detail: compacted || !llmError ? undefined : llmError.slice(0, DETAIL_MAX_CHARS),
    tokensBefore: tokensBefore || undefined,
    tokensAfter: tokensAfter || undefined,
    savedTokens: savedTokens || undefined,
    ms,
    model: model || undefined
  };
}

function roundRate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

/**
 * 汇总最近 `limit` 次压缩尝试。
 *
 * 「压缩次数」= 触发的尝试数（本文件的窗口行数）；成功率 = 成功 / 次数。
 * 未触发不入窗口，所以不存在「成功率被空转轮次稀释」的问题。
 * @param {string} userDataPath
 * @param {number} [limit]
 */
function summarizeCompactionTelemetry(userDataPath, limit = 200) {
  const filePath = compactionTelemetryPath(userDataPath);
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
    const lines = raw.trim().split('\n').slice(-limit);
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
        const reason = String(row.reason || 'llm_error');
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

module.exports = {
  recordCompactionTelemetry,
  compactionTelemetryRow,
  summarizeCompactionTelemetry,
  compactionTelemetryPath,
  TRIGGER_AUTO,
  TRIGGER_FORCE,
  RESULT_COMPACTED,
  RESULT_FAILED
};
