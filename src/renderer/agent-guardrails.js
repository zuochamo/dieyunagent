/* global window, getAgentLimits, GuardrailsShared, extractPathHintsFromText, textHasCodebaseMention, editToolFilePath */
'use strict';

const shared = typeof GuardrailsShared !== 'undefined' ? GuardrailsShared : null;
if (!shared) {
  throw new Error('guardrails-shared.js must load before agent-guardrails.js');
}

function limits() {
  return typeof getAgentLimits === 'function' ? getAgentLimits() : {};
}

const api = shared.createGuardrailApi(() => limits());

function recordToolCallFingerprint(history, name, args) {
  return api.recordToolCallFingerprint(history, name, args);
}

function shouldBlockRepeatToolCall(name, args, history, limit) {
  return api.shouldBlockRepeatToolCall(name, args, history, limit);
}

function repeatToolBlockMessage(name, argsBrief) {
  return api.repeatToolBlockMessage(name, argsBrief);
}

// 工具名归类来自单一来源 guardrails-shared.js（含 host_exec；下方 isTraceMutatingTool 对 host_exec 按命令内容细分）


function hostExecLooksFileWritingTool(tool) {
  const args = tool && typeof tool.toolArgs === 'object' ? tool.toolArgs : {};
  const command = String(args.command || tool?.command || tool?.argsBrief || '').trim();
  return shared.hostExecLooksFileWriting(command);
}

function hostExecLooksValidationTool(tool) {
  const args = tool && typeof tool.toolArgs === 'object' ? tool.toolArgs : {};
  const command = String(args.command || tool?.command || tool?.argsBrief || '').trim();
  const summary = String(tool?.summary || '').trim();
  return shared.hostExecLooksValidation(`${command}\n${summary}`);
}

function isTraceMutatingTool(tool) {
  if (tool && tool.failed) return false;
  const n = String(tool?.name || '').trim();
  if (n === 'host_exec') return hostExecLooksFileWritingTool(tool);
  return shared.MUTATING_TOOL_NAMES.has(n);
}

function traceToolFilePath(tool) {
  if (typeof editToolFilePath === 'function') {
    const p = editToolFilePath(tool);
    if (p) return p;
  }
  const args = tool && typeof tool.toolArgs === 'object' ? tool.toolArgs : {};
  const raw = String(
    args.filePath || args.path || tool?.filePath || tool?.path || tool?.argsBrief || ''
  ).trim();
  if (!raw) return '';
  return raw.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
}

function collectTraceWriteSignals(trace) {
  const fileWrites = new Set();
  const hostFileWrites = new Set();
  const mutators = new Set();
  const filePaths = new Set();
  for (const entry of trace || []) {
    for (const t of entry.tools || []) {
      if (!isTraceMutatingTool(t)) continue;
      const n = String(t.name || '').trim();
      mutators.add(n);
      if (n === 'host_exec') hostFileWrites.add(n);
      if (shared.FILE_WRITE_TOOL_NAMES.has(n)) {
        fileWrites.add(n);
        const p = traceToolFilePath(t);
        if (p) filePaths.add(p);
      }
    }
  }
  return { mutators, fileWrites, hostFileWrites, filePaths };
}

function traceUsedMutatingTools(trace) {
  return collectTraceWriteSignals(trace).mutators;
}

