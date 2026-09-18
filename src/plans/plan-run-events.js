'use strict';
// @ts-check

/**
 * 定时计划运行的 Main 侧运行态归约。
 *
 * 计划由调度器在 Main 内直接驱动 Rust agent loop，Renderer 并没有发起这次运行，
 * 因此拿不到 `agent:rust-loop-phase`。这里把同一个 loop 的 phase 归约成
 * 「Rust 风格 trace 行 + 流式正文」，再由 bootPlansRuntime 以 AgentRunEvent
 * 经 `plans:phase` 推给 Renderer —— 让计划运行复用聊天的 sessionActiveRuns /
 * live bubble 渲染链，而不是另起一套「后台任务」UI。
 *
 * 只产出事实（thought / tools{name,args,result,error,pending} / streamContent）；
 * summary、argsBrief 等展示文案由 Renderer 统一生成，避免两处措辞漂移。
 *
 * 与 `agent/rust-planner-runner.js#createLiveLoopTraceTracker` 同属「Main 产出 trace」
 * 模式，但计划是单条循环、没有 subagent，故不复用 planner 专用的
 * isolated / worker / parallel 字段，避免子 Agent 样式串进普通会话气泡。
 */

const { stripToolCallMarkup } = require('../llm-tool-call-fallback');

/** 与 planner tracker 的 LIVE_THOUGHT_CHARS 对齐 */
const LIVE_THOUGHT_CHARS = 2000;

/**
 * tool 结果只在 Renderer 用来生成一行 summary，整包结果（可能几十 KB）不该随
 * 每条 trace 增量反复过 IPC：这里只保留 summary 会用到的字段。
 */
const RESULT_KEYS = [
  'ok',
  'error',
  'errorCode',
  'suggestedFix',
  'path',
  'diff',
  'replacements',
  'rowCount',
  'truncated',
  'code',
  'exitCode',
  'stdout',
  'stderr',
  'message',
  'content'
];
const RESULT_STRING_CAP = 1200;

function compactToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const key of RESULT_KEYS) {
    const v = result[key];
    if (v === undefined) continue;
    out[key] = typeof v === 'string' && v.length > RESULT_STRING_CAP ? v.slice(0, RESULT_STRING_CAP) : v;
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.phaseLabel] 轮次标签前缀
 * @param {(payload: { trace: object[], streamContent: string }) => void} [opts.onUpdate]
 */
