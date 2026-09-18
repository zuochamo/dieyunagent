/* global window, currentSessionId, sessionActiveRuns, trackArtifact, scheduleArtifactsUiFlush, showClarifyInBubble, getUndoTurnIdForSession, resolveSessionWorkspacePathSync, DieyunToolCatalog, DieyunToolClassify, normalizeAgentToolName, noteBrowserToolUse */
'use strict';

const agentToolsApi = window.diecloud || {};

/** @type {Map<string, { runId: string, roleId?: string, worktreePath?: string, workspacePath?: string, sessionId: string, undoTurnId?: string }>} */
const agentExecutionContexts = new Map();

function runExclusiveAgentTool(fn, workspaceKey, holderId) {
  const mq = window.MutateQueue;
  if (mq && typeof mq.runExclusive === 'function') {
    return mq.runExclusive(fn, workspaceKey, holderId);
  }
  return fn();
}

function resolveAgentPlaceholderEl(sessionId) {
  const ctx = getAgentExecutionContext(sessionId) || {};
  const sid = String(ctx.sessionId || sessionId || '').trim();
  const live = sid ? sessionActiveRuns.get(String(sid)) : null;
  return live?.placeholderEl || null;
}

function getAgentExecutionContext(sessionId) {
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : '';
  return sid ? agentExecutionContexts.get(sid) || null : null;
}

function setAgentExecutionContext(ctx) {
  if (!ctx || !ctx.sessionId) return;
  const sid = String(ctx.sessionId);
  let workspacePath = ctx.workspacePath || null;
  if (!workspacePath) {
    const live =
      typeof sessionActiveRuns !== 'undefined' ? sessionActiveRuns.get(sid) : null;
    if (live && live.workspacePath) workspacePath = live.workspacePath;
  }
  if (!workspacePath && typeof resolveSessionWorkspacePathSync === 'function') {
    workspacePath = resolveSessionWorkspacePathSync(sid);
  }
  agentExecutionContexts.set(sid, { ...ctx, sessionId: sid, workspacePath });
}

function clearAgentExecutionContext(sessionId) {
  if (sessionId == null || !String(sessionId).trim()) {
    agentExecutionContexts.clear();
    return;
  }
  agentExecutionContexts.delete(String(sessionId));
}

if (typeof window !== 'undefined') {
  window.setAgentExecutionContext = setAgentExecutionContext;
  window.getAgentExecutionContext = getAgentExecutionContext;
  window.clearAgentExecutionContext = clearAgentExecutionContext;
}

function isMutatingAgentTool(name) {
  if (typeof DieyunToolClassify !== 'undefined' && DieyunToolClassify.isMutatingAgentTool) {
    return DieyunToolClassify.isMutatingAgentTool(name);
  }
  return false;
}

async function executeAgentTool(name, args, sessionId) {
  const norm =
    typeof normalizeAgentToolName === 'function'
      ? normalizeAgentToolName(name, args)
      : { name, args };
  const ctx = getAgentExecutionContext(sessionId) || {};
  const sid = String(ctx.sessionId || sessionId || '').trim();
  const workspaceKey = ctx.workspacePath || ctx.worktreePath || sid;
  // 记录本会话已进入浏览器任务：用于按需注册 browser_* 专用工具（见 renderer-tool-defs.js）。
  // 依据是「确实发生过的工具调用」这一结构信号，不涉及意图关键词判断。
  if (String(norm.name || '').startsWith('browser_') && typeof noteBrowserToolUse === 'function') {
    noteBrowserToolUse(sid || sessionId);
  }
  const invoke = async () => executeAgentToolInner(norm.name, norm.args, sid || sessionId);
  if (isMutatingAgentTool(norm.name)) {
    if (typeof maybeNotifySharedWorkspaceWrite === 'function') {
      maybeNotifySharedWorkspaceWrite(workspaceKey, sid);
    }
    const result = await runExclusiveAgentTool(async () => {
      const inner = await invoke();
      if (typeof scheduleArtifactsUiFlush === 'function') scheduleArtifactsUiFlush();
      return inner;
    }, workspaceKey, sid);
    if (typeof refreshWorkspaceMutateHint === 'function') {
      refreshWorkspaceMutateHint(workspaceKey, sid);
    }
    return result;
  }
  return invoke();
}

async function executeAgentToolInner(name, args, sessionId) {
  if (typeof normalizeAgentToolName === 'function') {
    const norm = normalizeAgentToolName(name, args);
    name = norm.name;
    args = norm.args;
  }
  const rendererOnly =
    (typeof DieyunToolCatalog !== 'undefined' &&
      Array.isArray(DieyunToolCatalog.RENDERER_ONLY_TOOLS) &&
      DieyunToolCatalog.RENDERER_ONLY_TOOLS.includes(name)) ||
    name === 'agent_clarify';
  if (!rendererOnly) {
    if (!agentToolsApi.agentRetryTool) {
      return { error: 'Main 工具桥不可用' };
    }
    const ctx = getAgentExecutionContext(sessionId) || {};
    const sid = String(ctx.sessionId || sessionId || '').trim();
    const result = await agentToolsApi.agentRetryTool({
      name,
      args: args || {},
      sessionId: sid || undefined,
      undoTurnId:
        ctx.undoTurnId ||
        (typeof getUndoTurnIdForSession === 'function' ? getUndoTurnIdForSession(sid) : undefined),
      runId: ctx.runId,
      workspacePath: ctx.workspacePath || ctx.worktreePath || undefined
    });
    if (
      result &&
      result.ok &&
      (name === 'fs_write_file' || name === 'fs_edit') &&
      typeof trackArtifact === 'function'
    ) {
      trackArtifact(result.path || (args && args.filePath), {
        diff: result.diff,
        sessionId: sid || undefined
      });
    }
    return result;
  }
  if (name === 'agent_clarify') {
    const el = resolveAgentPlaceholderEl(sessionId);
    if (!el) return { error: '无法展示确认界面' };
    try {
      return await showClarifyInBubble(el, args);
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }
  return { error: `未知 UI 工具: ${name}` };
}

if (typeof window !== 'undefined' && window.diecloud && window.diecloud.onAgentMainToolDelegate) {
  window.diecloud.onAgentMainToolDelegate(async (payload) => {
    const requestId = payload && payload.requestId;
    const name = payload && payload.name;
    const args = (payload && payload.args) || {};
    const sessionId = payload && payload.sessionId ? String(payload.sessionId) : null;
    if (!requestId || !name) return;
    let ctxRestored = false;
    if (sessionId && !getAgentExecutionContext(sessionId)) {
      const live = sessionActiveRuns.get(sessionId);
      if (live) {
        setAgentExecutionContext({
          sessionId,
          runId: live.runId,
          workspacePath: live.workspacePath,
          undoTurnId: live.undoTurnId
        });
        ctxRestored = true;
      }
    }
    try {
      const result = await executeAgentTool(name, args, sessionId);
      await window.diecloud.agentMainToolDelegateResult({ requestId, result });
    } catch (e) {
      await window.diecloud.agentMainToolDelegateResult({
        requestId,
        error: e && e.message ? e.message : String(e)
      });
    } finally {
      if (ctxRestored) clearAgentExecutionContext(sessionId);
    }
  });
}

window.isMutatingAgentTool = isMutatingAgentTool;
window.executeAgentTool = executeAgentTool;
