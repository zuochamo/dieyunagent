/* global loopApi, settings, currentSessionId, gwState, gatewayCall, createAgentAbortError, buildDieyunMdSystemBlock, assembleSystemPrompt, getContextFilePathsForAgent, getSessionChangeRowsForAgent, waitRemoteCoreForPrep, recordAgentPrepTrace, throwIfAgentAborted, getComposerAgentMode, CTX_LIMITS, getEffectiveInputBudget, skipAutoCodebaseForTaskTier, isTaskTierFeatureEnabled, shouldInjectCodeContext, textHasCodebaseMention, loadEnabledSkillIds, hasAgentContinueCheckpoint, sessionActiveRuns */
'use strict';

const systemMessageCache = new Map();
const SYSTEM_MESSAGE_CACHE_TTL_MS = 3 * 60 * 1000;
const SYSTEM_MESSAGE_CACHE_MAX = 32;

function normalizeSystemCacheQuery(q) {
  return String(q || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

function buildSystemMessageCacheKey(sessionId, userQuery, workspacePath, opts = {}) {
  const budget =
    typeof getEffectiveInputBudget === 'function' ? getEffectiveInputBudget() : 0;
  const mcpFlag =
    Array.isArray(opts.agentTools) &&
    opts.agentTools.some((t) => {
      const name = t && t.function && t.function.name ? String(t.function.name) : '';
      return name.startsWith('mcp_') && name !== 'mcp_tool_schema';
    })
      ? 'mcp'
      : 'nomcp';
  const modeFlag =
    typeof getComposerAgentMode === 'function'
      ? getComposerAgentMode(String(sessionId || '') || undefined)
      : 'agent';
  return `${String(sessionId || '_default')}|${String(workspacePath || '_none')}|${budget}|${mcpFlag}|${modeFlag}|${normalizeSystemCacheQuery(userQuery)}`;
}

function invalidateSystemMessageCache(sessionId) {
  if (sessionId != null && String(sessionId).trim()) {
    const prefix = `${String(sessionId).trim()}|`;
    for (const key of systemMessageCache.keys()) {
      if (key.startsWith(prefix)) systemMessageCache.delete(key);
    }
    return;
  }
  systemMessageCache.clear();
}

function trimSystemMessageCache() {
  if (systemMessageCache.size <= SYSTEM_MESSAGE_CACHE_MAX) return;
  const entries = [...systemMessageCache.entries()].sort((a, b) => a[1].at - b[1].at);
  while (systemMessageCache.size > SYSTEM_MESSAGE_CACHE_MAX && entries.length) {
    const [key] = entries.shift();
    systemMessageCache.delete(key);
  }
}

function workspaceInfoFromPath(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) return null;
  if (/^ssh:/i.test(p)) return { workspacePath: p, kind: 'ssh', sshConnected: true };
  return { workspacePath: p, kind: 'local' };
}

async function buildSystemMessage(userQuery = '', opts = {}) {
  const sessionId = String(opts.sessionId || opts.prepSessionId || '').trim();
  let workspacePathEarly = opts.runWorkspaceRoot || null;
  if (!workspacePathEarly && sessionId && typeof resolveSessionWorkspacePathSync === 'function') {
    workspacePathEarly = resolveSessionWorkspacePathSync(sessionId);
  }
  // 有 sessionId 时禁止回落到当前视图工作区，避免并行本地任务串台
  if (!workspacePathEarly && !sessionId && loopApi.getWorkspace) {
    try {
      const ws = await loopApi.getWorkspace();
      workspacePathEarly = ws && ws.workspacePath ? ws.workspacePath : null;
    } catch {
      workspacePathEarly = null;
    }
  }
  const cacheKey = buildSystemMessageCacheKey(
    opts.sessionId,
    userQuery,
    workspacePathEarly,
    opts
  );
  if (!opts.skipSystemCache && !opts.prepSessionId) {
    const hit = systemMessageCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SYSTEM_MESSAGE_CACHE_TTL_MS) {
      return hit.packed || (typeof unwrapSystemPromptPack === 'function'
        ? unwrapSystemPromptPack(hit.content)
        : { stable: hit.content, turnRide: '', content: hit.content });
    }
  }
  const packed = await buildSystemMessageBody(userQuery, opts);
  systemMessageCache.set(cacheKey, { packed, at: Date.now() });
  trimSystemMessageCache();
  return packed;
}

