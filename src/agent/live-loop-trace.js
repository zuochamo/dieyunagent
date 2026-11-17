'use strict';

/**
 * 内层循环（planner 执行器 / 主循环并发 subagent）「隔离 trace」装配的单一来源。
 *
 * Main 把 `runRustAgentLoop` 的 onPhase 事件与收尾 Rust trace 统一映射成 Renderer
 * 思考区可直接渲染的独立卡片条目（`isolated: true`）。planner（rust-planner-runner.js）
 * 与主循环 subagent（main/ipc/agent-runtime.js）共用这里，避免两份实现漂移。
 */
const { stripToolCallMarkup } = require('../llm-tool-call-fallback');

const LIVE_THOUGHT_CHARS = 2000;

/**
 * 内层循环实时 trace 的**最小推送间隔**（ms）。
 *
 * 内层循环每来一个 `llm_delta`（即每个 token）都会 sync 一次；若不合并，并发 N 路子 Agent
 * 会以「N × token」的频率把**整张卡片**（含各轮思考全文）反复过一遍 IPC。Main 侧
 * `webContents.send` 是同步 structured clone，会把主进程打满，Renderer 事件队列跟着积压 ——
 * 表现就是「只有一张卡片在动、整体卡死」。
 * 与 Renderer 的 `RUST_PROGRESS_MIN_INTERVAL_MS` 对齐：两端节流叠加后单卡片约 8 次/秒，够流畅。
 */
const LIVE_TRACE_MIN_INTERVAL_MS = 120;

/** 结构性事件：立即推送，不受节流影响（新轮 / 工具 pending→完成 / 收尾）。 */
const LIVE_TRACE_IMMEDIATE_PHASES = new Set([
  'start',
  'llm_request',
  'need_delegate',
  'delegate_start',
  'delegate_result'
]);

/** 卡片标题前缀：planner 执行器 / 主循环 subagent 共用同一套命名。 */
function loopTraceBaseLabel(meta) {
  const m = meta || {};
  if (m.phase) return String(m.phase);
  if (m.worker && m.taskId) return `执行器 ${m.worker} · ${m.taskId}`;
  if (m.worker) return `执行器 ${m.worker}`;
  if (m.label) return `子 Agent · ${m.label}`;
  return '执行器';
}

/**
 * 子 Agent 类型 → 中文标签（卡片标题用）。类型来源：planner 子任务的 agentType
 * （explore/shell/build），或派发来源（planner 勘察阶段 / 只读调研子 Agent）。
 */
const SUBAGENT_KIND_LABELS = {
  plan: '勘察',
  explore: '调研',
  shell: '命令',
  build: '写入',
  subagent: '调研'
};

function subagentKindLabel(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return SUBAGENT_KIND_LABELS[k] || '子 Agent';
}

/**
 * 子 Agent 卡片标题 = **类型 + 序号 + 干什么**（如「写入子 Agent #3 · 审查工具层改动」）。
 * 序号由 createSubagentNamer 在单次运行内单调分配，保证同一轮里唯一；
 * `label` 是派发方给这次派发起的短名（planner 用子任务 title，主循环 subagent 用模型传的
 * label）。**序号负责区分，label 负责可读** —— 只有序号时，用户看到一列「写入子 Agent #1/#2/#3」
 * 完全分不清谁在改什么，只能一个个点开。
 * 没有序号（非子 Agent 的隔离卡片、老调用点）时退回 loopTraceBaseLabel。
 */
function subagentCardTitle(meta) {
  const m = meta || {};
  const n = Number(m.subagentIndex) || 0;
  if (n <= 0) return loopTraceBaseLabel(m);
  const base = `${subagentKindLabel(m.subagentKind || m.worker)}子 Agent #${n}`;
  const label = String(m.label || '').trim();
  if (!label) return base;
  return `${base} · ${label}`;
}

