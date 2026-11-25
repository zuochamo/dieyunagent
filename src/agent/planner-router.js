'use strict';

const { completeOnce, currentLlmCompleteBridge } = require('./llm-complete');

/**
 * 「这一轮要不要拆成多路并行写入」的判定 —— **唯一来源**（Main）。
 *
 * 开关 `agent-limits.plannerMultiAgentEnabled` 的语义是**允许**，不是强制：
 * 打开后由这里问一次侧模型，只有它明确回答「值得拆」才起 planner，否则走普通工具循环。
 * 以前开关一开就是每轮硬闯 planner（`forcePlanner`）：两个字的追问也会被拆成 3 路执行器、
 * 子 Agent 跑到 71 步、花掉半小时（2026-11-19 实测），所以「要不要」交回模型判断。
 *
 * 四条硬约束：
 *  1. **失败即不走**（超时 / 解析失败 / 没有模型 → `use:false`）：多花一次小请求可以接受，
 *     多跑半小时不行；
 *  2. 判据只看**这一句请求的结构**（有没有 ≥2 个彼此独立、都要改文件或跑命令的交付物），
 *     不猜意图、不看措辞、不数历史；
 *  3. **侧模型可替换**：`model-settings.json` 的 `plannerRouterModel` / `plannerRouterBaseUrl` /
 *     `plannerRouterApiKey`；留空就用本轮主模型与它的 apiConfig（与 `reviewerModel` 同一手法，
 *     不新增「开关」——开关仍然只有「多 Agent 并行执行」那一个）。
 *  4. 判定结论与理由**要能被看见**：调用方把 `reason` 写进思考区（`调度 · 侧模型路由`）或日志，
 *     否则「为什么这轮没走 planner」永远查不出来。
 */

/** 判定请求的时长上限：超时就按「不拆」处理，绝不拖住这一轮。 */
const ROUTER_TIMEOUT_MS = 20000;
/** 判定只需要一个布尔 + 一句理由。 */
const ROUTER_MAX_OUTPUT_TOKENS = 256;
/** 送进判定的用户文本上限（再长也不会改变「有几件事」这个判断）。 */
const ROUTER_USER_TEXT_MAX_CHARS = 2000;

const PLANNER_ROUTER_SYSTEM = `你是叠云 Agent 的派单员。判断用户这一句请求值不值得拆成「多路并行子 Agent」去执行。
只输出一个 JSON 对象，不要 Markdown：{"use":true|false,"reason":"一句话中文理由"}

判 true 必须同时满足：这一句里有 **两个及以上彼此独立、都要改文件或跑命令**的交付物（不同模块 / 不同产物 / 互不依赖的多处修复），并且并行确实能省时间。
以下一律 false：
- 只是问一句、解释、评估、确认状态（例如「做完了？」「这个方案怎么样」）
- 单文件小改、单点修复、纯只读调研
- 步骤之间有先后依赖（先跑通再写文档这类只能串行的活）
- 只是同一件事被说得很长、很大
拿不准就 false。理由写 20 字以内，不要复述请求原文。`;

/**
 * 侧模型配置。缺 model 或缺 baseUrl 就当「没配」→ 返回 null（调用方回落到主模型）。
 *
 * @param {any} settings model-settings 同构对象
 * @returns {{model: string, apiConfig: {baseUrl: string, apiKey: string}} | null}
 */
function resolvePlannerRouterConfig(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const model = String(s.plannerRouterModel || '').trim();
  const baseUrl = String(s.plannerRouterBaseUrl || '').trim();
  if (!model || !baseUrl) return null;
  return { model, apiConfig: { baseUrl, apiKey: String(s.plannerRouterApiKey || '').trim() } };
}

/**
 * 判定请求体（模型看到的那一份）。
 *
 * @param {{userText?: string, model?: string, workspacePath?: string}} input
 */
function buildPlannerRouteBody(input = {}) {
  const text = String(input.userText || '').trim().slice(0, ROUTER_USER_TEXT_MAX_CHARS);
  const ws = String(input.workspacePath || '').trim();
  const user = ws ? `工作区：${ws}\n\n用户这一句：\n${text}` : `用户这一句：\n${text}`;
  return {
    model: String(input.model || '').trim(),
    messages: [
      { role: 'system', content: PLANNER_ROUTER_SYSTEM },
      { role: 'user', content: user }
    ],
    temperature: 0,
    max_tokens: ROUTER_MAX_OUTPUT_TOKENS,
    stream: false
  };
}

/**
 * 解析判定结果。返回 `null` 表示**这条答复不可用**（调用方按「不拆」处理）。
 *
 * 只认结构化 `{"use":…}`：判定轮没有别的合法产出，猜中文「要/不要」等于换个地方做词表。
 *
 * @param {string} content
 * @returns {{use: boolean, reason: string} | null}
 */
