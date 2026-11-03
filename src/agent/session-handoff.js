'use strict';

const { HANDOFF } = require('./handoff-prompts');
const { getAgentLimits } = require('./agent-limits');

/** 归纳段落的标题：模型写的是**判断**，事实在下面的快照里。 */
const HANDOFF_COMMENTARY_HEADER = '## 归纳（模型整理，可能有误）';
/** 快照段落标题：原文投影，模型没有改写权。 */
const HANDOFF_SNAPSHOT_HEADER = '## 原文快照（未经模型改写）';
/** 单条消息进快照时的截断长度：一轮的正文可能是一整段代码。 */
const SNAPSHOT_MESSAGE_MAX_CHARS = 600;

/**
 * 尾部消息 → 原文快照（确定性投影，不经过任何模型）。
 *
 * 为什么要它：交接的价值一半在「事实」、一半在「判断」。老实现两半都交给模型，
 * 一旦模型把文件名、报错、结论复述错，新会话会把错的当成既定前提，而且**无从检查**。
 * 现在事实由存储投影（可核对），模型只负责归纳与下一步建议。
 *
 * 从尾部往前取：越近越相关；预算用尽即停，且先丢最早的轮次。
 */
function buildSnapshot(messages, maxChars) {
  const lines = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const content = String((m && m.content) || '').trim();
    if (!content) continue;
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
    const body =
      content.length > SNAPSHOT_MESSAGE_MAX_CHARS
        ? `${content.slice(0, SNAPSHOT_MESSAGE_MAX_CHARS)}…`
        : content;
    const line = `[${role}] ${body}`;
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  if (!lines.length) return '';
  return [HANDOFF_SNAPSHOT_HEADER, ...lines].join('\n');
}

/**
 * 会话交接生成（Main 侧服务）。
 *
 * 链路：memory.messages_recent（取骨架）→ 原文快照（本地投影）+ plans/runner 的
 * chatCompletion（复用唯一的单轮 LLM 传输：超时/abort/端点单源）→ memory.handoff_save
 * （Rust 唯一写入路径）。
 *
 * 产物是两段：**判断在前**（模型归纳）、**原文在后**（确定性快照）。注入侧按
 * `HANDOFF_BLOCK_MAX_CHARS` 截断时，先丢的是原文尾部而不是结论。
 *
 * @param {{ userData: string, gateway: { invokeRpc: Function } }} ctx
 * @param {{ sessionId: string, limit?: number, contextTierId?: string }} opts
 */
async function generateSessionHandoff(ctx, { sessionId, limit = 200, contextTierId } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) {
    const e = new Error('sessionId 必填');
    e.code = 'INVALID_PARAMS';
    throw e;
  }
  const gateway = ctx && ctx.gateway;
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    const e = new Error('Gateway 未就绪');
    e.code = 'GATEWAY_UNAVAILABLE';
    throw e;
  }

  const session = await gateway.invokeRpc('memory.session_get', { sessionId: sid });
  const recent = await gateway.invokeRpc('memory.messages_recent', { sessionId: sid, limit });
  const messages = Array.isArray(recent) ? recent : [];
  if (!messages.length) {
    const e = new Error('会话没有消息，无交接可生成');
    e.code = 'EMPTY_SESSION';
    throw e;
  }

  // 惰性引入：runner.js 会连带 plan-agent-runner（较重的依赖面），服务模块按需加载；
  // 测试经 ctx.chatCompletion 注入替身。
  const complete =
    (ctx && typeof ctx.chatCompletion === 'function')
      ? ctx.chatCompletion
      : require('../plans/runner').chatCompletion;
  const payload = await complete(
    ctx.userData,
    HANDOFF.USER({ title: session && session.title, messages }),
    HANDOFF.SYSTEM
  );
  const text = String(payload || '').trim();
  if (!text) {
    const e = new Error('模型未返回交接正文');
    e.code = 'EMPTY_HANDOFF';
    throw e;
  }

  const snapshotLimit = getAgentLimits(ctx && ctx.userData, contextTierId).handoffSnapshotMaxChars;
  const snapshot = buildSnapshot(messages, snapshotLimit);
  const body = snapshot ? `${HANDOFF_COMMENTARY_HEADER}\n${text}\n\n${snapshot}` : text;

  const saved = await gateway.invokeRpc('memory.handoff_save', {
    sessionId: sid,
    title: (session && session.title) || '',
    payload: body
  });
  return { ok: true, sessionId: sid, payload: body, saved };
}

module.exports = { generateSessionHandoff, buildSnapshot, HANDOFF_COMMENTARY_HEADER };
