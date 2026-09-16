'use strict';

const { COMPACTION } = require('../compaction-prompts');

function buildCompactionPrompts() {
  const C = COMPACTION || {};
  return {
    system: C.SYSTEM || '你是上下文压缩器。输出 JSON 摘要。摘要保留目标与未完成项供后续继续，不能替代最后一条用户消息。',
    user: C.USER || '请压缩以下较早对话。摘要须让后续能继续同一会话，且不得改写最后一条用户消息。\n\n{CONVERSATION}',
    incrementalSystem: C.INCREMENTAL_SYSTEM || C.SYSTEM || '',
    incrementalUser: C.INCREMENTAL_USER || '',
    compactPrefix: C.COMPACT_PREFIX || '【对话摘要 · 历史背景】',
    compactSuffix: C.COMPACT_SUFFIX || ''
  };
}

module.exports = {
  buildCompactionPrompts
};
