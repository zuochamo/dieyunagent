'use strict';

const LONG_HORIZON_MAX_SEGMENTS = 20;

const SEGMENT_CONTINUE_USER_MSG =
  '[系统] 本段工具轮次已达上限，请在同一会话中继续未完成任务，勿重复已完成的步骤。';

function buildSegmentContinueMessages(messages, partialContent) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  const partial = String(partialContent || '').trim();
  if (partial) {
    const last = msgs[msgs.length - 1];
    const lastContent =
      last && last.role === 'assistant'
        ? typeof last.content === 'string'
          ? last.content.trim()
          : ''
        : '';
    if (lastContent !== partial) {
      msgs.push({ role: 'assistant', content: partial });
    }
  }
  msgs.push({ role: 'user', content: SEGMENT_CONTINUE_USER_MSG });
  return msgs;
}

module.exports = {
  LONG_HORIZON_MAX_SEGMENTS,
  SEGMENT_CONTINUE_USER_MSG,
  buildSegmentContinueMessages
};
