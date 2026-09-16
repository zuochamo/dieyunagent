/* global fetchChatCompletion, settings, compactPlainText, getSessionAbortSignal, extractReviewerJson, collectReviewerFileDiffs, collectExpectationSignals */
'use strict';

/**
 * 浏览器侧证据（给 Reviewer）：console/网络硬错误 + 最后一次 browser_expect 结果。
 * 无浏览器动作且无断言时返回 null，避免给 Reviewer 增加噪声。
 */
function buildReviewerBrowserEvidence(browser, trace) {
  const src = browser && typeof browser === 'object' ? browser : null;
  const exp =
    typeof collectExpectationSignals === 'function' ? collectExpectationSignals(trace) : null;
  const usedExpectation = !!(exp && exp.used);
  if (!src && !usedExpectation) return null;

  const out = {
    consoleErrors: src ? Number(src.consoleErrorCount) || 0 : 0,
    networkFailures: src ? Number(src.networkErrorCount) || 0 : 0
  };
  if (src && Array.isArray(src.errors) && src.errors.length) {
    out.errorSamples = src.errors.slice(0, 3).map((e) => compactPlainText(String(e || ''), 160));
  }
  if (usedExpectation) {
    out.lastAssertion = exp.lastFailed ? 'failed' : 'passed';
    if (exp.lastSummary) out.assertionSummary = compactPlainText(exp.lastSummary, 160);
  }
  return out;
}

function compactTraceForReviewer(trace, maxEntries = 18) {
  const rows = Array.isArray(trace) ? trace.slice(-maxEntries) : [];
  return rows
    .map((entry) => {
      const tools = (entry.tools || [])
        .map((tool) => {
          const status = tool.failed ? 'failed' : 'ok';
          const name = tool.name || 'tool';
          const args = tool.argsBrief ? `(${tool.argsBrief})` : '';
          const summary = compactPlainText(tool.summary || tool.result || tool.error || '', 260);
          return `  - ${name}${args}: ${status}${summary ? ` · ${summary}` : ''}`;
        })
        .join('\n');
      const thought = compactPlainText(entry.fullThought || entry.thought || '', 280);
      return `#${entry.round || ''} ${entry.phase || '阶段'}${thought ? `\n${thought}` : ''}${tools ? `\n${tools}` : ''}`;
    })
    .join('\n\n');
}

function isResponseFormatUnsupportedError(err) {
  const text = String(err?.message || err || '').toLowerCase();
  return text.includes('response_format') || text.includes('json_object') || text.includes('unsupported parameter');
}

/** Reviewer 单次调用（含 JSON 模式重发兜底）的总时长上限：超时即跳过验收，不拖住收尾 */
const REVIEWER_COMPLETION_TIMEOUT_MS = 60000;

/**
 * 组合「会话停止」与「本函数超时」两个信号；AbortSignal.any 不可用时退化为事件转发。
 */
function linkReviewerAbortSignals(externalSignal, timeoutSignal) {
  const list = [externalSignal, timeoutSignal].filter(Boolean);
  if (!list.length) return undefined;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const merged = new AbortController();
  for (const sig of list) {
    if (sig.aborted) {
      merged.abort();
      break;
    }
    sig.addEventListener('abort', () => merged.abort(), { once: true });
  }
  return merged.signal;
}