/**
 * 运行内子 Agent 身份分配器（**唯一来源**）：一次调用同时给出 subagentId / 序号 / 类型。
 *
 * planner（研究子 Agent + 写入/命令执行器）与主循环并发 subagent 共用一份实例，
 * 于是「卡片标题的 #N」「trace 隔离桶的 key」「派发标签」天然同源且唯一。
 *
 * id 里带序号是刻意的：早期各调用点用 `Date.now()` 造 id，同一批并发派发落在同一毫秒
 * 就会撞成同一个 id，4 个子 Agent 会被 upsert 进同一个桶、合并成一张卡片（序号还会错乱）。
 */
function createSubagentNamer(prefix = 'sa') {
  let seq = 0;
  return {
    next(kind) {
      seq += 1;
      const k = String(kind || 'subagent').trim().toLowerCase() || 'subagent';
      return { subagentId: `${prefix}-${k}-${seq}`, subagentIndex: seq, subagentKind: k };
    },
    count: () => seq
  };
}

function mapPendingDelegateTool(d) {
  const args = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
  return {
    id: d.id || '',
    name: d.name || 'tool',
    argsBrief: JSON.stringify(args).slice(0, 120),
    toolArgs: args,
    summary: '',
    pending: true
  };
}

/**
 * 内层循环的流式 trace（按 subagentId 独立更新，支持并行执行器 / 并行 subagent）。
 */
