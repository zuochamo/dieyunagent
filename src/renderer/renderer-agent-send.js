/* global isSessionSwitchInFlight, loopApi, currentSessionId, cleanupStaleSessionRun, resolveComposerModelForSend, attachmentNeedsVision, getCustomModelApiConfig, appendBubble, isCurrentSessionSending, getAgentContinueState, resumeAgentToolLoop, clearAgentContinueState, closeStaleAgentRunForSession, getPendingResumeCheckpoint, tryDetectResumeCheckpoint, clearPendingResumeCheckpoint, cloneAttachmentSnapshot, getPendingAttachments, appendUserTurn, setComposerSendingState, isImageAttachment, revokeAttachmentPreview, renderAttachmentChips, processAttachmentsForSend, syncComposerForActiveSession, focusChatInput, invalidateSessionMessageCache, packUserMessageMeta, messages, setMessagesOwnerSessionId, getMessagesOwnerSessionId, messagesBelongToSession, getSessionMessageCache, selectHistoryMessagesForSession, cloneHistoryMessages, renderChatFromMessages, gwState, resolveSessionWorkspacePath, bindCurrentSessionWorkspace, gatewayCall, sessionListTitle, refreshHistoryList, createTraceRunId, getComposerAgentMode, resetActiveRunContextUiState, beginComposerUsageAttribution, sessionActiveRuns, refreshContextProgress, throwIfAgentAborted, waitForAgentAbortable, isRemoteSessionWorkspacePath, syncSessionRemoteLease, finishSessionActiveRun, finalizeAssistantBubble, initAgentPrepSteps, renderAssistantBubbleContent, scrollChatToBottom, agentPrepStepStart, beginTurnUndo, agentPrepStepDone, agentPrepStepSkip, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, buildSystemMessage, buildAgentTools, buildExploreTools, buildExploreCoordinatorTools, setSessionContextEstimate, estimateToolsTokens, modelSupportsMultimodal, extractPreparedImageParts, composerModeLabel, formatModelFooterLabel, resolveUserMsgCreatedAt, canMutateViewMessages, settings, buildCompletionMessages, unwrapSystemPromptPack, joinPromptChunks, getMaxOutputTokens, buildSessionChatHistoryBlock, runAgentCompletion, pauseAgentForToolLimit, completeAgentRunAfterSuccess, finishAgentPrepPhase, isUserAbortError, resolveStoppedDisplayTrace, resolveFailedDisplayTrace, normalizeStoppedTrace, getLastAgentDisplayedTrace, buildFallbackTurnMeta, finalizeUndoForUserTurn, buildStoppedFooterMeta, persistStoppedAssistant, finalizeUserTurnFooter, cloneTraceForMobile, shouldPauseForNetworkDisconnect, pauseAgentForNetworkDisconnect, formatAgentApiError, persistFailedAssistantTurn, scheduleWorktreePolicyCleanup, autoCloseBrowserAfterAgentRun, isTaskTierFeatureEnabled, inferTaskTierFromStructure, extractPathHintsFromText, textHasCodebaseMention, getAgentLimits, fetchChatCompletion, pauseComposerQueueAfterUserStop, setLastMemoryInjectionAudit */
'use strict';

function rejectAgentServiceTask(requestId, sessionId, error) {
  if (requestId && loopApi.agentServiceTaskRejected) {
    loopApi.agentServiceTaskRejected({
      requestId,
      sessionId,
      error
    });
  }
}

