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

const { getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { buildTraceFactsDigest } = require('./agent-synthesis');
const { buildExploreTools } = require('./planner-tool-filters');
const { SUBAGENT_TOOL } = require('./tool-catalog');
const { createSubagentNamer } = require('./live-loop-trace');
const { isAbortError, createAbortError } = require('../llm-reconnect-retry');

/** 工具名常量：schema 单一来源在 tool-catalog.js */
const SUBAGENT_TOOL_NAME = SUBAGENT_TOOL.function.name;

/** 子 Agent 护栏键：与 agent-limits 的 schema 分组一一对应（此处只声明「哪些键属于本 runner」）。 */
const SUBAGENT_LIMIT_KEYS = [
  'subagentMaxDepth',
  'subagentMaxConcurrent',
  'subagentMaxPerRun',
  'subagentMaxRounds',
  'subagentMaxToolCalls',
  'subagentSummaryMaxChars',
  'subagentFollowupRetention'
];

/**
 * 无 userDataPath（Renderer / 测试）时的兜底护栏。
 * 不另写一份字面量：直接投影 agent-limits.js 的默认值 —— 护栏数字的唯一来源在那里，
 * 否则「放宽轮次」只会改到一半（有 userDataPath 的走新值，没有的仍走旧值）。
 */
const FALLBACK_LIMITS = Object.freeze(
  Object.fromEntries(SUBAGENT_LIMIT_KEYS.map((key) => [key, AGENT_LIMITS_DEFAULTS[key]]))
);

/**
 * 回注摘要的文案口径（单一来源，勿在调用方再拼）。
 * reason 字段把这几种情况结构化回给协调者：ok / limit / empty。
 *
 * 文案只承诺**工具事实**（不再说「发现」——那会把子 Agent 的推理过程暗示成结论）。
 */
const SUMMARY_HEAD_TRUNCATED_WITH_CONTENT =
  '（子 Agent 达到轮次/工具预算被截断，以下内容可能不完整）';
const SUMMARY_HEAD_TRUNCATED_WITH_TRACE =
  '（子 Agent 达到轮次/工具预算被截断，未给出正式结论；以下是它已完成的工具调用记录）';
const SUMMARY_HEAD_NO_CONCLUSION_WITH_TRACE =
  '（子 Agent 未给出结论；以下是它已完成的工具调用记录）';
const SUMMARY_TRUNCATED_NO_EVIDENCE =
  '（子 Agent 达到轮次/工具预算被截断，且未留下任何工具调用记录；建议缩小问题范围，或提高 subagentMaxRounds/subagentMaxToolCalls 后重派）';
const SUMMARY_NO_CONCLUSION = '（子 Agent 未产出结论，也没有留下任何工具调用记录）';
const SUMMARY_CUT_SUFFIX = '\n…（摘要已截断，完整内容见对话中该子 Agent 的折叠卡片）';

/**
 * @param {string} [userDataPath]
 * @param {string} [contextTierId]
 * @returns {typeof FALLBACK_LIMITS}
 */
function resolveSubagentLimits(userDataPath, contextTierId) {
  // 只支持 Node 侧（按 userDataPath 读落盘配置）。没有 userDataPath 说明可能是
  // Renderer/测试环境，此时直接用工厂默认值，不去读磁盘。
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

/** 追问轮的 user 提示词：明确「同一调研的延续」，避免子 Agent 把上文当无关历史折叠掉。 */
function buildFollowupPrompt(priorTask, task, hints) {
  const hintLines = (Array.isArray(hints) ? hints : [])
    .map((h) => String(h || '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((h) => `- ${h}`);
  return [
    `这是对同一调研的追问（原任务：${priorTask}）。上文里你已查明的事实直接复用，不要重查。`,
    '',
    `追问：${task}`,
    ...(hintLines.length ? ['', '补充线索：', ...hintLines] : [])
  ].join('\n');
}

/**
 * 把内层循环结果压成回注主上下文的摘要。
 *
 * **跨边界文本契约**（`docs/REASONING-ISOLATION-PLAN.md` §3.7）：回注只允许「正文 ∪ 工具事实」。
 * - 允许：`child.content`（子 Agent 正文 —— 它就是结论本身）；`trace[].tools[]` 的
 *   name / argsBrief / summary / error（工具层已归纳的事实）；结构信号（hitRoundLimit / reason）。
 * - 禁止：`trace[].thought` / `fullThought` —— 那是子 Agent 的**私有推理**（含过程猜测与
 *   对任务的元评论），回注进主上下文会被当成事实使用，且跨 Agent 污染比同轮污染更难排查。
 *
 * 为什么不能只看 `content`：子 Agent 的内层循环会因预算耗尽（maxRounds / maxToolCalls）
 * 而非正常收尾，此时最后一轮常常只发了 tool_calls、没有正文 —— 若只读 content，就会把
 * 已经完成的**工具调用事实**全部丢掉，只回一句「未产出结论」。协调者拿到这种摘要无法决策，
 * 只能把同一块工作重做一遍，子 Agent 白跑。因此这里把「结束原因」与「工具事实」一起回注：
 * - 有正文：交付正文；命中预算时显式标注「可能不完整」，避免协调者把半份结论当完整结论。
 * - 无正文但有工具事实：列出工具调用记录，并区分「被预算截断」与「模型没给结论」。
 * - 都没有：如实说明，并给出可执行建议。
 *
 * 有意接受的代价：子 Agent 若把结论只留在思考里（没写进正文），协调者只能拿到工具事实 ——
 * 这由 `buildSubagentPrompt()` 的「结论先行 / 查不到就说查不到」负责，而不是靠回注思考兜底。
 *
 * @param {any} child 内层循环结果（content / hitRoundLimit / trace）
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean, reason: 'ok'|'limit'|'empty' }}
 */
function buildSummary(child, maxChars) {
  const cap =
    Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : FALLBACK_LIMITS.subagentSummaryMaxChars;
  const raw = String((child && child.content) || '').trim();
  const hitLimit = !!(child && (child.hitRoundLimit || child.hit_round_limit));
  // reason 是回注给协调者的结构化信号：limit = 预算截断（可缩小问题重派），
  // empty = 模型确实没给结论（换问法），ok = 正常。
  const reason = raw ? (hitLimit ? 'limit' : 'ok') : hitLimit ? 'limit' : 'empty';

  let text;
  if (raw) {
    text = hitLimit ? `${SUMMARY_HEAD_TRUNCATED_WITH_CONTENT}\n${raw}` : raw;
  } else {
    const facts = buildTraceFactsDigest(child && child.trace);
    if (facts) {
      text = `${hitLimit ? SUMMARY_HEAD_TRUNCATED_WITH_TRACE : SUMMARY_HEAD_NO_CONCLUSION_WITH_TRACE}\n${facts}`;
    } else {
      text = hitLimit ? SUMMARY_TRUNCATED_NO_EVIDENCE : SUMMARY_NO_CONCLUSION;
    }
  }

  if (text.length > cap) {
    return { text: `${text.slice(0, cap)}${SUMMARY_CUT_SUFFIX}`, truncated: true, reason };
  }
  return { text, truncated: false, reason };
}

/**
 * @param {object} deps
 * @param {Array<object>} deps.allTools 当前运行可见的全部工具（用于 Explore 白名单过滤）
 * @param {(req: { model?: string, messages: object[], tools: object[], maxRounds: number, maxToolCalls: number, label: string, subagentId: string }, meta: object) => Promise<any>} deps.runChildLoop
 *   真正执行内层循环。Agent 入口传 runRustAgentLoop；planner 入口传 runToolLoopFromSpec。
 * @param {string} [deps.model]
 * @param {string} [deps.userDataPath]
 * @param {string} [deps.contextTierId]
 * @param {?{ aborted?: boolean }} [deps.signal] 父运行取消信号
 * @param {object} [deps.limits] 已解析护栏（默认按 userDataPath + contextTierId 读 agent-limits）
 * @param {ReturnType<import('./live-loop-trace').createSubagentNamer>} [deps.namer]
 *   子 Agent 身份分配器（id / 序号 / 类型）。planner 把「研究子 Agent + 写入/命令执行器」
 *   放进同一份实例，使同一轮里所有子 Agent 卡片唯一；缺省时本 runner 自持一份。
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
  const namer = deps.namer && typeof deps.namer.next === 'function' ? deps.namer : createSubagentNamer();

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

  /**
   * 追问留存：subagentId → { messages, task }。
   * 只在本 runner（= 同一次父运行）生命周期内保留，不落盘；LRU 按 retention 上限淘汰。
   * 追问 = 在原 messages 后追加新 user 轮，复用同一份只读工具集与预算，深度不变。
   */
  const followups = new Map();
  function rememberFollowup(subagentId, task, messages) {
    if (!(limits.subagentFollowupRetention > 0)) return;
    if (!Array.isArray(messages) || !messages.length) return;
    if (followups.has(subagentId)) followups.delete(subagentId);
    followups.set(subagentId, { task, messages });
    while (followups.size > limits.subagentFollowupRetention) {
      followups.delete(followups.keys().next().value);
    }
  }

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

    // id / 序号 / 类型一次性从共享 namer 取（planner 与本 runner 可能共用一份）：
    // 并发派发也不会撞 id，且「调研 1」这类回注标签与卡片标题「调研子 Agent #1」始终同号。
    const continueFrom = String((rawArgs && rawArgs.continueFrom) || '').trim();
    const prior = continueFrom ? followups.get(continueFrom) : null;
    if (continueFrom && !prior) {
      return {
        error: `continueFrom=${continueFrom} 没有可续用的子 Agent（不在本次运行内或已被留存上限淘汰）；请不带 continueFrom 重新派发`,
        errorCode: 'SUBAGENT_FOLLOWUP_NOT_FOUND'
      };
    }
    const named = namer.next('explore');
    const index = named.subagentIndex;
    issued += 1;
    const label = String((rawArgs && rawArgs.label) || '').trim() || `调研 ${index}`;
    const subagentId = named.subagentId;
    const meta = {
      label,
      task,
      index,
      subagentId,
      subagentKind: named.subagentKind,
      subagentIndex: named.subagentIndex,
      ...(prior ? { continueFrom } : {})
    };

    await acquire();
    try {
      // 排队期间可能已被取消：拿到槽位后再检查一次，避免取消后仍发起请求。
      if ((ctx && ctx.signal && ctx.signal.aborted) || (signal && signal.aborted)) {
        throw createAbortError('subagent 已取消');
      }
      if (typeof deps.onSubagentStart === 'function') deps.onSubagentStart(meta);

      const baseMessages = prior
        ? [
            ...prior.messages,
            { role: 'user', content: buildFollowupPrompt(prior.task, task, rawArgs && rawArgs.hints) }
          ]
        : [{ role: 'user', content: buildSubagentPrompt(task, rawArgs && rawArgs.hints) }];
      const child = await runChildLoop(
        {
          model: deps.model,
          messages: baseMessages,
          tools: childTools,
          maxRounds: limits.subagentMaxRounds,
          maxToolCalls: limits.subagentMaxToolCalls,
          label,
          subagentId
        },
        meta
      );

      // 留存追问上下文（含追问轮合并后的账本 messages；截断 run 也留 —— 半份上下文仍可续问）
      rememberFollowup(subagentId, prior ? `${prior.task}（含追问）` : task, child && child.messages);
      const summary = buildSummary(child, limits.subagentSummaryMaxChars);
      if (typeof deps.onSubagentEnd === 'function') deps.onSubagentEnd(meta, child);
      return {
        ok: true,
        label,
        subagentId,
        summary: summary.text,
        truncated: summary.truncated,
        reason: summary.reason,
        ...(prior ? { continuedFrom: continueFrom } : {})
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
    /** 当前可续问的子 Agent id（测试/诊断用） */
    followupIds: () => [...followups.keys()],
    stats: () => ({ issued, active, queued: waiters.length, retained: followups.size })
  };
}

module.exports = {
  createSubagentRunner,
  resolveSubagentLimits,
  buildSubagentPrompt,
  buildFollowupPrompt,
  SUBAGENT_TOOL_NAME,
  FALLBACK_LIMITS
};
