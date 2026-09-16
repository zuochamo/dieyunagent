/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, maybeAutoCollapseChatOnTraceGrowth, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, beginLiveWriteSyncSuppress, endLiveWriteSyncSuppress, syncLiveWriteFromTrace, clearLiveWrite, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, getActiveLiveWrite, applyLiveWriteFileListMarks, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns */
'use strict';

function focusChatInput() {
  if (!chatInput) return;
  // 已在输入框内：不做任何事。重复 focus + setSelectionRange 会打断输入法组合、
  // 把光标强移到末尾，用户会感觉「光标丢失、打不了字」。
  if (document.activeElement === chatInput) return;
  requestAnimationFrame(() => {
    if (!chatInput.isConnected) return;
    if (document.activeElement === chatInput) return;
    try {
      chatInput.focus({ preventScroll: true });
      const end = chatInput.value.length;
      chatInput.setSelectionRange(end, end);
    } catch {
      try {
        chatInput.focus();
      } catch {
        // ignore
      }
    }
  });
}
function resolveCheckpointRestoreForAssistant(assistantIndex) {
  const userIdx = assistantIndex - 1;
  if (userIdx < 0 || messages[userIdx]?.role !== 'user') return null;
  if (getLastUserMessageIndex() !== userIdx) return null;
  return checkpointRestoreOptsForLastTurn();
}

function checkpointRestoreOptsForLastTurn() {
  const userIdx = getLastUserMessageIndex();
  if (userIdx < 0 || messages[userIdx]?.role !== 'user') return null;
  const meta = messages[userIdx].meta || resolveUserFooterMeta(messages[userIdx], userIdx);
  if (typeof isTurnLongHorizon === 'function' && isTurnLongHorizon(meta)) return null;
  const undoTurnId =
    meta.undoTurnId ||
    (typeof getCurrentUndoTurnId === 'function' ? getCurrentUndoTurnId() : null);
  if (!undoTurnId) return null;
  return { undoTurnId, checkpointRestore: true };
}

function appendBubble(role, content, opts = {}) {
  const empty = $('chat-empty');
  if (empty && empty.parentNode) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (opts.loading) div.classList.add('loading');
  if (opts.error) div.classList.add('error');
  if (opts.sessionId) div.dataset.runSessionId = String(opts.sessionId);
  if (role === 'assistant' && (opts.loading || opts.trace?.length || opts.hitRoundLimit || opts.structured)) {
    renderAssistantBubbleContent(div, {
      content: content || '',
      trace: opts.trace || [],
      hitRoundLimit: !!opts.hitRoundLimit,
      loading: !!opts.loading,
      stopped: !!opts.stopped,
      undoTurnId: opts.undoTurnId || null,
      checkpointRestore: !!opts.checkpointRestore
    });
  } else {
    div.textContent = content;
  }
  chatList.appendChild(div);
  if (opts.skipScroll !== true) {
    if (role === 'assistant' && opts.loading && typeof resetChatStreamScrollBaseline === 'function') {
      resetChatStreamScrollBaseline();
    }
    scrollChatToBottom({ force: opts.forceScroll !== false });
  }
  return div;
}

function formatMsgFooterTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function humanizeModelId(id) {
  return String(id || '')
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => {
      if (/^v\d+$/i.test(w)) return w.toUpperCase();
      if (/^\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function formatModelFooterLabel(modelId, route) {
  if (modelId && String(modelId).trim()) return humanizeModelId(modelId);
  if (route === 'auto-vision' || route === 'custom-vision') {
    const v = (settings.visionModel || '').trim();
    return v ? humanizeModelId(v) : '识图模型';
  }
  return humanizeModelId(getTextModelId(settings)) || 'Auto';
}

function packAssistantMeta(content, meta) {
  if (!meta) return content;
  try {
    return `【叠云meta】${JSON.stringify(meta)}\n${content}`;
  } catch {
    return content;
  }
}

function slimAttachmentsForPersist(list) {
  return (list || [])
    .filter(Boolean)
    .map((att) => ({
      path: att.path || '',
      workspaceRelative: att.workspaceRelative || '',
      absolutePath: att.absolutePath || '',
      originalName: att.originalName || '',
      size: Number(att.size) || 0,
      mime: att.mime || ''
    }))
    .filter((att) => att.path || att.absolutePath || att.workspaceRelative);
}

function packUserMessageMeta(content, meta) {
  if (!meta) return content;
  const attachments = slimAttachmentsForPersist(meta.attachments);
  const payload = {};
  const inputText = meta.inputText != null ? String(meta.inputText).trim() : '';
  if (inputText) payload.inputText = inputText;
  if (attachments.length) payload.attachments = attachments;
  if (!Object.keys(payload).length) return content;
  try {
    return `【叠云meta】${JSON.stringify(payload)}\n${content}`;
  } catch {
    return content;
  }
}

function unpackAssistantMeta(raw) {
  const s = String(raw || '');
  const m = s.match(/^【叠云meta】(\{[\s\S]*?\})\n([\s\S]*)$/);
  if (!m) return { content: s, meta: null };
  try {
    return { content: m[2], meta: JSON.parse(m[1]) };
  } catch {
    return { content: s, meta: null };
  }
}

function unpackUserMessageContent(raw) {
  const s = String(raw || '');
  const m = s.match(/^【叠云meta】(\{[\s\S]*?\})\n([\s\S]*)$/);
  if (!m) return { content: s, meta: null };
  try {
    return { content: m[2], meta: JSON.parse(m[1]) };
  } catch {
    return { content: s, meta: null };
  }
}

function getLastUserMessageIndex() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

function normalizeTurnFooterMeta(meta, msg) {
  const m = { ...(meta || {}) };
  if (!m.modeLabel) m.modeLabel = 'Agent';
  if (!m.modelLabel && m.modelId) m.modelLabel = humanizeModelId(m.modelId);
  if (!m.modelLabel) m.modelLabel = formatModelFooterLabel(getTextModelId(settings));
  if (!m.ts) m.ts = msg?.created_at || Date.now();
  return m;
}

function resolveUserFooterMeta(msg, msgIndex) {
  let meta = {};
  const next = messages[msgIndex + 1];
  if (next && next.role === 'assistant') {
    const a = unpackAssistantMeta(next.content);
    if (a.meta) meta = { ...a.meta };
  }
  const userUnpack = unpackUserMessageContent(msg.content);
  if (userUnpack.meta) meta = { ...meta, ...userUnpack.meta };
  if (msg.meta) meta = { ...meta, ...msg.meta };
  return normalizeTurnFooterMeta(meta, msg);
}

function resolveUserTurnCopyText(msg, meta) {
  if (!msg) return '';
  const merged = { ...(meta || {}), ...(msg.meta || {}) };
  const fromMeta = String(merged.inputText || '').trim();
  if (fromMeta) return fromMeta;
  const unpacked = unpackUserMessageContent(msg.content);
  const fromPacked = String(unpacked.meta?.inputText || '').trim();
  if (fromPacked) return fromPacked;
  const plain = String(unpacked.content || '').trim();
  if (plain) return plain;
  const display = String(msg.displayContent || '').trim();
  if (!display) return '';
  return display.replace(/\n📎[^\n]*$/u, '').trim() || display;
}

async function copyTurnText(text) {
  const t = String(text || '').trim();
  if (!t) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('复制失败', '没有可复制的内容', { variant: 'error' });
    }
    return;
  }
  try {
    let copied = false;
    // 优先走异步剪贴板：不创建临时 textarea，不会抢走输入框焦点。
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(t);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      // 回退方案：临时 textarea 会短暂抢焦点，复制后必须交还。
      // 否则 textarea 被 remove() 后焦点落到 body，输入框「丢失光标」、无法输入。
      const prevActive = document.activeElement;
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, t.length);
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      ta.remove();
      if (prevActive && prevActive.isConnected && typeof prevActive.focus === 'function') {
        try {
          prevActive.focus({ preventScroll: true });
        } catch {
          // ignore
        }
      }
    }
    if (!copied) throw new Error('clipboard unavailable');
    if (typeof focusChatInput === 'function') focusChatInput();
    if (typeof showAgentToast === 'function') {
      const preview = t.length > 48 ? `${t.slice(0, 48)}…` : t;
      showAgentToast('已复制', preview, { variant: 'success' });
    }
  } catch {
    if (typeof showAgentToast === 'function') {
      showAgentToast('复制失败', '无法写入剪贴板', { variant: 'error' });
    }
  }
}

