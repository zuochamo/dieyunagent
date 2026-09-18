/* global isSessionSwitchInFlight, loopApi, currentSessionId, cleanupStaleSessionRun, resolveComposerModelForSend, attachmentNeedsVision, getCustomModelApiConfig, appendBubble, isCurrentSessionSending, getAgentContinueState, resumeAgentToolLoop, clearAgentContinueState, closeStaleAgentRunForSession, getPendingResumeCheckpoint, tryDetectResumeCheckpoint, clearPendingResumeCheckpoint, cloneAttachmentSnapshot, getPendingAttachments, appendUserTurn, setComposerSendingState, isImageAttachment, revokeAttachmentPreview, renderAttachmentChips, processAttachmentsForSend, syncComposerForActiveSession, focusChatInput, invalidateSessionMessageCache, packUserMessageMeta, messages, setMessagesOwnerSessionId, getMessagesOwnerSessionId, messagesBelongToSession, getSessionMessageCache, selectHistoryMessagesForSession, cloneHistoryMessages, renderChatFromMessages, gwState, resolveSessionWorkspacePath, bindCurrentSessionWorkspace, gatewayCall, sessionListTitle, refreshHistoryList, createTraceRunId, getComposerLongHorizon, getComposerAgentMode, resetActiveRunContextUiState, beginComposerUsageAttribution, sessionActiveRuns, refreshContextProgress, throwIfAgentAborted, waitForAgentAbortable, isRemoteSessionWorkspacePath, syncSessionRemoteLease, finishSessionActiveRun, finalizeAssistantBubble, initAgentPrepSteps, renderAssistantBubbleContent, scrollChatToBottom, agentPrepStepStart, beginTurnUndo, agentPrepStepDone, agentPrepStepSkip, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, buildSystemMessage, buildAgentTools, buildExploreTools, setSessionContextEstimate, estimateToolsTokens, modelSupportsMultimodal, stripMultimodalFromPrepared, extractPreparedImageParts, composerModeLabel, formatModelFooterLabel, resolveUserMsgCreatedAt, canMutateViewMessages, getVisionApiConfig, settings, pickCustomVisionModel, buildPlannerVisionSupplement, buildCompletionMessages, unwrapSystemPromptPack, joinPromptChunks, getMaxOutputTokens, applyContextCompaction, shortenCompactionLlmMessage, buildSessionChatHistoryBlock, runAgentCompletion, pauseAgentForToolLimit, completeAgentRunAfterSuccess, finishAgentPrepPhase, isUserAbortError, resolveStoppedDisplayTrace, resolveFailedDisplayTrace, normalizeStoppedTrace, getLastAgentDisplayedTrace, buildFallbackTurnMeta, finalizeUndoForUserTurn, buildStoppedFooterMeta, persistStoppedAssistant, finalizeUserTurnFooter, cloneTraceForMobile, shouldPauseForNetworkDisconnect, pauseAgentForNetworkDisconnect, formatAgentApiError, persistFailedAssistantTurn, scheduleWorktreePolicyCleanup, autoCloseBrowserAfterAgentRun, isTaskTierFeatureEnabled, inferTaskTierFromStructure, extractPathHintsFromText, textHasCodebaseMention, getAgentLimits, fetchChatCompletion, pauseComposerQueueAfterUserStop */
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

  state.longHorizon = typeof getComposerLongHorizon === 'function' && getComposerLongHorizon();
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
    longHorizon,
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
      skipUndo: longHorizon || state.execExplore,
      skipUndoReason: longHorizon
        ? '长程模式，已跳过'
        : state.execExplore
          ? 'Explore 只读模式，已跳过'
          : undefined,
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
  if (!longHorizon && !state.execExplore) {
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
    agentPrepStepSkip(
      runSessionId,
      'undo',
      state.execExplore && !longHorizon ? 'Explore 只读模式，已跳过' : undefined
    );
  }
  turnWithdrawMeta.longHorizon = !!longHorizon;

  emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.RUN_START, {
    requestId: agentServiceRequestId || null,
    mode: execUsesPlanner ? 'plan' : state.execExplore ? 'explore' : 'agent',
    meta: {
      longHorizon: !!longHorizon
    }
  });
  refreshHistoryList().catch(() => {});

  const cp = !longHorizon && undoTurnId ? { undoTurnId, checkpointRestore: true } : null;
  const prepTrace = sessionActiveRuns.get(runSessionId)?.trace || [];
  renderAssistantBubbleContent(placeholder, {
    content: '',
    trace: prepTrace,
    hitRoundLimit: false,
    loading: true,
    undoTurnId: longHorizon ? null : undoTurnId || null,
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
  // 过滤器意外缺失时降级为空集（宁可不给工具，也不给写工具），保证只读硬约束。
  const effectiveAgentTools = state.execExplore
    ? typeof buildExploreTools === 'function'
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
    effectivePrepared = stripMultimodalFromPrepared(prepared);
  } else if (canSendImages) {
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
    undoTurnId: turnWithdrawMeta.undoTurnId || null,
    longHorizon: !!turnWithdrawMeta.longHorizon
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
  const useVisionApi = canSendImages || /^auto-vision|custom-vision/.test(route || '');
  const apiConfig = useVisionApi
    ? resolvedComposerApiConfig || {
        baseUrl: getVisionApiConfig().baseUrl || settings.baseUrl,
        apiKey: getVisionApiConfig().apiKey || settings.apiKey
      }
    : resolvedComposerApiConfig || getCustomModelApiConfig(route);
  if (/^custom-/.test(route || '')) {
    const customApiConfig = getCustomModelApiConfig(route);
    apiConfig.baseUrl = customApiConfig.baseUrl;
    apiConfig.apiKey = customApiConfig.apiKey;
  }
  const plannerVisionPick =
    prepared.hasImages && typeof pickCustomVisionModel === 'function'
      ? pickCustomVisionModel()
      : null;
  const visionApiConfig = prepared.hasImages ? getVisionApiConfig() : null;
  let plannerUserText = fullText;
  if (
    execUsesPlanner &&
    prepared.hasImages &&
    !canSendImages &&
    visionApiConfig?.model &&
    visionApiConfig?.baseUrl
  ) {
    const supplement = await waitForAgentAbortable(
      buildPlannerVisionSupplement(prepared, {
        visionModel: plannerVisionPick?.model || visionApiConfig.model,
        visionApiConfig,
        signal: runAbortController.signal
      }),
      runAbortController.signal
    );
    throwIfAgentAborted(runAbortController.signal);
    if (supplement) {
      plannerUserText = fullText + '\n\n【Plan 视觉补充】\n' + supplement;
    }
  }
  const payload = {
    model: composerModel,
    messages: buildCompletionMessages(
      sysStable,
      effectivePrepared,
      canSendImages,
      turnRide,
      historyMessages
    ),
    temperature: settings.temperature,
    max_tokens: getMaxOutputTokens()
  };
  const bookPrefixMessages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  if (typeof agentPrepStepStart === 'function') agentPrepStepStart(runSessionId, 'compact');
  const compactResult = await waitForAgentAbortable(
    applyContextCompaction(payload, {
      signal: runAbortController.signal,
      apiConfig,
      sessionId: runSessionId
    }),
    runAbortController.signal
  );
  if (compactResult && compactResult.compacted) {
    if (typeof agentPrepStepDone === 'function') agentPrepStepDone(runSessionId, 'compact');
  } else if (compactResult && compactResult.skipped === 'llm_error') {
    const detail =
      typeof shortenCompactionLlmMessage === 'function'
        ? `已跳过：${shortenCompactionLlmMessage(compactResult.llmError)}`
        : '已跳过：模型请求失败';
    if (typeof agentPrepStepSkip === 'function') agentPrepStepSkip(runSessionId, 'compact', detail);
    else if (typeof agentPrepStepDone === 'function') agentPrepStepDone(runSessionId, 'compact');
  } else if (compactResult && compactResult.skipped === 'content_policy') {
    if (typeof agentPrepStepSkip === 'function') {
      agentPrepStepSkip(runSessionId, 'compact', '内容审核拦截');
    } else if (typeof agentPrepStepDone === 'function') {
      agentPrepStepDone(runSessionId, 'compact');
    }
  } else if (typeof agentPrepStepSkip === 'function') {
    agentPrepStepSkip(runSessionId, 'compact', '未触发');
  } else if (typeof agentPrepStepDone === 'function') {
    agentPrepStepDone(runSessionId, 'compact');
  }
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
    fullText: plannerUserText,
    composerModel,
    apiConfig,
    // 计划创建（plan_create）要按本次实际路由解析模型配置，续跑/定时执行都靠它
    modelRoute: route,
    userTurn,
    undoTurnId: turnWithdrawMeta.undoTurnId || null,
    agentRunId,
    userContent: effectivePrepared.content,
    hasImages: effectivePrepared.hasImages,
    visionModel: plannerVisionPick?.model || null,
    visionApiConfig,
    sysContent: sysStable,
    turnRide,
    bookPrefixMessages,
    notifyAgentServiceDone: state.notifyAgentServiceDone,
    ensureUserLocalMsgId: state.ensureUserLocalMsgId,
    historyMessages,
    taskTier
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
    userText: plannerUserText,
    userContent: effectivePrepared.content,
    hasImages: effectivePrepared.hasImages,
    visionModel: state.agentRunFrame.visionModel,
    visionApiConfig,
    sysContent: sysStable,
    chatHistoryBlock,
    forcePlanner: execUsesPlanner,
    allowPlannerResume,
    runId: agentRunId,
    longHorizon: !!longHorizon,
    turnRide,
    bookPrefixMessages,
    ensureUserLocalMsgId: state.ensureUserLocalMsgId,
    taskTier
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
    longHorizon: false,
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
