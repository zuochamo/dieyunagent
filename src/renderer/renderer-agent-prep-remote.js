/* global loopApi, gatewayCall, fetchCodebaseContext, isRemoteSessionWorkspacePath, agentPrepStepStart, agentPrepStepDone, agentPrepStepSkip, agentPrepStepFail, agentPrepStepNote, recordAgentPrepTrace, textHasCodebaseMention, shouldAutoCodebaseSearch */
'use strict';

async function buildCodebaseMentionContext(text, rpcScope = {}) {
  if (!textHasCodebaseMention(text)) {
    return '';
  }
  return fetchCodebaseContext(text, rpcScope);
}

async function buildAutoCodebaseContext(userQuery, ws, rpcScope = {}) {
  if (typeof window.getMonacoEditorContext === 'function') {
    const ctx = window.getMonacoEditorContext();
    if (ctx && ctx.activeFilePath) return '';
  }
  if (typeof window.getSelectedArtifactPath === 'function') {
    const selected = window.getSelectedArtifactPath();
    if (selected) return '';
  }
  if (!shouldAutoCodebaseSearch(userQuery, ws)) return '';
  return fetchCodebaseContext(userQuery, {
    ...rpcScope,
    ...(ws?.workspacePath ? { runWorkspaceRoot: ws.workspacePath } : {})
  });
}

const REMOTE_CORE_PREP_TIMEOUT_MS = 45000;
const REMOTE_CORE_PREP_CONFIGURE_RETRIES = 3;
/** 含一次自愈（SSH 重连 / ensure gateway）+ 二次 wait */
const REMOTE_CORE_PREP_GATEWAY_TIMEOUT_MS = 120000;
/** 同一远程工作区近期已就绪则跳过 wait_ready */
const REMOTE_CORE_READY_TTL_MS = 60000;

/** @type {Map<string, number>} */
const remoteCoreReadyAt = new Map();

function rememberRemoteCoreReady(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (p) remoteCoreReadyAt.set(p, Date.now());
}

function isRemoteCoreReadyCached(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) return false;
  const at = remoteCoreReadyAt.get(p);
  return at != null && Date.now() - at < REMOTE_CORE_READY_TTL_MS;
}

function invalidateRemoteCoreReadyCache(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (p) remoteCoreReadyAt.delete(p);
  else remoteCoreReadyAt.clear();
}

function isCodebaseContextFailure(block) {
  return typeof block === 'string' && /状态：失败/.test(block);
}

async function waitRemoteCoreForPrep(prepSid, workspaceInfo, opts = {}) {
  const wsPath = workspaceInfo && workspaceInfo.workspacePath ? workspaceInfo.workspacePath : '';
  if (!prepSid || !isRemoteSessionWorkspacePath(wsPath)) {
    if (prepSid && typeof agentPrepStepSkip === 'function') agentPrepStepSkip(prepSid, 'remote_core');
    return { ok: true, skipped: true };
  }
  if (opts.skipWait) {
    if (typeof agentPrepStepSkip === 'function') {
      agentPrepStepSkip(prepSid, 'remote_core', '本轮不依赖远程索引');
    }
    return { ok: true, skipped: true };
  }
  if (isRemoteCoreReadyCached(wsPath)) {
    if (typeof agentPrepStepDone === 'function') agentPrepStepDone(prepSid, 'remote_core');
    return { ok: true, skipped: true, cached: true };
  }
  if (typeof agentPrepStepStart === 'function') agentPrepStepStart(prepSid, 'remote_core');
  try {
    const result = await gatewayCall(
      'index.remote_wait_ready',
      {
        workspaceRoot: wsPath,
        sessionId: prepSid,
        runWorkspaceRoot: wsPath,
        timeoutMs: REMOTE_CORE_PREP_TIMEOUT_MS,
        maxConfigureRetries: REMOTE_CORE_PREP_CONFIGURE_RETRIES
      },
      { timeoutMs: REMOTE_CORE_PREP_GATEWAY_TIMEOUT_MS }
    );
    if (result && result.ok) {
      rememberRemoteCoreReady(wsPath);
      if (result.healed && typeof agentPrepStepNote === 'function') {
        agentPrepStepNote(prepSid, 'remote_core', '已恢复远程连接');
      }
      if (typeof agentPrepStepDone === 'function') agentPrepStepDone(prepSid, 'remote_core');
      if (result.healed && typeof showAgentToast === 'function') {
        const viaSsh = Array.isArray(result.heal?.steps) && result.heal.steps.includes('ssh_reconnected');
        showAgentToast(
          '远程连接已恢复',
          viaSsh ? 'SSH 与 Remote Agent 已重新就绪' : 'Remote Agent 隧道已重新就绪',
          { variant: 'info' }
        );
      }
      return result;
    }
    invalidateRemoteCoreReadyCache(wsPath);
    const errText =
      (result && (result.error || result.reason)) || '远程 dieyun-core 未就绪';
    if (typeof agentPrepStepSkip === 'function') {
      agentPrepStepSkip(prepSid, 'remote_core', errText);
    } else if (typeof agentPrepStepFail === 'function') {
      agentPrepStepFail(prepSid, 'remote_core', errText);
    }
    return { ok: false, skipped: true, error: errText };
  } catch (e) {
    invalidateRemoteCoreReadyCache(wsPath);
    const errText = e && e.message ? e.message : String(e);
    if (typeof agentPrepStepSkip === 'function') {
      agentPrepStepSkip(prepSid, 'remote_core', errText);
    } else if (typeof agentPrepStepFail === 'function') {
      agentPrepStepFail(prepSid, 'remote_core', errText);
    }
    return { ok: false, skipped: true, error: errText };
  }
}

if (typeof window !== 'undefined') {
  window.waitRemoteCoreForPrep = waitRemoteCoreForPrep;
  window.invalidateRemoteCoreReadyCache = invalidateRemoteCoreReadyCache;
  window.buildCodebaseMentionContext = buildCodebaseMentionContext;
  window.buildAutoCodebaseContext = buildAutoCodebaseContext;
}
