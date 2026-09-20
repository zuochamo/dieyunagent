/* global window, document, setTimeout, clearTimeout, requestAnimationFrame, tracePrefs, currentSessionId, isEditToolName, artifactPathFromTool, resolveToolDiffBody, pickDiffDisplayText, isSidePanelOpen, getSidePanelTab, getSelectedArtifactPath, isMonacoArtifactEditorMounted, updateMonacoArtifactEditorText, getMonacoEditorHandle, isActiveMonacoEditorUserDirty */
'use strict';

/**
 * Agent 写入跟随（live write follow）—— 编辑区实时预览的唯一实现。
 *
 * 历史：早期由 `renderer-artifacts-live-write.js` 实现「边写边预览」，用 Monaco DiffEditor +
 * 逐帧快照动画渲染；开销大，且与产物列表的自动重载互相打断（编辑器反复 dispose → 永远
 * 停在「加载中…」），引擎被整体移除。本文件是它的替代实现，单一职责：
 * 把「工具写入事件」映射为「编辑区增量跟随」。
 *
 * 与旧实现的三点差别（也是快的原因）：
 *   1. 数据源是 trace 里工具 diff 的正文（`resolveToolDiffBody`），零 RPC：
 *      不读盘、不 list_dir、不重建编辑器；
 *   2. 单栏编辑器 `applyEdits` 增量写入（`updateMonacoArtifactEditorText`），保留滚动与光标；
 *   3. 单写者 + rAF 合并：只在「用户没有未保存改动」时写入，同一帧多次事件只应用最后一次，
 *      不存在逐帧动画。
 *
 * 跟随粒度：`fs_write_file` 在工具「发出」时（args.content 已完整）即可预览；
 * `fs_edit` 在工具「完成」后（result.diff.afterText 完整）预览。
 */

/** 超过此长度的正文不跟随（跟随不做流式分块，避免大文件卡顿），交给工具完成后的读盘刷新 */
var ARTIFACT_FOLLOW_MAX_CHARS = 400000;
/** 「已更新」徽标停留时长 */
var ARTIFACT_FOLLOW_DONE_BADGE_MS = 2000;
/**
 * 跟随基线的有效期。编辑器内容与基线一致时跳过 mtime 触发的重载，避免「跟随完又被读盘重建」。
 * 但必须有时效，否则用非 edit 工具（host_exec 跑构建/脚本）改动的文件将永远看不到更新。
 */
var ARTIFACT_FOLLOW_FRESH_MS = 3000;

/** path -> { text, at }：上次由跟随写入编辑器的正文与时间 */
var artifactFollowLastApplied = new Map();
/** rAF 合并句柄 */
var artifactFollowRafId = null;
/** 同一帧内待应用的最后一次写入 */
var artifactFollowPendingWrite = null;
/** 「已更新」徽标淡出定时器 */
var artifactFollowBadgeTimer = null;

function artifactFollowPathKey(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isArtifactFollowEnabled() {
  if (typeof tracePrefs === 'undefined' || !tracePrefs) return true;
  return tracePrefs.followWrites !== false;
}

/** 跟随是否可用：面板开着、停在文件页、且当前就是目标文件 */
function artifactFollowTargetIsViewable(filePath) {
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return false;
  if (typeof getSidePanelTab === 'function' && getSidePanelTab() !== 'files') return false;
  const selected =
    typeof getSelectedArtifactPath === 'function' ? String(getSelectedArtifactPath() || '') : '';
  if (!selected || !filePath) return false;
  return artifactFollowPathKey(selected) === artifactFollowPathKey(filePath);
}

/**
 * 从 trace 里取最近一次「可跟随」的写入。
 * 只认有完整正文的编辑工具：截断的正文（textTruncated）会误导用户，直接跳过。
 */
function pickLatestArtifactWrite(trace) {
  const rows = Array.isArray(trace) ? trace : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const tools = rows[i] && rows[i].tools;
    if (!Array.isArray(tools) || !tools.length) continue;
    for (let j = tools.length - 1; j >= 0; j--) {
      const tool = tools[j];
      if (!tool || tool.failed) continue;
      if (typeof isEditToolName !== 'function' || !isEditToolName(tool.name)) continue;
      const path = typeof artifactPathFromTool === 'function' ? artifactPathFromTool(tool) : '';
      if (!path) continue;
      const diff = typeof resolveToolDiffBody === 'function' ? resolveToolDiffBody(tool) : null;
      if (!diff || diff.textTruncated) continue;
      const text =
        typeof pickDiffDisplayText === 'function' ? String(pickDiffDisplayText(diff, 'after') || '') : '';
      if (!text || text.length > ARTIFACT_FOLLOW_MAX_CHARS) continue;
      return { path, text, pending: !!tool.pending };
    }
  }
  return null;
}

/**
 * 「写入中 / 已更新」徽标。复用 live-write 遗留的 .artifacts-live-write-badge 样式，
 * 挂在编辑区标题栏（用户正在看的位置）。
 * @param {'writing'|'done'|'paused'|'idle'} state
 */