async function fetchReviewerCompletion(pick, { messages, signal, maxTokens = 1600, useJsonMode = true }) {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, REVIEWER_COMPLETION_TIMEOUT_MS);
  const base = {
    model: pick.model,
    apiConfig: pick.apiConfig,
    temperature: 0,
    max_tokens: maxTokens,
    signal: linkReviewerAbortSignals(signal, timeoutController.signal),
    messages
  };
  try {
    if (!useJsonMode) return await fetchChatCompletion(base);
    try {
      return await fetchChatCompletion({
        ...base,
        response_format: { type: 'json_object' }
      });
    } catch (err) {
      if (isResponseFormatUnsupportedError(err)) {
        return await fetchChatCompletion(base);
      }
      throw err;
    }
  } catch (err) {
    // 只有「本地超时」才改写文案；用户停止（外部 signal）保持 AbortError，避免误报成"已停止"
    if (timedOut && !signal?.aborted) {
      throw new Error(`Reviewer 请求超时（${Math.round(REVIEWER_COMPLETION_TIMEOUT_MS / 1000)}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function repairReviewerJson(raw, pick, signal) {
  const sample = compactPlainText(raw || '', 2400);
  if (!sample || sample === '(空响应)') return null;
  try {
    const repaired = await fetchReviewerCompletion(pick, {
      signal,
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content:
            '你只负责把输入改写成合法 JSON 对象。只输出 JSON，不要 Markdown。字段固定为：{"accepted":boolean,"acceptancePlan":string[],"reason":string,"missing":string[],"nextAction":string}。如果原文无法判断是否通过，则 accepted=true，reason 写“Reviewer 格式修复无法可靠判断，跳过验收”。'
        },
        {
          role: 'user',
          content: sample
        }
      ]
    });
    return extractReviewerJson(repaired);
  } catch {
    return null;
  }
}

function resolveReviewerModelForRun() {
  const configuredModel = String(settings?.reviewerModel || '').trim();
  const configuredBaseUrl = String(settings?.reviewerBaseUrl || '').trim();
  if (!configuredModel || !configuredBaseUrl) return null;
  return {
    model: configuredModel,
    apiConfig: {
      baseUrl: configuredBaseUrl,
      apiKey: String(settings?.reviewerApiKey || '').trim()
    },
    source: 'settings'
  };
}

function shouldRunReviewerValidation(files) {
  if (settings?.reviewerEnabled !== true) return false;
  if (!resolveReviewerModelForRun()) return false;
  return Array.isArray(files) && files.length > 0;
}

function buildReviewerReadiness(result) {
  const missing = Array.isArray(result?.missing) ? result.missing.filter(Boolean) : [];
  const reason = compactPlainText(result?.reason || result?.note || 'Reviewer 判定目标尚未可靠完成。', 500);
  const nextAction = compactPlainText(result?.nextAction || '', 500);
  const note =
    'Reviewer 目标验收未通过：' +
    reason +
    (missing.length ? `\n缺失项：${missing.join('；')}` : '') +
    (nextAction ? `\n下一步：${nextAction}` : '');
  return {
    ok: false,
    shouldRetry: false,
    surfaceToUser: true,
    note,
    reason: 'reviewer_validation_failed',
    reviewer: result
  };
}

function pushReviewerTrace(trace, thought) {
  if (!Array.isArray(trace)) return;
  trace.push({
    round: trace.length + 1,
    phase: 'Reviewer 验收',
    thought,
    tools: []
  });
}

async function runReviewerValidation(run, fc, context = {}) {
  const trace = context.trace;
  const files =
    typeof collectReviewerFileDiffs === 'function'
      ? collectReviewerFileDiffs(context.sessionChanges, trace, { maxFiles: 12, maxSnippetChars: 3500 })
      : [];
  if (!shouldRunReviewerValidation(files)) {
    return { ok: true, skipped: true };
  }
  if (typeof fetchChatCompletion !== 'function') {
    pushReviewerTrace(trace, 'Reviewer 调用失败，已跳过：当前环境没有可用的模型调用函数。');
    return { ok: true, skipped: true };
  }
  const pick = resolveReviewerModelForRun();
  const diagnostics = context.diagnostics && typeof context.diagnostics === 'object' ? context.diagnostics : null;
  const payload = {
    userTask: compactPlainText(fc.fullText || '', 1800),
    files,
    diagnostics: diagnostics
      ? {
          hasErrors: !!diagnostics.hasErrors,
          text: compactPlainText(diagnostics.text || '', 800)
        }
      : null,
    planSummary: compactPlainText(run?.result?.plan?.planSummary || '', 600),
    browser: buildReviewerBrowserEvidence(context.browser, trace)
  };

  let parsed = null;
  let raw = '';
  try {
    raw = await fetchReviewerCompletion(pick, {
      signal: getSessionAbortSignal(fc.runSessionId),
      maxTokens: 1600,
      messages: [
        {
          role: 'system',
          content:
            '你是叠云 Agent 的独立 Reviewer。根据用户目标和文件 diff 判断是否满足目标，不要依据聊天过程或模型自称完成。只输出一个合法 JSON 对象，不要 Markdown。格式固定为：{"accepted":true,"acceptancePlan":["验收项"],"reason":"一句话原因","missing":[],"nextAction":""}。若未通过，accepted=false，并填写 missing 与 nextAction。不要要求不必要的额外工作；diff 已覆盖用户目标则 accepted=true。' +
            '额外：若 browser 证据显示页面运行时错误（consoleErrors / networkFailures 大于 0）或最后一次断言失败（lastAssertion="failed"），且与本次改动相关，则不应 accepted=true，需在 missing 与 nextAction 中说明；若证据为空或明显与本任务无关，则不因此扣分。'
        },
        {
          role: 'user',
          content: `请审查以下变更是否满足用户目标：\n\n${JSON.stringify(payload, null, 2)}`
        }
      ]
    });
    parsed = extractReviewerJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      parsed = await repairReviewerJson(raw, pick, getSessionAbortSignal(fc.runSessionId));
    }
  } catch (err) {
    const message = compactPlainText(err?.message || String(err), 240);
    pushReviewerTrace(trace, `Reviewer 调用失败，已跳过：${message}`);
    return { ok: true, skipped: true, error: err };
  }

  if (!parsed || typeof parsed !== 'object') {
    const preview = compactPlainText(raw || '', 260);
    pushReviewerTrace(
      trace,
      `Reviewer 未返回合法 JSON，已跳过${preview ? `：${preview}` : '。'}`
    );
    return { ok: true, skipped: true, raw };
  }

  const accepted = parsed.accepted === true;
  pushReviewerTrace(
    trace,
    accepted
      ? `Reviewer 通过：${compactPlainText(parsed.reason || 'diff 覆盖用户目标。', 500)}`
      : `Reviewer 未通过：${compactPlainText(parsed.reason || parsed.nextAction || '目标尚未可靠完成。', 700)}`
  );
  if (accepted) return { ok: true, reviewer: parsed, model: pick.model };
  return buildReviewerReadiness(parsed);
}