var CHAT_IMAGE_ATTACH_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico)$/i;
function chatImagePreviewMaxBytes() {
  const mb =
    typeof getAgentLimits === 'function' ? getAgentLimits().chatImagePreviewMaxMb : 15;
  return Math.max(1, Number(mb) || 15) * 1024 * 1024;
}

function isChatImageAttachment(att) {
  if (!att) return false;
  if (att.mime && String(att.mime).startsWith('image/')) return true;
  return CHAT_IMAGE_ATTACH_RE.test(String(att.originalName || att.path || ''));
}

function chatAttachmentName(att) {
  return String(att?.originalName || att?.path || '图片');
}

function chatImageMime(att) {
  if (att?.mime && String(att.mime).startsWith('image/')) return att.mime;
  const name = chatAttachmentName(att).toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

function attachmentReadPath(att) {
  if (!att) return '';
  return String(att.absolutePath || att.workspaceRelative || att.path || '').trim();
}

function normalizeChatBase64(base64) {
  const raw = String(base64 || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  return (comma >= 0 ? raw.slice(comma + 1) : raw).replace(/\s+/g, '');
}

function chatImageDataUrl(att) {
  const preview = String(att?.previewUrl || '');
  if (preview.startsWith('data:image/') || preview.startsWith('blob:')) return preview;
  const base64 = normalizeChatBase64(att?._base64 || att?._pasteBase64);
  return base64 ? `data:${chatImageMime(att)};base64,${base64}` : '';
}

async function hydrateChatImageAttachment(img, statusEl, att) {
  if (!img || !att) return;
  const existing = String(img.getAttribute('src') || img.src || '').trim();
  if (existing && existing !== window.location.href) return;

  const inline = chatImageDataUrl(att);
  if (inline) {
    img.src = inline;
    img.hidden = false;
    if (statusEl) statusEl.textContent = chatAttachmentName(att);
    return;
  }

  const size = Number(att.size) || 0;
  if (size > chatImagePreviewMaxBytes()) {
    if (statusEl) statusEl.textContent = '图片过大，未预览';
    return;
  }
  const filePath = attachmentReadPath(att);
  if (!gwState.authed || !filePath || typeof gatewayCall !== 'function') {
    if (statusEl) statusEl.textContent = '图片待读取';
    return;
  }
  try {
    const r = await gatewayCall('fs.read_file', {
      filePath,
      encoding: 'base64',
      maxBytes: chatImagePreviewMaxBytes()
    });
    if (!img.isConnected) return;
    if (r && r.truncated) {
      if (statusEl) statusEl.textContent = '图片过大，未预览';
      return;
    }
    const base64 = normalizeChatBase64(r?.data || '');
    if (!base64) {
      if (statusEl) statusEl.textContent = '图片为空';
      return;
    }
    img.src = `data:${chatImageMime(att)};base64,${base64}`;
    img.hidden = false;
    if (statusEl) statusEl.textContent = chatAttachmentName(att);
  } catch {
    if (statusEl) statusEl.textContent = '图片读取失败';
  }
}

function renderUserAttachments(container, attachments) {
  const list = (attachments || []).filter(Boolean);
  if (!container || !list.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-user-attachments';
  for (const att of list) {
    if (isChatImageAttachment(att)) {
      const figure = document.createElement('figure');
      figure.className = 'msg-user-image';
      const img = document.createElement('img');
      img.alt = chatAttachmentName(att);
      img.loading = 'lazy';
      img.decoding = 'async';
      const status = document.createElement('figcaption');
      status.textContent = chatAttachmentName(att);
      const dataUrl = chatImageDataUrl(att);
      if (dataUrl) {
        img.src = dataUrl;
      } else {
        img.hidden = true;
        status.textContent = `${chatAttachmentName(att)} · 读取中`;
        hydrateChatImageAttachment(img, status, att);
      }
      img.addEventListener('click', () => {
        figure.classList.toggle('is-expanded');
      });
      figure.appendChild(img);
      figure.appendChild(status);
      wrap.appendChild(figure);
      continue;
    }
    const file = document.createElement('div');
    file.className = 'msg-user-file';
    file.textContent = chatAttachmentName(att);
    wrap.appendChild(file);
  }
  container.appendChild(wrap);
}

function mkMsgActionBtn({ title, ariaLabel, html, onClick, action }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-action-btn';
  btn.title = title;
  btn.setAttribute('aria-label', ariaLabel);
  if (action) btn.dataset.action = action;
  btn.innerHTML = html;
  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const turn = btn.closest('.msg-turn');
    if (turn) turn.classList.add('is-footer-active');
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof onClick === 'function') onClick();
  });
  return btn;
}

