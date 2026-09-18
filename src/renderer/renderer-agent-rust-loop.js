/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getComposerLongHorizon, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, syncLiveWriteFromTrace, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, scaleLimitForLongHorizon, dismissAgentContinueRows, maybeShowProposeToolPreview, agentApi, STREAM_IDLE_HINT_MS */
'use strict';

function isDieyunCoreReady() {
  return !!(typeof gwState !== 'undefined' && gwState.rustCore && gwState.rustCore.enabled);
}

/**
 * 循环模型是否多模态：决定是否把浏览器截图作为 image_url 注入上下文。
 * 仅当所选模型支持识图时开启，避免给文本模型发送图片触发上游 400。
 */
function resolveBrowserVision(model) {
  try {
    const caps = typeof window !== 'undefined' ? window.ModelCapabilities : null;
    if (caps && typeof caps.modelSupportsMultimodalInSettings === 'function') {
      return !!caps.modelSupportsMultimodalInSettings(settings, model);
    }
  } catch {
    /* 能力探测失败时保守关闭 */
  }
  return false;
}

/**
 * Main 进程 Rust planner pipeline（Explore/Worker 使用 Rust agent loop）。
 */
async function runPlannerPipelineViaMain(params, options = {}) {
  if (!agentApi.agentPlannerRun) {
    throw new Error('Rust planner IPC 不可用');
  }
  const cancelToken = options.cancelToken || `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const signal = options.signal;
  const onProgress = options.onProgress;
  let pendingProgress = null;
  let progressTimer = null;
  let progressRaf = null;
  let lastProgressFlushAt = 0;
  let lastProgressStructureSig = '';
  const flushProgress = () => {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    if (progressRaf) {
      cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }
    if (!pendingProgress || typeof onProgress !== 'function') return;
    const { trace, streamContent, plan } = pendingProgress;
    pendingProgress = null;
    lastProgressFlushAt = Date.now();
    onProgress(trace, streamContent || '', plan || null);
  };
  const scheduleProgress = (trace, streamContent, plan) => {
    if (typeof onProgress !== 'function') return;
    pendingProgress = { trace, streamContent: streamContent || '', plan: plan || null };
    const sig =
      typeof thinkingTraceStructureSig === 'function'
        ? thinkingTraceStructureSig(trace)
        : String((trace || []).length);
    const streamOnly = !!(lastProgressStructureSig && sig === lastProgressStructureSig);
    lastProgressStructureSig = sig;

    if (streamOnly) {
      if (!progressRaf) progressRaf = requestAnimationFrame(flushProgress);
      return;
    }

    if (progressRaf) {
      cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }

    const elapsed = Date.now() - lastProgressFlushAt;
    const delay = Math.max(0, 120 - elapsed);
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      progressRaf = requestAnimationFrame(flushProgress);
    }, delay);
  };
  const unregisterBackendCancel = registerActiveAgentBackendCancel(
    'planner',
    cancelToken,
    () => {
      if (agentApi.agentPlannerCancel) {
        return agentApi.agentPlannerCancel({ cancelToken });
      }
      return null;
    },
    options.sessionId
  );

  const onAbort = () => {
    if (options.sessionId) {
      cancelActiveAgentBackendsForSession(options.sessionId, '用户停止');
    } else {
      cancelActiveAgentBackends('用户停止');
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const offPhase =
    typeof agentApi.onAgentPlannerPhase === 'function'
      ? agentApi.onAgentPlannerPhase((ev) => {
          if (!ev || ev.cancelToken !== cancelToken) return;
          if (ev.phase === 'started' && ev.data) {
            const rid = ev.data.coordinatorRunId || ev.data.runId;
            if (rid && typeof window.beginPlanWorktreeTracking === 'function') {
              window.beginPlanWorktreeTracking(rid, options.sessionId || params.sessionId);
            }
          }
          if (ev.phase === 'progress' && ev.data && ev.data.trace && typeof onProgress === 'function') {
            scheduleProgress(ev.data.trace, ev.data.streamContent || '', ev.data.plan || null);
            const planSessionId = options.sessionId || params.sessionId || null;
            const planVisible = String(planSessionId || '') === String(currentSessionId || '');
            if (planVisible && ev.data.plan && typeof window.syncPlanPreviewFromPlan === 'function') {
              window.syncPlanPreviewFromPlan(ev.data.plan);
            }
            const planTraceDiff =
              typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
              window.shouldPlanUseTraceDiffFallback() &&
              planVisible;
            if (planTraceDiff) {
              if (typeof trackArtifactsFromTrace === 'function') {
                trackArtifactsFromTrace(ev.data.trace, { sessionId: planSessionId });
              }
            }
            if (planVisible && typeof window.schedulePlanWorktreeChangesRefresh === 'function') {
              window.schedulePlanWorktreeChangesRefresh();
            }
          }
        })
      : null;

  try {
    const result = await agentApi.agentPlannerRun({
      cancelToken,
      sessionId: options.sessionId || params.sessionId || undefined,
      ...params
    });
    flushProgress();
    if (typeof onProgress === 'function' && result && result.trace) {
      onProgress(result.trace, result.content || '');
    }
    if (result?.runId && typeof window.beginPlanWorktreeTracking === 'function') {
      window.beginPlanWorktreeTracking(result.runId, options.sessionId || params.sessionId);
    }
    return result;
  } finally {
    flushProgress();
    unregisterBackendCancel();
    if (offPhase) offPhase();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function mapRustAgentTrace(rustTrace, prefixTrace) {
  const out = Array.isArray(prefixTrace) ? prefixTrace.slice() : [];
  if (!Array.isArray(rustTrace)) return out;
  for (const r of rustTrace) {
    const tools = (r.tools || []).map((t) => {
      const args = t.args || t.toolArgs || {};
      const argsBrief =
        typeof formatToolArgsBrief === 'function'
          ? formatToolArgsBrief(t.name, args)
          : JSON.stringify(args).slice(0, 120);
      // pending 只出现在「实时进度」trace（Main 侧边跑边推）；Rust 收尾 trace 不带该字段
      const pending = !!t.pending;
      let summary = '完成';
      if (t.error) summary = `错误: ${t.error}`;
      else if (pending) summary = '';
      else if (typeof summarizeToolResult === 'function') {
        summary = summarizeToolResult(t.name, t.result);
      }
      const failed =
        !pending &&
        (!!t.error ||
          !!(t.result && typeof t.result === 'object' && (t.result.error || t.result.ok === false)));
      return {
        name: t.name,
        argsBrief,
        summary,
        pending,
        failed,
        errorCode: t.result && t.result.errorCode ? t.result.errorCode : undefined,
        toolArgs: args
      };
    });
    const row = {
      round: r.round,
      phase: r.phase || (r.round ? `第 ${r.round} 轮` : '思考'),
      thought: sanitizeTraceThought(r.thought || '', out.map((e) => e.fullThought || e.thought)),
      fullThought: sanitizeTraceThought(r.fullThought || r.thought || '', out.map((e) => e.fullThought || e.thought)),
      subagentId: r.subagentId,
      isolated: r.isolated,
      worker: r.worker,
      parallel: r.parallel,
      tools
    };
    const vis = String(r.visibleContent || '').trim();
    if (vis) row.visibleContent = vis;
    out.push(row);
  }
  return out;
}

function mergeTraceVisibleContent(mapped, liveTrace) {
  if (!Array.isArray(mapped) || !Array.isArray(liveTrace)) return mapped;
  const visByRound = new Map();
  for (const e of liveTrace) {
    const v = String((e && e.visibleContent) || '').trim();
    if (e && e.round != null && v) visByRound.set(e.round, v);
  }
  if (!visByRound.size) return mapped;
  return mapped.map((e) => {
    const v = e && e.round != null ? visByRound.get(e.round) : '';
    if (!v || String((e && e.visibleContent) || '').trim()) return e;
    return { ...e, visibleContent: v };
  });
}

function applyCheckpointIdsToTrace(traceRows, checkpointByRound) {
  if (!checkpointByRound || !checkpointByRound.size || !Array.isArray(traceRows)) return traceRows;
  return traceRows.map((entry) => {
    const round = entry && entry.round;
    const cp = round != null ? checkpointByRound.get(round) : null;
    if (!cp) return entry;
    return { ...entry, checkpointId: cp };
  });
}

function seedCheckpointByRound(traceRows, checkpointByRound) {
  if (!checkpointByRound || !Array.isArray(traceRows)) return;
  for (const entry of traceRows) {
    if (entry && entry.checkpointId != null && entry.round != null) {
      checkpointByRound.set(entry.round, entry.checkpointId);
    }
  }
}

function formatLlmWaitLabel(kind, modelId) {
  const prefix = kind === 'vision' ? '多模态识图中' : '请求 LLM';
  const id = String(modelId || '').trim();
  let name = '';
  if (id) {
    if (typeof formatModelFooterLabel === 'function') {
      name = String(formatModelFooterLabel(id) || '').trim();
    } else if (typeof humanizeModelId === 'function') {
      name = String(humanizeModelId(id) || '').trim();
    } else {
      name = id;
    }
  }
  if (!name) return `${prefix}…`;
  return `${prefix} · ${name}…`;
}

async function chatCompletionWithToolsViaRust(payload, tools, options = {}) {
  if (!agentApi.agentRustLoopRun) {
    throw new Error('Rust agent loop IPC 不可用');
  }
  let body = options.body ? options.body : { ...payload };
  const useTools = tools && tools.length > 0;
  if (!options.body && useTools) body.tools = tools;
  else if (options.body && useTools && !body.tools) body.tools = tools;

  const trace = options.trace ? options.trace.slice() : [];
  const onProgress = options.onProgress;
  const signal = options.signal;
  const apiConfig = options.apiConfig || getCustomModelApiConfig(body.model);
  const cancelToken = options.cancelToken || `rl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let runId = options.runId || null;
  let coreRunId = null;
  const unregisterBackendCancel = registerActiveAgentBackendCancel(
    'rust-loop',
    cancelToken,
    () => {
      if (agentApi.agentRustLoopCancel) {
        return agentApi.agentRustLoopCancel({ cancelToken, runId: coreRunId || runId });
      }
      return null;
    },
    options.sessionId
  );
  let displayedTrace = trace.slice();
  let liveContent = '';
  let frozenRounds = [];
  const checkpointByRound = new Map();
  let rustLoopFailedCheckpoint = null;
  let tokenUsage = options.tokenUsage
    ? addUsageStats(emptyUsageStats(), options.tokenUsage)
    : emptyUsageStats();

  const RUST_PROGRESS_MIN_INTERVAL_MS = 120;
  let pendingRustProgress = null;
  let rustProgressTimer = null;
  let rustProgressRaf = null;
  let lastRustProgressFlushAt = 0;
  let lastRustProgressStructureSig = '';

  const cloneTraceSnapshot = (traceRows) =>
    traceRows.map((r) => ({ ...r, tools: (r.tools || []).map((t) => ({ ...t })) }));

  const flushRustProgress = () => {
    if (rustProgressTimer) {
      clearTimeout(rustProgressTimer);
      rustProgressTimer = null;
    }
    if (rustProgressRaf) {
      cancelAnimationFrame(rustProgressRaf);
      rustProgressRaf = null;
    }
    if (!pendingRustProgress || typeof onProgress !== 'function') return;
    const { traceRows, streamContent } = pendingRustProgress;
    pendingRustProgress = null;
    lastRustProgressFlushAt = Date.now();
    onProgress(cloneTraceSnapshot(traceRows), streamContent || '');
  };

  const scheduleRustProgress = (traceRows, streamContent) => {
    if (typeof onProgress !== 'function') return;
    pendingRustProgress = { traceRows, streamContent: streamContent || '' };
    const sig =
      typeof thinkingTraceStructureSig === 'function'
        ? thinkingTraceStructureSig(traceRows)
        : String((traceRows || []).length);
    const streamOnly = !!(lastRustProgressStructureSig && sig === lastRustProgressStructureSig);
    lastRustProgressStructureSig = sig;

    if (streamOnly) {
      if (!rustProgressRaf) rustProgressRaf = requestAnimationFrame(flushRustProgress);
      return;
    }

    if (rustProgressRaf) {
      cancelAnimationFrame(rustProgressRaf);
      rustProgressRaf = null;
    }

    const elapsed = Date.now() - lastRustProgressFlushAt;
    const delay = Math.max(0, RUST_PROGRESS_MIN_INTERVAL_MS - elapsed);
    if (rustProgressTimer) return;
    rustProgressTimer = setTimeout(() => {
      rustProgressTimer = null;
      rustProgressRaf = requestAnimationFrame(flushRustProgress);
    }, delay);
  };

  const notifyRustProgress = (traceRows, streamContent, { immediate = false } = {}) => {
    if (typeof onProgress !== 'function') return traceRows;
    if (immediate) {
      pendingRustProgress = { traceRows, streamContent: streamContent || '' };
      lastRustProgressStructureSig =
        typeof thinkingTraceStructureSig === 'function'
          ? thinkingTraceStructureSig(traceRows)
          : String((traceRows || []).length);
      flushRustProgress();
      return traceRows;
    }
    scheduleRustProgress(traceRows, streamContent);
    return traceRows;
  };

  const mapDelegateTools = (delegates) =>
    (delegates || []).map((d) => {
      const rawName = String(d.name || 'tool').trim();
      const rawArgs = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
      const norm =
        typeof normalizeAgentToolName === 'function'
          ? normalizeAgentToolName(rawName, rawArgs)
          : { name: rawName, args: rawArgs };
      return {
        id: d.id || '',
        name: norm.name,
        argsBrief:
          typeof formatToolArgsBrief === 'function'
            ? formatToolArgsBrief(norm.name, norm.args)
            : JSON.stringify(norm.args || {}).slice(0, 120),
        toolArgs: norm.args,
        summary: '',
        pending: true,
        failed: false
      };
    });

  const normalizeDelegateEvent = (evData) => {
    if (!evData) return { name: '', args: {} };
    const rawName = String(evData.name || '').trim();
    const rawArgs = evData.arguments && typeof evData.arguments === 'object' ? evData.arguments : {};
    if (typeof normalizeAgentToolName !== 'function') {
      return { name: rawName, args: rawArgs };
    }
    const norm = normalizeAgentToolName(rawName, rawArgs);
    return { name: norm.name, args: norm.args };
  };

  let rustBootSteps =
    typeof createInitialRustLoopBootSteps === 'function' ? createInitialRustLoopBootSteps() : null;
  let rustBootVisible = !!rustBootSteps;
  let llmWaitTimer = null;
  let llmWaitStartedAt = 0;
  let llmWaitBaseLabel = '';
  /** 本轮是否已出字（首包到达）：出字前显示「请求 LLM…」，出字后改为静默监控 */
  let llmStreaming = false;
  /** 最近一次收到 delta 的时刻 */
  let llmLastDeltaAt = 0;

  /** 思考轮次上的等待备注（如「上游 42s 无数据」）：叠加一行，不覆盖模型正文 */
  const setLiveNote = (note) => {
    const text = String(note || '').trim();
    if (!displayedTrace.length) return;
    const idx = displayedTrace.length - 1;
    const live = displayedTrace[idx];
    if (String(live.liveNote || '') === text) return;
    displayedTrace = displayedTrace.slice();
    displayedTrace[idx] = { ...live, liveNote: text };
    notifyRustProgress(displayedTrace, liveContent);
  };

  const clearLlmWaitTimer = () => {
    if (llmWaitTimer) {
      clearInterval(llmWaitTimer);
      llmWaitTimer = null;
    }
    llmWaitStartedAt = 0;
    llmWaitBaseLabel = '';
    llmStreaming = false;
    llmLastDeltaAt = 0;
    setLiveNote('');
  };

  /**
   * 「等待模型」提示的唯一来源（请求期内只此一处改文案）：
   *   未出字 → 「请求 LLM · 模型（已等 Ns）」
   *   已出字且静默 ≥ STREAM_IDLE_HINT_MS → 备注「上游 Ns 无数据」
   *   已出字且正常 → 不加噪音
   */
  const startLlmWaitTimer = (baseLabel) => {
    clearLlmWaitTimer();
    llmWaitBaseLabel = String(baseLabel || '请求 LLM…');
    llmWaitStartedAt = Date.now();
    llmWaitTimer = setInterval(() => {
      if (!llmWaitStartedAt) return;
      const base = llmWaitBaseLabel.replace(/…\s*$/, '');
      if (!llmStreaming) {
        const sec = Math.max(1, Math.round((Date.now() - llmWaitStartedAt) / 1000));
        pushLive(`${base}（已等 ${sec}s）…`, []);
        return;
      }
      const idleMs = Date.now() - llmLastDeltaAt;
      setLiveNote(idleMs >= STREAM_IDLE_HINT_MS ? `上游 ${Math.round(idleMs / 1000)}s 无数据` : '');
    }, 5000);
  };

  const stripBootStepsFromEntry = (entry) => {
    if (!entry || !entry.bootSteps) return entry;
    const next = { ...entry };
    delete next.bootSteps;
    return next;
  };

  const finishRustBootDisplay = ({ immediate = false } = {}) => {
    if (!rustBootVisible && !rustBootSteps) return;
    rustBootVisible = false;
    rustBootSteps = null;
    for (let i = 0; i < frozenRounds.length; i++) {
      frozenRounds[i] = stripBootStepsFromEntry(frozenRounds[i]);
    }
    displayedTrace = displayedTrace.map(stripBootStepsFromEntry);
    notifyRustProgress(displayedTrace, liveContent, { immediate });
  };

  const syncBootStepsToLiveTrace = ({ immediate = false } = {}) => {
    if (!rustBootVisible || !rustBootSteps || !displayedTrace.length) return;
    const liveIdx = displayedTrace.length - 1;
    const live = displayedTrace[liveIdx];
    if (!live || live.phase === 'prep') return;
    displayedTrace = displayedTrace.slice();
    displayedTrace[liveIdx] = {
      ...live,
      bootSteps:
        typeof cloneRustBootSteps === 'function'
          ? cloneRustBootSteps(rustBootSteps)
          : rustBootSteps.map((s) => ({ ...s }))
    };
    notifyRustProgress(displayedTrace, liveContent, { immediate });
  };

  const patchRustBootSteps = (mutator, { immediate = true } = {}) => {
    if (!rustBootVisible || !rustBootSteps || typeof mutator !== 'function') return;
    const next = mutator(rustBootSteps);
    if (next) rustBootSteps = next;
    syncBootStepsToLiveTrace({ immediate });
  };

  const pushLive = (thoughtPreview, toolsRows, fullThoughtText, extra = {}) => {
    const previous = [...trace, ...frozenRounds].map((e) => e.fullThought || e.thought);
    const rawFull = fullThoughtText != null ? String(fullThoughtText) : String(thoughtPreview || '');
    const full = sanitizeTraceThought(rawFull, previous);
    const preview = full.slice(0, TRACE_DESKTOP_THOUGHT_CHARS);
    const entry = {
      round: trace.length + frozenRounds.length + 1,
      thought: preview,
      fullThought: full,
      tools: toolsRows || [],
      ...(extra || {})
    };
    if (rustBootVisible && rustBootSteps && !entry.bootSteps) {
      entry.bootSteps =
        typeof cloneRustBootSteps === 'function'
          ? cloneRustBootSteps(rustBootSteps)
          : rustBootSteps.map((s) => ({ ...s }));
    }
    displayedTrace = [...trace, ...frozenRounds, entry];
    notifyRustProgress(displayedTrace, liveContent);
  };

  /** 给当前轮打「确认不再调工具」标记：思考区折叠的唯一信号来源 */
  const markAnswerPhaseRound = (traceRows) => {
    const rows = Array.isArray(traceRows) ? traceRows : [];
    if (!rows.length) return rows;
    const idx = rows.length - 1;
    const last = rows[idx];
    if (!last || last.answerPhase) return rows;
    const next = rows.slice();
    next[idx] = { ...last, answerPhase: true };
    return next;
  };

  const freezeLiveWithTools = (toolsRows) => {
    const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
    if (!live) return;
    frozenRounds.push({
      ...live,
      tools: toolsRows || live.tools || [],
      thought: live.thought || live.fullThought || '执行工具…',
      fullThought: live.fullThought || live.thought || ''
    });
    pushLive('…', []);
  };

  const liveThoughtLooksEphemeral = () => {
    const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
    const full = String((live && (live.fullThought || live.thought)) || '').trim();
    if (!full || full === '…' || full === '生成中…') return true;
    if (full.startsWith('压缩上下文：') || full.startsWith('启动 Rust') || full.startsWith('连接中断')) {
      return true;
    }
    return false;
  };

  const offPhase =
    typeof agentApi.onAgentRustLoopPhase === 'function'
      ? agentApi.onAgentRustLoopPhase((ev) => {
          if (!ev || ev.cancelToken !== cancelToken) return;
          if (ev.data && ev.data.runId) coreRunId = ev.data.runId;
          if (ev.phase === 'start') {
            patchRustBootSteps((steps) => {
              rustBootStepDone(steps, 'ipc_start');
              rustBootStepDone(steps, 'loop_init');
              return steps;
            });
          } else if (ev.phase === 'llm_request') {
            patchRustBootSteps((steps) => {
              const compact = steps.find((s) => s.id === 'compact_loop');
              if (compact && (compact.status === 'pending' || compact.status === 'active')) {
                const detail =
                  compact.status === 'active' && compact.detail
                    ? String(compact.detail).slice(0, 120)
                    : '无需压缩';
                rustBootStepSkip(steps, 'compact_loop', detail);
              }
              rustBootStepDone(steps, 'loop_init');
              rustBootStepStart(steps, 'llm_handoff');
              rustBootStepDone(steps, 'llm_handoff');
              return steps;
            });
            finishRustBootDisplay({ immediate: true });
            const modelId = (ev.data && ev.data.model) || body.model || '';
            const phaseLabel = formatLlmWaitLabel(options.hasImages ? 'vision' : 'text', modelId);
            pushLive(phaseLabel, []);
            startLlmWaitTimer(phaseLabel);
          } else if (ev.phase === 'llm_delta') {
            // 不结束心跳：出字后从「请求 LLM（已等 Ns）」切到「静默时长」监控，
            // 上游断流时才会出现「上游 Ns 无数据」，不再回落成无信息的占位符
            llmStreaming = true;
            llmLastDeltaAt = Date.now();
            finishRustBootDisplay();
            const reasoning = String((ev.data && ev.data.reasoning) || '');
            const rawContent = String((ev.data && ev.data.content) || '');
            const content = stripVisibleToolCallMarkup(rawContent);
            const hasToolCalls = !!(ev.data && ev.data.hasToolCalls);
            if (reasoning) {
              // 双通道：reasoning → 思考；有 tool 时 content 挂轮次旁白，无 tool 时才进回答尾
              const extra = hasToolCalls && content ? { visibleContent: content } : {};
              pushLive(reasoning, [], reasoning, extra);
              liveContent = hasToolCalls ? '' : content;
            } else if (content) {
              // 单通道（如 mimo）：流式 content 是推理，不应泄漏到正文区
              pushLive(content, [], content);
              liveContent = '';
            } else {
              pushLive('生成中…', []);
            }
          } else if (ev.phase === 'llm_response') {
            clearLlmWaitTimer();
            if (ev.data?.usage) {
              const usageChunk = extractUsageStats(ev.data.usage, ev.data.model || body.model);
              tokenUsage = addUsageStats(tokenUsage, usageChunk);
              if (typeof noteComposerSessionUsage === 'function' && options.sessionId) {
                noteComposerSessionUsage(options.sessionId, usageChunk);
              }
            }
            const toolCalls = Number(ev.data && ev.data.toolCalls);
            if (Number.isFinite(toolCalls) && toolCalls > 0) {
              const leftover = stripVisibleToolCallMarkup(
                String((ev.data && ev.data.content) || liveContent || '')
              ).trim();
              const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
              if (live && leftover) live.visibleContent = leftover;
              liveContent = '';
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            } else if (Number.isFinite(toolCalls) && toolCalls === 0) {
              // 本轮不再调工具：正文会落到回答区，思考区据此折叠
              displayedTrace = markAnswerPhaseRound(displayedTrace);
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            } else if (ev.data && ev.data.persistRound) {
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            }
          } else if (ev.phase === 'synthesis_start') {
            displayedTrace = upsertSynthesisTraceRound(displayedTrace, { streaming: true });
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
          } else if (ev.phase === 'synthesis_delta') {
            liveContent = String((ev.data && ev.data.content) || liveContent);
            notifyRustProgress(displayedTrace, liveContent);
          } else if (ev.phase === 'synthesis_done') {
            displayedTrace = upsertSynthesisTraceRound(displayedTrace, {
              streaming: false,
              failed: !!(ev.data && ev.data.failed)
            });
            if (ev.data && ev.data.content) liveContent = String(ev.data.content);
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
          } else if (ev.phase === 'turn_overflow_stopped') {
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            showAgentToast(
              '本轮已停止',
              '上下文仍超限（已压缩一次）。思考已保留，可新开对话或缩短历史后再试。',
              { variant: 'warn' }
            );
          } else if (ev.phase === 'compacted') {
            const compactCr = {
              tokensBefore: ev.data && ev.data.tokensBefore,
              tokensAfter: ev.data && ev.data.tokensAfter
            };
            if (typeof noteContextCompaction === 'function' && options.sessionId) {
              noteContextCompaction(compactCr, options.sessionId);
            }
            const before = Number(compactCr.tokensBefore);
            const after = Number(compactCr.tokensAfter);
            const compactDetail =
              Number.isFinite(before) && Number.isFinite(after)
                ? `${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tokens`
                : '';
            patchRustBootSteps((steps) => {
              rustBootStepStart(steps, 'compact_loop');
              rustBootStepDone(steps, 'compact_loop', compactDetail || undefined);
              return steps;
            });
            const detail =
              Number.isFinite(before) && Number.isFinite(after)
                ? `messages 约 ${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tokens；工具定义另计，圆环仍可能偏红`
                : '较早对话已摘要归档，可继续当前任务';
            showAgentToast('上下文已压缩', detail, { variant: 'info' });
          } else if (ev.phase === 'compact_skipped') {
            const skipReason = String((ev.data && ev.data.reason) || '');
            const skipDetail =
              skipReason === 'content_policy'
                ? '内容审核拦截'
                : typeof shortenCompactionLlmMessage === 'function'
                  ? shortenCompactionLlmMessage(ev.data && ev.data.llmError)
                  : '模型超时或失败';
            patchRustBootSteps((steps) => {
              rustBootStepStart(steps, 'compact_loop');
              rustBootStepSkip(steps, 'compact_loop', skipDetail || '已跳过');
              return steps;
            });
            showAgentToast(
              skipReason === 'content_policy' ? '上下文压缩被供应商拦截' : '上下文压缩已跳过',
              skipReason === 'content_policy'
                ? '内容审核未通过，已跳过压缩继续请求。建议新开对话或缩短历史。'
                : '摘要模型超时或失败，本轮继续用原对话。可新开对话或缩短历史后再试。',
              { variant: 'warn' }
            );
          } else if (ev.phase === 'delegate_start') {
            const toolsRows = mapDelegateTools(ev.data && ev.data.delegates);
            freezeLiveWithTools(toolsRows);
            const fr = frozenRounds[frozenRounds.length - 1];
            const runSessionId = options.sessionId || null;
            const undoTurnId =
              options.undoTurnId ||
              (runSessionId && typeof getUndoTurnIdForSession === 'function'
                ? getUndoTurnIdForSession(runSessionId)
                : null);
            const hasMutatingBatch =
              fr &&
              (fr.tools || []).some((t) =>
                typeof isMutatingAgentTool === 'function' ? isMutatingAgentTool(t.name) : false
              );
            if (fr && undoTurnId && hasMutatingBatch && typeof captureTurnBatchCheckpoint === 'function') {
              void captureTurnBatchCheckpoint({
                sessionId: runSessionId,
                turnId: undoTurnId,
                round: fr.round,
                tools: fr.tools,
                runWorkspaceRoot: options.runWorkspaceRoot
              })
                .then((r) => {
                  if (r && r.ok && r.batchId) {
                    fr.checkpointId = r.batchId;
                    if (fr.round != null) checkpointByRound.set(fr.round, r.batchId);
                    notifyRustProgress(displayedTrace, liveContent, { immediate: true });
                  }
                })
                .catch(() => {});
            }
            if (typeof syncLiveWriteFromTrace === 'function') {
              void syncLiveWriteFromTrace(displayedTrace, { sessionId: runSessionId });
            }
          } else if (ev.phase === 'delegate_result') {
            const fr = frozenRounds[frozenRounds.length - 1];
            const normEv = normalizeDelegateEvent(ev.data);
            if (fr && fr.tools) {
              const tool =
                fr.tools.find((t) => t.id && t.id === ev.data.id) ||
                fr.tools.find((t) => t.pending && t.name === normEv.name);
              if (tool) {
                tool.pending = false;
                tool.toolArgs = normEv.args || tool.toolArgs || {};
                const result = ev.data.result || {};
                const failed = !!(ev.data.error || result.error || result.ok === false);
                tool.failed = failed;
                if (ev.data.error) {
                  tool.summary = `错误: ${ev.data.error}`;
                  tool.errorCode = 'EXCEPTION';
                } else if (typeof summarizeToolResult === 'function') {
                  tool.summary = summarizeToolResult(normEv.name, {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    code: result.code,
                    ...result
                  });
                } else {
                  tool.summary = failed ? `错误: ${result.error || '失败'}` : '完成';
                }
                if (result.errorCode) tool.errorCode = result.errorCode;
                if (result.suggestedFix) tool.suggestedFix = result.suggestedFix;
                if (
                  (normEv.name === 'fs_write_file' || normEv.name === 'fs_edit') &&
                  result.diff &&
                  typeof compactDiffForTrace === 'function'
                ) {
                  tool.diff = compactDiffForTrace(result.diff);
                }
                if (!failed && typeof maybeShowProposeToolPreview === 'function') {
                  maybeShowProposeToolPreview(normEv.name, result);
                }
              }
            }
            const live = displayedTrace[displayedTrace.length - 1];
            pushLive(live?.thought || '…', fr?.tools || live?.tools || []);
            if (typeof syncLiveWriteFromTrace === 'function') {
              void syncLiveWriteFromTrace(displayedTrace, { sessionId: runSessionId });
            }
          } else if (ev.phase === 'llm_reconnect_wait') {
            clearLlmWaitTimer();
            const waitData = ev.data || {};
            const sec = Math.max(1, Math.round((waitData.waitMs || 0) / 1000));
            const remainMin = waitData.remainingMs > 0 ? Math.ceil(waitData.remainingMs / 60000) : 0;
            const budgetNote = remainMin > 0 ? `，最长再等 ${remainMin} 分钟` : '';
            if (!liveThoughtLooksEphemeral()) {
              const live = displayedTrace[displayedTrace.length - 1];
              freezeLiveWithTools((live && live.tools) || []);
            }
            pushLive(
              `连接中断，${sec}s 后自动重试（第 ${waitData.attempt || 1} 次${budgetNote}）…`,
              [],
              '等待模型连接恢复，恢复后将从当前进度继续…'
            );
            maybeShowLlmReconnectToast(
              '模型连接中断',
              `${sec}s 后自动重试${budgetNote}，无需手动点「继续」`,
              { force: (waitData.attempt || 1) === 1 }
            );
          } else if (ev.phase === 'loop_failed' && ev.data?.checkpoint) {
            rustLoopFailedCheckpoint = ev.data.checkpoint;
          }
        })
      : null;

  const onAbort = () => {
    if (options.sessionId) {
      cancelActiveAgentBackendsForSession(options.sessionId, '用户停止');
    } else {
      cancelActiveAgentBackends('用户停止');
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let onCompactionProgressUi = null;
  try {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      err.trace = displayedTrace;
      throw err;
    }

    pushLive('启动 Rust agent loop…', []);
    patchRustBootSteps((steps) => {
      rustBootStepStart(steps, 'compact_preflight');
      return steps;
    });
    onCompactionProgressUi = (ev) => {
      const detail = (ev && ev.detail) || {};
      const note = detail.note || formatCompactionProgressNote(detail);
      if (!note) return;
      const kind = String(detail.kind || '');
      patchRustBootSteps((steps) => {
        const pre = (steps || []).find((s) => s && s.id === 'compact_preflight' && s.status === 'active');
        if (pre) {
          if (kind === 'llm_skip') {
            rustBootStepSkip(steps, 'compact_preflight', note);
          } else if (typeof rustBootStepNote === 'function') {
            rustBootStepNote(steps, 'compact_preflight', note);
          } else {
            pre.detail = String(note).slice(0, 160);
          }
          return steps;
        }
        if (kind === 'llm_skip') {
          rustBootStepStart(steps, 'compact_loop');
          rustBootStepSkip(steps, 'compact_loop', note);
          return steps;
        }
        rustBootStepStart(steps, 'compact_loop');
        if (typeof rustBootStepNote === 'function') rustBootStepNote(steps, 'compact_loop', note);
        return steps;
      });
      if (!liveThoughtLooksEphemeral()) {
        const live = displayedTrace[displayedTrace.length - 1];
        freezeLiveWithTools((live && live.tools) || []);
      }
      pushLive(`压缩上下文：${note}`, []);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('dieyun:compaction-progress', onCompactionProgressUi);
    }
    const preflightResult = await applyContextCompaction(body, {
      signal,
      apiConfig,
      sessionId: options.sessionId || undefined
    });
    if (signal?.aborted) {
      throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
    }
    patchRustBootSteps((steps) => {
      if (preflightResult && preflightResult.compacted) {
        rustBootStepDone(steps, 'compact_preflight', '已压缩');
      } else if (preflightResult && preflightResult.skipped === 'llm_error') {
        rustBootStepSkip(
          steps,
          'compact_preflight',
          shortenCompactionLlmMessage(preflightResult.llmError)
        );
      } else if (preflightResult && preflightResult.skipped === 'content_policy') {
        rustBootStepSkip(steps, 'compact_preflight', '内容审核拦截');
      } else {
        rustBootStepSkip(steps, 'compact_preflight', '未触发');
      }
      rustBootStepStart(steps, 'ipc_start');
      return steps;
    });
    const runRustSegment = (segmentBody) => {
      patchRustBootSteps((steps) => {
        rustBootStepStart(steps, 'loop_init');
        return steps;
      });
      return agentApi.agentRustLoopRun({
        cancelToken,
        runWorkspaceRoot: options.runWorkspaceRoot || undefined,
        browserVision: resolveBrowserVision(segmentBody.model),
        startParams: {
          model: segmentBody.model,
          messages: sanitizeMessagesForChatApi(segmentBody.messages),
          tools: segmentBody.tools || tools || [],
          maxToolCalls: scaleRunLimit('ctxAgentToolCallLimit', getAgentToolCallLimit(), options),
          maxRounds: scaleRunLimit('agentMaxRounds', getAgentMaxRounds(), options),
          taskTier: options.taskTier || undefined,
          longHorizon: runIsLongHorizon(options)
        },
        apiConfig,
        modelRoute: options.modelRoute || undefined,
        sessionId: options.sessionId || undefined,
        model: segmentBody.model,
        taskTier: options.taskTier || undefined,
        longHorizon: runIsLongHorizon(options),
        contextTierId:
          typeof resolveContextTierId === 'function'
            ? resolveContextTierId({ sessionId: options.sessionId })
            : undefined,
        undoTurnId: runIsLongHorizon(options)
          ? undefined
          : options.undoTurnId ||
            (typeof getUndoTurnIdForSession === 'function' && options.sessionId
              ? getUndoTurnIdForSession(options.sessionId)
              : null),
        turnEndSynthesis: !options.readinessRetry
      });
    };

    let done = null;
    let mapped = trace.slice();
    let resultTrace = mapped;
    let finalContent = '';
    let hitRoundLimit = false;
    let loopMessages = body.messages;
    let tracePrefix = trace.slice();

    while (true) {
      if (signal?.aborted) {
        throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
      }
      done = await runRustSegment(body);
      if (signal?.aborted) {
        throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
      }
      if (done && done.overflowStopped) {
        finalContent =
          stripVisibleToolCallMarkup(done.content || liveContent || '') ||
          '上下文仍超限，本轮已停止。思考已保留，可缩短历史后再试。';
        resultTrace = displayedTrace;
        notifyRustProgress(displayedTrace, finalContent, { immediate: true });
        break;
      }
      finalContent = stripVisibleAgentStatus(stripVisibleToolCallMarkup(done.content || ''));
      mapped = mapRustAgentTrace(done.trace, tracePrefix);
      mapped = mergeTraceVisibleContent(mapped, displayedTrace);
      seedCheckpointByRound(mapped, checkpointByRound);
      mapped = applyCheckpointIdsToTrace(mapped, checkpointByRound);
      resultTrace = mapped;
      displayedTrace = notifyRustProgress(mapped, finalContent, { immediate: true });
      hitRoundLimit = !!done.hitRoundLimit;
      loopMessages = Array.isArray(done.messages) && done.messages.length ? done.messages : body.messages;
      break;
    }

    liveContent = finalContent;

    let toolCallsUsed = 0;
    for (const r of resultTrace || []) {
      toolCallsUsed += Array.isArray(r.tools) ? r.tools.length : 0;
    }

    if (hitRoundLimit) {
      body = { ...body, messages: loopMessages };
      await maybeCompactBodyIfHeavy(body, {
        signal,
        apiConfig,
        sessionId: options.sessionId || undefined
      });
    }

    const outBody = hitRoundLimit
      ? { ...body, messages: buildSegmentContinueMessages(body.messages, finalContent) }
      : body;

    return {
      runId: runId || coreRunId || null,
      content: finalContent || '(空响应)',
      trace: resultTrace,
      hitRoundLimit,
      toolCallsUsed,
      toolFingerprintHistory: options.toolFingerprintHistory || [],
      body: outBody,
      messages: loopMessages,
      tools,
      tokensUsed: options.tokensUsed || tokenUsage.totalTokens || 0,
      tokenUsage
    };
  } catch (err) {
    flushRustProgress();
    if (!err.trace || !err.trace.length) {
      err.trace = displayedTrace.slice();
    }
    if (isUserAbortError(err)) {
      throw toUserAbortError(err, { trace: displayedTrace });
    }
    const checkpoint = rustLoopFailedCheckpoint;
    if (
      (isTransientFetchError(err) || err.code === 'LLM_RECONNECT_EXHAUSTED') &&
      displayedTrace.length > 0
    ) {
      const checkpointBody = checkpoint
        ? {
            ...body,
            model: checkpoint.model || body.model,
            messages: checkpoint.messages || body.messages,
            tools: checkpoint.tools || body.tools || tools
          }
        : body;
      err.partialResult = {
        content: liveContent || '',
        trace: displayedTrace,
        body: checkpointBody,
        toolFingerprintHistory: options.toolFingerprintHistory || [],
        tokensUsed: options.tokensUsed || tokenUsage.totalTokens || 0,
        tokenUsage,
        runId: runId || coreRunId || checkpoint?.runId || null
      };
      err.networkDisconnect = true;
    }
    throw err;
  } finally {
    clearLlmWaitTimer();
    flushRustProgress();
    rustLoopFailedCheckpoint = null;
    unregisterBackendCancel();
    if (offPhase) offPhase();
    if (signal) signal.removeEventListener('abort', onAbort);
    if (typeof window !== 'undefined' && onCompactionProgressUi) {
      window.removeEventListener('dieyun:compaction-progress', onCompactionProgressUi);
    }
  }
}