function createLiveLoopTraceTracker(
  meta,
  { onUpdate, minIntervalMs = LIVE_TRACE_MIN_INTERVAL_MS } = {}
) {
  const subagentId = meta.subagentId || '';
  const rounds = [];
  /** 未落地的 `llm_delta`（同一帧只留最新一份，content 是累计全文）。 */
  const pendingDelta = [];
  let llmRound = 0;
  let liveContent = '';
  let flushTimer = null;
  let disposed = false;
  let lastEmitAt = 0;

  function getRound(roundNo) {
    const n = Math.max(1, Number(roundNo) || 1);
    let row = rounds.find((x) => x.round === n);
    if (!row) {
      row = { round: n, thought: '', fullThought: '', tools: [], placeholder: false };
      rounds.push(row);
      rounds.sort((a, b) => a.round - b.round);
    }
    return row;
  }

  /**
   * 把挂起的 `llm_delta` 落到卡片行上，**每帧只做一次**。
   *
   * `llm_delta` 的 content 是累计全文，逐 token 归一化就是 O(累计长度²) 的正则扫描；
   * 而真正被消费的只有「发帧那一刻的最新值」。所以这里推迟到发帧前统一归一化，
   * 结果与「每个 token 都归一化、只发最后一帧」逐字节一致。
   */
  function flushPendingDelta() {
    if (!pendingDelta.length) return;
    const batch = pendingDelta.splice(0, pendingDelta.length);
    for (const item of batch) {
      const contentOnly = stripToolCallMarkup(item.content);
      const thoughtSource = item.reasoning || (item.contentIsReasoning ? contentOnly || item.content : '');
      item.row.thought = thoughtSource.slice(0, LIVE_THOUGHT_CHARS) || '生成中…';
      item.row.fullThought = thoughtSource;
      item.row.placeholder = !thoughtSource;
      // 只有真正的正文才进回答区；单通道模型的 content 属于思考，不泄漏。
      liveContent = item.reasoning || !item.contentIsReasoning ? contentOnly.slice(0, 800) : '';
    }
  }

  function toUiEntries() {
    flushPendingDelta();
    return [buildIsolatedCard(meta, rounds, subagentId)];
  }

  function emitNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    lastEmitAt = Date.now();
    onUpdate(toUiEntries(), liveContent);
  }

  /**
   * 结构事件立即推；纯流式增量（llm_delta）按 minIntervalMs 合并。
   *
   * 内层循环每个 token 都会走到这里 —— 不合并就是「每 token 全量重推整张卡片」，
   * 并发多路子 Agent 时会把 Main 主进程（同步 structured clone）与 Renderer 事件队列一起打满。
   * 这是节流的**唯一收敛点**（planner 执行器与主循环 subagent 共用），不要在调用点另写一份。
   */
  function sync(immediate) {
    if (disposed) return;
    if (immediate || Date.now() - lastEmitAt >= minIntervalMs) {
      emitNow();
      return;
    }
    if (flushTimer) return; // 已有一帧在途：把最新内容合并进它，不再新开定时器
    flushTimer = setTimeout(() => {
      flushTimer = null;
      emitNow();
    }, Math.max(0, minIntervalMs - (Date.now() - lastEmitAt)));
  }

  function eventRoundNo(data) {
    if (data && data.round != null) return Number(data.round) + 1;
    return llmRound + 1;
  }

  function handlePhase(name, data) {
    // 结构事件立即推；纯流式增量（llm_delta）合并节流（见 LIVE_TRACE_MIN_INTERVAL_MS）。
    const immediate = LIVE_TRACE_IMMEDIATE_PHASES.has(name);
    // 结构事件会读上一次的 thought（如 need_delegate 清占位），先把未落地的增量落地。
    if (name !== 'llm_delta') flushPendingDelta();
    if (name === 'start') {
      const startRow = getRound(1);
      startRow.thought = '启动…';
      startRow.placeholder = true;
      sync(immediate);
      return;
    }
    if (name === 'llm_request') {
      llmRound = data && data.round != null ? Number(data.round) : llmRound;
      const row = getRound(eventRoundNo(data));
      row.thought =
        data && data.model ? `请求 LLM · ${String(data.model).trim()}…` : '请求 LLM…';
        row.placeholder = true;
      sync(immediate);
      return;
    }
    if (name === 'llm_delta') {
      llmRound = data && data.round != null ? Number(data.round) : llmRound;
      // 累计全文的归一化推迟到发帧时（见 flushPendingDelta）：同一帧内只保留最新一份。
      pendingDelta.length = 0;
      pendingDelta.push({
        row: getRound(eventRoundNo(data)),
        content: String((data && data.content) || ''),
        reasoning: String((data && data.reasoning) || ''),
        // content 的通道身份由入口盖章（llm-channel.classifyDelta），此处不再用 `a || b` 猜。
        contentIsReasoning: (data && data.contentChannel) === 'reasoning'
      });
      sync(immediate);
      return;
    }
    if (name === 'llm_response') {
      if (data && data.round != null) llmRound = Number(data.round) + 1;
      return;
    }
    if (name === 'need_delegate' || name === 'delegate_start') {
      const delegates = Array.isArray(data && data.delegates) ? data.delegates : [];
      if (!delegates.length) return;
      const row = getRound(llmRound || 1);
      for (const d of delegates) {
        if (d.id && row.tools.some((t) => t.id === d.id)) continue;
        row.tools.push(mapPendingDelegateTool(d));
      }
      // 不写「执行工具…」占位文本：卡片正文只显示真实模型输出，工具进度由工具行自己表达。
      // 顺手清掉上一轮的「请求 LLM…」，避免工具已经跑起来了还挂着过期的请求提示。
      if (!row.thought || row.placeholder) {
        row.thought = '';
        row.placeholder = false;
      }
      sync(immediate);
      return;
    }
    if (name === 'delegate_result') {
      const row = getRound(llmRound || 1);
      const tool = row.tools.find((t) => t.id === data.id) || row.tools.find((t) => t.pending && t.name === data.name);
      if (tool) {
        tool.pending = false;
        if (data.arguments && typeof data.arguments === 'object') {
          tool.toolArgs = { ...(tool.toolArgs || {}), ...data.arguments };
          tool.args = { ...(tool.args || {}), ...data.arguments };
        }
        // 只把「路径」这类渲染级信息并进参数；整包 result 不进卡片（见 CARD_TOOL_KEYS）。
        if (data.result && typeof data.result === 'object' && data.result.path && !tool.toolArgs?.filePath) {
          tool.toolArgs = { ...(tool.toolArgs || {}), filePath: data.result.path };
          tool.args = { ...(tool.args || {}), filePath: data.result.path };
        }
        const briefArgs = tool.toolArgs || tool.args || {};
        tool.argsBrief =
          briefArgs.filePath ||
          briefArgs.path ||
          JSON.stringify(briefArgs).slice(0, 120);
        tool.summary = data.error
          ? `错误: ${data.error}`
          : summarizeLoopTool({ name: data.name, result: data.result, error: data.error });
        if ((data.name === 'fs_write_file' || data.name === 'fs_edit') && data.result && data.result.diff) {
          tool.diff = compactLoopToolDiff(data.result.diff);
        }
      }
      sync(immediate);
    }
  }

  /**
   * 收尾前调用：把节流中未发的一帧补发出去（否则卡片会丢尾 ~120ms 的流式文本），
   * 之后不再接受 sync（子循环已结束）。
   */
  function dispose() {
    if (disposed) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
      onUpdate(toUiEntries(), liveContent);
    }
    disposed = true;
  }

  return { handlePhase, getSubagentId: () => subagentId, dispose };
}

