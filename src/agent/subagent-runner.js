'use strict';

/**
 * 只读并发调研子 Agent 执行器。
 *
 * 为什么这样切：
 * 1. 子 Agent = 一次完整的内层 Agent 循环，工具集 = Explore 只读白名单。
 *    白名单（planner-tool-filters.js 的 EXPLORE_TOOL_NAMES）里没有 subagent，
 *    所以「子 Agent 不能再派子 Agent」是工具层面的物理约束，深度恒为 1，
 *    不依赖运行期判断、也不需要下游再写一遍守卫。
 * 2. 只读工具在 delegate-batch 走的是无限并发分支（Promise.all），
 *    因此并发上限必须在这里用信号量自限流 —— 不能指望调用方。
 * 3. 只把摘要回注主上下文；过程不进主上下文（否则 N 路调研会把上下文顶爆，
 *    这是这类功能最典型的失败模式）。planner 入口另有隔离 trace 折叠卡片。
 *
 * 本模块只负责「编排 + 护栏 + 摘要」，真正跑循环的 runChildLoop 由调用方注入，
 * 从而 Agent 入口与 planner 入口复用同一份护栏与提示词，不重复实现。
 */

const { getAgentLimits } = require('./agent-limits');
const { buildExploreTools } = require('./planner-tool-filters');
const { SUBAGENT_TOOL } = require('./tool-catalog');
const { isAbortError, createAbortError } = require('../llm-reconnect-retry');

/** 工具名常量：schema 单一来源在 tool-catalog.js */
const SUBAGENT_TOOL_NAME = SUBAGENT_TOOL.function.name;

const FALLBACK_LIMITS = {
  subagentMaxDepth: 1,
  subagentMaxConcurrent: 3,
  subagentMaxPerRun: 8,
  subagentMaxRounds: 16,
  subagentMaxToolCalls: 32,
  subagentSummaryMaxChars: 2400
};

/**
 * @param {string} [userDataPath]
 * @param {string} [contextTierId]
 * @returns {typeof FALLBACK_LIMITS}
 */
function resolveSubagentLimits(userDataPath, contextTierId) {
  // 只支持 Node 侧（按 userDataPath 读落盘配置）。没有 userDataPath 说明可能是
  // Renderer/测试环境，此时直接回退默认值，不去碰 browserCache。
  if (!userDataPath || typeof userDataPath !== 'string') return { ...FALLBACK_LIMITS };
  try {
    const merged = getAgentLimits(userDataPath, contextTierId) || {};
    /** @type {any} */
    const out = { ...FALLBACK_LIMITS };
    for (const key of Object.keys(FALLBACK_LIMITS)) {
      const n = Number(merged[key]);
      if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
    }
    // 深度允许为 0（完全禁用派发）
    const depth = Number(merged.subagentMaxDepth);
    if (Number.isFinite(depth) && depth >= 0) out.subagentMaxDepth = Math.floor(depth);
    return out;
  } catch {
    return { ...FALLBACK_LIMITS };
  }
}

/**
 * 子 Agent 的任务提示词。刻意强调「只读」「结论先行」「先证据后过程」「查不到就说查不到」，
 * 抑制子 Agent 编造与无效探索 —— 它的输出是主 Agent 的唯一依据。
 * @param {string} task
 * @param {unknown} hints
 */