function isAgentRunStillActive() {
  const live = sessionActiveRuns.get(currentSessionId);
  return !!(live && !live.finished);
}

function isWithdrawableTurn(msgIndex, meta) {
  if (typeof isTurnLongHorizon === 'function' && isTurnLongHorizon(meta)) return false;
  const next = messages[msgIndex + 1];
  const hasAssistantReply = !!(next && next.role === 'assistant');
  if (meta?.undoTurnId) {
    if (meta.undoFinalized) return true;
    return hasAssistantReply;
  }
  if (!hasAssistantReply) return false;
  return meta?.inputText != null || (Array.isArray(meta?.attachments) && meta.attachments.length > 0);
}

function canWithdrawUserTurn(msgIndex) {
  if (isAgentRunStillActive() || msgIndex < 0 || getLastUserMessageIndex() !== msgIndex) return false;
  const msg = messages[msgIndex];
  if (!msg || msg.role !== 'user') return false;
  const meta = msg.meta || resolveUserFooterMeta(msg, msgIndex);
  return isWithdrawableTurn(msgIndex, meta);
}

function buildMsgTurnFooter(meta, { canWithdraw, msgIndex, copyText }) {
  const footer = document.createElement('div');
  footer.className = 'msg-turn-footer';
  footer.dataset.copyText = String(copyText || '');
  if (msgIndex >= 0) footer.dataset.msgIndex = String(msgIndex);
  const metaSpan = document.createElement('span');
  metaSpan.className = 'msg-turn-meta';
  const mode = meta.modeLabel || 'Agent';
  const model = meta.modelLabel || '—';
  const time = formatMsgFooterTime(meta.ts);
  metaSpan.textContent = `${mode} · ${model} · ${time}`;
  footer.appendChild(metaSpan);

  const actions = document.createElement('div');
  actions.className = 'msg-turn-actions';

  if (canWithdraw) {
    actions.appendChild(
      mkMsgActionBtn({
        title: '撤回本轮改动（恢复代码并撤回到输入框）',
        ariaLabel: '撤回本轮改动',
        action: 'withdraw',
        html:
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H12"/></svg>',
        onClick: () => withdrawUserTurn(msgIndex)
      })
    );
  }

  actions.appendChild(
    mkMsgActionBtn({
      title: '复制',
      ariaLabel: '复制',
      action: 'copy',
      html:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
      onClick: () => copyTurnText(copyText)
    })
  );

  footer.appendChild(actions);
  return footer;
}

