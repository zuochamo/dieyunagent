/* global window, currentSessionId, sessionActiveRuns, trackArtifact, scheduleArtifactsUiRefresh, scheduleArtifactsUiFlush, showClarifyInBubble, getUndoTurnIdForSession, resolveSessionWorkspacePathSync, DieyunToolCatalog, DieyunToolClassify, normalizeAgentToolName, noteBrowserToolUse, createNewSession, sendMessage, gatewayCall */
'use strict';

const agentToolsApi = window.diecloud || {};

/** @type {Map<string, { runId: string, roleId?: string, worktreePath?: string, workspacePath?: string, sessionId: string, undoTurnId?: string }>} */
const agentExecutionContexts = new Map();

function runExclusiveAgentTool(fn, workspaceKey, holderId, tool) {
  const mq = window.MutateQueue;
  if (mq && typeof mq.runExclusive === 'function') {
    return mq.runExclusive(fn, workspaceKey, holderId, { tool });
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
      // 写入类工具已落盘：full 刷新才会重新 list_dir，让新文件出现在工作面板
      if (typeof scheduleArtifactsUiRefresh === 'function') scheduleArtifactsUiRefresh('full');
      else if (typeof scheduleArtifactsUiFlush === 'function') scheduleArtifactsUiFlush();
      return inner;
    }, workspaceKey, sid, norm.name);
    if (typeof refreshWorkspaceMutateHint === 'function') {
      refreshWorkspaceMutateHint(workspaceKey, sid);
    }
    return result;
  }
  return invoke();
}

/**
 * `session_new` 的执行体：建会话 + 挂工作空间。
 *
 * 唯一实现是 createNewSession（「新对话」按钮走同一条流程）；这里只做参数校验与结果整形，
 * 不重写一遍「先建行、再绑工作空间、再刷历史列表」的顺序 —— 那会立刻变成两份。
 *
 * @param {{ workspacePath?: string, title?: string, prompt?: string }} args
 */
async function createSessionFromTool(args = {}) {
  if (typeof createNewSession !== 'function') return { error: '会话创建入口不可用' };
  const rawPath = args.workspacePath;
  const workspacePath = rawPath == null ? undefined : String(rawPath).trim();
  if (workspacePath === '') return { error: 'workspacePath 不能是空字符串；想沿用当前工作空间就省略该参数' };
  const title = String(args.title || '').trim();
  const prompt = String(args.prompt || '').trim();
  const beforeId = String((typeof currentSessionId !== 'undefined' && currentSessionId) || '');
  await createNewSession(workspacePath, title ? { title } : {});
  const sessionId = String((typeof currentSessionId !== 'undefined' && currentSessionId) || '');
  if (!sessionId || sessionId === beforeId) return { error: '新建对话失败：会话 id 没有变化' };
  // 路径不存在时 Main 会把该会话的 workspace_path 清回 null（见 workspace:set-active-session），
  // 所以这里回读一次账本，把「建了但没挂上」如实告诉模型，别让它以为工作空间已经就位。
  let effectiveWorkspacePath = null;
  if (workspacePath) {
    try {
      const row = await gatewayCall('memory.session_get', { sessionId });
      effectiveWorkspacePath = (row && row.workspacePath) || null;
    } catch {
      // 回读只是校验：查不到不影响「已建会话」这个事实
      effectiveWorkspacePath = null;
    }
  }
  if (workspacePath && !effectiveWorkspacePath) {
    return {
      ok: true,
      sessionId,
      workspacePath: null,
      warning: `已新建对话，但工作空间 ${workspacePath} 不存在或不可用，未挂上；确认路径后可用工作空间选择器重设`
    };
  }
  if (prompt && typeof sendMessage === 'function') {
    // 不能 await：sendMessage 会一直阻塞到那一轮 Agent 跑完，工具调用不能挂在那里。
    // 也不能让它把异常冒成未处理拒绝：这已经是新会话那边的事，失败只影响 prompt 是否发出。
    void Promise.resolve(sendMessage(prompt)).catch(() => {});
  }
  return {
    ok: true,
    sessionId,
    workspacePath: effectiveWorkspacePath || workspacePath || null,
    dispatched: !!(prompt && typeof sendMessage === 'function'),
    warning: prompt && typeof sendMessage !== 'function' ? '已新建对话，但没有可用的发送入口，prompt 未发出' : undefined
  };
}

// 入参必须已归一：两个入口（本地调用 / Main 反向委托）都先过 `executeAgentTool`，
// 归一发生在那里一次即可。内层再归一既无用、又会让人误以为"这里也可以传原始名"。
async function executeAgentToolInner(name, args, sessionId) {
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
  if (name === 'session_new') {
    try {
      return await createSessionFromTool(args || {});
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
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