function compactLoopToolDiff(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const out = {
    added: Number(diff.added) || 0,
    removed: Number(diff.removed) || 0,
    created: !!diff.created,
    textTruncated: !!diff.textTruncated
  };
  const cap = 12000;
  if (diff.beforeSnippet != null) {
    const s = String(diff.beforeSnippet);
    out.beforeSnippet = s.length > cap ? s.slice(0, cap) : s;
  }
  if (diff.afterSnippet != null) {
    const s = String(diff.afterSnippet);
    out.afterSnippet = s.length > cap ? s.slice(0, cap) : s;
  }
  if (!diff.textTruncated) {
    if (diff.beforeText != null) {
      const t = String(diff.beforeText);
      if (t.length <= 120000) out.beforeText = t;
    }
    if (diff.afterText != null) {
      const t = String(diff.afterText);
      if (t.length <= 120000) out.afterText = t;
    }
  }
  return out;
}

function summarizeLoopTool(t) {
  if (t.error) return `错误: ${t.error}`;
  if (t.name === 'host_exec') {
    return summarizeHostExecInline(t.result, t.error);
  }
  if (t.name === 'fs_write_file' || t.name === 'fs_edit') {
    const r = t.result;
    if (r && typeof r === 'object' && r.path) {
      const file = String(r.path).replace(/\\/g, '/').split('/').pop() || r.path;
      const diff = r.diff
        ? ` · +${Number(r.diff.added) || 0} -${Number(r.diff.removed) || 0}`
        : '';
      const n = Number(r.replacements);
      const repl = t.name === 'fs_edit' && Number.isFinite(n) && n > 0 ? ` · ${n} 处` : '';
      return `${file}${r.diff?.created ? ' · 新建' : t.name === 'fs_edit' ? ' · 已替换' : ' · 已写入'}${diff}${repl}`;
    }
  }
  const r = t.result;
  if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout.trim().slice(0, 240);
    if (typeof r.stderr === 'string' && r.stderr.trim()) return r.stderr.trim().slice(0, 240);
    if (typeof r.message === 'string' && r.message.trim()) return r.message.trim().slice(0, 240);
    if (typeof r.content === 'string' && r.content.trim()) return r.content.trim().slice(0, 240);
  }
  return '完成';
}

function summarizeHostExecInline(result, error) {
  if (error) return `错误: ${error}`;
  if (!result || typeof result !== 'object') return '完成';
  if (result.timedOut && result.stillRunning) {
    return `转后台继续运行（${result.handle || (result.pid ? `pid ${result.pid}` : '无句柄')}）`;
  }
  const exit = result.code != null ? result.code : result.exitCode;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr && exit != null && exit !== 0) {
    return `exit ${exit} · ${stderr.slice(0, 80)}`;
  }
  const out = String(result.stdout ?? result.output ?? '').trim();
  if (out) {
    if ((/^\/\*|^#|^<!DOCTYPE|^<html[\s>]/i.test(out) || out.includes('{')) && out.length > 80) {
      return `exit ${exit ?? 0} · 输出 ${out.length} 字`;
    }
    if (/^(True|False|OK|null|None)$/i.test(out)) return `exit ${exit ?? 0} · ${out}`;
    return out.length > 100 ? `${out.slice(0, 100)}…` : out;
  }
  if (stderr) return stderr.slice(0, 100);
  return exit != null ? (exit === 0 ? 'exit 0' : `exit ${exit}`) : '完成';
}