function appendUserTurn(displayContent, opts = {}) {
  const empty = $('chat-empty');
  if (empty && empty.parentNode) empty.remove();
  const turn = document.createElement('div');
  turn.className = 'msg-turn';
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  const attachments = opts.attachments || [];
  if (attachments.length) {
    const textEl = document.createElement('div');
    textEl.className = 'msg-user-text';
    textEl.textContent = displayContent || '(附件)';
    bubble.appendChild(textEl);
    renderUserAttachments(bubble, attachments);
  } else {
    bubble.textContent = displayContent || '(附件)';
  }
  turn.appendChild(bubble);
  if (opts.footer) {
    turn.appendChild(opts.footer);
  }
  chatList.appendChild(turn);
  if (opts.skipScroll !== true) {
    scrollChatToBottom({ force: opts.forceScroll !== false });
  }
  return { turn, bubble };
}

function updateUserTurnFooter(turnEl, meta, footerOpts) {
  if (!turnEl) return;
  const old = turnEl.querySelector('.msg-turn-footer');
  if (old) old.remove();
  turnEl.appendChild(buildMsgTurnFooter(meta, footerOpts));
}

function finalizeUserTurnFooter(turnEl, msgIndex, meta) {
  const msg = messages[msgIndex];
  if (!msg || msg.role !== 'user') return;
  const normalized = normalizeTurnFooterMeta(meta, msg);
  msg.meta = normalized;
  const copyText = resolveUserTurnCopyText(msg, normalized);
  updateUserTurnFooter(turnEl, normalized, {
    canWithdraw: canWithdrawUserTurn(msgIndex),
    msgIndex,
    copyText
  });
}
async function withdrawUserTurn(msgIndex) {
  if (!canWithdrawUserTurn(msgIndex)) return;
  const msg = messages[msgIndex];
  if (!msg || msg.role !== 'user') return;
  const meta = msg.meta || resolveUserFooterMeta(msg, msgIndex);
  const undoTurnId = meta.undoTurnId;
  const sessionId = currentSessionId;
  const removeCount =
    messages[msgIndex + 1] && messages[msgIndex + 1].role === 'assistant' ? 2 : 1;
  const messageId = [];
  for (let i = 0; i < removeCount; i++) {
    const m = messages[msgIndex + i];
    if (!m) continue;
    const lid =
      m.localMsgId != null ? Number(m.localMsgId) : m.id != null ? Number(m.id) : null;
    if (lid && Number.isFinite(lid)) messageId.push(lid);
  }
  const recallInputText = meta.inputText || msg.displayContent || '';
  const recallAttachments = (meta.attachments || []).map((att) => ({ ...att }));

  messages.splice(msgIndex, removeCount);
  if (typeof saveSessionMessageCache === 'function') {
    saveSessionMessageCache(sessionId, messages, {
      hasMore: typeof getSessionCacheHasMore === 'function' ? getSessionCacheHasMore(sessionId) : false
    });
  }
  if (typeof refreshHistoryList === 'function') refreshHistoryList();
  for (const att of getPendingAttachments()) revokeAttachmentPreview(att);
  const pendingAttachments = getPendingAttachments();
  pendingAttachments.length = 0;
  for (const att of recallAttachments) pendingAttachments.push(att);
  renderAttachmentChips();
  chatInput.value = recallInputText;
  if (typeof renderChatFromMessagesYielding === 'function') {
    void renderChatFromMessagesYielding();
  } else {
    renderChatFromMessages();
  }
  focusChatInput();
  tryDetectResumeCheckpoint(sessionId);

  void (async () => {
    try {
      if (gwState.authed && sessionId) {
        try {
          const del = await gatewayCall('memory.messages_delete_turn', {
            sessionId,
            messageId,
            removeCount: messageId.length ? undefined : removeCount
          });
          if (del && del.deleted === 0 && (messageId.length > 0 || removeCount > 0)) {
            showAgentToast('记忆未同步', 'SQLite 未删除任何消息，请稍后重试', { variant: 'error' });
          }
        } catch (e) {
          console.warn(e);
          showAgentToast('记忆未同步', 'SQLite 消息删除失败，请稍后重试', { variant: 'error' });
        }
      }
      if (!undoTurnId) return;
      const prep =
        typeof prepareTurnForWithdraw === 'function'
          ? await prepareTurnForWithdraw(undoTurnId, sessionId)
          : { canRollbackFiles: false };
      if (!prep.canRollbackFiles) return;
      showAgentToast('正在恢复文件', '撤回已在后台进行，请稍候…', { variant: 'info', duration: 4000 });
      const runWs =
        (typeof resolveSessionWorkspacePathSync === 'function' &&
          resolveSessionWorkspacePathSync(sessionId)) ||
        (typeof window !== 'undefined' &&
          String(currentSessionId) === String(sessionId) &&
          window.activeViewSessionWorkspacePath) ||
        null;
      const rb = await rollbackTurnFiles(undoTurnId, sessionId, runWs || undefined);
      if (!rb || rb.ok === false || (rb.errors && rb.errors.length)) {
        showAgentToast(
          '文件恢复失败',
          (rb && rb.errors && rb.errors[0] && rb.errors[0].error) ||
            (rb && rb.error) ||
            '部分文件未能恢复',
          { variant: 'error' }
        );
        return;
      }
      if (rb && rb.committed !== false) {
        const n = rb.restored != null ? rb.restored : (rb.files && rb.files.length) || 0;
        if (n > 0 || rb.strategy === 'worktree-only') {
          showAgentToast(
            '已恢复文件',
            rb.strategy === 'worktree-only' ? '已丢弃 worktree 改动' : `已恢复 ${n} 个文件`,
            { variant: 'success' }
          );
        }
      }
      // 撤回中途切走：勿清当前可见会话的文件区/产物
      if (String(currentSessionId || '') === String(sessionId || '')) {
        if (typeof invalidateWorkspaceArtifacts === 'function') invalidateWorkspaceArtifacts();
      }
    } catch (e) {
      console.warn('withdraw background restore failed', e);
      showAgentToast('文件恢复失败', e.message || String(e), { variant: 'error' });
    }
  })();
}
/** 系统托盘通知（Win10/11 为操作中心 Toast，非聊天区气泡） */
function showTrayBalloon(title, body) {
  const content = String(body || '').slice(0, 256);
  const t = String(title || '叠云 Agent').slice(0, 64);
  if (chatRenderApi.trayNotify) {
    chatRenderApi
      .trayNotify({ title: t, content: content || t })
      .then((r) => {
        if (r && r.channel === 'tooltip-only') {
          showAgentToast(t, content, { variant: 'success' });
        }
      })
      .catch(() => {
        showAgentToast(t, content, { variant: 'success' });
      });
    return;
  }
  showAgentToast(t, content, { variant: 'success' });
}

