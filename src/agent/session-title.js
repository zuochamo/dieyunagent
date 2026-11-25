'use strict';

/**
 * 会话标题的 AI 总结（Main / Node 侧，唯一实现）。
 *
 * 现状：`sessions.title` 由 Rust 的 `title_from_user_content` 用「首条用户消息切片」填，
 * 于是历史列表里全是 `有个员工的名字变了。` / `看下这个取数任务 e7b0…` 这种半句话。
 * 这里在**一轮正常收尾之后**补一次小请求（每会话最多一次），让模型给一个能认出话题的短标题。
 *
 * 四条硬约束：
 *   1. **每会话只生成一次**：判据是 `sessions.title_source`（Rust 列，`ai`/`user`/`heuristic`），
 *      不是猜标题长什么样。已 `ai` / 已 `user` 直接跳过，永不重写。
 *   2. **不阻塞交付**：调用方 fire-and-forget，跑完再通过 IPC 事件让历史列表刷新一次；
 *      标题是列表装饰，不该让用户多等一秒才能看到回答。
 *   3. **失败静默**：模型报错 / 超时 / 返回空 → 什么都不做（保留启发式标题），
 *      下一轮会再试一次；绝不为了一个标题把对话搞挂。
 *   4. **不走工具链**：一次非流式 chat 请求，输入只有「用户这条需求 + 本轮答复节选」，
 *      不复用对话上下文（省 token，也不会把工具输出喂给标题模型）。
 *
 * 请求装配（端点 / 请求头）一律走 `llm-request.js`，这里不拼 URL、不写 Authorization。
 */

