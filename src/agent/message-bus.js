'use strict';

const { newId } = require('./task-schema');

/** @typedef {'task_assign'|'task_result'|'review'|'clarify'|'error'|'cancel'|'heartbeat'|'plan'|'arbitrate'} MsgType */

/**
 * @param {object} input
 */
function createMessage(input) {
  return {
    id: input.id || newId('msg'),
    runId: String(input.runId),
    taskId: input.taskId ? String(input.taskId) : null,
    traceId: String(input.traceId || input.runId),
    fromRole: String(input.fromRole || 'system'),
    toRole: String(input.toRole || '*'),
    type: String(input.type || 'task_assign'),
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    createdAt: Number(input.createdAt) || Date.now()
  };
}

/**
 * 子 Agent 只读投递给自己的消息（+ 广播 *）。
 * @param {object[]} messages
 * @param {string} roleId
 */
function messagesForRole(messages, roleId) {
  const role = String(roleId);
  return messages
    .filter((m) => m.toRole === '*' || m.toRole === role)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 子 Agent 运行中增量拉取新消息（since 为上次最大 createdAt）。
 */
function messagesForRoleSince(messages, roleId, since = 0) {
  const sinceTs = Number(since) || 0;
  return messagesForRole(messages, roleId).filter((m) => m.createdAt > sinceTs);
}

function lastMessageTimestamp(msgs) {
  if (!msgs || !msgs.length) return 0;
  return Math.max(...msgs.map((m) => Number(m.createdAt) || 0));
}

module.exports = {
  createMessage,
  messagesForRole,
  messagesForRoleSince,
  lastMessageTimestamp
};
