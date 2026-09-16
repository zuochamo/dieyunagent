'use strict';

const { normalizeTask, newId, DEFAULT_MAX_RETRIES } = require('./task-schema');
const {
  createMessage,
  messagesForRole,
  messagesForRoleSince,
  lastMessageTimestamp
} = require('./message-bus');

class AgentRunCoordinator {
  constructor() {
    /** @type {Map<string, object>} */
    this.runs = new Map();
  }

  _getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Agent 运行不存在: ${runId}`);
    return run;
  }

  _log(run, type, detail) {
    const evt = {
      id: newId('evt'),
      type,
      detail: detail && typeof detail === 'object' ? detail : { message: String(detail || '') },
      at: Date.now()
    };
    run.events.push(evt);
    return evt;
  }

  _clearTaskTimer(run, taskId) {
    const t = run.timers.get(taskId);
    if (t) {
      clearTimeout(t);
      run.timers.delete(taskId);
    }
  }

  _armTaskTimeout(run, task) {
    this._clearTaskTimer(run, task.taskId);
    const ms = Math.max(1000, Math.min(task.timeoutMs, task.deadlineAt - Date.now()));
    if (ms <= 0) {
      this._onTaskTimeout(run.runId, task.taskId);
      return;
    }
    const timer = setTimeout(() => {
      this._onTaskTimeout(run.runId, task.taskId);
    }, ms);
    run.timers.set(task.taskId, timer);
  }

  _onTaskTimeout(runId, taskId) {
    const run = this.runs.get(runId);
    if (!run || run.status === 'cancelled') return;
    const task = run.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'cancelled') return;

    this._clearTaskTimer(run, taskId);
    task.status = 'timeout';
    task.lastError = '任务超时';
    task.finishedAt = Date.now();
    this._log(run, 'task_timeout', { taskId, roleId: task.roleId });

    this.postMessage(runId, {
      fromRole: 'coordinator',
      toRole: task.roleId,
      type: 'error',
      taskId,
      payload: { error: 'timeout', message: '任务已超时' }
    });

    if (task.exceptionPolicy === 'escalate') {
      run.pendingArbitration = { taskId, reason: 'timeout' };
      this._log(run, 'arbitration_required', { taskId, reason: 'timeout' });
      return;
    }

    if (task.retryCount < task.maxRetries && task.exceptionPolicy !== 'fail') {
      this._scheduleRetry(run, task, 'timeout');
    } else {
      task.status = 'failed';
      this._log(run, 'task_failed', { taskId, error: 'timeout' });
    }
  }

  _scheduleRetry(run, task, reason) {
    if (task.retryCount >= task.maxRetries) {
      task.status = 'failed';
      task.lastError = reason;
      return;
    }
    task.retryCount += 1;
    task.status = 'retrying';
    task.lastError = reason;
    task.startedAt = null;
    task.finishedAt = null;
    this._log(run, 'task_retry', {
      taskId: task.taskId,
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
      reason
    });
    this.postMessage(run.runId, {
      fromRole: 'coordinator',
      toRole: task.roleId,
      type: 'task_assign',
      taskId: task.taskId,
      payload: {
        retry: true,
        retryCount: task.retryCount,
        reason,
        instruction: task.instruction,
        expectedOutput: task.expectedOutput
      }
    });
    run.retryQueue.push(task.taskId);
  }

  startRun(meta = {}) {
    const runId = meta.runId || newId('run');
    const run = {
      runId,
      status: 'running',
      meta: { ...meta },
      tasks: new Map(),
      messages: [],
      events: [],
      timers: new Map(),
      retryQueue: [],
      pendingArbitration: null,
      abortReason: null,
      startedAt: Date.now(),
      finishedAt: null
    };
    this.runs.set(runId, run);
    this._log(run, 'run_start', meta);
    return { runId, status: run.status };
  }

  enqueueTask(runId, spec) {
    const run = this._getRun(runId);
    if (run.status === 'cancelled') throw new Error('运行已取消');

    const task = normalizeTask({ ...spec, maxRetries: Math.min(3, spec.maxRetries ?? DEFAULT_MAX_RETRIES) });
    if (run.tasks.has(task.taskId)) {
      task.taskId = newId('task');
    }
    task.status = 'queued';
    run.tasks.set(task.taskId, task);
    this._log(run, 'task_enqueue', {
      taskId: task.taskId,
      roleId: task.roleId,
      priority: task.priority,
      deadlineAt: task.deadlineAt
    });

    this.postMessage(runId, {
      fromRole: 'planner',
      toRole: task.roleId,
      type: 'task_assign',
      taskId: task.taskId,
      payload: {
        title: task.title,
        instruction: task.instruction,
        expectedOutput: task.expectedOutput,
        deadlineAt: task.deadlineAt,
        priority: task.priority,
        worktreePath: task.worktreePath
      }
    });

    return { ok: true, task };
  }

  markTaskRunning(runId, taskId) {
    const run = this._getRun(runId);
    const task = run.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    task.status = 'running';
    task.startedAt = Date.now();
    this._armTaskTimeout(run, task);
    this._log(run, 'task_running', { taskId, roleId: task.roleId });
    return { ok: true, task };
  }

  completeTask(runId, taskId, result) {
    const run = this._getRun(runId);
    const task = run.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    this._clearTaskTimer(run, taskId);
    task.status = 'completed';
    task.result = result;
    task.finishedAt = Date.now();
    this._log(run, 'task_complete', { taskId, roleId: task.roleId });

    this.postMessage(runId, {
      fromRole: task.roleId,
      toRole: 'planner',
      type: 'task_result',
      taskId,
      payload: { ok: true, result }
    });
    return { ok: true, task };
  }

  failTask(runId, taskId, error, opts = {}) {
    const run = this._getRun(runId);
    const task = run.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    this._clearTaskTimer(run, taskId);
    const msg = error && error.message ? error.message : String(error || 'unknown');
    task.lastError = msg;
    task.finishedAt = Date.now();
    this._log(run, 'task_error', { taskId, error: msg, cancel: !!opts.cancel });

    this.postMessage(runId, {
      fromRole: task.roleId,
      toRole: 'planner',
      type: 'error',
      taskId,
      payload: { ok: false, error: msg }
    });

    if (opts.cancel) {
      task.status = 'cancelled';
      return { ok: true, task, retry: false };
    }

    if (task.exceptionPolicy === 'escalate') {
      task.status = 'failed';
      run.pendingArbitration = { taskId, reason: msg };
      this._log(run, 'arbitration_required', { taskId, reason: msg });
      return { ok: true, task, retry: false, needsArbitration: true };
    }

    if (task.retryCount < task.maxRetries && task.exceptionPolicy !== 'fail') {
      this._scheduleRetry(run, task, msg);
      return { ok: true, task, retry: true, retryCount: task.retryCount };
    }

    task.status = 'failed';
    this._log(run, 'task_failed', { taskId, error: msg });
    return { ok: true, task, retry: false };
  }

  postMessage(runId, input) {
    const run = this._getRun(runId);
    const msg = createMessage({ ...input, runId, traceId: runId });
    run.messages.push(msg);
    this._log(run, 'message', {
      id: msg.id,
      type: msg.type,
      fromRole: msg.fromRole,
      toRole: msg.toRole,
      taskId: msg.taskId
    });
    return msg;
  }

  getMessagesForRole(runId, roleId) {
    const run = this._getRun(runId);
    return messagesForRole(run.messages, roleId);
  }

  getMessagesForRoleSince(runId, roleId, since) {
    const run = this._getRun(runId);
    const msgs = messagesForRoleSince(run.messages, roleId, since);
    return { messages: msgs, lastAt: lastMessageTimestamp(msgs) || Number(since) || 0 };
  }

  cancelRun(runId, reason = '用户取消') {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    run.status = 'cancelled';
    run.abortReason = reason;
    run.finishedAt = Date.now();
    for (const taskId of run.timers.keys()) {
      this._clearTaskTimer(run, taskId);
    }
    for (const task of run.tasks.values()) {
      if (task.status === 'running' || task.status === 'queued' || task.status === 'retrying') {
        task.status = 'cancelled';
        task.finishedAt = Date.now();
      }
    }
    this.postMessage(runId, {
      fromRole: 'coordinator',
      toRole: '*',
      type: 'cancel',
      payload: { reason }
    });
    this._log(run, 'run_cancel', { reason });
    return { ok: true };
  }

  /**
   * 仲裁：retry | fail | accept_partial
   */
  arbitrate(runId, decision) {
    const run = this._getRun(runId);
    const pending = run.pendingArbitration;
    if (!pending) return { ok: false, error: '无待仲裁项' };

    const task = run.tasks.get(pending.taskId);
    if (!task) return { ok: false, error: '任务不存在' };

    const action = decision && decision.action ? String(decision.action) : 'fail';
    this._log(run, 'arbitration', { taskId: task.taskId, action, note: decision.note });

    run.pendingArbitration = null;

    if (action === 'retry') {
      this._scheduleRetry(run, task, pending.reason || 'arbitrated_retry');
      return { ok: true, action: 'retry' };
    }
    if (action === 'accept_partial') {
      task.status = 'completed';
      task.result = decision.result || { partial: true, note: decision.note || '' };
      return { ok: true, action: 'accept_partial' };
    }

    task.status = 'failed';
    task.lastError = pending.reason || 'arbitrated_fail';
    return { ok: true, action: 'fail' };
  }

  getTrace(runId) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      runId,
      status: run.status,
      meta: run.meta,
      tasks: [...run.tasks.values()],
      messages: run.messages,
      events: run.events,
      pendingArbitration: run.pendingArbitration,
      abortReason: run.abortReason
    };
  }

  endRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false };
    for (const taskId of run.timers.keys()) {
      this._clearTaskTimer(run, taskId);
    }
    if (run.status === 'running') run.status = 'completed';
    run.finishedAt = Date.now();
    this._log(run, 'run_end', {});
    return { ok: true };
  }

  isRunCancelled(runId) {
    const run = this.runs.get(runId);
    return !run || run.status === 'cancelled';
  }
}

module.exports = { AgentRunCoordinator };