function mapLoopToolToUi(t) {
  const args =
    (t.toolArgs && typeof t.toolArgs === 'object' && Object.keys(t.toolArgs).length
      ? t.toolArgs
      : null) ||
    (t.args && typeof t.args === 'object' ? t.args : {});
  const normalized = { ...(args || {}) };
  if (!normalized.filePath && normalized.path) normalized.filePath = normalized.path;
  if (!normalized.filePath && normalized.file) normalized.filePath = normalized.file;
  if (!normalized.filePath && t.result && typeof t.result === 'object' && t.result.path) {
    normalized.filePath = String(t.result.path);
  }
  const out = {
    name: t.name || 'tool',
    argsBrief:
      normalized.filePath ||
      normalized.path ||
      JSON.stringify(normalized).slice(0, 120),
    summary: summarizeLoopTool(t),
    pending: !!t.pending,
    failed: !!t.failed,
    toolArgs: normalized,
    args: t.args && typeof t.args === 'object' ? t.args : normalized
  };
  if (t.diff) out.diff = t.diff;
  if (t.result) out.result = t.result;
  if (t.error) out.error = t.error;
  return out;
}

function mergeTraceTools(liveTools, rustTools) {
  const out = [];
  const n = Math.max(liveTools.length, rustTools.length);
  for (let i = 0; i < n; i += 1) {
    const live = liveTools[i];
    const rust = rustTools[i];
    if (!live) {
      out.push(rust);
      continue;
    }
    if (!rust) {
      out.push(live);
      continue;
    }
    const mergedArgs = {
      ...(rust.args && typeof rust.args === 'object' ? rust.args : {}),
      ...(rust.toolArgs && typeof rust.toolArgs === 'object' ? rust.toolArgs : {}),
      ...(live.args && typeof live.args === 'object' ? live.args : {}),
      ...(live.toolArgs && typeof live.toolArgs === 'object' ? live.toolArgs : {})
    };
    if (!mergedArgs.filePath && mergedArgs.path) mergedArgs.filePath = mergedArgs.path;
    const mergedResult = live.result || rust.result || null;
    if (!mergedArgs.filePath && mergedResult && mergedResult.path) {
      mergedArgs.filePath = String(mergedResult.path);
    }
    out.push({
      ...rust,
      ...live,
      toolArgs: mergedArgs,
      args: live.args || rust.args || mergedArgs,
      result: mergedResult,
      diff: live.diff || rust.diff,
      summary: live.summary || rust.summary,
      argsBrief:
        (live.argsBrief && live.argsBrief !== '{}' && live.argsBrief) ||
        (rust.argsBrief && rust.argsBrief !== '{}' && rust.argsBrief) ||
        mergedArgs.filePath ||
        JSON.stringify(mergedArgs).slice(0, 120),
      // 实时 + 收尾合并：收尾侧才是完成状态的权威来源，
      // 若用 OR 合并，已结束的卡片会因实时侧残留 pending 而一直显示未完成。
      pending: rust ? !!rust.pending : !!live.pending,
      failed: !!(live.failed || rust.failed)
    });
  }
  return out;
}

/**
 * 卡片工具条目只保留 Renderer 渲染需要的字段（对齐 Renderer 的 `appendThinkingToolRows`
 * / `appendInlineToolDiff` / 结构签名：只用 name / argsBrief / toolArgs / pending / failed /
 * summary / diff）。
 *
 * **整包 `result` 不进卡片**：fs_read_file 正文、host_exec 输出可达几十 KB，结果信息在
 * `delegate_result` 时已落进 `summary`（摘要）与 `diff`（compact 后）。若让原包随卡片增量
 * 反复过 IPC，并发多路子 Agent 时会把 Main 主进程的同步 structured clone 打满。
 */
const CARD_TOOL_KEYS = [
  'id',
  'name',
  'argsBrief',
  'toolArgs',
  'args',
  'pending',
  'failed',
  'summary',
  'diff',
  'error'
];