function paintArtifactWriteBadge(state) {
  const view = document.getElementById('artifacts-file-view');
  if (!view) return;
  const head = view.querySelector('.artifacts-editor-head');
  if (!head) return;
  let badge = head.querySelector('.artifacts-live-write-badge');
  if (state === 'idle') {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'artifacts-live-write-badge';
    const pathEl = head.querySelector('.artifacts-editor-path');
    if (pathEl && pathEl.nextSibling) head.insertBefore(badge, pathEl.nextSibling);
    else head.appendChild(badge);
  }
  if (artifactFollowBadgeTimer) {
    clearTimeout(artifactFollowBadgeTimer);
    artifactFollowBadgeTimer = null;
  }
  if (state === 'writing') {
    badge.classList.remove('is-done');
    badge.classList.add('is-writing');
    badge.textContent = '写入中…';
    return;
  }
  if (state === 'done') {
    badge.classList.remove('is-writing');
    badge.classList.add('is-done');
    badge.textContent = '已更新';
    artifactFollowBadgeTimer = setTimeout(function () {
      artifactFollowBadgeTimer = null;
      const cur = document.querySelector('#artifacts-file-view .artifacts-live-write-badge');
      if (cur && cur.classList.contains('is-done')) cur.remove();
    }, ARTIFACT_FOLLOW_DONE_BADGE_MS);
    return;
  }
  // paused
  badge.classList.remove('is-writing');
  badge.classList.add('is-done');
  badge.textContent = '已暂停跟随';
}

/** 编辑器内容是否就是「刚跟随写入的内容」（用于让列表刷新别再强制重载） */
function isArtifactEditorFollowCurrent(filePath) {
  const rec = artifactFollowLastApplied.get(artifactFollowPathKey(filePath));
  if (!rec) return false;
  if (Date.now() - Number(rec.at || 0) > ARTIFACT_FOLLOW_FRESH_MS) return false;
  const handle = typeof getMonacoEditorHandle === 'function' ? getMonacoEditorHandle() : null;
  if (!handle || typeof handle.getValue !== 'function') return false;
  return String(handle.getValue() || '') === rec.text;
}

/** 清掉跟随状态（切换会话 / 卸载编辑器时调用） */
function resetArtifactFollowState() {
  artifactFollowLastApplied.clear();
  artifactFollowPendingWrite = null;
  artifactFollowRafId = null;
  if (artifactFollowBadgeTimer) {
    clearTimeout(artifactFollowBadgeTimer);
    artifactFollowBadgeTimer = null;
  }
}

function applyArtifactFollowPayload(write) {
  const path = write.path;
  if (!artifactFollowTargetIsViewable(path)) return false;
  if (
    typeof isMonacoArtifactEditorMounted === 'function' &&
    !isMonacoArtifactEditorMounted(path)
  ) {
    // 还没挂编辑器（由读盘路径负责加载），跟随不做首次挂载
    return false;
  }
  // 用户手动改过未保存：暂停跟随，绝不覆盖用户输入
  if (typeof isActiveMonacoEditorUserDirty === 'function' && isActiveMonacoEditorUserDirty()) {
    paintArtifactWriteBadge('paused');
    return false;
  }
  const handle = typeof getMonacoEditorHandle === 'function' ? getMonacoEditorHandle() : null;
  const current =
    handle && typeof handle.getValue === 'function' ? String(handle.getValue() || '') : null;
  const key = artifactFollowPathKey(path);
  const rec = artifactFollowLastApplied.get(key);
  if (current != null && rec && current !== rec.text) {
    // 编辑器内容和「我们上次写入的」不一致，说明用户改过
    paintArtifactWriteBadge('paused');
    return false;
  }
  const markApplied = function () {
    if (artifactFollowLastApplied.size > 50) artifactFollowLastApplied.clear();
    artifactFollowLastApplied.set(key, { text: write.text, at: Date.now() });
  };
  if (current != null && current === write.text) {
    markApplied();
    paintArtifactWriteBadge(write.pending ? 'writing' : 'done');
    return true;
  }
  const changed =
    typeof updateMonacoArtifactEditorText === 'function'
      ? updateMonacoArtifactEditorText(path, write.text, { appendOnly: !!write.pending })
      : false;
  if (!changed) {
    // 写入中且不是纯追加：跳过这一拍，等工具完成再整量对齐
    paintArtifactWriteBadge(write.pending ? 'writing' : 'done');
    return false;
  }
  markApplied();
  paintArtifactWriteBadge(write.pending ? 'writing' : 'done');
  return true;
}

/**
 * 跟随入口：由 trace 更新驱动（调用点见 renderer-artifacts.js#trackArtifactsFromTrace）。
 * 同一帧内多次调用只应用最后一次写入。
 */
function followArtifactEditorOnWrite(trace, opts) {
  if (!isArtifactFollowEnabled()) return false;
  const sessionId = opts && opts.sessionId ? String(opts.sessionId) : '';
  if (
    sessionId &&
    typeof currentSessionId !== 'undefined' &&
    currentSessionId &&
    sessionId !== String(currentSessionId)
  ) {
    return false;
  }
  const write = pickLatestArtifactWrite(trace);
  if (!write) return false;
  if (!artifactFollowTargetIsViewable(write.path)) return false;
  artifactFollowPendingWrite = write;
  if (artifactFollowRafId != null) return true;
  const run = function () {
    artifactFollowRafId = null;
    const payload = artifactFollowPendingWrite;
    artifactFollowPendingWrite = null;
    if (payload) applyArtifactFollowPayload(payload);
  };
  if (typeof requestAnimationFrame === 'function') {
    artifactFollowRafId = requestAnimationFrame(run);
  } else {
    artifactFollowRafId = setTimeout(run, 0);
  }
  return true;
}

window.followArtifactEditorOnWrite = followArtifactEditorOnWrite;
window.isArtifactEditorFollowCurrent = isArtifactEditorFollowCurrent;
window.resetArtifactFollowState = resetArtifactFollowState;