async function gateSendMessage(text, options) {
  const fromQueue = options.fromQueue === true;
  const agentServiceRequestId = options.agentServiceRequestId
    ? String(options.agentServiceRequestId)
    : '';
  // 切换历史进行中禁止发送，避免 UI 已亮新会话但 currentSessionId/messages 仍属旧会话
  if (
    typeof isSessionSwitchInFlight === 'function' &&
    isSessionSwitchInFlight()
  ) {
    rejectAgentServiceTask(
      agentServiceRequestId,
      String(options.sessionId || currentSessionId || ''),
      '正在切换对话，请稍后再发'
    );
    return null;
  }
  // 在任何 await 之前固定会话，避免附件处理中切会话导致写错 messages / 绑错 run
  const runSessionId = String(options.sessionId || currentSessionId || '');
  cleanupStaleSessionRun(runSessionId);
  const pendingModel = resolveComposerModelForSend(text, {
    hasImages: attachmentNeedsVision(),
    sessionId: runSessionId
  });
  const pendingApiConfig = pendingModel.apiConfig || getCustomModelApiConfig(pendingModel.route);
  if (!pendingModel.model || !pendingApiConfig?.baseUrl) {
    appendBubble(
      'assistant',
      '尚未配置可用模型，请前往「模型设置」添加自定义模型，或在「供应商」中添加接口并启用模型。',
      { error: true }
    );
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, '尚未配置可用模型');
    return null;
  }
  if (
    String(runSessionId) === String(currentSessionId || '') &&
    isCurrentSessionSending() &&
    !options.fromQueue
  ) {
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, '当前会话已有任务在执行');
    return null;
  }
  // 协议续跑：仅当已有 continue checkpoint 时，短命令「继续/continue/resume」触发 resume（非意图词表路由）
  const trimmedCmd = String(text || '').trim().toLowerCase();
  const protocolContinue =
    (trimmedCmd === '继续' || trimmedCmd === 'continue' || trimmedCmd === 'resume');
  if (protocolContinue) {
    const pendingContinue =
      typeof getAgentContinueState === 'function' ? getAgentContinueState(runSessionId) : null;
    if (pendingContinue && pendingContinue.sessionId === runSessionId) {
      await resumeAgentToolLoop();
      return null;
    }
  }
  if (typeof clearAgentContinueState === 'function') {
    clearAgentContinueState(runSessionId);
  }
  let allowPlannerResume = false;
  await closeStaleAgentRunForSession(runSessionId, text);
  if (String(runSessionId) !== String(currentSessionId || '')) {
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, '发送过程中已切换会话');
    return null;
  }
  if (protocolContinue) {
    // 无 tool-loop continue state 时，尝试恢复 planner 断点
    if (!getPendingResumeCheckpoint(runSessionId)) {
      await tryDetectResumeCheckpoint(runSessionId);
    }
    allowPlannerResume = !!getPendingResumeCheckpoint(runSessionId);
  } else {
    // 新消息视为新任务：清断点
    clearPendingResumeCheckpoint(runSessionId);
  }

  return {
    fromQueue,
    agentServiceRequestId,
    runSessionId,
    allowPlannerResume
  };
}

function isolateViewMessagesForSend(runSessionId) {
  const sid = String(runSessionId || '');
  if (!sid) return;
  if (typeof messagesBelongToSession === 'function' && messagesBelongToSession(sid)) {
    return;
  }
  let cachedList = [];
  if (typeof getSessionMessageCache === 'function') {
    const cached = getSessionMessageCache(sid);
    if (cached && Array.isArray(cached.messages)) cachedList = cached.messages;
  }
  const next =
    typeof selectHistoryMessagesForSession === 'function'
      ? selectHistoryMessagesForSession({
          runSessionId: sid,
          ownerSessionId:
            typeof getMessagesOwnerSessionId === 'function' ? getMessagesOwnerSessionId() : '',
          viewMessages: messages,
          cachedMessages: cachedList
        })
      : cachedList.slice();
  messages.length = 0;
  messages.push(...next);
  if (typeof setMessagesOwnerSessionId === 'function') {
    setMessagesOwnerSessionId(sid);
  }
  if (typeof renderChatFromMessages === 'function') {
    renderChatFromMessages();
  }
}

