/* global window, document */
'use strict';

let mermaidReady = false;
let mermaidCounter = 0;
let mermaidSubgraphSeq = 0;

function initMermaidRender() {
  if (mermaidReady) return !!window.mermaid;
  if (!window.mermaid) {
    console.warn('mermaid 未加载');
    return false;
  }
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      // loose：LLM 图里中文/括号标签更稳；渲染前会去掉 HTML/<br/>
      securityLevel: 'loose',
      suppressErrorRendering: true,
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      flowchart: { htmlLabels: false, curve: 'basis' }
    });
    mermaidReady = true;
    return true;
  } catch (e) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        flowchart: { htmlLabels: false, curve: 'basis' }
      });
      mermaidReady = true;
      return true;
    } catch (e2) {
      console.warn(e2 || e);
      return false;
    }
  }
}

function hasMermaidBlock(text) {
  return /```\s*mermaid\b/i.test(String(text || ''));
}

/**
 * @param {string} text
 * @returns {{ type: 'text'|'mermaid', value: string }[]}
 */
function splitMermaidBlocks(text) {
  const src = String(text || '');
  const segments = [];
  const re = /```\s*mermaid(?:[^\n\r]*)?\r?\n([\s\S]*?)```/gi;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', value: src.slice(last, m.index) });
    }
    segments.push({ type: 'mermaid', value: (m[1] || '').replace(/^\s+|\s+$/g, '') });
    last = m.index + m[0].length;
  }
  if (last < src.length) {
    segments.push({ type: 'text', value: src.slice(last) });
  }
  return segments.length ? segments : [{ type: 'text', value: src }];
}

function labelNeedsQuotes(label) {
  const s = String(label || '');
  if (!s) return false;
  if (/^["`].*["`]$/.test(s.trim())) return false;
  // `/` 在 Mermaid flowchart 词法里特殊（点线边等），含路径必须加引号
  if (s.includes('/')) return true;
  // 纯 ASCII 标识符可无引号；中文、空格、括号等需引号
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return false;
  return true;
}

