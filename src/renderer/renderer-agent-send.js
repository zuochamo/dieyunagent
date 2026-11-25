/* global isSessionSwitchInFlight, loopApi, currentSessionId, cleanupStaleSessionRun, resolveComposerModelForSend, attachmentNeedsVision, getCustomModelApiConfig, appendBubble, isCurrentSessionSending, stopTtsPlayback, getAgentContinueState, resumeAgentToolLoop, clearAgentContinueState, closeStaleAgentRunForSession, getPendingResumeCheckpoint, tryDetectResumeCheckpoint, clearPendingResumeCheckpoint, cloneAttachmentSnapshot, getPendingAttachments, appendUserTurn, setComposerSendingState, isImageAttachment, revokeAttachmentPreview, renderAttachmentChips, processAttachmentsForSend, syncComposerForActiveSession, focusChatInput, invalidateSessionMessageCache, isSessionCacheDiverged, packUserMessageMeta, messages, setMessagesOwnerSessionId, getMessagesOwnerSessionId, messagesBelongToSession, getSessionMessageCache, selectHistoryMessagesForSession, cloneHistoryMessages, renderChatFromMessages, gwState, resolveSessionWorkspacePath, bindCurrentSessionWorkspace, gatewayCall, sessionListTitle, refreshHistoryList, createTraceRunId, resetActiveRunContextUiState, beginComposerUsageAttribution, sessionActiveRuns, refreshContextProgress, throwIfAgentAborted, waitForAgentAbortable, isRemoteSessionWorkspacePath, syncSessionRemoteLease, finishSessionActiveRun, finalizeAssistantBubble, initAgentPrepSteps, renderAssistantBubbleContent, scrollChatToBottom, agentPrepStepStart, beginTurnUndo, agentPrepStepDone, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, buildSystemMessage, buildAgentTools, setSessionContextEstimate, estimateToolsTokens, modelSupportsMultimodal, extractPreparedImageParts, formatModelFooterLabel, resolveUserMsgCreatedAt, canMutateViewMessages, settings, buildCompletionMessages, unwrapSystemPromptPack, joinPromptChunks, getMaxOutputTokens, buildSessionChatHistoryBlock, runAgentCompletion, pauseAgentForToolLimit, completeAgentRunAfterSuccess, finishAgentPrepPhase, isUserAbortError, resolveStoppedDisplayTrace, resolveFailedDisplayTrace, normalizeStoppedTrace, getLastAgentDisplayedTrace, buildFallbackTurnMeta, finalizeUndoForUserTurn, buildStoppedFooterMeta, persistStoppedAssistant, finalizeUserTurnFooter, cloneTraceForMobile, shouldPauseForNetworkDisconnect, pauseAgentForNetworkDisconnect, formatAgentApiError, persistFailedAssistantTurn, scheduleWorktreePolicyCleanup, autoCloseBrowserAfterAgentRun, isTaskTierFeatureEnabled, inferTaskTierFromStructure, extractPathHintsFromText, textHasCodebaseMention, getAgentLimits, fetchChatCompletion, pauseComposerQueueAfterUserStop, setLastMemoryInjectionAudit, sessionGoalPanelView, routePeerSessionSend, peerLinkForSession, isDieyunCoreReady, AGENT_RUNTIME_UNAVAILABLE, agentApi, AgentRoundText */
'use strict';

/**
 * 会话目标续跑轮的合成消息：**不是**用户说的话。
 *
 * 为什么需要它：一轮请求必须以 user 角色收尾，而「目标还没收尾」不能靠伪造一句用户话来驱动
 * （AGENTS 原则 5 明令禁止假用户续跑）。这条合成消息走的是既有段续机制
 * （`SEGMENT_CONTINUE_USER_MSG` 同款）：`isSyntheticLoopUserContent` 认得出它的前缀，
 * 于是【当前任务】仍然是用户原本那句话，模型看到的是「系统说目标还没完」而不是「用户又催了一遍」。
 *
 * 它只进当轮请求的历史副本：不写 `messages`、不落库、不出用户气泡。
 */