function createPlanRunTrace(opts = {}) {
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
  const baseLabel = String(opts.phaseLabel || '执行计划').trim() || '执行计划';
  /** @type {object[]} */
  const rounds = [];
  let llmRound = 0;
  let streamContent = '';

  function roundPhase(index, roundNo) {
    if (index <= 0) return baseLabel;
    return `${baseLabel} · 第 ${roundNo || index + 1} 轮`;
  }

  function getRound(roundNo) {
    const n = Math.max(1, Number(roundNo) || 1);
    let row = rounds.find((x) => x.round === n);
    if (!row) {
      row = { round: n, thought: '', fullThought: '', tools: [] };
      rounds.push(row);
      rounds.sort((a, b) => a.round - b.round);
    }
    return row;
  }

  function snapshot() {
    return rounds.map((r, i) => ({
      round: r.round,
      phase: roundPhase(i, r.round),
      thought: r.thought,
      fullThought: r.fullThought || r.thought,
      visibleContent: r.visibleContent || '',
      tools: r.tools.map((t) => ({ ...t, args: t.args ? { ...t.args } : {} }))
    }));
  }

  function sync() {
    onUpdate({ trace: snapshot(), streamContent });
  }

  /** phase 里的 round 是 0 基（Rust 侧），trace 行从 1 开始 */
  function eventRoundNo(data) {
    if (data && data.round != null) return Number(data.round) + 1;
    return llmRound + 1;
  }

  function mapPendingTool(d) {
    const args = d && d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
    return {
      id: (d && d.id) || '',
      name: (d && d.name) || 'tool',
      args,
      toolArgs: args,
      pending: true
    };
  }

  function attachDelegates(delegates) {
    if (!Array.isArray(delegates) || !delegates.length) return false;
    const row = getRound(llmRound || 1);
    for (const d of delegates) {
      if (d && d.id && row.tools.some((t) => t.id === d.id)) continue;
      row.tools.push(mapPendingTool(d));
    }
    if (!row.thought || String(row.thought).startsWith('请求 LLM')) row.thought = '执行工具…';
    return true;
  }

  function settleDelegate(data) {
    const row = getRound(llmRound || 1);
    const tool =
      row.tools.find((t) => t.id && t.id === data.id) ||
      row.tools.find((t) => t.pending && t.name === data.name);
    if (!tool) return false;
    tool.pending = false;
    if (data.arguments && typeof data.arguments === 'object') {
      tool.args = { ...(tool.args || {}), ...data.arguments };
      tool.toolArgs = tool.args;
    }
    if (data.result !== undefined) tool.result = compactToolResult(data.result);
    if (data.error) tool.error = String(data.error);
    const r = data.result;
    if (r && typeof r === 'object' && r.path && !(tool.args && tool.args.filePath)) {
      tool.args = { ...(tool.args || {}), filePath: r.path };
      tool.toolArgs = tool.args;
    }
    return true;
  }

  /**
   * @param {string} name Rust agent loop phase 名
   * @param {object} [data]
   */
  function handlePhase(name, data) {
    const d = data && typeof data === 'object' ? data : {};
    if (name === 'start') {
      getRound(1).thought = '启动…';
      sync();
      return;
    }
    if (name === 'llm_request') {
      llmRound = d.round != null ? Number(d.round) : llmRound;
      const row = getRound(eventRoundNo(d));
      row.thought = d.model ? `请求 LLM · ${String(d.model).trim()}…` : '请求 LLM…';
      sync();
      return;
    }
    if (name === 'llm_delta') {
      llmRound = d.round != null ? Number(d.round) : llmRound;
      const reasoning = String(d.reasoning || '');
      const contentOnly = stripToolCallMarkup(String(d.content || ''));
      const row = getRound(eventRoundNo(d));
      if (reasoning) {
        row.thought = reasoning.slice(0, LIVE_THOUGHT_CHARS);
        row.fullThought = reasoning.slice(0, LIVE_THOUGHT_CHARS);
        if (d.hasToolCalls) row.visibleContent = contentOnly;
        else if (contentOnly) streamContent = contentOnly;
      } else if (contentOnly) {
        // 单通道模型：流式 content 是推理，不应泄漏进回答区
        row.thought = contentOnly.slice(0, LIVE_THOUGHT_CHARS);
        row.fullThought = contentOnly.slice(0, LIVE_THOUGHT_CHARS);
        streamContent = '';
      } else {
        row.thought = row.thought || '生成中…';
      }
      sync();
      return;
    }
    if (name === 'llm_response') {
      if (d.round != null) llmRound = Number(d.round) + 1;
      if (Array.isArray(d.toolCalls) ? d.toolCalls.length : Number(d.toolCalls) > 0) {
        streamContent = '';
      }
      sync();
      return;
    }
    if (name === 'need_delegate' || name === 'delegate_start') {
      if (attachDelegates(d.delegates)) sync();
      return;
    }
    if (name === 'delegate_result') {
      if (settleDelegate(d)) sync();
      return;
    }
    if (name === 'llm_reconnect_wait') {
      const sec = Math.max(1, Math.round((Number(d.waitMs) || 0) / 1000));
      const row = getRound(llmRound || 1);
      row.thought = `连接中断，${sec}s 后自动重试…`;
      sync();
      return;
    }
    if (name === 'compacted') {
      sync();
    }
  }

  return {
    handlePhase,
    snapshot,
    getStreamContent: () => streamContent
  };
}

module.exports = { createPlanRunTrace, LIVE_THOUGHT_CHARS };
