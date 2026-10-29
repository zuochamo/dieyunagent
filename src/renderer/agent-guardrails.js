/* global window, GuardrailsShared, tracePrefs */
'use strict';

/**
 * Renderer 侧的完成验收**只有一件事**：把 Main 给出的结论渲染成一句话。
 *
 * 判定与证据采集都在 `src/agent/completion-readiness.js`（Main）：
 * 证据是循环账本的 trace、Gateway 的静态诊断、`browser.console/network` 的运行时事实，
 * 这些 Renderer 都不掌握，所以这里不再有「规则门」。原来那份 `verifyAgentCompletionReadiness`
 * 是 JS 循环还在渲染进程时的实现，已按分层边界整体移走。
 *
 * 仍然保留的两处：
 * - `normalizeAgentToolName`：工具名归一化（单一来源 `guardrails-shared`），Renderer 侧
 *   展示与卡片归类要用，不是判定逻辑。
 * - `applyReadinessNote`：验收提示的唯一渲染出口（含「显示完成验收提示」开关与去重）。
 */

const shared = typeof GuardrailsShared !== 'undefined' ? GuardrailsShared : null;
if (!shared) {
  throw new Error('guardrails-shared.js must load before agent-guardrails.js');
}

/**
 * 「显示完成验收提示」开关（设置 → 主题 → 显示完成验收提示，偏好存 tracePrefs.showReadiness）。
 * 关掉后只是不往回复正文里追加提示，验收结论仍留在 `run.result.readiness.evidence` 里供排查。
 * 这里是唯一渲染出口，规则来源（规则门 / reviewer）都经过它，所以开关只在这里判一次。
 */
function isReadinessNoteMuted() {
  try {
    return !!(typeof tracePrefs !== 'undefined' && tracePrefs && tracePrefs.showReadiness === false);
  } catch {
    return false;
  }
}

function applyReadinessNote(reply, readiness) {
  if (!readiness || readiness.ok || !readiness.note || !readiness.surfaceToUser) return String(reply || '');
  if (isReadinessNoteMuted()) return String(reply || '');
  // 自带幂等：模型可能复述历史里的验收提示（历史投影已在 session-context 剥离，
  // 这里是同一条链的第二道），先剥掉已有验收段再加，避免同一提示叠成两段。
  const cleaned =
    shared && typeof shared.stripReadinessNotes === 'function'
      ? shared.stripReadinessNotes(reply)
      : String(reply || '');
  const body = String(cleaned || '').trim() || '（模型未生成文字答复。）';
  return `${body}\n\n---\n\n> ⚠️ **完成验收**：${readiness.note}`;
}

if (typeof window !== 'undefined') {
  window.normalizeAgentToolName = shared.normalizeAgentToolName;
  window.applyReadinessNote = applyReadinessNote;
}