function buildSubagentPrompt(task, hints) {
  const hintLines = (Array.isArray(hints) ? hints : [])
    .map((h) => String(h || '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((h) => `- ${h}`);
  return [
    '你是只读调研子 Agent。只做调研，不改工作区，不要尝试任何写操作或执行副作用命令。',
    '',
    `调研任务：${task}`,
    ...(hintLines.length ? ['', '已知线索/起点：', ...hintLines] : []),
    '',
    '要求：',
    '- 用最小够用的工具调用拿到事实；能一次带足 context 就别反复读同一处。',
    '- 结论先行，紧跟着列证据路径（形如 path:line），再按需补充细节。',
    '- 查不到就明确说「未找到」，并说明查过哪些范围；不要猜测、不要编造路径。',
    '- 不要输出与任务无关的探索过程，不要复述这个任务本身。'
  ].join('\n');
}

/**
 * 把内层循环结果压成回注主上下文的摘要。
 * @param {any} child 内层循环结果（含 content）
 * @param {number} maxChars
 */
function buildSummary(child, maxChars) {
  const raw = String((child && child.content) || '').trim();
  if (!raw) return { text: '（子 Agent 未产出结论）', truncated: false };
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return {
    text: `${raw.slice(0, maxChars)}\n…（摘要已截断，完整内容见对话中该子 Agent 的折叠卡片）`,
    truncated: true
  };
}

/**
 * @param {object} deps
 * @param {Array<object>} deps.allTools 当前运行可见的全部工具（用于 Explore 白名单过滤）
 * @param {(req: { model?: string, messages: object[], tools: object[], maxRounds: number, maxToolCalls: number, label: string, subagentId: string }, meta: object) => Promise<any>} deps.runChildLoop
 *   真正执行内层循环。Agent 入口传 runRustAgentLoop；planner 入口传 runToolLoopFromSpec。
 * @param {(kind: string) => string} [deps.newSubagentId]
 * @param {string} [deps.model]
 * @param {string} [deps.userDataPath]
 * @param {string} [deps.contextTierId]
 * @param {?{ aborted?: boolean }} [deps.signal] 父运行取消信号
 * @param {object} [deps.limits] 已解析护栏（默认按 userDataPath + contextTierId 读 agent-limits）
 * @param {(meta: object) => void} [deps.onSubagentStart]
 * @param {(meta: object, child: any) => void} [deps.onSubagentEnd]
 */
function createSubagentRunner(deps) {
  if (!deps || typeof deps.runChildLoop !== 'function') {
    throw new Error('createSubagentRunner: deps.runChildLoop 必填');
  }
  const runChildLoop = deps.runChildLoop;
  const allTools = Array.isArray(deps.allTools) ? deps.allTools : [];
  const signal = deps.signal || null;
  const limits = deps.limits || resolveSubagentLimits(deps.userDataPath, deps.contextTierId);
  const newSubagentId =
    typeof deps.newSubagentId === 'function'
      ? deps.newSubagentId
      : (kind) => `${kind}-${Date.now().toString(36)}`;

  // 子 Agent 的只读工具集：Explore 白名单，并显式剔除 subagent。
  // 白名单本身已不含 subagent，这里的 filter 是纵深防御 —— 万一有人把 subagent
  // 加进白名单，也不会让递归在这里被打开（同时 planner-tool-filters.js 有反向注释）。
  const childTools = buildExploreTools(allTools).filter(
    (t) => t && t.function && t.function.name !== SUBAGENT_TOOL_NAME
  );

  let issued = 0;
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  function acquire() {
    if (active < limits.subagentMaxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  }

  /**
   * 派一个只读研究子 Agent。
   * 永不抛业务错误（除非父运行被取消）：参数/预算/深度问题一律返回结构化错误对象，
   * 由模型自行调整策略，避免一个子 Agent 的参数问题打断整轮对话。
   * @param {any} rawArgs { task, label?, hints? }
   * @param {object} [ctx] 调用上下文（含 subagentDepth / signal）
   */
  async function run(rawArgs, ctx = {}) {
    const depth = Number((ctx && ctx.subagentDepth) || 0);
    if (depth >= limits.subagentMaxDepth) {
      return {
        error: '子 Agent 不能再派子 Agent（深度已达上限）',
        errorCode: 'SUBAGENT_DEPTH_EXCEEDED'
      };
    }

    const task = String((rawArgs && rawArgs.task) || '').trim();
    if (!task) {
      return { error: 'subagent 缺少 task：请给出这次调研要回答的单一问题', errorCode: 'SUBAGENT_TASK_REQUIRED' };
    }
    if (issued >= limits.subagentMaxPerRun) {
      return {
        error: `本次运行已派出 ${issued} 个子 Agent，达到上限（subagentMaxPerRun=${limits.subagentMaxPerRun}）`,
        errorCode: 'SUBAGENT_BUDGET_EXCEEDED'
      };
    }
    if (!childTools.length) {
      return { error: '当前运行没有可用的只读调研工具，请自己用现有工具完成', errorCode: 'SUBAGENT_NO_TOOLS' };
    }
    if ((ctx && ctx.signal && ctx.signal.aborted) || (signal && signal.aborted)) {
      throw createAbortError('subagent 已取消');
    }

    const index = issued + 1;
    issued += 1;
    const label = String((rawArgs && rawArgs.label) || '').trim() || `调研 ${index}`;
    const subagentId = newSubagentId(SUBAGENT_TOOL_NAME);
    const meta = { label, task, index, subagentId };

    await acquire();
    try {
      // 排队期间可能已被取消：拿到槽位后再检查一次，避免取消后仍发起请求。
      if ((ctx && ctx.signal && ctx.signal.aborted) || (signal && signal.aborted)) {
        throw createAbortError('subagent 已取消');
      }
      if (typeof deps.onSubagentStart === 'function') deps.onSubagentStart(meta);

      const child = await runChildLoop(
        {
          model: deps.model,
          messages: [{ role: 'user', content: buildSubagentPrompt(task, rawArgs && rawArgs.hints) }],
          tools: childTools,
          maxRounds: limits.subagentMaxRounds,
          maxToolCalls: limits.subagentMaxToolCalls,
          label,
          subagentId
        },
        meta
      );

      const summary = buildSummary(child, limits.subagentSummaryMaxChars);
      if (typeof deps.onSubagentEnd === 'function') deps.onSubagentEnd(meta, child);
      return {
        ok: true,
        label,
        subagentId,
        summary: summary.text,
        truncated: summary.truncated
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const message = err && err.message ? err.message : String(err);
      if (typeof deps.onSubagentEnd === 'function') deps.onSubagentEnd(meta, { content: '', error: message });
      return { error: `子 Agent「${label}」失败：${message}`, errorCode: 'SUBAGENT_FAILED' };
    } finally {
      release();
    }
  }

  return {
    run,
    toolName: SUBAGENT_TOOL_NAME,
    /** 子 Agent 实际可用的只读工具名（测试/诊断用） */
    childToolNames: () => childTools.map((t) => t && t.function && t.function.name).filter(Boolean),
    limits,
    stats: () => ({ issued, active, queued: waiters.length })
  };
}

module.exports = {
  createSubagentRunner,
  resolveSubagentLimits,
  buildSubagentPrompt,
  SUBAGENT_TOOL_NAME,
  FALLBACK_LIMITS
};