async function prepareSendUserTurn(state, text, options) {
  const { fromQueue, runSessionId, agentServiceRequestId } = state;

  isolateViewMessagesForSend(runSessionId);

  const attachmentSnapshot = Array.isArray(options.attachments)
    ? cloneAttachmentSnapshot(options.attachments)
    : getPendingAttachments().slice();
  const displayText =
    attachmentSnapshot.length && text
      ? `${text}\n📎 ${attachmentSnapshot.map((a) => a.originalName).join(', ')}`
      : attachmentSnapshot.length
        ? `📎 ${attachmentSnapshot.map((a) => a.originalName).join(', ')}`
        : text;

  const userTurnResult = appendUserTurn(displayText || '(附件)', {
    attachments: cloneAttachmentSnapshot(attachmentSnapshot),
    skipScroll: fromQueue,
    forceScroll: !fromQueue
  });
  const userTurn = userTurnResult.turn;
  state.userTurnResult = userTurnResult;
  state.userTurn = userTurn;
  state.turnWithdrawMeta = {
    inputText: text,
    attachments: cloneAttachmentSnapshot(attachmentSnapshot)
  };
  state.userMsgIndex = -1;
  state.turnMeta = null;
  state.userLocalMsgId = null;
  state.agentServiceDone = false;
  state.displayText = displayText;

  state.notifyAgentServiceDone = (payload) => {
    if (!agentServiceRequestId || !loopApi.agentServiceTaskCompleted || state.agentServiceDone) return;
    state.agentServiceDone = true;
    loopApi.agentServiceTaskCompleted({
      requestId: agentServiceRequestId,
      sessionId: payload.sessionId || runSessionId,
      ...payload
    });
  };

  if (attachmentSnapshot.some(isImageAttachment)) {
    setComposerSendingState(true);
  }

  let prepared = {
    content: text || (attachmentSnapshot.length ? '请根据附件协助我。' : ''),
    hasImages: false,
    textForStorage: text || ''
  };
  if (attachmentSnapshot.length) {
    for (const att of attachmentSnapshot) revokeAttachmentPreview(att);
    getPendingAttachments().length = 0;
    renderAttachmentChips();
    try {
      prepared = await processAttachmentsForSend(text, attachmentSnapshot);
      state.turnWithdrawMeta.attachments = cloneAttachmentSnapshot(attachmentSnapshot);
    } catch (err) {
      appendBubble('assistant', `附件处理失败：${err.message || err}`, { error: true });
      try {
        if (userTurnResult && userTurnResult.turn && userTurnResult.turn.parentNode) {
          userTurnResult.turn.remove();
        }
      } catch {
        // ignore
      }
      rejectAgentServiceTask(
        agentServiceRequestId,
        runSessionId,
        err.message || String(err) || '附件处理失败'
      );
      if (typeof syncComposerForActiveSession === 'function') {
        syncComposerForActiveSession();
      } else {
        setComposerSendingState(false);
      }
      focusChatInput();
      return 'abort';
    }
  } else {
    prepared = { content: text, hasImages: false, textForStorage: text };
  }

  if (String(currentSessionId || '') !== runSessionId) {
    try {
      if (userTurnResult && userTurnResult.turn && userTurnResult.turn.parentNode) {
        userTurnResult.turn.remove();
      }
    } catch {
      // ignore
    }
    if (typeof invalidateSessionMessageCache === 'function') {
      invalidateSessionMessageCache(runSessionId);
    }
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, '发送过程中已切换会话');
    if (typeof syncComposerForActiveSession === 'function') {
      syncComposerForActiveSession();
    } else {
      setComposerSendingState(false);
    }
    return 'abort';
  }

  const userContent = prepared.content;
  const fullText = prepared.textForStorage || text;
  state.prepared = prepared;
  state.userContent = userContent;
  state.fullText = fullText;

  messages.push({
    role: 'user',
    content:
      typeof packUserMessageMeta === 'function'
        ? packUserMessageMeta(fullText, state.turnWithdrawMeta)
        : fullText,
    displayContent: displayText || '(附件)',
    meta: { ...state.turnWithdrawMeta },
    created_at: Date.now()
  });
  state.userMsgIndex = messages.length - 1;
  if (typeof setMessagesOwnerSessionId === 'function') {
    setMessagesOwnerSessionId(runSessionId);
  }
  state.historyMessages =
    typeof cloneHistoryMessages === 'function'
      ? cloneHistoryMessages(messages)
      : messages.slice();

  /** 后台持久化用户消息，不阻塞 Agent UI */
  state.userGatewayPersist = null;
  if (gwState.authed) {
    state.userGatewayPersist = (async () => {
      const ins = await gatewayCall('memory.message_append', {
        sessionId: runSessionId,
        role: 'user',
        content:
          typeof packUserMessageMeta === 'function'
            ? packUserMessageMeta(fullText, state.turnWithdrawMeta)
            : fullText
      });
      await gatewayCall('memory.touch_session', {
        sessionId: runSessionId,
        title: sessionListTitle({ title: null, preview: displayText || fullText })
      }).catch(() => {});
      refreshHistoryList().catch(() => {});
      return ins;
    })().catch((e) => {
      console.warn(e);
      return null;
    });
  }

  return 'ok';
}

function installSendRunShell(state) {
  const { fromQueue, runSessionId, agentServiceRequestId } = state;

  state.agentRunId = createTraceRunId();
  state.runAbortController = new AbortController();

  const runMode =
    typeof getComposerAgentMode === 'function' ? getComposerAgentMode(runSessionId) : 'agent';
  state.agentRunMode = runMode;
  state.execUsesPlanner = runMode === 'plan';
  state.execExplore = runMode === 'explore';

  resetActiveRunContextUiState(runSessionId);
  beginComposerUsageAttribution(runSessionId);

  sessionActiveRuns.set(runSessionId, {
    runId: state.agentRunId,
    trace: [],
    placeholderEl: null,
    agentServiceRequestId,
    streamContent: '',
    abortController: state.runAbortController,
    gatewayRunId: null,
    workspacePath: null,
    undoTurnId: null,
    agentRunMode: runMode
  });

  state.placeholder = appendBubble('assistant', '', {
    loading: true,
    trace: [],
    skipScroll: fromQueue,
    sessionId: runSessionId
  });
  sessionActiveRuns.get(runSessionId).placeholderEl = state.placeholder;
  syncComposerForActiveSession();
  refreshContextProgress();
}

