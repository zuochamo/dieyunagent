/* global window, document, $, fetch, gwState, gatewayCall, pendingAttachments, composerBox, chatInput, refreshContextProgress, appendBubble, insertComposerQuotedText, showAgentToast, updateComposerMentionMenu, focusChatInput, getAgentLimits */
'use strict';

const attachmentsApi = window.diecloud || {};

const MAX_ATTACH_TEXT = 12000;
const IMAGE_ATTACH_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico)$/i;
const FALLBACK_IMAGE_ATTACH_MAX_MB = 15;
const FALLBACK_REQUEST_MAX_CHARS = 800000;

/** 图片附件体积上限的唯一来源是 agent-limits.chatImagePreviewMaxMb（勿在此硬编码第二份）。 */
function attachmentImageMaxBytes() {
  let mb = FALLBACK_IMAGE_ATTACH_MAX_MB;
  try {
    if (typeof getAgentLimits === 'function') {
      const n = Number((getAgentLimits() || {}).chatImagePreviewMaxMb);
      if (Number.isFinite(n) && n > 0) mb = n;
    }
  } catch {
    /* 读配置失败退回默认，不影响发送 */
  }
  return Math.max(1, Math.round(mb * 1024 * 1024));
}

/** 本次请求的字符硬顶：上游按字符计 Input length，base64 全量算在内。 */
function attachmentRequestMaxChars() {
  try {
    if (typeof getAgentLimits === 'function') {
      const n = Number((getAgentLimits() || {}).llmRequestMaxChars);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* ignore */
  }
  return FALLBACK_REQUEST_MAX_CHARS;
}

function attachmentToast(title, detail, opts) {
  if (typeof showAgentToast === 'function') showAgentToast(title, detail, opts || {});
}

function isImageAttachment(att) {
  if (!att) return false;
  if (att.mime && String(att.mime).startsWith('image/')) return true;
  return IMAGE_ATTACH_RE.test(String(att.originalName || att.path || ''));
}

function cloneAttachmentSnapshot(list) {
  return (list || []).map((att) => ({
    path: att.path,
    workspaceRelative: att.workspaceRelative,
    absolutePath: att.absolutePath,
    originalName: att.originalName,
    size: att.size,
    mime: att.mime,
    previewUrl: att.previewUrl,
    _pasteBase64: att._pasteBase64,
    _base64: att._base64
  }));
}

function agentAttachmentPath(att) {
  if (!att) return '';
  if (att.workspaceRelative) return att.workspaceRelative;
  return att.path || '';
}

function guessImageMime(att) {
  if (att && att.mime && String(att.mime).startsWith('image/')) return att.mime;
  const name = String((att && att.originalName) || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

function revokeAttachmentPreview(att) {
  if (att && att.previewUrl) {
    try {
      URL.revokeObjectURL(att.previewUrl);
    } catch {
      // ignore
    }
    att.previewUrl = null;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeAttachmentBase64(base64) {
  const raw = String(base64 || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  return payload.replace(/\s+/g, '');
}

async function readAttachmentBase64(att) {
  if (att && att._base64) return normalizeAttachmentBase64(att._base64);
  if (att && att._pasteBase64) {
    att._base64 = normalizeAttachmentBase64(att._pasteBase64);
    return att._base64;
  }
  if (!att || !att.path) throw new Error('附件路径无效');
  if (gwState.authed) {
    const limitBytes = attachmentImageMaxBytes();
    const fileBytes = Math.max(1, Number(att.size) || limitBytes);
    const maxBytes = Math.min(limitBytes, fileBytes);
    const r = await gatewayCall('fs.read_file', {
      filePath: att.path,
      encoding: 'base64',
      maxBytes
    });
    if (r && r.truncated) {
      const mb = Math.round((Number(r.size) || fileBytes) / 1024 / 1024);
      throw new Error(`图片未完整读取（约 ${mb}MB），请压缩后重试或使用 Ctrl+V 粘贴`);
    }
    const data = normalizeAttachmentBase64(r.data || '');
    if (!data) throw new Error('附件内容为空');
    att._base64 = data;
    return data;
  }
  throw new Error('无法读取附件内容');
}

async function addAttachmentsFromPaths(paths) {
  if (!paths || !paths.length || !attachmentsApi.stageFiles) return;
  const staged = await attachmentsApi.stageFiles(paths);
  for (const s of staged) {
    if (isImageAttachment(s) && gwState.authed && s.path && typeof gatewayCall === 'function') {
      try {
        const limitBytes = attachmentImageMaxBytes();
        const maxBytes = Math.min(limitBytes, Math.max(1, Number(s.size) || limitBytes));
        const r = await gatewayCall('fs.read_file', {
          filePath: s.absolutePath || s.workspaceRelative || s.path,
          encoding: 'base64',
          maxBytes
        });
        const base64 = normalizeAttachmentBase64(r?.data || '');
        if (base64 && !r?.truncated) {
          s._base64 = base64;
          s.previewUrl = `data:${guessImageMime(s)};base64,${base64}`;
        }
      } catch {
        // preview optional
      }
    }
    getPendingAttachments().push(s);
  }
  renderAttachmentChips();
}

function insertTextAtCursor(text) {
  if (!chatInput) return;
  const raw = String(text ?? '');
  if (!raw) return;
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  chatInput.value = chatInput.value.slice(0, start) + raw + chatInput.value.slice(end);
  const pos = start + raw.length;
  chatInput.focus();
  chatInput.setSelectionRange(pos, pos);
  if (typeof refreshContextProgress === 'function') refreshContextProgress();
  if (typeof updateComposerMentionMenu === 'function') updateComposerMentionMenu();
}

function extractSyncImageFile(cd) {
  if (!cd) return null;
  const imageItems = [];
  for (const item of cd.items || []) {
    if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
      imageItems.push(item);
    }
  }
  if (imageItems.length) {
    const item =
      imageItems.find((it) => it.type === 'image/png') ||
      imageItems.find((it) => it.type === 'image/jpeg') ||
      imageItems[0];
    return item.getAsFile();
  }
  if (cd.files && cd.files.length) {
    return [...cd.files].find((f) => f.type && f.type.startsWith('image/')) || null;
  }
  return null;
}

function clipboardTypesSuggestImage(cd) {
  if (!cd) return false;
  for (const t of cd.types || []) {
    if (/^image\//i.test(t) || t === 'PNG' || t === 'JFIF') return true;
  }
  return false;
}

function clipboardHtmlImageDataUrl(cd) {
  if (!cd) return '';
  try {
    const html = cd.getData('text/html') || '';
    const m = html.match(/src=["'](data:image\/[^"']+)["']/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function shouldProbeNativeClipboard(cd) {
  if (!cd) return true;
  const types = [...(cd.types || [])];
  if (clipboardTypesSuggestImage(cd)) return true;
  if (clipboardHtmlImageDataUrl(cd)) return true;
  const plain = cd.getData('text/plain') || '';
  // 截图剪贴板常有 text/plain 类型但内容为空
  if (types.includes('text/plain') && !plain.trim()) return true;
  if (!types.length && !plain.trim()) return true;
  return false;
}

async function addAttachmentFromBase64(name, base64, mime) {
  const normalized = normalizeAttachmentBase64(base64);
  if (!normalized) throw new Error('粘贴图片数据为空');

  let staged = null;
  if (attachmentsApi.stageBase64) {
    try {
      staged = await attachmentsApi.stageBase64({ name, base64: normalized, mime });
    } catch (err) {
      console.warn('stageBase64 failed, keep in-memory paste', err);
    }
  }
  if (!staged) {
    staged = {
      originalName: name,
      path: '',
      workspaceRelative: '',
      size: Math.max(1, Math.ceil((normalized.length * 3) / 4)),
      mime: mime || 'image/png',
      _pasteOnly: true
    };
  }
  staged._pasteBase64 = normalized;
  if (mime && String(mime).startsWith('image/')) {
    staged.previewUrl = `data:${mime};base64,${normalized}`;
  }
  getPendingAttachments().push(staged);
  renderAttachmentChips();
}

function notifyPasteAttachmentSuccess(name) {
  if (typeof showAgentToast !== 'function') return;
  showAgentToast('已添加图片', String(name || '图片').slice(0, 48), { variant: 'success' });
}

async function ingestClipboardImageFile(file) {
  if (!file) return false;
  const buf = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const name =
    file.name && !/^image\.\w+$/i.test(file.name)
      ? file.name
      : `paste-${Date.now()}.${ext}`;
  await addAttachmentFromBase64(name, base64, file.type || 'image/png');
  return true;
}

function isPastedLocalImagePath(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('\n') || t.includes('\r')) return false;
  if (!IMAGE_ATTACH_RE.test(t)) return false;
  return /^[a-zA-Z]:\\/.test(t) || t.startsWith('/') || t.startsWith('\\\\');
}

async function handleComposerPaste(e) {
  const cd = e.clipboardData;
  const imageFile = extractSyncImageFile(cd);
  const dataUrl = clipboardHtmlImageDataUrl(cd);
  const text = cd?.getData('text/plain')?.trim() || '';

  if (imageFile) {
    e.preventDefault();
    e.stopImmediatePropagation();
    await ingestClipboardImageFile(imageFile);
    notifyPasteAttachmentSuccess(imageFile.name);
    return;
  }

  if (dataUrl) {
    const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/i);
    if (m) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const pasteName = `paste-${Date.now()}.png`;
      await addAttachmentFromBase64(pasteName, m[2], m[1]);
      notifyPasteAttachmentSuccess(pasteName);
      return;
    }
  }

  if (text && isPastedLocalImagePath(text)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    await addAttachmentsFromPaths([text]);
    notifyPasteAttachmentSuccess(text);
    return;
  }

  if (!shouldProbeNativeClipboard(cd) || !attachmentsApi.readClipboardImage) return;

  e.preventDefault();
  e.stopImmediatePropagation();

  const snap = await attachmentsApi.readClipboardImage();
  if (snap && snap.base64) {
    const pasteName = snap.name || `paste-${Date.now()}.png`;
    await addAttachmentFromBase64(pasteName, snap.base64, snap.mime || 'image/png');
    notifyPasteAttachmentSuccess(pasteName);
    return;
  }

  if (text) {
    insertTextAtCursor(text);
    return;
  }
  if (typeof showAgentToast === 'function') {
    showAgentToast('粘贴图片失败', '剪贴板中未检测到图片', { variant: 'error' });
  }
}

async function handleComposerDrop(e) {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) {
    const text = e.dataTransfer?.getData('text/plain')?.trim();
    if (text && typeof insertComposerQuotedText === 'function') {
      insertComposerQuotedText(text);
    }
    return;
  }
  const paths = [];
  for (const file of files) {
    if (file.path) {
      paths.push(file.path);
      continue;
    }
    const isImg = file.type.startsWith('image/') || IMAGE_ATTACH_RE.test(file.name || '');
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const mime = file.type || (isImg ? guessImageMime({ originalName: file.name }) : 'application/octet-stream');
    await addAttachmentFromBase64(file.name || (isImg ? 'drop.png' : 'file.bin'), base64, mime);
  }
  if (paths.length) await addAttachmentsFromPaths(paths);
}

let composerPasteCaptureBound = false;

function initComposerPasteAndDrop() {
  bindComposerImageLightbox();
  if (!composerPasteCaptureBound) {
    composerPasteCaptureBound = true;
    document.addEventListener(
      'paste',
      (e) => {
        if (!e.target?.closest?.('#composer-box')) return;
        if (e.__dieyunComposerPasteHandled) return;
        e.__dieyunComposerPasteHandled = true;
        void handleComposerPaste(e).catch((err) => {
          const msg = err?.message || String(err);
          if (typeof showAgentToast === 'function') {
            showAgentToast('粘贴图片失败', msg.slice(0, 200), { variant: 'error' });
          } else {
            appendBubble('assistant', `粘贴图片失败：${msg}`, { error: true });
          }
        });
      },
      true
    );
  }
  const box = composerBox;
  if (!box) return;
  box.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  box.addEventListener('drop', (ev) => {
    handleComposerDrop(ev).catch((err) => {
      appendBubble('assistant', `拖入附件失败：${err.message || err}`, { error: true });
    });
  });
}

function closeComposerImageLightbox() {
  const overlay = $('composer-image-lightbox');
  const img = $('composer-image-lightbox-img');
  if (overlay) overlay.hidden = true;
  if (img) {
    img.removeAttribute('src');
    img.alt = '';
  }
}

function openComposerImageLightbox(src, alt) {
  const overlay = $('composer-image-lightbox');
  const img = $('composer-image-lightbox-img');
  if (!overlay || !img || !src) return;
  img.src = src;
  img.alt = alt || '';
  overlay.hidden = false;
}

let composerImageLightboxBound = false;

function bindComposerImageLightbox() {
  if (composerImageLightboxBound) return;
  composerImageLightboxBound = true;
  const overlay = $('composer-image-lightbox');
  const closeBtn = $('composer-image-lightbox-close');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeComposerImageLightbox();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeComposerImageLightbox();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const box = $('composer-image-lightbox');
    if (box && !box.hidden) closeComposerImageLightbox();
  });
}

function renderAttachmentChips() {
  const box = $('composer-attachments');
  if (!box) return;
  // 重建 chips 会移除当前聚焦的按钮（如「×」），焦点会掉到 body、输入框看似丢光标
  const hadFocusInside = box.contains(document.activeElement);
  const pendingAttachments = getPendingAttachments();
  if (!pendingAttachments.length) {
    box.hidden = true;
    box.innerHTML = '';
    refreshContextProgress();
    if (hadFocusInside && typeof focusChatInput === 'function') focusChatInput();
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (isImageAttachment(att)) chip.classList.add('attach-chip-image');
    const label = document.createElement('span');
    label.title = att.path || att.originalName;
    if (isImageAttachment(att) && att.previewUrl) {
      const img = document.createElement('img');
      img.className = 'attach-chip-thumb';
      img.src = att.previewUrl;
      img.alt = att.originalName || '';
      img.title = '点击放大';
      img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openComposerImageLightbox(att.previewUrl, att.originalName || '');
      });
      chip.appendChild(img);
    }
    label.textContent = att.originalName;
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.setAttribute('aria-label', '移除');
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      revokeAttachmentPreview(att);
      pendingAttachments.splice(idx, 1);
      renderAttachmentChips();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
  refreshContextProgress();
  if (hadFocusInside && typeof focusChatInput === 'function') focusChatInput();
}

async function processAttachmentsForSend(userText, attachments) {
  // 图片附件走「前置轻量标记」：历史折叠是压成一行 + 从头截断，
  // 标记必须排在消息最前面才不会被正文挤掉（否则模型连图在哪都不知道，无法补看）。
  const lead = [];
  const lines = [];
  if (userText) lines.push(userText);
  const imageParts = [];
  const list = attachments && attachments.length ? attachments : [];
  const imageAtts = list.filter((att) => isImageAttachment(att));
  const otherAtts = list.filter((att) => !isImageAttachment(att));

  /** 被排除的图片：只写进模型可见文本不够，用户也必须知道，否则会以为图已经发出去了。 */
  const excluded = [];
  const maxImageBytes = attachmentImageMaxBytes();

  if (imageAtts.length) {
    let seq = 0;
    for (const att of imageAtts) {
      if (att.size > maxImageBytes) {
        const mb = Math.round(maxImageBytes / 1024 / 1024);
        lead.push(`[附件图 ${att.originalName}: 超过 ${mb}MB，未随消息发送]`);
        excluded.push(`${att.originalName} 超过 ${mb}MB`);
        continue;
      }
      const filePath = agentAttachmentPath(att);
      seq += 1;
      lead.push(
        `[附件图 ${seq}/${imageAtts.length}: ${filePath || att.originalName}]`
      );
      let base64 = '';
      try {
        base64 = await readAttachmentBase64(att);
      } catch (err) {
        lead.push(`（读取失败: ${err.message || err}）`);
        excluded.push(`${att.originalName} 读取失败`);
        continue;
      }
      const mime = att.mime && String(att.mime).startsWith('image/') ? att.mime : guessImageMime(att);
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}` }
      });
    }
    if (imageParts.length) {
      lead.push('（重新查看某张图：fs_read_file 设 encoding=base64）');
    }
  }

  if (excluded.length) {
    attachmentToast('部分图片未随消息发送', `${excluded.join('；')}。可压缩后重新发送。`, {
      variant: 'warn',
      duration: 7000
    });
  }


  if (otherAtts.length) {
    if (lines.length) lines.push('');
    lines.push('【用户附件】');
    for (const att of otherAtts) {
      lines.push(`- ${att.originalName} (${att.size} bytes)\n  路径: ${agentAttachmentPath(att) || att.path}`);
      if (gwState.authed && att.size <= MAX_ATTACH_TEXT) {
        try {
          const r = await gatewayCall('fs.read_file', { filePath: att.path, encoding: 'utf8' });
          const text = String(r.data || '');
          if (text && !text.includes('\u0000')) {
            lines.push(`  内容预览:\n\`\`\`\n${text.slice(0, MAX_ATTACH_TEXT)}\n\`\`\``);
          }
        } catch {
          lines.push('  （无法以文本读取，可通过 fs_read_file 访问）');
        }
      }
    }
  }

  // 上游按字符计 Input length，base64 全量算在内。这里不自动剔除图片（会误伤当前可用
  // 的场景），但超出本地请求硬顶时必须让用户知道，而不是发出去换一个 400。
  if (imageParts.length) {
    const payloadChars = imageParts.reduce(
      (n, p) => n + String((p.image_url && p.image_url.url) || '').length,
      0
    );
    const budgetChars = attachmentRequestMaxChars();
    if (payloadChars > budgetChars) {
      attachmentToast(
        '图片较大，可能超出中转上限',
        `本次图片约 ${Math.round(payloadChars / 1024 / 1024)}M 字符，超过请求上限 ${Math.round(budgetChars / 1024)}K 字符。若本轮报错，请压缩后重发。`,
        { variant: 'warn', duration: 8000 }
      );
    }
  }

  const textForStorage = [...lead, ...lines].join('\n').trim() || userText || '';
  if (imageParts.length) {
    return {
      content: [
        { type: 'text', text: textForStorage || '请根据附件图片协助我。' },
        ...imageParts
      ],
      hasImages: true,
      textForStorage
    };
  }
  return {
    content: textForStorage || userText || '',
    hasImages: false,
    textForStorage
  };
}
