'use strict';

const TASK_STATUSES = [
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'retrying'
];

const EXCEPTION_POLICIES = ['retry', 'fail', 'escalate'];

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PRIORITY = 5;

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} input
 * @returns {object}
 */
const AGENT_TYPES = ['explore', 'shell', 'build'];

function normalizeWorkerId(raw) {
  const w = String(raw || 'A').trim().toUpperCase();
  if (/^[A-F]$/.test(w)) return w;
  if (/^W\d+$/.test(w)) return w;
  if (/^[A-F]-BN\d+$/i.test(w)) return w.toUpperCase();
  return 'A';
}

function normalizeAgentType(raw) {
  const t = String(raw || 'build').trim().toLowerCase();
  return AGENT_TYPES.includes(t) ? t : 'build';
}

function normalizeTask(input) {
  const now = Date.now();
  const taskId = input.taskId || newId('task');
  const roleId = normalizeWorkerId(input.roleId || input.worker || 'A');
  const maxRetries = Math.min(3, Math.max(0, Number(input.maxRetries ?? DEFAULT_MAX_RETRIES)));
  const timeoutMs = Math.max(5000, Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const deadlineAt = Number(input.deadlineAt) || now + timeoutMs;
  const priority = Math.min(10, Math.max(1, Number(input.priority ?? DEFAULT_PRIORITY)));
  const policy = EXCEPTION_POLICIES.includes(input.exceptionPolicy)
    ? input.exceptionPolicy
    : 'retry';

  return {
    taskId,
    roleId,
    worker: normalizeWorkerId(input.worker || roleId),
    agentType: normalizeAgentType(input.agentType),
    title: String(input.title || roleId).trim(),
    instruction: String(input.instruction || '').trim(),
    expectedOutput: String(input.expectedOutput || '完成子任务并返回可验收的结果摘要').trim(),
    deadlineAt,
    priority,
    exceptionPolicy: policy,
    maxRetries,
    retryCount: Math.max(0, Number(input.retryCount) || 0),
    timeoutMs,
    worktreePath: input.worktreePath ? String(input.worktreePath) : null,
    worktreeBranch: input.worktreeBranch ? String(input.worktreeBranch) : null,
    status: TASK_STATUSES.includes(input.status) ? input.status : 'pending',
    createdAt: Number(input.createdAt) || now,
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    lastError: input.lastError || null,
    result: input.result || null
  };
}

module.exports = {
  TASK_STATUSES,
  EXCEPTION_POLICIES,
  AGENT_TYPES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  newId,
  normalizeWorkerId,
  normalizeAgentType,
  normalizeTask
};