function parseToolExitCode(tool) {
  const summary = String(tool?.summary || '');
  const m = summary.match(/\bexit\s+(-?\d+)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function replyClaimsFileWork(_text) {
  // 禁用「宣称完成」关键词；是否缺写入只看 trace / changes 结构信号
  return false;
}

/** 结构信号：路径 / @Codebase / 编辑器选区 / 选中产物 — 禁用任务意图词表 */
function hasFileModificationStructureSignal(userText) {
  const user = String(userText || '');
  if (!user.trim()) return false;
  if (typeof textHasCodebaseMention === 'function' && textHasCodebaseMention(user)) return true;
  if (typeof extractPathHintsFromText === 'function' && extractPathHintsFromText(user).length) {
    return true;
  }
  if (typeof window !== 'undefined') {
    if (typeof window.getMonacoEditorContext === 'function') {
      const ctx = window.getMonacoEditorContext();
      if (ctx && ctx.activeFilePath && ctx.selection?.text) return true;
    }
    if (typeof window.getSelectedArtifactPath === 'function' && window.getSelectedArtifactPath()) {
      return true;
    }
  }
  return false;
}

function isLikelyFileModificationTask(userText, _reply) {
  return hasFileModificationStructureSignal(userText);
}

function getTraceWriteFilePaths(trace) {
  const out = [];
  const seen = new Set();
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (!isTraceMutatingTool(tool)) continue;
      const p = traceToolFilePath(tool);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * 浏览器侧证据：只从 trace 判断「是否用过浏览器工具」，运行时错误由调用方
 * 通过 browser.console / browser.network 现场采集后传入（browser 参数）。
 */
function collectBrowserEvidence(trace, browser) {
  const signal = { used: false, tools: [], failedTools: [], errorCount: 0, errors: [] };
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      const name = String(tool?.name || '').trim();
      if (!name.startsWith('browser_')) continue;
      signal.used = true;
      if (!signal.tools.includes(name)) signal.tools.push(name);
      if (tool?.failed) signal.failedTools.push(name);
    }
  }
  const input = browser && typeof browser === 'object' ? browser : null;
  // 未用过浏览器工具时，忽略传入的运行时错误（缓冲可能是上一轮/别的会话残留）
  if (input && signal.used) {
    signal.errorCount = Math.max(0, Number(input.errorCount) || 0);
    signal.errors = Array.isArray(input.errors) ? input.errors.slice(0, 3) : [];
  }
  return signal;
}

/**
 * browser_expect 断言信号：只看**最后一次**断言调用的结果。
 * 这样"先失败 → 修复后重跑通过"不会被误判为验收未通过。
 */
function collectExpectationSignals(trace) {
  let total = 0;
  let failedCount = 0;
  let lastFailed = false;
  let lastSummary = '';
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (String(tool?.name || '').trim() !== 'browser_expect') continue;
      total += 1;
      const failed = !!tool?.failed;
      if (failed) failedCount += 1;
      lastFailed = failed;
      lastSummary = String(tool?.summary || '').slice(0, 160);
    }
  }
  return { total, failedCount, lastFailed, lastSummary, used: total > 0 };
}

function collectCompletionEvidence(trace, sessionChanges, diagnostics, browser) {
  const changes = Array.isArray(sessionChanges) ? sessionChanges : [];
  const signals = collectTraceWriteSignals(trace);
  const failedTools = [];
  const failedValidationTools = [];
  const passedValidationTools = [];

  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      const name = String(tool?.name || '').trim();
      const exitCode = parseToolExitCode(tool);
      const failed =
        !!tool?.failed || (name === 'host_exec' && exitCode != null && exitCode !== 0);
      const validation =
        name === 'host_exec'
          ? hostExecLooksValidationTool(tool)
          : /diagnostics|test|lint|check/i.test(name);
      if (failed) failedTools.push(tool);
      if (validation && failed) failedValidationTools.push(tool);
      if (validation && !failed && (exitCode === 0 || (exitCode == null && !tool?.failed))) {
        passedValidationTools.push(tool);
      }
    }
  }

  const expectationSignals = collectExpectationSignals(trace);
  const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
  const hasDiagnosticErrors = !!diag?.hasErrors;
  const hasDiagnosticsEvidence = !!diag;
  const hasChanges = changes.length > 0;
  const hasWriteSignal = signals.fileWrites.size > 0 || signals.hostFileWrites.size > 0 || hasChanges;
  const browserSignals = collectBrowserEvidence(trace, browser);

  return {
    changes,
    signals,
    filePaths: [...signals.filePaths],
    hasChanges,
    hasWriteSignal,
    hasFileWriteTool: signals.fileWrites.size > 0,
    hasHostFileWrite: signals.hostFileWrites.size > 0,
    failedTools,
    failedValidationTools,
    passedValidationTools,
    hasFailedTools: failedTools.length > 0,
    hasFailedValidation: failedValidationTools.length > 0,
    hasPassedValidation: passedValidationTools.length > 0 || (hasDiagnosticsEvidence && !hasDiagnosticErrors),
    hasDiagnosticErrors,
    hasDiagnosticsEvidence,
    browserSignals,
    hasBrowserSignal: browserSignals.used,
    hasBrowserRuntimeErrors: browserSignals.errorCount > 0,
    expectationSignals,
    hasFailedExpectation: expectationSignals.lastFailed
  };
}

function buildReadinessResult(note, context, extra = {}) {
  return {
    ok: false,
    shouldRetry: false,
    surfaceToUser: true,
    note,
    ...extra
  };
}