function quoteLabel(label) {
  let s = String(label || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '#quot;');
  // 全角斜线，避免个别版本对引号内 / 仍敏感
  s = s.replace(/\//g, '／');
  return `"${s}"`;
}

/**
 * 修补 LLM 常见坏图：中文未加引号、subgraph 标题带括号、edge 文案、&lt;br/&gt; 等。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeMermaidCode(raw) {
  let code = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    // 弯引号 → ASCII，否则 ["…"] 不算字符串，里面的 / 会炸词法
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/^\s*```+\s*mermaid\s*\n?/i, '')
    .replace(/\n?\s*```+\s*$/i, '')
    .trim();

  if (!code) return code;

  // 去掉常见 HTML 标签；勿用跨行 [^>]*，以免误删节点定义
  code = code
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:b|i|em|strong|span|div|p|font|br)(?:\s[^>\n]*)?>/gi, '')
    .split('\n')
    .filter((line) => !/^\s*(?:style|classDef|class|click|linkStyle)\b/i.test(line))
    .join('\n');

  // 无图类型声明时补 flowchart
  if (
    !/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/m.test(
      code
    )
  ) {
    code = `flowchart TB\n${code}`;
  }

  // graph → flowchart（Mermaid 11 仍支持 graph，统一更稳）
  code = code.replace(/^\s*graph\b/i, 'flowchart');

  const lines = code.split('\n');
  const out = [];
  for (let line of lines) {
    // subgraph Title with (parens) / 中文
    const sg = line.match(/^(\s*subgraph\s+)(.+?)\s*$/i);
    if (sg) {
      const rest = sg[2].trim();
      // 已有 id[...] / id["..."] / 纯 ASCII id
      if (/^[A-Za-z_][\w-]*\s*\[/.test(rest) || /^[A-Za-z_][\w-]*$/.test(rest)) {
        out.push(line);
        continue;
      }
      const id = `sg${++mermaidSubgraphSeq}`;
      if (/^["`].*["`]$/.test(rest)) {
        out.push(`${sg[1]}${id}[${rest}]`);
      } else {
        out.push(`${sg[1]}${id}[${quoteLabel(rest)}]`);
      }
      continue;
    }

    // 边标签 A -->|中文| B / A -- 中文 --> B
    line = line.replace(/(--?>?\|)(?:"([^"]*)"|([^|"\n]+))(\|)/g, (full, a, quoted, bare, b) => {
      const trimmed = String(quoted != null ? quoted : bare || '').trim();
      if (!trimmed) return full;
      const inner = trimmed.replace(/\//g, '／').replace(/"/g, '#quot;');
      return `${a}"${inner}"${b}`;
    });

    // 节点形状：按括号配对给中文/特殊字符标签加引号
    const shapeOpeners = [
      { open: '((', close: '))' },
      { open: '[[', close: ']]' },
      { open: '{{', close: '}}' },
      { open: '[(', close: ')]' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '{', close: '}' }
    ];
    for (const { open, close } of shapeOpeners) {
      const escOpen = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escClose = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `\\b([A-Za-z_][\\w-]*)\\s*${escOpen}([^\\n]*?)${escClose}`,
        'g'
      );
      line = line.replace(re, (full, id, label) => {
        const trimmed = String(label || '').trim();
        if (!trimmed) return full;
        if (/^["`].*["`]$/.test(trimmed)) {
          const inner = trimmed.slice(1, -1).replace(/\//g, '／').replace(/"/g, '#quot;');
          return `${id}${open}"${inner}"${close}`;
        }
        if (!labelNeedsQuotes(trimmed)) return full;
        return `${id}${open}${quoteLabel(trimmed)}${close}`;
      });
    }

    // stadium / asymmetric: ID>label]（勿匹配 --> 箭头）
    line = line.replace(
      /(?<!-)\b([A-Za-z_][\w-]*)\s*>([^\n\]|>]+)]/g,
      (full, id, label) => {
        const trimmed = String(label || '').trim();
        if (!trimmed || /^["`].*["`]$/.test(trimmed) || !labelNeedsQuotes(trimmed)) return full;
        return `${id}>${quoteLabel(trimmed)}]`;
      }
    );

    // 保留字 end 作节点 ID（flowchart）
    line = line.replace(/(^|[\s;])end(?=\s*[\[\(\{>])/g, '$1endNode');

    out.push(line);
  }

  return out.join('\n').trim();
}

function appendTextSegment(container, text) {
  const chunk = String(text || '').replace(/^\s+|\s+$/g, '');
  if (!chunk) return;
  const el = document.createElement('div');
  el.className = 'msg-answer-text';
  el.textContent = chunk;
  container.appendChild(el);
}

function formatMermaidError(err) {
  if (!err) return '未知错误';
  const msg = String(err.message || err.str || err).trim();
  if (!msg) return '渲染失败';
  const low = msg.toLowerCase();
  if (
    low.includes('content security policy') ||
    low.includes('unsafe-eval') ||
    err.name === 'EvalError' ||
    low.includes('violates the following content security policy')
  ) {
    return 'CSP 拦截了 Mermaid（需要 script-src 含 unsafe-eval）。请完全重启应用后再试';
  }
  // 压缩超长 parse 堆栈行
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

function appendMermaidFallback(container, code, err) {
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-mermaid msg-mermaid-error';
  const title = document.createElement('div');
  title.className = 'msg-mermaid-error-title';
  title.textContent = `流程图渲染失败：${formatMermaidError(err)}`;
  const pre = document.createElement('pre');
  pre.className = 'msg-mermaid-fallback';
  pre.textContent = code;
  wrap.appendChild(title);
  wrap.appendChild(pre);
  container.appendChild(wrap);
}

function isMermaidErrorSvg(svg) {
  const s = String(svg || '');
  // 注意：正常 flowchart 的 <style> 里也会声明 .error-text { ... }，绝不能用 includes('error-text')
  if (/Syntax error in text/i.test(s)) return true;
  // 真正的错误图：text/tspan 元素带 error-text 类
  if (/<(?:text|tspan)\b[^>]*\bclass\s*=\s*(["'])[^"']*\berror-text\b[^"']*\1/i.test(s)) return true;
  if (/<(?:text|tspan)\b[^>]*\bclass\s*=\s*[^>]*\berror-text\b/i.test(s)) return true;
  return false;
}

function extractMermaidSvgError(svg) {
  const s = String(svg || '');
  const m =
    s.match(/class="[^"]*error-text[^"]*"[^>]*>([^<]+)/i) ||
    s.match(/Syntax error in text[^<\n]*/i);
  if (!m) return '';
  return String(m[1] || m[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function nextMermaidRenderId(prefix) {
  return `${prefix || 'mmd'}-${Date.now()}-${++mermaidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupMermaidRenderDom(id) {
  if (!id || typeof document === 'undefined') return;
  try {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  } catch {
    // ignore
  }
}

async function validateMermaidCode(code) {
  if (!window.mermaid || typeof window.mermaid.parse !== 'function') {
    throw new Error('Mermaid.parse 不可用');
  }
  await window.mermaid.parse(code);
}

/**
 * @param {HTMLElement} wrap
 * @param {string} code
 */
async function renderMermaidDiagram(wrap, code) {
  const parent = wrap.parentElement;
  if (!initMermaidRender()) {
    wrap.remove();
    if (parent) appendMermaidFallback(parent, code, new Error('Mermaid 未就绪'));
    return;
  }
  const sanitized = sanitizeMermaidCode(code);
  const raw = String(code || '').trim();
  // 先试原文，再试修补版——避免 sanitize 误伤已经合法的图
  const candidates = [];
  if (raw) candidates.push(raw);
  if (sanitized && sanitized !== raw) candidates.push(sanitized);
  let lastErr = null;
  let lastCode = raw || sanitized;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate) continue;
    lastCode = candidate;
    const id = nextMermaidRenderId('mmd');
    try {
      await validateMermaidCode(candidate);
      const out = await window.mermaid.render(id, candidate);
      cleanupMermaidRenderDom(id);
      if (!wrap.isConnected) return;
      if (!out || !out.svg) {
        throw new Error('Mermaid 未返回 SVG');
      }
      if (isMermaidErrorSvg(out.svg)) {
        throw new Error(extractMermaidSvgError(out.svg) || 'Mermaid 渲染失败');
      }
      wrap.innerHTML = out.svg;
      if (typeof out.bindFunctions === 'function') out.bindFunctions(wrap);
      wrap.classList.remove('msg-mermaid-loading');
      wrap.classList.add('msg-mermaid-ok');
      attachMermaidExpandControl(wrap);
      return;
    } catch (e) {
      cleanupMermaidRenderDom(id);
      lastErr = e;
    }
  }

  const host = wrap.parentElement || parent;
  wrap.remove();
  if (host) appendMermaidFallback(host, lastCode, lastErr || new Error('渲染失败'));
}

/**
 * 渲染含 mermaid 的 assistant 正文；无 mermaid 时由调用方走 textContent。
 * @param {HTMLElement} answerEl
 * @param {string} content
 * @returns {Promise<boolean>}
 */
async function renderAssistantAnswerContent(answerEl, content) {
  const text = String(content || '');
  if (!hasMermaidBlock(text)) return false;

  const segments = splitMermaidBlocks(text);
  if (!segments.some((s) => s.type === 'mermaid')) return false;

  answerEl.replaceChildren();
  answerEl.classList.add('msg-answer-rich');
  answerEl.dataset.rawContent = text;

  const pending = [];

  for (const seg of segments) {
    if (seg.type === 'text') {
      appendTextSegment(answerEl, seg.value);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg-mermaid msg-mermaid-loading';
    wrap.textContent = '正在绘制流程图…';
    answerEl.appendChild(wrap);
    pending.push(renderMermaidDiagram(wrap, seg.value));
  }

  await Promise.all(pending);
  return true;
}

/**
 * Wiki / 聊天气泡流程图：右上角放大预览。
 * @param {HTMLElement} wrap
 */
function attachMermaidExpandControl(wrap) {
  if (!wrap || wrap.querySelector('.msg-mermaid-expand-btn')) return;
  if (!wrap.querySelector(':scope > svg')) return;
  wrap.classList.add('msg-mermaid-has-expand');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-mermaid-expand-btn';
  btn.title = '放大查看';
  btn.setAttribute('aria-label', '放大查看流程图');
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMermaidLightbox(wrap);
  });
  wrap.appendChild(btn);
}

function closeMermaidLightbox() {
  const el = document.getElementById('mermaid-lightbox');
  if (el) el.remove();
  document.removeEventListener('keydown', onMermaidLightboxKeydown, true);
}

function onMermaidLightboxKeydown(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeMermaidLightbox();
  }
}

/**
 * @param {HTMLElement} sourceWrap
 */
function openMermaidLightbox(sourceWrap) {
  const svg =
    (sourceWrap && sourceWrap.querySelector(':scope > svg')) ||
    (sourceWrap &&
      Array.from(sourceWrap.querySelectorAll('svg')).find(
        (el) => !el.closest('.msg-mermaid-expand-btn')
      ));
  if (!svg) return;
  closeMermaidLightbox();

  const overlay = document.createElement('div');
  overlay.id = 'mermaid-lightbox';
  overlay.className = 'mermaid-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '流程图放大预览');

  const panel = document.createElement('div');
  panel.className = 'mermaid-lightbox-panel';
  panel.style.width = `${Math.min(Math.round(window.innerWidth * 0.88), 1280)}px`;
  panel.style.height = `${Math.min(Math.round(window.innerHeight * 0.82), 900)}px`;

  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-lightbox-toolbar';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'mermaid-lightbox-tool-btn';
  zoomOutBtn.title = '缩小';
  zoomOutBtn.setAttribute('aria-label', '缩小');
  zoomOutBtn.textContent = '−';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'mermaid-lightbox-tool-btn';
  zoomInBtn.title = '放大';
  zoomInBtn.setAttribute('aria-label', '放大');
  zoomInBtn.textContent = '+';

  const zoomResetBtn = document.createElement('button');
  zoomResetBtn.type = 'button';
  zoomResetBtn.className = 'mermaid-lightbox-tool-btn mermaid-lightbox-zoom-reset';
  zoomResetBtn.title = '重置缩放';
  zoomResetBtn.textContent = '100%';

  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'mermaid-lightbox-zoom-label';
  zoomLabel.textContent = '100%';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mermaid-lightbox-tool-btn mermaid-lightbox-close';
  closeBtn.title = '关闭 (Esc)';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    closeMermaidLightbox();
  });

  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(zoomResetBtn);
  toolbar.appendChild(zoomLabel);
  toolbar.appendChild(closeBtn);

  const stage = document.createElement('div');
  stage.className = 'mermaid-lightbox-stage';
  const clone = svg.cloneNode(true);
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  const vb = clone.viewBox && clone.viewBox.baseVal;
  const naturalW = (vb && vb.width) || 1000;
  const baseW = Math.max(naturalW, Math.min(window.innerWidth * 0.78, 1200));
  clone.style.width = `${baseW}px`;
  clone.style.height = 'auto';
  clone.style.maxWidth = 'none';
  clone.style.transformOrigin = 'top center';
  stage.appendChild(clone);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'mermaid-lightbox-resize';
  resizeHandle.title = '拖动调整大小';
  resizeHandle.setAttribute('aria-hidden', 'true');

  let scale = 1;
  const applyZoom = () => {
    clone.style.transform = `scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    zoomResetBtn.textContent = `${Math.round(scale * 100)}%`;
  };
  const setZoom = (next) => {
    scale = Math.min(4, Math.max(0.35, next));
    applyZoom();
  };
  zoomInBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    setZoom(scale + 0.15);
  });
  zoomOutBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    setZoom(scale - 0.15);
  });
  zoomResetBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    setZoom(1);
  });
  stage.addEventListener(
    'wheel',
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setZoom(scale + (ev.deltaY < 0 ? 0.12 : -0.12));
    },
    { passive: false }
  );

  let panning = false;
  let panX = 0;
  let panY = 0;
  stage.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.mermaid-lightbox-resize')) return;
    if (ev.button !== 0) return;
    panning = true;
    panX = ev.clientX;
    panY = ev.clientY;
    stage.classList.add('is-panning');
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!panning) return;
    stage.scrollLeft -= ev.clientX - panX;
    stage.scrollTop -= ev.clientY - panY;
    panX = ev.clientX;
    panY = ev.clientY;
  });
  const endPan = (ev) => {
    if (!panning) return;
    panning = false;
    stage.classList.remove('is-panning');
    try {
      stage.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  resizeHandle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;
    const minW = 360;
    const minH = 260;
    const maxW = Math.round(window.innerWidth * 0.98);
    const maxH = Math.round(window.innerHeight * 0.96);
    const onMove = (e) => {
      panel.style.width = `${Math.min(maxW, Math.max(minW, startW + e.clientX - startX))}px`;
      panel.style.height = `${Math.min(maxH, Math.max(minH, startH + e.clientY - startY))}px`;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  panel.appendChild(toolbar);
  panel.appendChild(stage);
  panel.appendChild(resizeHandle);
  overlay.appendChild(panel);

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeMermaidLightbox();
  });
  panel.addEventListener('click', (ev) => ev.stopPropagation());

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onMermaidLightboxKeydown, true);
  closeBtn.focus();
}

