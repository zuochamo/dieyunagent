'use strict';

/** Session transcript roles that may be projected into the next model request. */
const TRANSCRIPT_ROLES = new Set(['user', 'assistant']);

/**
 * 账本消息形状（投影白名单）——会话账本只保留协议字段 + 账本自有 `reasoning`。
 *
 * **不含 `reasoning_content`**：思考通道不属于账本/历史投影（REASONING-ISOLATION D2）。
 * 历史轮的 reasoning_content 由发送前的 `reasoning-backfill.js` 按需补：有账本真值用真值，
 * 真值不可得（老数据 / 压缩后）才补占位，绝不把某一轮思考原样带进下一轮请求正文。
 *
 * `reasoning`（账本自有字段，**名字不是上游 `reasoning_content`**）与 `content` 分列存储：
 * 只作为上行回传的真值来源，`buildCompletionMessagesFromHistory` 不会把它当正文读。
 *
 * 投影白名单覆盖两种消息：带 tool_calls 的 assistant 轮与普通对话轮；
 * 工具结果行由调用点（`extractInTurnLoopTail` 等）单独处理，不走本函数。
 */
const TRANSCRIPT_FIELDS = Object.freeze([
  'role',
  'content',
  'tool_calls',
  'tool_call_id',
  'name',
  'reasoning'
]);

/**
 * 投影单条消息：只保留协议字段，返回**浅拷贝**（不再把带 UI 字段的活对象交出去）。
 * `content` / `tool_calls` 保持引用（内容可能是多模态数组），仅裁剪字段集合。
 * `reasoning` 归一化为非空字符串：空串 / 非字符串一律丢弃，避免下游出现半状态。
 * 非对象原样返回，避免把 null / 字符串投影成 `{}`。
 */
function projectTranscriptMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const out = {};
  for (const key of TRANSCRIPT_FIELDS) {
    if (key === 'reasoning') continue;
    if (message[key] !== undefined) out[key] = message[key];
  }
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning.trim() : '';
  if (reasoning) out.reasoning = reasoning;
  return out;
}

/**
 * The session book: user/assistant records only, protocol fields only.
 * Live UI fields (transientTrace / meta / reasoning_content) and system/tool rows
 * are not part of the transcript.
 */
function transcriptFromMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && TRANSCRIPT_ROLES.has(m.role))
    .map(projectTranscriptMessage);
}

module.exports = {
  TRANSCRIPT_ROLES,
  TRANSCRIPT_FIELDS,
  projectTranscriptMessage,
  transcriptFromMessages
};