async function resolveSendWorkspace(state) {
  const { runSessionId, runAbortController, placeholder } = state;

  try {
    throwIfAgentAborted(runAbortController.signal);
    state.runWorkspacePath = await waitForAgentAbortable(
      (async () => {
        let p =
          typeof resolveSessionWorkspacePathSync === 'function'
            ? resolveSessionWorkspacePathSync(runSessionId)
            : null;
        if (!p && typeof resolveSessionWorkspacePath === 'function') {
          p = await resolveSessionWorkspacePath(runSessionId);
        }
        if (isRemoteSessionWorkspacePath(p)) {
          await syncSessionRemoteLease(runSessionId, p, true);
        }
        return p;
      })(),
      runAbortController.signal
    );
    const liveAfterWs = sessionActiveRuns.get(runSessionId);
    if (liveAfterWs) liveAfterWs.workspacePath = state.runWorkspacePath;
    if (state.runWorkspacePath && typeof bindCurrentSessionWorkspace === 'function') {
      await bindCurrentSessionWorkspace(runSessionId, state.runWorkspacePath, { bindOnly: true });
    }
  } catch (err) {
    if (err.name === 'AbortError' || isUserAbortError(err)) {
      if (typeof pauseComposerQueueAfterUserStop === 'function') {
        pauseComposerQueueAfterUserStop(runSessionId);
      }
      finalizeAssistantBubble(runSessionId, placeholder, {
        content: '已停止生成。',
        trace: [],
        hitRoundLimit: false,
        stopped: true
      });
      state.notifyAgentServiceDone({
        sessionId: runSessionId,
        status: 'stopped',
        summary: '已停止生成。',
        trace: []
      });
      return false;
    }
    throw err;
  }

  return true;
}