window.hasMermaidBlock = hasMermaidBlock;
window.renderAssistantAnswerContent = renderAssistantAnswerContent;
window.initMermaidRender = initMermaidRender;
window.sanitizeMermaidCode = sanitizeMermaidCode;
window.closeMermaidLightbox = closeMermaidLightbox;

/**
 * 轻量 Markdown → 容器（标题/段落/列表/表格/代码/mermaid）。
 * @param {HTMLElement} container
 * @param {string} markdown
 */
async function renderMarkdownWithMermaid(container, markdown) {
  if (!container) return;
  const src = String(markdown || '');
  container.replaceChildren();
  container.classList.add('wiki-md-view');

  const escape = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const inlineFormat = (s) =>
    escape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  const segments = [];
  const re = /```\s*(\w+)?\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) segments.push({ type: 'md', value: src.slice(last, m.index) });
    const lang = String(m[1] || '').toLowerCase();
    segments.push({
      type: lang === 'mermaid' ? 'mermaid' : 'code',
      lang,
      value: m[2] || ''
    });
    last = m.index + m[0].length;
  }
  if (last < src.length) segments.push({ type: 'md', value: src.slice(last) });
  if (!segments.length) segments.push({ type: 'md', value: src });

  const mermaidJobs = [];

  for (const seg of segments) {
    if (seg.type === 'mermaid') {
      const wrap = document.createElement('div');
      wrap.className = 'msg-mermaid msg-mermaid-loading';
      wrap.textContent = '绘制流程图…';
      container.appendChild(wrap);
      mermaidJobs.push(
        (async () => {
          await renderMermaidDiagram(wrap, seg.value);
        })()
      );
      continue;
    }
    if (seg.type === 'code') {
      const pre = document.createElement('pre');
      pre.className = 'wiki-md-code';
      pre.textContent = seg.value.replace(/\n$/, '');
      container.appendChild(pre);
      continue;
    }

    const lines = String(seg.value || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!String(line).trim()) {
        i += 1;
        continue;
      }
      const hm = /^(#{1,3})\s+(.+)$/.exec(line);
      if (hm) {
        const el = document.createElement(`h${hm[1].length}`);
        el.innerHTML = inlineFormat(hm[2]);
        container.appendChild(el);
        i += 1;
        continue;
      }
      if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*-+/.test(lines[i + 1])) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          if (!/^\|?\s*-+/.test(lines[i])) rows.push(lines[i]);
          i += 1;
        }
        const table = document.createElement('table');
        table.className = 'wiki-md-table';
        rows.forEach((row, ri) => {
          const tr = document.createElement('tr');
          const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|');
          cells.forEach((c) => {
            const cell = document.createElement(ri === 0 ? 'th' : 'td');
            cell.innerHTML = inlineFormat(c.trim());
            tr.appendChild(cell);
          });
          table.appendChild(tr);
        });
        container.appendChild(table);
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.innerHTML = inlineFormat(lines[i].replace(/^[-*]\s+/, ''));
          ul.appendChild(li);
          i += 1;
        }
        container.appendChild(ul);
        continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.innerHTML = inlineFormat(lines[i].replace(/^\d+\.\s+/, ''));
          ol.appendChild(li);
          i += 1;
        }
        container.appendChild(ol);
        continue;
      }
      const p = document.createElement('p');
      const buf = [line];
      i += 1;
      while (i < lines.length && String(lines[i]).trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^[-*`|]/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      p.innerHTML = inlineFormat(buf.join(' '));
      container.appendChild(p);
    }
  }

  await Promise.all(mermaidJobs);
}

window.renderMarkdownWithMermaid = renderMarkdownWithMermaid;
