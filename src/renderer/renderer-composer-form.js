/* global chatForm, chatInput, composerSendBtn, isCurrentSessionSending, sendMessage, stopAgentRun, refreshContextProgress, updateComposerMentionMenu, appendBubble, finishSessionActiveRun, syncComposerForActiveSession, currentSessionId, renderAttachmentChips, trySubmitComposerWhileBusy, initComposerQueueUI, isUserAbortError, isEditingComposerQueueItem, commitEditComposerQueueItem, isSessionSwitchInFlight, showAgentToast */
'use strict';

function isComposerUserAbortError(err) {
  return typeof isUserAbortError === 'function' && isUserAbortError(err);
}

function handleComposerSendError(err) {
  if (isComposerUserAbortError(err)) return;
  console.error(err);
  appendBubble('assistant', `发送失败：${err.message || err}`, { error: true });
  finishSessionActiveRun(currentSessionId);
  syncComposerForActiveSession();
}

function tryCommitComposerQueueEdit() {
  if (
    typeof isEditingComposerQueueItem === 'function' &&
    isEditingComposerQueueItem(currentSessionId) &&
    typeof commitEditComposerQueueItem === 'function'
  ) {
    commitEditComposerQueueItem();
    return true;
  }
  return false;
}

function clearComposerPendingAndRefresh(attachments) {
  const pending = getPendingAttachments();
  const snapshot = attachments || pending.slice();
  chatInput.value = '';
  pending.length = 0;
  if (typeof renderAttachmentChips === 'function') renderAttachmentChips();
  refreshContextProgress();
  return snapshot;
}

function initComposerFormUI() {
  if (typeof initComposerQueueUI === 'function') initComposerQueueUI();

  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (tryCommitComposerQueueEdit()) return;
      // 切换会话进行中：不发送、也不清空草稿。
      // 下面 clearComposerPendingAndRefresh() 会先清空输入框，若 sendMessage 再被
      // gateSendMessage 拦下（返回 false）就会静默丢草稿，所以在这里提前拦截。
      if (typeof isSessionSwitchInFlight === 'function' && isSessionSwitchInFlight()) {
        if (typeof showAgentToast === 'function') {
          showAgentToast('暂时无法发送', '正在切换对话，请稍后再发', { variant: 'warn' });
        }
        return;
      }

      const text = chatInput.value.trim();
      const pendingAttachments = getPendingAttachments();
      if (!text && !pendingAttachments.length) return;

      if (isCurrentSessionSending()) {
        const attachments = clearComposerPendingAndRefresh(pendingAttachments.slice());
        void trySubmitComposerWhileBusy(text || '请根据附件内容协助我。', attachments).catch(
          handleComposerSendError
        );
        return;
      }

      const attachments = clearComposerPendingAndRefresh();
      sendMessage(text || '请根据附件内容协助我。', { attachments }).catch(handleComposerSendError);
    });
  }

  if (composerSendBtn) {
    composerSendBtn.addEventListener('click', (e) => {
      if (tryCommitComposerQueueEdit()) {
        e.preventDefault();
        return;
      }
      if (isCurrentSessionSending() || composerSendBtn.classList.contains('stopping')) {
        e.preventDefault();
        stopAgentRun();
      }
    });
  }

  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });
    chatInput.addEventListener('input', () => {
      refreshContextProgress();
      updateComposerMentionMenu();
    });
  }
}