async function executeSendPrepAndRun(state) {
  const {
    runSessionId,
    runAbortController,
    placeholder,
    execUsesPlanner,
    prepared,
    fullText,
    agentServiceRequestId,
    userMsgIndex,
    userTurn,
    userGatewayPersist,
    allowPlannerResume,
    agentRunId,
    runWorkspacePath,
    historyMessages
  } = state;
  const turnWithdrawMeta = state.turnWithdrawMeta;

  state.ensureUserLocalMsgId = async function ensureUserLocalMsgId() {
    if (state.userLocalMsgId || !userGatewayPersist) return state.userLocalMsgId;
    try {
      const ins = await userGatewayPersist;
      state.userLocalMsgId = ins?.localMsgId || null;
      if (
        state.userLocalMsgId &&
        userMsgIndex >= 0 &&
        messages[userMsgIndex] &&
        (typeof canMutateViewMessages !== 'function' || canMutateViewMessages(runSessionId))
      ) {
        messages[userMsgIndex].localMsgId = state.userLocalMsgId;
        messages[userMsgIndex].id = state.userLocalMsgId;
      }
    } catch (e) {
      console.warn(e);
    }
    return state.userLocalMsgId;
  };

  if (typeof initAgentPrepSteps === 'function') {
    initAgentPrepSteps(runSessionId, {
      skipUndo: state.execExplore,
      skipUndoReason: state.execExplore ? 'Explore 只读模式，已跳过' : undefined,
      isRemote: isRemoteSessionWorkspacePath(runWorkspacePath),
      requestId: agentServiceRequestId || null
    });
    renderAssistantBubbleContent(placeholder, {
      content: '',
      trace: sessionActiveRuns.get(runSessionId)?.trace || [],
      hitRoundLimit: false,
      loading: true
    });
    // 二次渲染后强制贴底，避免准备清单落在视口外
    if (typeof scrollChatToBottom === 'function') {
      scrollChatToBottom({ force: true });
    }
  }

  throwIfAgentAborted(runAbortController.signal);

  let undoTurnId = null;
  if (!state.execExplore) {
    if (typeof agentPrepStepStart === 'function') agentPrepStepStart(runSessionId, 'undo');
    undoTurnId = await waitForAgentAbortable(
      beginTurnUndo({
        sessionId: runSessionId,
        workspacePath: runWorkspacePath,
        mode: execUsesPlanner ? 'plan' : 'agent',
        userMsgIndex
      }),
      runAbortController.signal
    );
    if (typeof agentPrepStepDone === 'function') agentPrepStepDone(runSessionId, 'undo');
    if (undoTurnId) {
      turnWithdrawMeta.undoTurnId = undoTurnId;
      const liveRun = sessionActiveRuns.get(runSessionId);
      if (liveRun) liveRun.undoTurnId = undoTurnId;
    }
  } else if (typeof agentPrepStepSkip === 'function') {
    agentPrepStepSkip(runSessionId, 'undo', 'Explore 只读模式，已跳过');
  }

  emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.RUN_START, {
    requestId: agentServiceRequestId || null,
    mode: execUsesPlanner ? 'plan' : state.execExplore ? 'explore' : 'agent'
  });
  refreshHistoryList().catch(() => {});

  const cp = undoTurnId ? { undoTurnId, checkpointRestore: true } : null;
  const prepTrace = sessionActiveRuns.get(runSessionId)?.trace || [];
  renderAssistantBubbleContent(placeholder, {
    content: '',
    trace: prepTrace,
    hitRoundLimit: false,
    loading: true,
    undoTurnId: undoTurnId || null,
    checkpointRestore: !!cp?.checkpointRestore
  });
  placeholder.classList.add('loading');

  throwIfAgentAborted(runAbortController.signal);
  const modelPick = resolveComposerModelForSend(fullText, {
    hasImages: prepared.hasImages,
    sessionId: runSessionId
  });
  const editorCtx =
    String(runSessionId) === String(currentSessionId || '') &&
    typeof window.getMonacoEditorContext === 'function'
      ? window.getMonacoEditorContext()
      : null;
  const selectedArtifact =
    typeof window.getSelectedArtifactPath === 'function'
      ? window.getSelectedArtifactPath(runSessionId)
      : '';
  const taskTierEnabled =
    typeof isTaskTierFeatureEnabled === 'function'
      ? isTaskTierFeatureEnabled()
      : typeof getAgentLimits === 'function'
        ? getAgentLimits().taskTierEnabled !== false
        : true;
  let taskTier =
    taskTierEnabled && typeof inferTaskTierFromStructure === 'function'
      ? inferTaskTierFromStructure({
          userText: fullText,
          pathHints:
            typeof extractPathHintsFromText === 'function' ? extractPathHintsFromText(fullText) : [],
          editorPath: editorCtx && editorCtx.activeFilePath,
          artifactPath: selectedArtifact || '',
          codebaseMention:
            typeof textHasCodebaseMention === 'function' && textHasCodebaseMention(fullText)
        })
      : null;
  const prepOpts = {
    prepSessionId: runSessionId,
    sessionId: runSessionId,
    runWorkspaceRoot: runWorkspacePath || undefined,
    signal: runAbortController.signal,
    taskTier
  };
  // 执行序与 UI 清单一致：索引/记忆/技能 → 再组装工具（勿先 ✓ tools）
  const sysPack = unwrapSystemPromptPack(
    await waitForAgentAbortable(buildSystemMessage(fullText, prepOpts), runAbortController.signal)
  );
  const sysStable = sysPack.stable;
  const turnRide = sysPack.turnRide;
  const sysContent = sysPack.content;
  // 注入事实：Main 才知道本轮命中了哪几条记忆，这里只搬运到 UI 与 contextAudit。
  if (typeof setLastMemoryInjectionAudit === 'function') {
    setLastMemoryInjectionAudit(runSessionId, sysPack.memoryAudit || null);
  }
  throwIfAgentAborted(runAbortController.signal);
  const agentTools = await waitForAgentAbortable(
    buildAgentTools(fullText, {
      model: modelPick.model,
      route: modelPick.route,
      prepSessionId: runSessionId,
      signal: runAbortController.signal
    }),
    runAbortController.signal
  );
  // Explore 只读模式：白名单过滤，写/执行类工具不进 schema（模型物理上无法调用）。
  // Explore 模式自身是「协调者」，额外拿到 subagent（可派只读研究子 Agent）；
  // 研究子 Agent 只拿 buildExploreTools（白名单无 subagent），深度恒为 1。
  // 过滤器意外缺失时降级为空集（宁可不给工具，也不给写工具），保证只读硬约束。
  const effectiveAgentTools = state.execExplore
    ? typeof buildExploreCoordinatorTools === 'function'
      ? buildExploreCoordinatorTools(agentTools)
      : typeof buildExploreTools === 'function'
        ? buildExploreTools(agentTools)
        : []
    : agentTools;
  throwIfAgentAborted(runAbortController.signal);
  setSessionContextEstimate(runSessionId, {
    system: sysContent,
    toolsTokenEst:
      typeof estimateToolsTokens === 'function' ? estimateToolsTokens(effectiveAgentTools) : 0
  });
  refreshContextProgress();
  const { model: composerModel, route, apiConfig: resolvedComposerApiConfig } = modelPick;
  let effectivePrepared = prepared;
  const canSendImages = prepared.hasImages && modelSupportsMultimodal(composerModel, route);
  if (prepared.hasImages && !canSendImages) {
    // 图片只能交给多模态模型自己看：不换模型、不中继、也不静默丢弃附件
    throw new Error(
      `当前模型「${composerModel || '未设置'}」不支持识图，无法处理图片附件。请在「模型设置」中把它设为全模态，或切换到支持识图的模型后重发。`
    );
  }
  if (canSendImages) {
    const plain = String(turnWithdrawMeta.inputText || '').trim() || '请根据附件图片协助我。';
    const imageParts = extractPreparedImageParts(prepared);
    effectivePrepared = {
      content: [{ type: 'text', text: plain }, ...imageParts],
      hasImages: imageParts.length > 0,
      textForStorage: prepared.textForStorage,
      multimodalPlainText: plain
    };
  }
  state.turnMeta = {
    modeLabel:
      execUsesPlanner || state.execExplore ? composerModeLabel(runSessionId) : 'Agent',
    modelLabel: formatModelFooterLabel(composerModel, route),
    modelId: composerModel,
    ts: resolveUserMsgCreatedAt(userMsgIndex),
    inputText: turnWithdrawMeta.inputText,
    attachments: turnWithdrawMeta.attachments,
    undoTurnId: turnWithdrawMeta.undoTurnId || null
  };
  if (
    userMsgIndex >= 0 &&
    messages[userMsgIndex] &&
    (typeof canMutateViewMessages !== 'function' || canMutateViewMessages(runSessionId))
  ) {
    messages[userMsgIndex].meta = {
      ...(messages[userMsgIndex].meta || {}),
      ...state.turnMeta
    };
  }
  const apiConfig = resolvedComposerApiConfig || getCustomModelApiConfig(route);
  // 审计事实：折叠/裁剪只发生在这里（Renderer 拼 prompt），Main 拿到的是结果。
  // 这里算出来的 `contextAudit` 随请求送下去，最终落到 request_snapshots，
  // 让「历史为什么只剩 24 条」可查（见 docs/REQUEST-SNAPSHOT.md）。
  const contextAudit = {
    taskTier: taskTier || null,
    // 本轮注入的记忆条目（id + 召回模式 + 按 kind 隐去数）：随请求落 request_snapshots
    memory: sysPack.memoryAudit || null
  };
  const payload = {
    model: composerModel,
    messages: buildCompletionMessages(
      sysStable,
      effectivePrepared,
      canSendImages,
      turnRide,
      historyMessages,
      contextAudit
    ),
    temperature: settings.temperature,
    max_tokens: getMaxOutputTokens()
  };
  const bookPrefixMessages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  // 压缩预检的唯一入口在 Rust 循环起步处（renderer-agent-rust-loop.js 的 compact_preflight，
  // 判据单一来源 Rust compaction::maybe_compact）。此处不再预检：同一次发送里第二次预检
  // 必因冷却空转，白付一次 RPC + 一次设置读盘，且两处判定会分叉。
  throwIfAgentAborted(runAbortController.signal);
  if (typeof agentPrepStepStart === 'function') agentPrepStepStart(runSessionId, 'llm');
  state.agentRunFrame = {
    runSessionId,
    placeholder,
    payload,
    agentTools: effectiveAgentTools,
    agentMode: state.agentRunMode || 'agent',
    agentServiceRequestId,
    turnMeta: state.turnMeta,
    userMsgIndex,
    userGatewayPersist,
    turnWithdrawMeta,
    fullText,
    composerModel,
    apiConfig,
    // 计划创建（plan_create）要按本次实际路由解析模型配置，续跑/定时执行都靠它
    modelRoute: route,
    userTurn,
    undoTurnId: turnWithdrawMeta.undoTurnId || null,
    agentRunId,
    userContent: effectivePrepared.content,
    hasImages: effectivePrepared.hasImages,
    sysContent: sysStable,
    turnRide,
    bookPrefixMessages,
    notifyAgentServiceDone: state.notifyAgentServiceDone,
    ensureUserLocalMsgId: state.ensureUserLocalMsgId,
    historyMessages,
    taskTier,
    contextAudit
  };
  const chatHistoryBlock = joinPromptChunks
    ? joinPromptChunks([buildSessionChatHistoryBlock({ messages: historyMessages })])
    : String(buildSessionChatHistoryBlock({ messages: historyMessages }) || '');
  state.agentRunFrame.chatHistoryBlock = chatHistoryBlock;
  throwIfAgentAborted(runAbortController.signal);
  const run = await runAgentCompletion(payload, effectiveAgentTools, placeholder, {
    signal: runAbortController.signal,
    apiConfig,
    sessionId: runSessionId,
    undoTurnId: turnWithdrawMeta.undoTurnId || null,
    userText: fullText,
    userContent: effectivePrepared.content,
    hasImages: effectivePrepared.hasImages,
    sysContent: sysStable,
    chatHistoryBlock,
    forcePlanner: execUsesPlanner,
    allowPlannerResume,
    runId: agentRunId,
    turnRide,
    bookPrefixMessages,
    ensureUserLocalMsgId: state.ensureUserLocalMsgId,
    taskTier,
    // 完成验收的判定在 Main；「本轮是不是 explore（只读）」这个事实只有 Renderer 知道
    agentMode: state.agentRunMode || 'agent',
    contextAudit
  });
  if (!run.done) {
    pauseAgentForToolLimit(run, state.agentRunFrame);
    return;
  }

  await completeAgentRunAfterSuccess(run, state.agentRunFrame);
}

