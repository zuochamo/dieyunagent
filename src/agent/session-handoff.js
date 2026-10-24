'use strict';

const { HANDOFF } = require('./handoff-prompts');

/**
 * 会话交接生成（Main 侧服务）。
 *
 * 链路：memory.messages_recent（取骨架）→ plans/runner 的 chatCompletion（复用唯一的
 * 单轮 LLM 传输：超时/abort/端点单源）→ memory.handoff_save（Rust 唯一写入路径）。
 *
 * @param {{ userData: string, gateway: { invokeRpc: Function } }} ctx
 * @param {{ sessionId: string, limit?: number }} opts
 */
async function generateSessionHandoff(ctx, { sessionId, limit = 200 } = {}) {
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

  const saved = await gateway.invokeRpc('memory.handoff_save', {
    sessionId: sid,
    title: (session && session.title) || '',
    payload: text
  });
  return { ok: true, sessionId: sid, payload: text, saved };
}

module.exports = { generateSessionHandoff };
