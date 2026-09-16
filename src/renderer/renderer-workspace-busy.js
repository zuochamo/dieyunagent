/* global window, document, $, currentSessionId, sessionActiveRuns, showAgentToast */
'use strict';

function mq() {
  return typeof window !== 'undefined' && window.MutateQueue ? window.MutateQueue : null;
}

function workspaceKeyFromPath(workspacePath) {
  const api = mq();
  if (api && typeof api.normalizeWorkspaceMutateKey === 'function') {
    return api.normalizeWorkspaceMutateKey(workspacePath || '');
  }
  return String(workspacePath || '__global__').trim() || '__global__';
}

function countOtherActiveRunsOnWorkspace(workspacePath, sessionId) {
  const key = String(workspacePath || '').trim();
  if (!key) return 0;
  const sid = String(sessionId || currentSessionId || '').trim();
  let count = 0;
  for (const [runSid, run] of sessionActiveRuns.entries()) {
    if (run.finished) continue;
    if (sid && String(runSid) === sid) continue;
    if (String(run.workspacePath || '').trim() === key) count += 1;
  }
  return count;
}

function getWorkspaceParallelWriteStatus(workspacePath, sessionId) {
  const key = workspaceKeyFromPath(workspacePath);
  const sid = String(sessionId || currentSessionId || '').trim();
  const api = mq();
  const otherRuns = countOtherActiveRunsOnWorkspace(workspacePath, sid);
  const mutatePending =
    api && typeof api.getWorkspaceMutatePending === 'function' ? api.getWorkspaceMutatePending(key) : 0;
  const mutateBusy =
    api && typeof api.isWorkspaceMutateBusy === 'function'
      ? api.isWorkspaceMutateBusy(key, sid)
      : false;
  return {
    workspaceKey: key,
    otherActiveRuns: otherRuns,
    mutatePending,
    mutateBusy,
    sharedWriteActive: otherRuns > 0 || mutateBusy
  };
}

function refreshWorkspaceMutateHint(workspacePath, sessionId) {
  const el = $('composer-workspace');
  if (!el) return;
  const st = getWorkspaceParallelWriteStatus(workspacePath, sessionId);
  el.classList.toggle('composer-workspace-shared-write', st.sharedWriteActive);
  if (st.sharedWriteActive) {
    const parts = [];
    if (st.otherActiveRuns > 0) parts.push(`${st.otherActiveRuns} 个后台对话`);
    if (st.mutatePending > 0) parts.push('写操作排队中');
    el.dataset.sharedWriteHint = parts.join(' · ') || '同工作区并行写入将串行执行';
  } else {
    delete el.dataset.sharedWriteHint;
  }
}

function maybeNotifySharedWorkspaceWrite(workspacePath, sessionId) {
  const st = getWorkspaceParallelWriteStatus(workspacePath, sessionId);
  if (!st.sharedWriteActive) return;
  if (typeof showAgentToast !== 'function') return;
  const hint =
    st.otherActiveRuns > 0
      ? '该工作区另有 Agent 在运行，文件写入将排队执行'
      : '该工作区写操作排队中';
  showAgentToast('工作区占用', hint, { variant: 'info', durationMs: 3200 });
}

if (typeof window !== 'undefined') {
  window.getWorkspaceParallelWriteStatus = getWorkspaceParallelWriteStatus;
  window.refreshWorkspaceMutateHint = refreshWorkspaceMutateHint;
  window.maybeNotifySharedWorkspaceWrite = maybeNotifySharedWorkspaceWrite;
}