const GOAL_TURN_USER_MSG =
  '[系统] 目标尚未收尾，继续推进（轮次、待办与检查事实见 system 里的目标块），不要向用户请示是否继续。';

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
  // 能力闸门（与「尚未配置可用模型」同一层）：core 未就绪就地拒绝，连气泡前的准备都不开始。
  // Renderer 没有降级循环可退 —— 这条路径只有一份实现，缺 core 就是不可用。
  if (!isDieyunCoreReady()) {
    appendBubble('assistant', AGENT_RUNTIME_UNAVAILABLE, { error: true });
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, 'Agent 不可用');
    return null;
  }
  // 续跑由**状态 + 显式动作**决定，不由用户打了什么字决定（AGENTS 原则 3）。
  // 触发入口只有一个：`requestResumeInterruptedTurn`（思考区「继续」/ Composer 空提交 /
  // 频道显式续跑），它把结论以 `resumeInterrupted` 传进来。以前这里靠
  // `text === '继续' || 'continue' || 'resume'` 三个精确词，等于让词表决定「是否 resume」。
  const wantsResume = options.resumeInterrupted === true;
  if (wantsResume) {
    const pendingContinue =
      typeof getAgentContinueState === 'function' ? getAgentContinueState(runSessionId) : null;
    if (pendingContinue && pendingContinue.sessionId === runSessionId) {
      await resumeAgentToolLoop();
      return null;
    }
  }
  if (!wantsResume && typeof clearAgentContinueState === 'function') {
    clearAgentContinueState(runSessionId);
  }
  let allowPlannerResume = false;
  await closeStaleAgentRunForSession(runSessionId, text);
  if (String(runSessionId) !== String(currentSessionId || '')) {
    rejectAgentServiceTask(agentServiceRequestId, runSessionId, '发送过程中已切换会话');
    return null;
  }
  if (wantsResume) {
    // 没有 tool-loop continue 状态时，恢复 planner 断点（断点本身是 Rust 里的 running 记录）
    if (!getPendingResumeCheckpoint(runSessionId)) {
      await tryDetectResumeCheckpoint(runSessionId);
    }
    allowPlannerResume = !!getPendingResumeCheckpoint(runSessionId);
    if (!allowPlannerResume) return null; // 没有任何断点：不发起空跑
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

  // —— 目标续跑轮（`goalTurn`）：这一轮没有用户输入 ——
  // 不 appendUserTurn（没有用户气泡）、不写用户消息、不落库、不动 Composer 附件。
  // 驱动这一轮的是 system 里的目标事实块（Main 每轮注入），加一条 `[系统]` 合成消息
  // 让请求以 user 角色收尾 —— 两者都不是「用户说了什么」。
  if (options.goalTurn === true) {
    state.userTurnResult = null;
    state.userTurn = null;
    state.turnWithdrawMeta = { inputText: '', attachments: [] };
    state.userMsgIndex = -1;
    state.userLocalMsgId = null;
    state.agentServiceDone = false;
    state.displayText = '';
    state.fullText = '';
    state.userContent = '';
    state.prepared = { content: '', hasImages: false, textForStorage: '' };
    state.userGatewayPersist = null;
    // 召回 / 档位判定用目标本身当查询词（目标块也来自同一份目标，不会出现两套说法）
    state.recallQuery = String(options.recallQuery || '');
    // 没有 agentServiceRequestId 的轮次没有可回报的任务：收尾回调保持空转
    state.notifyAgentServiceDone = () => {};
    const history =
      typeof cloneHistoryMessages === 'function' ? cloneHistoryMessages(messages) : messages.slice();
    history.push({ role: 'user', content: GOAL_TURN_USER_MSG });
    state.historyMessages = history;
    if (String(currentSessionId || '') !== runSessionId) return 'abort';
    return 'ok';
  }

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

  resetActiveRunContextUiState(runSessionId);
  beginComposerUsageAttribution(runSessionId);
  // 新一轮开始：上一轮的朗读（可能在合成中，也可能正在播）到此为止 ——
  // 用户已经开口，不该让旧回复继续念。
  if (typeof stopTtsPlayback === 'function') stopTtsPlayback();

  sessionActiveRuns.set(runSessionId, {
    runId: state.agentRunId,
    trace: [],
    placeholderEl: null,
    agentServiceRequestId,
    streamContent: '',
    abortController: state.runAbortController,
    gatewayRunId: null,
    workspacePath: null,
    undoTurnId: null
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
          const leased =
            typeof syncSessionRemoteLease === 'function'
              ? await syncSessionRemoteLease(runSessionId, p, true)
              : '';
          // 租约把会话切进 worktree 时，p 已经是「仓库根」的旧值：整轮都得以 Main 的生效路径为准，
          // 否则索引/记忆/沙箱各自对着不同的根（症状：面板「索引根不一致 · 状态暂不可用」）。
          if (leased && leased !== p) {
            p = leased;
            if (typeof rememberSessionWorkspacePath === 'function') {
              rememberSessionWorkspacePath(runSessionId, leased);
            }
          }
        }
        return p;
      })(),
      runAbortController.signal
    );
    const liveAfterWs = sessionActiveRuns.get(runSessionId);
    if (liveAfterWs) liveAfterWs.workspacePath = state.runWorkspacePath;
    // 远端会话的工作区归 Main 的 session-worktree：建/复用 worktree 之后它已经落库并设好上下文。
    // 渲染端这里再拿「租约之前的仓库根」写一次，会把 worktree 盖回仓库根（重启后再从 DB 读回来），
    // 于是 agent 又跑在共享树上。远端只认 Main 那次写，渲染端只补本地工作区。
    if (
      state.runWorkspacePath &&
      !isRemoteSessionWorkspacePath(state.runWorkspacePath) &&
      typeof bindCurrentSessionWorkspace === 'function'
    ) {
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

/**
 * 「这一轮要不要拆成多路并行」的判定卡（拆与不拆同形）。
 *
 * 单一来源：phase 名来自 `agent-round-text.PLANNER_ROUTE_PHASE`（Main 的 planner 侧写同一张卡时
 * 也用这个常量），所以「拆了」和「没拆」在思考区长得一样，用户不会以为是两件事。
 * `thought` 是一句结论 + 理由；`fullThought` 带判定模型的思考原文（2026-11-20 用户要求）。
 */
function buildPlannerJudgeTraceEntry(route) {
  const phase =
    typeof AgentRoundText !== 'undefined' && AgentRoundText.PLANNER_ROUTE_PHASE
      ? AgentRoundText.PLANNER_ROUTE_PHASE
      : '调度 · 侧模型判定';
  const verdict = route && route.use ? '拆成多路并行走 planner' : '不拆，按普通工具循环跑';
  const reason = String((route && route.reason) || '').trim();
  const thinking = String((route && route.thinking) || '').trim();
  const thought = `${verdict}${reason ? `：${reason}` : ''}`;
  const fullThought = thinking ? `${thought}\n\n【判定模型思考】\n${thinking}` : thought;
  return { round: 0, phase, thought, fullThought, tools: [], planJudge: true };
}

/**
 * 本轮 trace 里模型有没有要求中途改道（调了 `fan_out`）。
 *
 * 判定单一来源在 `agent-round-text.findFanOutRequest`（只认结构化工具调用记录，不扫正文）；
 * 这里只做 bundle 兼容（老 bundle 没有这个方法就不改道，按普通循环交付）。
 */
function readFanOutHandoff(trace) {
  return typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.findFanOutRequest === 'function'
    ? AgentRoundText.findFanOutRequest(trace)
    : null;
}

async function executeSendPrepAndRun(state) {
  const {
    runSessionId,
    runAbortController,
    placeholder,
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
  // 召回 / 档位判定的查询词：普通轮就是用户输入；目标续跑轮没有用户输入，
  // 用目标原文（Main 传下来的同一份 objective），否则记忆/索引召回会对着空串乱猜。
  const recallQuery = String(state.recallQuery || fullText || '');

  /**
   * 多 Agent 并行执行（planner 管线）的入口开关：它只表示「允许」，不表示「强制」。
   *
   * 打开后要问一次侧模型（Main 的 `agent:planner-route` → `agent/planner-router.js`）：
   * 这一句里有没有 ≥2 个彼此独立、都要改文件/跑命令的交付物？判「要拆」才走 planner，
   * 判不准 / 判定失败 / 超时一律走普通工具循环。
   * 以前这里是直接 `forcePlanner`：两个字的追问也会被拆成 3 路执行器、跑半小时（2026-11-19 实测）。
   *
   * 判定**串行**放在选路前（等它 1.4~4s）。试过与准备阶段并发发出：省了等待，但判定会在
   * 「本轮模型/端点还没解析出来」时用磁盘默认模型去判，判定口径与本轮不一致 ——
   * 2026-11-20 实测取舍后按用户要求改回串行（口径一致优先于省 1~4s）。
   *
   * 两个结构性抑制（都不是猜意图，是入口本身的形状）：
   * - `agentServiceRequestId` 非空 = 外部提交（手机 / 频道 / 内网对端 / 转接器）：改动要
   *   有人在桌面「变更」面板点应用才落盘，无人值守入口点了也白等，还会先对外报"完成"；
   * - 本轮带图片 = planner 管线的 user 消息只搬文本（图片进不了子 Agent），走了就静默丢图。
   */
  const plannerMultiAgent =
    typeof getAgentLimits === 'function' &&
    getAgentLimits().plannerMultiAgentEnabled === true &&
    !agentServiceRequestId &&
    !(prepared && prepared.hasImages);

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

  if (typeof agentPrepStepStart === 'function') agentPrepStepStart(runSessionId, 'undo');
  const undoTurnId = await waitForAgentAbortable(
    beginTurnUndo({
      sessionId: runSessionId,
      workspacePath: runWorkspacePath,
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

  emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.RUN_START, {
    requestId: agentServiceRequestId || null
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
  /**
   * 多 Agent 并行执行（planner 管线）的入口开关判定已在函数开头算出
   * （见 `plannerMultiAgent`）：判定只看用户这一句，与这里的档位推断无关。
   * 这里只留档位推断。
   */
  let taskTier =
    taskTierEnabled && typeof inferTaskTierFromStructure === 'function'
      ? inferTaskTierFromStructure({
          userText: recallQuery,
          pathHints:
            typeof extractPathHintsFromText === 'function'
              ? extractPathHintsFromText(recallQuery)
              : [],
          editorPath: editorCtx && editorCtx.activeFilePath,
          artifactPath: selectedArtifact || '',
          codebaseMention:
            typeof textHasCodebaseMention === 'function' && textHasCodebaseMention(recallQuery)
        })
      : null;
  const prepOpts = {
    prepSessionId: runSessionId,
    sessionId: runSessionId,
    runWorkspaceRoot: runWorkspacePath || undefined,
    signal: runAbortController.signal,
    taskTier
  };
  // 系统提示与工具装配**互不依赖**，一起发出去、只等最慢的那一段。
  // 以前这里是串行（注释还写着「执行序与 UI 清单一致：索引/记忆/技能 → 再组装工具」）——
  // 让准备清单的勾选顺序决定了首字延迟，而清单本来只是展示。工具这边的结果只有一个地方
  // 需要（`compactMcpTools` 决定 MCP 块用紧凑 schema 还是逐服务列启动命令），所以把
  // Promise 交给系统提示，由它在真正要用时 await。
  const agentToolsPromise = buildAgentTools(recallQuery, {
    model: modelPick.model,
    route: modelPick.route,
    prepSessionId: runSessionId,
    signal: runAbortController.signal
  });
  // 中止时这条链会被外层丢掉：先挂一个空 catch，别让它变成 unhandledRejection
  agentToolsPromise.catch(() => {});
  const sysPack = unwrapSystemPromptPack(
    await waitForAgentAbortable(
      buildSystemMessage(recallQuery, { ...prepOpts, agentToolsPromise }),
      runAbortController.signal
    )
  );
  const sysStable = sysPack.stable;
  const turnRide = sysPack.turnRide;
  const sysContent = sysPack.content;
  // 注入事实：Main 才知道本轮命中了哪几条记忆，这里只搬运到 UI 与 contextAudit。
  if (typeof setLastMemoryInjectionAudit === 'function') {
    setLastMemoryInjectionAudit(runSessionId, sysPack.memoryAudit || null);
  }
  throwIfAgentAborted(runAbortController.signal);
  const agentTools = await waitForAgentAbortable(agentToolsPromise, runAbortController.signal);
  throwIfAgentAborted(runAbortController.signal);
  setSessionContextEstimate(runSessionId, {
    system: sysContent,
    toolsTokenEst:
      typeof estimateToolsTokens === 'function' ? estimateToolsTokens(agentTools) : 0
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
    memory: sysPack.memoryAudit || null,
    // 本轮索引内容有没有真的进上下文（code / repoMap）：工具遥测只记主动调用，
    // 注入走的 RPC 不进遥测，缺这一项统计页就会把「一直在注入」误读成「没人用」
    index: sysPack.indexAudit || null
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
    agentTools,
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
  // 开关只代表「允许」：这一轮到底拆不拆，问一次侧模型。判定在 Main（`agent:planner-route`，
  // LLM 调用仍只有 `llm.complete` 一个出口）；失败 / 超时 / 拿不准一律不拆。
  let plannerRoute = null;
  if (plannerMultiAgent) {
    try {
      plannerRoute =
        typeof agentApi === 'undefined' ||
        !agentApi ||
        typeof agentApi.agentPlannerRoute !== 'function'
          ? { use: false, reason: '当前入口没有路由判定（旧版桥），按不拆处理' }
          : await agentApi.agentPlannerRoute({
              userText: fullText,
              workspacePath: runWorkspacePath || state.runWorkspacePath || '',
              model: composerModel || (payload && payload.model) || '',
              apiConfig
            });
    } catch {
      plannerRoute = { use: false, reason: '路由调用失败' };
    }
    throwIfAgentAborted(runAbortController.signal);
    if (!plannerRoute || !plannerRoute.use) {
      console.warn(
        `[dieyun:planner] 侧模型判断：这一轮不拆（${(plannerRoute && plannerRoute.reason) || '无理由'}）`
      );
    }
  }
  const baseRunOpts = {
    signal: runAbortController.signal,
    apiConfig,
    sessionId: runSessionId,
    undoTurnId: turnWithdrawMeta.undoTurnId || null,
    userText: fullText,
    userContent: effectivePrepared.content,
    hasImages: effectivePrepared.hasImages,
    sysContent: sysStable,
    chatHistoryBlock,
    allowPlannerResume,
    // 「多 Agent 并行执行」只是**允许**：真正拆不拆由侧模型这一轮判定（见上面的 plannerRoute）。
    // 拆了的话这张卡由 planner 自己写在思考区最前（`调度 · 侧模型判定`，带判定思考）；
    // 没拆的话在下面由 Renderer 补同一张卡 —— 两处同形，用户总能看见「凭什么这么判」。
    forcePlanner: !!(plannerRoute && plannerRoute.use),
    plannerRouteReason: (plannerRoute && plannerRoute.reason) || '',
    plannerRouteThinking: (plannerRoute && plannerRoute.thinking) || '',
    runId: agentRunId,
    turnRide,
    bookPrefixMessages,
    ensureUserLocalMsgId: state.ensureUserLocalMsgId,
    taskTier,
    contextAudit
  };
  let run = await runAgentCompletion(payload, agentTools, placeholder, baseRunOpts);
  // 中途改道：普通循环跑到一半，模型自己调了 `fan_out`（发现这活该拆成多路并行写入）。
  // 这一段**不交付** —— 它的 trace 当 planner 的前缀（baseTrace），由 planner 出最终答复。
  const handoff = run.done ? readFanOutHandoff(run.result && run.result.trace) : null;
  // 「没拆」也要把判定摆出来：否则用户只看到一条普通循环，不知道它为什么没并行。
  // 但真改道时**不写这张卡**：图上先写「不拆」再写「中途改道」会自相矛盾。
  if (run.result && plannerRoute && !plannerRoute.use && !handoff) {
    run.result = {
      ...run.result,
      trace: [
        buildPlannerJudgeTraceEntry(plannerRoute),
        ...(Array.isArray(run.result.trace) ? run.result.trace : [])
      ]
    };
  }
  if (handoff && effectivePrepared.hasImages) {
    // 本轮带图：planner 的 user 消息只搬文本，改道会静默丢图 —— 宁可不改道。
    console.warn('[dieyun:planner] 本轮带图片，忽略中途改道（planner 只搬文本）');
  } else if (handoff) {
    const segTrace = Array.isArray(run.result && run.result.trace) ? run.result.trace : [];
    // 模型自己已经想好怎么拆时，把它的切分当「参考」交给规划阶段（不强制采用，规划器可以改）。
    const splitHint = handoff.subtasks.length
      ? `\n\n【模型执行中确认的切分（参考，可调整）】\n${handoff.subtasks
          .map((s, i) => `${i + 1}. ${s.title || s.instruction}${s.instruction && s.title ? `：${s.instruction}` : ''}`)
          .join('\n')}`
      : '';
    try {
      run = await runAgentCompletion(payload, agentTools, placeholder, {
        ...baseRunOpts,
        forcePlanner: true,
        userText: `${fullText}${splitHint}`,
        plannerRoutePhase:
          typeof AgentRoundText !== 'undefined' && AgentRoundText.PLANNER_HANDOFF_PHASE
            ? AgentRoundText.PLANNER_HANDOFF_PHASE
            : '',
        plannerRouteReason: `模型执行途中要求改道：${handoff.reason}`,
        plannerRouteThinking: '',
        baseTrace: segTrace
      });
    } catch (err) {
      // 改道失败（planner 起不来 / 被中止）：退回交付这一段本身，别把整轮吞掉。
      if (err && (err.name === 'AbortError' || isUserAbortError(err))) throw err;
      console.warn('[dieyun:planner] 中途改道失败，改为交付当前这一段：', err);
      run = {
        ...run,
        done: true,
        result: {
          ...(run.result || {}),
          trace: [
            {
              round: 0,
              phase: '调度 · 中途改道失败',
              thought: `没能起 planner（${(err && err.message) || err}），已按当前进度交付`,
              fullThought: `没能起 planner（${(err && err.message) || err}），已按当前进度交付`,
              tools: []
            },
            ...segTrace
          ]
        }
      };
    }
  }
  if (!run.done) {
    await pauseAgentForToolLimit(run, state.agentRunFrame);
    return;
  }

  await completeAgentRunAfterSuccess(run, state.agentRunFrame);
  // 目标还没收尾：本轮正文已交付，接着开下一轮（判定在 Main，这里只照做）
  if (run.result?.goalContinue) state.goalContinue = true;
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
  // 本轮跑动中出现过「库里有、视图里没有」（对端来信 / 回复在那期间落库，而这期间只能用
  // 缓存快照）：现在这一轮结束了，补一次真回源，否则那几条会一直不显示 ——
  // 用户看到的就是「我发的那句话从对话里消失了」（判据见 `renderer-chat-history.js#resolveChatLoadMode`）。
  if (
    typeof isSessionCacheDiverged === 'function' &&
    isSessionCacheDiverged(runSessionId) &&
    String(runSessionId) === String(currentSessionId || '')
  ) {
    void loadChatFromGateway(null, runSessionId, { forceRefresh: true }).catch(() => {});
  }
}

async function sendMessage(text, options = {}) {
  // 绑定对端的会话 = 「与那台内网 agent 的通道」：在这里打字就是发给它，不跑本机模型。
  // 只接管**人手动发送**；由 agent-service / peer 回调触发的回合必须继续走本机循环，
  // 否则「对方来信 → 本机跑一轮 → 又把原话发回去」会互相弹皮球（路由判据在 renderer-peer.js）。
  // 目标续跑轮（goalTurn）没有用户输入、也不是发给对端的话：直接走本机循环。
  if (
    options.goalTurn !== true &&
    typeof routePeerSessionSend === 'function' &&
    (await routePeerSessionSend(text, options))
  ) {
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
    recallQuery: null,
    goalContinue: false,

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
    // 目标没烧尾：本轮已收尾落地（气泡 / 运行态 / 队列都释放了），再开下一轮。
    // 放 finally 是因为开新轮要过发送闸门，而闸门会拒绝「本会话还在跑」。
    if (state.goalContinue) kickGoalTurn(state.runSessionId);
  }
}

/**
 * 目标续跑：一轮结束后的下一轮（**没有用户输入**的一轮）。
 *
 * 判定在 Main（`decideContinuation`）：这里不看目标状态、不算预算，只执行「再来一轮」。
 * 只有当前视图就是该会话时才接着跑 —— 用户切走了就不该在背后继续烧 token；
 * 目标保持 active，回来发一句话就继续推进。
 *
 * @param {{ sessionId?: string, recallQuery?: string }} options
 * @returns {Promise<boolean>} 是否真的开了这一轮
 */
async function startGoalTurn(options = {}) {
  const sessionId = String(options.sessionId || currentSessionId || '');
  if (!sessionId) return false;
  if (sessionId !== String(currentSessionId || '')) return false;
  // 与对端 agent 绑定的会话（会话即通道）不自动开轮：那里的每一轮都可能被投递给对方，
  // 「代码自己决定再跑一轮」会变成替人向对方连发消息。人发了才跑。
  if (typeof peerLinkForSession === 'function' && peerLinkForSession(sessionId)) return false;
  if (typeof isCurrentSessionSending === 'function' && isCurrentSessionSending()) {
    return false;
  }
  // 召回查询词用目标原文：Renderer 不自己造一份目标文案，取的就是「目标」面板那一条视图。
  // 这份视图顺带做**执行时复核**：判定发生在上一轮结束时，真正开轮可能已经晚了一拍
  // （用户刚按停止 → 目标转 paused；或目标已被收尾/清掉）。没有可推进的目标就不开轮，
  // 只读状态与 objective，仍然不碰预算 —— 续跑该不该发生仍由 Main 判。
  let recallQuery = String(options.recallQuery || '');
  if (typeof sessionGoalPanelView === 'function') {
    try {
      const view = await sessionGoalPanelView(sessionId);
      if (!view || view.outcome || String(view.status || '') !== 'active') return false;
      if (!recallQuery) recallQuery = String(view.objective || '');
    } catch {
      recallQuery = '';
    }
  }
  try {
    return await sendMessage('', { ...options, sessionId, goalTurn: true, recallQuery });
  } catch (err) {
    console.warn(err);
    return false;
  }
}

/** 让出当前栈再开下一轮：本轮的气泡 / 运行态 / 队列先落地 */
function kickGoalTurn(sessionId) {
  setTimeout(() => {
    void startGoalTurn({ sessionId });
  }, 0);
}

// 目标面板的「继续」走这个入口。显式挂到 window 而不是依赖「顶层函数声明恰好成了全局」——
// 后者只在脚本原位 concat 时成立，换个打包方式就会静默失效（点了没反应）。
window.startGoalTurn = startGoalTurn;
window.kickGoalTurn = kickGoalTurn;