async function handleSendAgentError(state, err) {
  const {
    runSessionId,
    placeholder,
    agentServiceRequestId,
    userMsgIndex,
    userTurn,
    turnWithdrawMeta,
    agentRunId
  } = state;
  let { turnMeta } = state;

  if (typeof finishAgentPrepPhase === 'function') finishAgentPrepPhase(runSessionId);
  const liveRunForCleanup = sessionActiveRuns.get(runSessionId);
  const liveMatchesThisRun =
    !agentRunId ||
    !liveRunForCleanup?.runId ||
    String(liveRunForCleanup.runId) === String(agentRunId);
  if (liveMatchesThisRun && liveRunForCleanup?.gatewayRunId && loopApi.worktreeCleanupRun) {
    loopApi.worktreeCleanupRun(liveRunForCleanup.gatewayRunId).catch(() => scheduleWorktreePolicyCleanup());
  }
  if (err.name === 'AbortError' || isUserAbortError(err)) {
    if (typeof pauseComposerQueueAfterUserStop === 'function') {
      pauseComposerQueueAfterUserStop(runSessionId);
    }
    const liveRun = sessionActiveRuns.get(runSessionId);
    const stoppedTrace =
      typeof resolveStoppedDisplayTrace === 'function'
        ? resolveStoppedDisplayTrace(
            err.trace || liveRun?.trace || getLastAgentDisplayedTrace(runSessionId) || []
          )
        : normalizeStoppedTrace(
            err.trace || liveRun?.trace || getLastAgentDisplayedTrace(runSessionId) || []
          );
    if (liveRun && liveMatchesThisRun) liveRun.traceCheckpointClosed = true;
    finishSessionActiveRun(runSessionId, agentRunId);
    syncComposerForActiveSession();
    finalizeAssistantBubble(runSessionId, placeholder, {
      content: '已停止生成。',
      trace: stoppedTrace,
      hitRoundLimit: false,
      stopped: true
    });
    emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.STOPPED, {
      trace: stoppedTrace,
      streamContent: '已停止生成。',
      stopped: true,
      requestId: agentServiceRequestId || null
    });
    if (!turnMeta && userMsgIndex >= 0) {
      turnMeta = buildFallbackTurnMeta(userMsgIndex, turnWithdrawMeta);
      state.turnMeta = turnMeta;
    }
    const stoppedUndoId =
      turnWithdrawMeta.undoTurnId ||
      turnMeta?.undoTurnId ||
      messages[userMsgIndex]?.meta?.undoTurnId ||
      null;
    try {
      await finalizeUndoForUserTurn(userMsgIndex, stoppedUndoId, runSessionId);
      const stoppedFooterMeta = buildStoppedFooterMeta(userMsgIndex, turnMeta, turnWithdrawMeta);
      await persistStoppedAssistant(stoppedTrace, '已停止生成。', stoppedFooterMeta, {
        runId: agentRunId,
        sessionId: runSessionId,
        userMsgIndex,
        userMessageId: await state.ensureUserLocalMsgId()
      });
      if (userMsgIndex >= 0) {
        const stoppedFooterMeta = buildStoppedFooterMeta(userMsgIndex, turnMeta, turnWithdrawMeta);
        finalizeUserTurnFooter(userTurn, userMsgIndex, stoppedFooterMeta);
      }
    } catch (persistErr) {
      console.warn('stopped assistant persist failed', persistErr);
      if (userMsgIndex >= 0) {
        const stoppedFooterMeta = buildStoppedFooterMeta(userMsgIndex, turnMeta, turnWithdrawMeta);
        finalizeUserTurnFooter(userTurn, userMsgIndex, stoppedFooterMeta);
      }
    }
    state.notifyAgentServiceDone({
      status: 'stopped',
      sessionId: runSessionId,
      summary: '已停止生成。',
      trace: cloneTraceForMobile(stoppedTrace || [])
    });
  } else {
    if (
      state.agentRunFrame &&
      shouldPauseForNetworkDisconnect(err, state.agentRunFrame) &&
      (await pauseAgentForNetworkDisconnect(state.agentRunFrame, err))
    ) {
      return;
    }
    const liveRun = sessionActiveRuns.get(runSessionId);
    const failedTrace =
      typeof resolveFailedDisplayTrace === 'function'
        ? resolveFailedDisplayTrace(err, liveRun, runSessionId)
        : err.trace || liveRun?.lastDisplayedTrace || liveRun?.trace || [];
    await finalizeUndoForUserTurn(
      userMsgIndex,
      turnWithdrawMeta.undoTurnId || turnMeta?.undoTurnId,
      runSessionId
    );
    finalizeAssistantBubble(runSessionId, placeholder, {
      content: `调用失败：${formatAgentApiError(err)}`,
      trace: failedTrace,
      hitRoundLimit: false,
      error: true
    });
    if (!turnMeta && userMsgIndex >= 0) {
      turnMeta = buildFallbackTurnMeta(userMsgIndex, turnWithdrawMeta);
      state.turnMeta = turnMeta;
    }
    const failedFooterMeta = {
      ...(turnMeta || {}),
      ...(messages[userMsgIndex]?.meta || {})
    };
    await persistFailedAssistantTurn({
      sessionId: runSessionId,
      runId: agentRunId || liveRun?.runId || null,
      trace: failedTrace,
      err,
      turnMeta: failedFooterMeta,
      userMsgIndex,
      userMessageId: await state.ensureUserLocalMsgId()
    });
    if (userMsgIndex >= 0 && userTurn) {
      finalizeUserTurnFooter(userTurn, userMsgIndex, failedFooterMeta);
    }
    state.notifyAgentServiceDone({
      status: 'failed',
      sessionId: runSessionId,
      error: err.message || String(err),
      trace: cloneTraceForMobile(failedTrace || [])
    });
  }
}