async function buildSystemMessageBody(userQuery = '', opts = {}) {
  const prepSid = opts.prepSessionId ? String(opts.prepSessionId) : '';
  const sessionId = String(opts.sessionId || prepSid || '').trim();
  const abortSignal = opts.signal || null;
  const abortIfNeeded = () => {
    if (abortSignal?.aborted) throw createAgentAbortError();
  };
  const prepStart = (id) => {
    abortIfNeeded();
    if (prepSid && typeof agentPrepStepStart === 'function') agentPrepStepStart(prepSid, id);
  };
  const prepDone = (id) => {
    if (prepSid && typeof agentPrepStepDone === 'function') agentPrepStepDone(prepSid, id);
    abortIfNeeded();
  };
  const prepFail = (id, detail) => {
    if (prepSid && typeof agentPrepStepFail === 'function') agentPrepStepFail(prepSid, id, detail);
  };
  const languagePrompt =
    window.dieyunI18n && typeof window.dieyunI18n.agentLanguagePrompt === 'function'
      ? window.dieyunI18n.agentLanguagePrompt()
      : '';
  const extraStable = [];
  const extraTurn = [];

  let workspacePath = opts.runWorkspaceRoot || null;
  let workspaceInfo = opts.workspaceInfo || null;
  if (!workspacePath && sessionId && typeof resolveSessionWorkspacePathSync === 'function') {
    workspacePath = resolveSessionWorkspacePathSync(sessionId);
  }
  if (!workspacePath && sessionId && typeof resolveSessionWorkspacePath === 'function') {
    try {
      workspacePath = await resolveSessionWorkspacePath(sessionId);
    } catch {
      workspacePath = null;
    }
  }
  if (workspacePath && !workspaceInfo) {
    workspaceInfo = workspaceInfoFromPath(workspacePath);
  }
  if (!workspacePath && !sessionId && loopApi.getWorkspace) {
    try {
      workspaceInfo = await loopApi.getWorkspace();
      workspacePath = workspaceInfo && workspaceInfo.workspacePath ? workspaceInfo.workspacePath : null;
    } catch {
      workspaceInfo = null;
    }
  }

  const rpcScope = {
    sessionId: sessionId || undefined,
    runWorkspaceRoot: workspacePath || undefined
  };

  const injectCode =
    typeof shouldInjectCodeContext === 'function'
      ? shouldInjectCodeContext(userQuery, {
          workspaceInfo,
          includeEditor: !(
            sessionId &&
            typeof currentSessionId !== 'undefined' &&
            sessionId !== String(currentSessionId || '')
          )
        })
      : true;
  const allowCodebase =
    injectCode || (typeof textHasCodebaseMention === 'function' && textHasCodebaseMention(userQuery));
  const skipFastIndex =
    typeof skipAutoCodebaseForTaskTier === 'function' &&
    skipAutoCodebaseForTaskTier(
      opts.taskTier,
      typeof isTaskTierFeatureEnabled === 'function' ? isTaskTierFeatureEnabled() : undefined
    );

  await waitRemoteCoreForPrep(prepSid, workspaceInfo, { skipWait: skipFastIndex });
  abortIfNeeded();

  const codeChunks = [];
  let codebaseIndexOk = false;
  let graphIndexOk = false;

  const collectCodebase = async () => {
    try {
      prepStart('codebase');
      // status → 未就绪则 start 一次（后台）；一律不等待，索引就绪后才注入
      if (allowCodebase && workspacePath && typeof gatewayCall === 'function') {
        const ensure =
          typeof ensurePrepIndexReady === 'function' ? ensurePrepIndexReady : null;
        const readyFn =
          typeof isCodebasePrepReady === 'function'
            ? isCodebasePrepReady
            : (st) =>
                !!(
                  st &&
                  st.indexed &&
                  !st.indexing &&
                  (Number(st.chunkCount) || Number(st.chunk_count) || 0) > 0
                );
        let indexOk = false;
        let softSkip = null;
        if (ensure && !skipFastIndex) {
          const r = await ensure({
            kind: 'codebase',
            workspacePath,
            prepSid,
            abortIfNeeded,
            gatewayCall,
            isReady: readyFn
          });
          indexOk = !!(r && r.ok);
          if (r && r.skipped && !r.ok) softSkip = r.error || '索引未就绪，本次不等待';
        } else if (!ensure) {
          indexOk = true;
        }
        codebaseIndexOk = indexOk;
        if (typeof buildCursorLikeContextBlocks === 'function') {
          const cursorCtx = await buildCursorLikeContextBlocks(userQuery, workspaceInfo, {
            ...rpcScope,
            fetchCodebase: async () => '',
            maxPreviews: 0,
            includeGitDiff: false,
            skipOpenFiles: true,
            skipChanges: true
          });
          for (const block of cursorCtx.chunks || []) {
            if (block) codeChunks.push(block);
          }
        } else if (injectCode) {
          if (
            workspaceInfo?.workspacePath &&
            typeof fetchWorkspaceDiagnosticsContext === 'function' &&
            typeof shouldFetchWorkspaceDiagnostics === 'function' &&
            shouldFetchWorkspaceDiagnostics(userQuery, workspaceInfo)
          ) {
            const diagnosticsBlock = await fetchWorkspaceDiagnosticsContext(userQuery, {
              workspaceInfo,
              ...rpcScope
            });
            if (diagnosticsBlock) codeChunks.push(diagnosticsBlock);
          }
        }
        if (softSkip && typeof agentPrepStepSkip === 'function') {
          agentPrepStepSkip(prepSid, 'codebase', softSkip);
        } else {
          prepDone('codebase');
        }
      } else {
        prepDone('codebase');
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      prepFail('codebase', msg);
      if (
        !/超时|timeout|dieyun-core 已停止|dieyun-core 已退出|EXEC_ERROR|暂不可用|不等待|已发起|创建中/i.test(
          msg
        )
      ) {
        throw err;
      }
    }
  };

  const collectGraph = async () => {
    try {
      if (!workspacePath || typeof gatewayCall !== 'function' || skipFastIndex) {
        if (typeof agentPrepStepSkip === 'function') {
          agentPrepStepSkip(
            prepSid,
            'graph',
            skipFastIndex ? '本轮不依赖结构索引' : undefined
          );
        }
        return;
      }
      prepStart('graph');
      const ensure =
        typeof ensurePrepIndexReady === 'function' ? ensurePrepIndexReady : null;
      const readyFn =
        typeof isGraphPrepReady === 'function'
          ? isGraphPrepReady
          : (st) =>
              !!(
                st &&
                st.indexed &&
                !st.indexing &&
                ((Number(st.symbolCount) || Number(st.symbol_count) || 0) > 0 ||
                  (Number(st.edgeCount) || Number(st.edge_count) || 0) > 0)
              );
      if (ensure) {
        const r = await ensure({
          kind: 'graph',
          workspacePath,
          prepSid,
          abortIfNeeded,
          gatewayCall,
          isReady: readyFn
        });
        graphIndexOk = !!(r && r.ok);
        if (r && r.skipped && !r.ok && typeof agentPrepStepSkip === 'function') {
          agentPrepStepSkip(prepSid, 'graph', r.error || '结构索引未就绪，本次不等待');
        } else {
          prepDone('graph');
        }
      } else {
        graphIndexOk = true;
        prepDone('graph');
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      prepFail('graph', msg);
      if (
        !/超时|timeout|dieyun-core 已停止|dieyun-core 已退出|EXEC_ERROR|暂不可用|不等待|已发起|创建中/i.test(
          msg
        )
      ) {
        throw err;
      }
    }
  };

  await Promise.all([collectCodebase(), collectGraph()]);
  extraTurn.push(...codeChunks);

  try {
    const dieyunBlock = await buildDieyunMdSystemBlock(userQuery);
    if (dieyunBlock) extraTurn.push(dieyunBlock);
  } catch {
    // ignore
  }

  const composerMode =
    typeof getComposerAgentMode === 'function'
      ? getComposerAgentMode(sessionId || undefined)
      : '';
  const includeEditor = !(
    sessionId &&
    typeof currentSessionId !== 'undefined' &&
    sessionId !== String(currentSessionId || '')
  );
  const editorCtx =
    includeEditor && typeof window.getMonacoEditorContext === 'function'
      ? window.getMonacoEditorContext()
      : null;
  const selectedArtifact =
    typeof window.getSelectedArtifactPath === 'function'
      ? window.getSelectedArtifactPath(sessionId || undefined)
      : '';
  const openFilePaths =
    typeof getMergedContextFilePaths === 'function'
      ? getMergedContextFilePaths(sessionId || undefined)
      : typeof getContextFilePathsForAgent === 'function'
        ? getContextFilePathsForAgent(sessionId)
        : [];
  const changeRows =
    injectCode && typeof getSessionChangeRowsForAgent === 'function'
      ? (getSessionChangeRowsForAgent(sessionId) || []).slice(0, 16).map((r) => ({
          path: r.path,
          diff: r.diff ? { added: r.diff.added || 0, removed: r.diff.removed || 0 } : null
        }))
      : [];
  const snapshot = {
    userQuery,
    sessionId,
    runWorkspaceRoot: workspacePath || undefined,
    workspaceInfo,
    languagePrompt,
    userSystem: settings.system || '',
    composerMode,
    taskTier: opts.taskTier,
    injectCode,
    allowCodebase,
    includeEditor,
    indexOk: codebaseIndexOk,
    skipFastIndex,
    graphIndexOk,
    compactMcpTools:
      Array.isArray(opts.agentTools) &&
      opts.agentTools.some((t) => {
        const name = t && t.function && t.function.name ? String(t.function.name) : '';
        return name.startsWith('mcp_') && name !== 'mcp_tool_schema';
      }),
    openFilePaths,
    changeRows,
    editor: {
      hasActiveFile: !!(editorCtx && editorCtx.activeFilePath),
      hasSelection: !!(editorCtx && editorCtx.selection && editorCtx.selection.text),
      hasArtifact: !!selectedArtifact
    },
    enabledSkillMap: typeof loadEnabledSkillIds === 'function' ? loadEnabledSkillIds() : {},
    skillCatalogMode: true,
    hasContinueCheckpoint:
      typeof hasAgentContinueCheckpoint === 'function' && hasAgentContinueCheckpoint(sessionId),
    hasActiveRun:
      typeof sessionActiveRuns !== 'undefined' &&
      sessionActiveRuns &&
      typeof sessionActiveRuns.has === 'function' &&
      sessionActiveRuns.has(String(sessionId || '')),
    stableDataChunks: extraStable,
    turnDataChunks: extraTurn
  };
  prepStart('memory');
  prepStart('skills_mcp');
  try {
    const diecloud = typeof window !== 'undefined' ? window.diecloud : null;
    if (diecloud && typeof diecloud.agentPrepSystemPrompt === 'function') {
      return await diecloud.agentPrepSystemPrompt(snapshot);
    }
    return assembleSystemPrompt({
      languagePrompt,
      userSystem: snapshot.userSystem,
      composerMode,
      taskTier: opts.taskTier,
      workspaceInfo,
      stableDataChunks: extraStable,
      turnDataChunks: extraTurn
    });
  } finally {
    prepDone('memory');
    prepDone('skills_mcp');
  }
}