function showAgentToast(title, body, opts = {}) {
  const stack = $('agent-toast-stack');
  if (!stack) return;
  const variant =
    opts.variant === 'error'
      ? 'error'
      : opts.variant === 'info'
        ? 'info'
        : opts.variant === 'warn'
          ? 'info'
          : 'success';
  const el = document.createElement('div');
  el.className = `agent-toast agent-toast-${variant}`;
  el.setAttribute('role', 'status');
  const titleEl = document.createElement('div');
  titleEl.className = 'agent-toast-title';
  titleEl.textContent = String(title || '叠云 Agent');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'agent-toast-body';
  bodyEl.textContent = String(body || '').slice(0, 240);
  el.appendChild(titleEl);
  if (bodyEl.textContent) el.appendChild(bodyEl);
  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-toast-action';
    btn.textContent = String(opts.actionLabel);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        opts.onAction();
      } catch (err) {
        console.warn(err);
      }
      el.classList.remove('show');
      setTimeout(() => el.remove(), 320);
    });
    el.appendChild(btn);
  }
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let duration = Number(opts.duration) > 0 ? Number(opts.duration) : 4800;
  if (opts.actionLabel) duration = Math.max(duration, 9000);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, duration);
}

function toastPreviewText(text, max = 72) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

var SCROLL_CHAT_THROTTLE_MS = 100;
var THINKING_COLLAPSE_FOLLOW_MS = 1100;
var scrollChatTimer = null;
var scrollChatForcePending = false;
var streamScrollRaf = null;
var thinkingTransitionFollowTimer = null;
var thinkingTransitionPinRaf = null;
var thinkingTransitionPinUntil = 0;