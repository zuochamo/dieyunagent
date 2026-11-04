/* global window, currentSessionId, sessionActiveRuns, trackArtifact, scheduleArtifactsUiRefresh, scheduleArtifactsUiFlush, showClarifyInBubble, getUndoTurnIdForSession, resolveSessionWorkspacePathSync, DieyunToolCatalog, DieyunToolClassify, normalizeAgentToolName, noteBrowserToolUse, createNewSession, sendMessage, gatewayCall */
'use strict';

const agentToolsApi = window.diecloud || {};

/**
 * `session_new` 派发 prompt 后，等待「早期失败」的窗口（毫秒）。
 * sendMessage 整轮跑完可能几分钟，等不得；但「发不出去」几乎都在这个窗口内就拒绝。
 * 取值只影响工具返回里 `dispatched` 的真实性，不影响发送本身。
 */
const SESSION_NEW_DISPATCH_PROBE_MS = 800;

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
    const result = await runExclusiveAgentTool(async () => {
      const inner = await invoke();
      // 写入类工具已落盘：full 刷新才会重新 list_dir，让新文件出现在工作面板
      if (typeof scheduleArtifactsUiRefresh === 'function') scheduleArtifactsUiRefresh('full');
      else if (typeof scheduleArtifactsUiFlush === 'function') scheduleArtifactsUiFlush();
      return inner;
    }, workspaceKey, sid, norm.name);
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
  if (!sessionId || sessionId === beforeId) {
    return {
      error:
        '新建对话失败：会话 id 没有变化。常见原因是 workspacePath 无法识别（远端须写成 ssh://user@host/path）或工作空间不可用'
    };
  }
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
  let dispatched = false;
  let dispatchWarning;
  if (prompt && typeof sendMessage === 'function') {
    // 不能 await 整轮（sendMessage 会阻塞到那一轮 Agent 跑完），但「发不出去」通常是
    // 同步/近同步就拒绝的（模型未配置、会话正忙、正在切换对话、SSH 没连上）。
    // 所以只等一个短窗口把早期失败如实回给模型 —— 否则 dispatched 恒为 true，
    // 失败就成了静默的「已派发，其实什么都没跑」。
    const sending = Promise.resolve(sendMessage(prompt));
    let state = 'pending';
    sending.then(
      () => {
        state = 'done';
      },
      (err) => {
        state = 'failed';
        const msg = err && err.message ? String(err.message) : String(err || '');
        dispatchWarning = msg ? `prompt 未派发成功：${msg}` : 'prompt 未派发成功';
      }
    );
    await new Promise((resolve) => setTimeout(resolve, SESSION_NEW_DISPATCH_PROBE_MS));
    dispatched = state !== 'failed';
    void sending.catch(() => {});
  }
  return {
    ok: true,
    sessionId,
    workspacePath: effectiveWorkspacePath || workspacePath || null,
    dispatched,
    warning:
      dispatchWarning ||
      (prompt && typeof sendMessage !== 'function'
        ? '已新建对话，但没有可用的发送入口，prompt 未发出'
        : undefined)
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
  if (name === 'session_set_workspace') {
    if (typeof window.applySessionWorkspaceFromTool !== 'function') {
      return { error: '工作空间切换不可用（渲染器未就绪）' };
    }
    try {
      // 带上这一轮真正跑的会话：它不在前台时只改那条会话的绑定，不动桌面视图
      return await window.applySessionWorkspaceFromTool({
        ...(args || {}),
        sessionId: sessionId || undefined
      });
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