function toCardTool(tool) {
  const t = tool || {};
  const out = {};
  for (const key of CARD_TOOL_KEYS) {
    if (t[key] !== undefined) out[key] = t[key];
  }
  return out;
}

/**
 * 子 Agent 卡片：**一个子 Agent = 一个 trace 条目**。
 *
 * 该子 Agent 的全部轮次（思考 + 工具）都装进 `rounds`，Renderer 只渲染一张直角卡片、
 * 内容全部落在卡片内部，并随 `rounds` 变化实时更新（而非每轮各开一张小卡、工具甩到卡片外）。
 */
function buildIsolatedCard(meta, rounds, subagentId) {
  const m = meta || {};
  const list = (Array.isArray(rounds) ? rounds : []).map((r, i) => ({
    round: r && r.round != null ? r.round : i + 1,
    thought: String((r && (r.thought || r.fullThought)) || ''),
    fullThought: String((r && (r.fullThought || r.thought)) || ''),
    placeholder: !!(r && r.placeholder),
    tools: Array.isArray(r && r.tools) ? r.tools.map(toCardTool) : []
  }));
  const latest = list.length ? list[list.length - 1] : null;
  return {
    // 条目级 round 取最新轮，仅用于兼容既有字段；真正的分轮在 rounds 内
    round: latest ? latest.round : 1,
    // 标题 = 子 Agent 类型 + 序号（Renderer 折叠摘要直接展示）
    phase: subagentCardTitle(m),
    thought: latest ? latest.thought : '',
    fullThought: latest ? latest.fullThought : '',
    placeholder: !!(latest && latest.placeholder),
    subagentId: subagentId || m.subagentId || '',
    isolated: true,
    worker: m.worker || '',
    // 类型 / 序号随卡片走，收尾合并后仍能拼出同一个标题
    subagentKind: String(m.subagentKind || m.worker || ''),
    subagentIndex: Number(m.subagentIndex) || 0,
    parallel: !!m.parallel,
    rounds: list
  };
}

/**
 * 合并「实时 tracker 卡片」与「收尾 Rust trace 卡片」：按轮对齐、逐轮合并工具，
 * 保留实时思考文本。保证运行中与结束后的卡片是同一个条目（不闪、不丢内容）。
 */
function mergeIsolatedCards(liveCard, rustCard) {
  const live = liveCard || {};
  const rust = rustCard || {};
  const liveRounds = Array.isArray(live.rounds) ? live.rounds : [];
  const rustRounds = Array.isArray(rust.rounds) ? rust.rounds : [];
  const n = Math.max(liveRounds.length, rustRounds.length);
  const rounds = [];
  for (let i = 0; i < n; i += 1) {
    const l = liveRounds[i];
    const r = rustRounds[i];
    const ref = r || l;
    if (!ref) continue;
    rounds.push({
      round: ref.round != null ? ref.round : i + 1,
      thought: (l && l.thought) || (r && r.thought) || '',
      fullThought: (l && l.fullThought) || (r && r.fullThought) || '',
      tools: mergeTraceTools((l && l.tools) || [], (r && r.tools) || [])
    });
  }
  return buildIsolatedCard({ ...rust, ...live }, rounds, live.subagentId || rust.subagentId);
}

function mapLoopTraceToUi(trace, meta = {}) {
  const rounds = (trace || []).map((r) => ({
    round: r.round,
    thought: String(r.thought || '').trim(),
    fullThought: String(r.fullThought || r.thought || '').trim(),
    tools: Array.isArray(r.tools) ? r.tools.map(mapLoopToolToUi) : []
  }));
  return [buildIsolatedCard(meta, rounds, meta.subagentId || '')];
}

module.exports = {
  LIVE_THOUGHT_CHARS,
  LIVE_TRACE_MIN_INTERVAL_MS,
  subagentCardTitle,
  createSubagentNamer,
  createLiveLoopTraceTracker,
  mapLoopToolToUi,
  buildIsolatedCard,
  mergeIsolatedCards,
  mapLoopTraceToUi
};