const { completeOnce, currentLlmCompleteBridge } = require('./llm-complete');
const { resolveLlmEndpoint } = require('./llm-request');
const { getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { extractLastUserMessageText } = require('./agent-synthesis');
const { unpackMessageMeta } = require('./session-context');

/** `sessions.title_source`：本模块写出的标题来源（与 Rust TITLE_SOURCE_AI 同值）。 */
const TITLE_SOURCE_AI = 'ai';
/** 已有这两种来源的标题一律不再自动改写（AI 已写过 / 用户亲手改过）。 */
const TITLE_SOURCE_LOCKED = new Set([TITLE_SOURCE_AI, 'user']);

/** 生成标题时给模型的输入上限：够判断话题，又不至于把整轮正文搬过去。 */
const TITLE_USER_TEXT_MAX = 2000;
const TITLE_REPLY_TEXT_MAX = 1200;

/** 标题整形：去掉模型偶尔多写的引号/序号前缀，再按上限截断。 */
const LEADING_NOISE_RE = /^(?:标题[:：]|title[:：])\s*/i;
const WRAPPING_QUOTES_RE = /^[「『"'“”‘’《【\[(]+|[」』"'“”‘’》】\])]+$/g;

function titleMaxChars(userData) {
  const n = Number(getAgentLimits(userData).sessionTitleMaxChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : AGENT_LIMITS_DEFAULTS.sessionTitleMaxChars;
}

function titleTimeoutMs(userData) {
  const n = Number(getAgentLimits(userData).sessionTitleTimeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : AGENT_LIMITS_DEFAULTS.sessionTitleTimeoutMs;
}

/**
 * 一次标题请求的 body。`maxChars` 进提示词（比事后截断准），`max_tokens` 给足余量
 * （中日韩一个字约 1~1.5 token，再留出模型偶尔啰嗦的两句）。
 */
function buildSessionTitleBody({ model, userText, replyText, maxChars }) {
  const limit = Math.max(8, Number(maxChars) || AGENT_LIMITS_DEFAULTS.sessionTitleMaxChars);
  const parts = [`【用户需求】\n${String(userText || '').trim().slice(0, TITLE_USER_TEXT_MAX)}`];
  const reply = String(replyText || '').trim().slice(0, TITLE_REPLY_TEXT_MAX);
  if (reply) parts.push(`【本轮答复节选】\n${reply}`);
  parts.push(`请用不超过 ${limit} 个字给出这段对话的标题。`);
  return {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是会话标题生成器。读用户需求（与助手答复节选），给出一个能让人一眼认出这段对话的短标题。\n\n' +
          '要求：\n' +
          '- 只输出标题本身：一行、纯文本、不要引号、不要书名号、不要冒号、不要结尾标点\n' +
          '- 用用户需求的语言\n' +
          '- 具体到**任务对象**（改哪个文件、查哪件事、做哪个功能），不要「关于…的帮助」「用户咨询…」这类空话\n' +
          '- 不要出现「对话」「会话」「标题」「需求」这类元词\n' +
          '- 不要 Markdown、不要解释、不要给多个候选'
      },
      { role: 'user', content: parts.join('\n\n') }
    ],
    temperature: 0.2,
    max_tokens: Math.min(64, limit * 2),
    stream: false
  };
}

/**
 * 模型输出 → 可落库标题。
 *
 * 只做「明显不是标题」的清理，不做语义改写：首行、折叠空白、剥引号与「标题：」前缀、
 * 去结尾标点、按上限截断。清完为空就当作失败（返回 ''）。
 */
function cleanGeneratedTitle(raw, maxChars) {
  const limit = Math.max(4, Number(maxChars) || AGENT_LIMITS_DEFAULTS.sessionTitleMaxChars);
  const firstLine =
    String(raw == null ? '' : raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || '';
  let text = firstLine.replace(/\s+/g, ' ').replace(LEADING_NOISE_RE, '').trim();
  text = text.replace(WRAPPING_QUOTES_RE, '').trim();
  text = text.replace(/[。．.,，;；:：、\s]+$/g, '').trim();
  return text.slice(0, limit);
}

/** 用户这条需求（剥掉落库 meta），拿不到就返回 ''。 */
function resolveUserText(messages) {
  const raw = extractLastUserMessageText(messages);
  if (!raw) return '';
  return String(unpackMessageMeta(raw).content || '').trim();
}

/** 用本轮答复正文做节选；没有就退回消息列表里最后一条 assistant 文本。 */
function resolveReplyText(done, messages) {
  const content = String((done && done.content) || '').trim();
  if (content) return content;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'assistant') continue;
    const text = String(unpackMessageMeta(m.content).content || '').trim();
    if (text) return text;
  }
  return '';
}

/** OpenAI 兼容响应 → 正文；兼容 `{content}` 形状（测试替身 / 中转网关）。 */
function extractCompletionContent(json) {
  if (typeof json === 'string') return json;
  if (json && typeof json.content === 'string') return json.content;
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = (choice && choice.message) || {};
  return msg.content != null ? String(msg.content) : '';
}

/**
 * 给一个会话补 AI 标题（每会话一次）。返回最终写入的标题，跳过/失败返回 null。
 *
 * @param {object} opts
 * @param {(method: string, params?: object) => Promise<any>} opts.invokeRpc Gateway RPC
 * @param {object} opts.llm `{ baseUrl, apiKey, model, headers?, authMode?, sessionId? }`
 * @param {string} opts.sessionId
 * @param {Array} [opts.messages] 本轮请求的消息（只用来取「用户这条需求」）
 * @param {object} [opts.done] 本轮 loop 结果（`content` 作为答复节选）
 * @param {string} [opts.userData]
 * @param {AbortSignal} [opts.signal]
 */
async function maybeGenerateSessionTitle(opts = {}) {
  const invokeRpc = opts.invokeRpc;
  const sessionId = String(opts.sessionId || '').trim();
  const llm = opts.llm || {};
  const baseUrl = String(llm.baseUrl || '').trim();
  const done = opts.done || {};
  // 用户主动停掉的轮次不配一个「AI 标题」——正文都没写完，标题只会跑偏。
  if (typeof invokeRpc !== 'function' || !sessionId || !baseUrl || done.aborted) return null;
  const userText = resolveUserText(opts.messages);
  if (!userText) return null;

  const maxChars = titleMaxChars(opts.userData);
  const timeoutMs = titleTimeoutMs(opts.userData);
  const body = buildSessionTitleBody({
    model: String(llm.model || '').trim() || 'unknown',
    userText,
    replyText: resolveReplyText(done, opts.messages),
    maxChars
  });

  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) return null;

  const child = new AbortController();
  const parent = opts.signal || null;
  const onParentAbort = () => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  };
  if (parent) {
    if (parent.aborted) return null;
    if (typeof parent.addEventListener === 'function') {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    // 已 ai / 已 user 的标题到此为止：这一次 DB 读就是「只生成一次」的唯一判据。
    const row = await invokeRpc('memory.session_get', { sessionId });
    const source = row && row.titleSource ? String(row.titleSource).trim() : '';
    if (TITLE_SOURCE_LOCKED.has(source)) return null;

    const raw =
      typeof opts.fetchTitleOnce === 'function'
        ? await opts.fetchTitleOnce({ body, signal: child.signal })
        : // 请求由 core 发（`llm.complete`）：标题生成不再自己打 HTTP，
          // 端点/请求头/超时/SSE/usage 只有 core 那一份实现。
          await completeOnce({
            coreBridge: opts.coreBridge || currentLlmCompleteBridge(),
            llm,
            body,
            runId: ''
          });
    const title = cleanGeneratedTitle(extractCompletionContent(raw), maxChars);
    if (!title) return null;

    await invokeRpc('memory.session_set_title', { sessionId, title, source: TITLE_SOURCE_AI });
    return title;
  } catch (err) {
    // 标题是列表装饰：失败只留一行日志，保留启发式标题，下一轮再试。
    console.warn(
      '[dieyun:agent] session title skip:',
      err && (err.message || err)
    );
    return null;
  } finally {
    clearTimeout(timer);
    if (parent && typeof parent.removeEventListener === 'function') {
      parent.removeEventListener('abort', onParentAbort);
    }
  }
}

module.exports = {

  buildSessionTitleBody,
  cleanGeneratedTitle,
  extractCompletionContent,
  resolveUserText,
  resolveReplyText,
  maybeGenerateSessionTitle
};