function finalizeSendAgentRun(state) {
  const { runSessionId, agentRunId } = state;

  finishSessionActiveRun(runSessionId, agentRunId);
  void autoCloseBrowserAfterAgentRun(runSessionId).catch(() => {});
  refreshHistoryList().catch(() => {});
  syncComposerForActiveSession();
  focusChatInput();
}

async function sendMessage(text, options = {}) {
  // 绑定对端的会话 = 「与那台内网 agent 的通道」：在这里打字就是发给它，不跑本机模型。
  // 只接管**人手动发送**；由 agent-service / peer 回调触发的回合必须继续走本机循环，
  // 否则「对方来信 → 本机跑一轮 → 又把原话发回去」会互相弹皮球（路由判据在 renderer-peer.js）。
  if (typeof routePeerSessionSend === 'function' && (await routePeerSessionSend(text, options))) {
    return true;
  }
  const gate = await gateSendMessage(text, options);
  if (!gate) return false;

  const state = {
    text,
    options,
    ...gate,
    userTurnResult: null,
    userTurn: null,
    turnWithdrawMeta: null,
    userMsgIndex: -1,
    turnMeta: null,
    userLocalMsgId: null,
    agentServiceDone: false,
    notifyAgentServiceDone: null,
    prepared: null,
    displayText: null,
    fullText: null,
    userContent: null,
    userGatewayPersist: null,
    agentRunId: null,
    runAbortController: null,
    execUsesPlanner: false,
    execExplore: false,
    agentRunMode: 'agent',
    placeholder: null,
    historyMessages: null,
    runWorkspacePath: null,
    ensureUserLocalMsgId: null,
    agentRunFrame: null
  };

  const prepResult = await prepareSendUserTurn(state, text, options);
  if (prepResult === 'abort') return false;

  installSendRunShell(state);

  try {
    const wsOk = await resolveSendWorkspace(state);
    if (!wsOk) return true;
    await executeSendPrepAndRun(state);
    return true;
  } catch (err) {
    await handleSendAgentError(state, err);
    return true;
  } finally {
    finalizeSendAgentRun(state);
  }
}