function verifyTargetCompletion() {
  return { ok: true, skipped: true, checks: [] };
}

function verifyAgentCompletionReadiness(reply, trace, sessionChanges, context = {}) {
  const evidence = collectCompletionEvidence(trace, sessionChanges, context.diagnostics, context.browser);
  const claimsWork = replyClaimsFileWork(reply);
  const target = verifyTargetCompletion();

  // Explore 只读模式：无写工具，写入验收（含历史残留变更行）不适用
  if (context.mode === 'explore') {
    return { ok: true, note: '', shouldRetry: false, skipped: true, evidence, target };
  }

  // 浏览器运行时错误：纯浏览器任务没有 write signal，必须在"无证据即跳过"之前判定
  if (evidence.hasBrowserRuntimeErrors) {
    const samples = evidence.browserSignals.errors
      .map((e) => String(e || '').replace(/\s+/g, ' ').trim().slice(0, 120))
      .filter(Boolean);
    const detail = samples.length ? `：${samples.join('；')}` : '';
    return buildReadinessResult(
      `浏览器操作后检测到页面运行时错误（console error / 未捕获异常 / 失败请求）${detail}。` +
        '请用 browser_console / browser_network 确认并修复后再交付；若与本任务无关，请明确说明。',
      context,
      { evidence, target, reason: 'browser_runtime_errors' }
    );
  }

  // 断言未通过：最后一次 browser_expect 有失败就提示（修复后重跑通过则不提示）
  if (evidence.hasFailedExpectation) {
    const detail = evidence.expectationSignals.lastSummary
      ? `：${evidence.expectationSignals.lastSummary}`
      : '';
    return buildReadinessResult(
      `最后一次 browser_expect 断言未通过${detail}。请修复页面状态或修正断言，确认通过后再交付。`,
      context,
      { evidence, target, reason: 'browser_expect_failed' }
    );
  }

  if (!evidence.hasWriteSignal && !claimsWork) {
    return { ok: true, note: '', shouldRetry: false, skipped: true, evidence, target };
  }

  if (evidence.hasWriteSignal && evidence.hasDiagnosticErrors) {
    return buildReadinessResult(
      '写入后静态检查仍有 error 级诊断。请继续修复诊断问题；如果无法自动修复，请说明卡点。',
      context,
      { evidence, target, reason: 'diagnostic_errors' }
    );
  }

  if (evidence.hasWriteSignal && evidence.hasFailedValidation && !evidence.hasPassedValidation) {
    return buildReadinessResult(
      '检测到测试、构建、lint 或静态检查失败。请先修复失败项；如果失败与本任务无关，请明确说明。',
      context,
      { evidence, target, reason: 'validation_failed' }
    );
  }

  if (claimsWork && !evidence.hasWriteSignal) {
    return buildReadinessResult(
      '回复声称已完成修改/创建，但未检测到实际写入。请继续执行实际修改；如果无需修改，请明确说明卡点。',
      context,
      { evidence, target, reason: 'missing_write_evidence' }
    );
  }

  return { ok: true, note: '', shouldRetry: false, evidence, target };
}
function applyReadinessNote(reply, readiness) {
  if (!readiness || readiness.ok || !readiness.note || !readiness.surfaceToUser) return String(reply || '');
  const body = String(reply || '').trim() || '（模型未生成文字答复。）';
  return `${body}\n\n---\n\n> ⚠️ **完成验收**：${readiness.note}`;
}

if (typeof window !== 'undefined') {
  window.shouldBlockRepeatToolCall = shouldBlockRepeatToolCall;
  window.normalizeAgentToolName = shared.normalizeAgentToolName;
  window.recordToolCallFingerprint = recordToolCallFingerprint;
  window.repeatToolBlockMessage = repeatToolBlockMessage;
  window.verifyAgentCompletionReadiness = verifyAgentCompletionReadiness;
  window.applyReadinessNote = applyReadinessNote;
  window.isLikelyFileModificationTask = isLikelyFileModificationTask;
  window.getTraceWriteFilePaths = getTraceWriteFilePaths;
  window.collectCompletionEvidence = collectCompletionEvidence;
  window.collectBrowserEvidence = collectBrowserEvidence;
  window.collectExpectationSignals = collectExpectationSignals;
  window.verifyTargetCompletion = verifyTargetCompletion;
}