function parsePlannerRoute(content) {
  const raw = String(content || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : '';
  if (!candidate) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.use !== 'boolean') return null;
  return {
    use: parsed.use,
    reason: String(parsed.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  };
}

/** 判定思考的展示上限：卡片里能读就行，不必把整段推理铺进思考区。 */
const ROUTER_THINKING_MAX_CHARS = 1200;

/**
 * 判定思考的展示文本：优先思考通道，退回正文（有的模型只回其中一边）。
 *
 * 为什么必须交出去：判定结果是「拆 / 不拆」这个决定本身，用户要能复盘它凭什么这么判
 * —— 只给一句 20 字的理由，误判时无从下手（2026-11-20 用户要求）。
 *
 * @param {?string} reasoning
 * @param {?string} content
 */
function summarizeThinking(reasoning, content) {
  const pick = String(reasoning || '').trim() || String(content || '').trim();
  if (!pick) return '';
  return pick.length > ROUTER_THINKING_MAX_CHARS
    ? `${pick.slice(0, ROUTER_THINKING_MAX_CHARS)}…`
    : pick;
}

/**
 * 问一次侧模型：这一轮要不要拆。
 *
 * **永不抛错**：任何失败（没模型 / 超时 / 上游只回思考 / 解析不出来）都返回 `use:false` 并带理由，
 * 由调用方按普通工具循环继续。planner 是重流程，缺省必须是最轻的那条路。
 *
 * @param {{
 *   userText?: string,
 *   workspacePath?: string,
 *   model?: string,
 *   apiConfig?: {baseUrl?: string, apiKey?: string},
 *   settings?: any,
 *   coreBridge?: {invoke: Function},
 *   signal?: AbortSignal,
 *   timeoutMs?: number
 * }} input
 * @returns {Promise<{use: boolean, reason: string, thinking: string, model: string, source: 'side'|'main'|'none'}>}
 */
async function routeTurnToPlanner(input = {}) {
  const userText = String(input.userText || '').trim();
  if (!userText) {
    return { use: false, reason: '没有用户文本可判', thinking: '', model: '', source: 'none' };
  }
  const side = resolvePlannerRouterConfig(input.settings);
  const mainConfig = input.apiConfig && typeof input.apiConfig === 'object' ? input.apiConfig : {};
  const model = side ? side.model : String(input.model || mainConfig.model || '').trim();
  const apiConfig = side ? side.apiConfig : mainConfig;
  const source = side ? 'side' : 'main';
  if (!model || !apiConfig || !apiConfig.baseUrl) {
    return { use: false, reason: '没有可用的判定模型（回落主模型也缺端点）', thinking: '', model, source };
  }

  const body = buildPlannerRouteBody({ userText, model, workspacePath: input.workspacePath });
  const timeoutMs =
    Number.isFinite(Number(input.timeoutMs)) && Number(input.timeoutMs) > 0
      ? Number(input.timeoutMs)
      : ROUTER_TIMEOUT_MS;
  const child = new AbortController();
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);
  const parent = input.signal;
  const onParentAbort = () => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  };
  if (parent) {
    if (parent.aborted) onParentAbort();
    else if (typeof parent.addEventListener === 'function') {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  try {
    const result = await completeOnce({
      coreBridge: input.coreBridge || currentLlmCompleteBridge(),
      llm: { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey || '', model },
      body,
      stream: false,
      signal: child.signal,
      timeoutMs
    });
    // 判定模型的思考也要留下：用户要能看见「它凭什么判这一轮不拆」，而不是只给一句结论。
    // 思考为空就退回它吐的原始正文（有的模型只回 content，有的只回 reasoning）。
    const thinking = summarizeThinking(result && result.reasoning, result && result.content);
    const parsed = parsePlannerRoute(result && result.content);
    if (!parsed) {
      return {
        use: false,
        reason: '判定轮没有给出可用的 JSON，按不拆处理',
        thinking,
        model,
        source
      };
    }
    return {
      use: parsed.use,
      reason: parsed.reason || (parsed.use ? '值得拆' : '不值得拆'),
      thinking,
      model,
      source
    };
  } catch (e) {
    const aborted = !!(e && (e.name === 'AbortError' || e.code === 'LLM_RECONNECT_EXHAUSTED'));
    return {
      use: false,
      reason: aborted ? '判定超时，按不拆处理' : `判定失败，按不拆处理：${(e && e.message) || e}`,
      thinking: '',
      model,
      source
    };
  } finally {
    clearTimeout(timer);
    if (parent && typeof parent.removeEventListener === 'function') {
      parent.removeEventListener('abort', onParentAbort);
    }
  }
}

module.exports = {
  ROUTER_TIMEOUT_MS,
  ROUTER_MAX_OUTPUT_TOKENS,
  ROUTER_THINKING_MAX_CHARS,
  PLANNER_ROUTER_SYSTEM,
  resolvePlannerRouterConfig,
  buildPlannerRouteBody,
  summarizeThinking,
  parsePlannerRoute,
  routeTurnToPlanner
};
