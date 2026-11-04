/* global document, window, IMAGE_ARTIFACT_RE, MEDIA_ARTIFACT_RE, openSidePanel, setSidePanelTab, openArtifactTab, openImageLightbox, loadArtifactImageObjectUrl, artifactMediaUrlForCurrentSession, openLocalPathInSystemPlayer, revokeArtifactMediaBlobUrls, isImagePreviewToolCall, toolArtifactPath, nudgeChatFollowSettle */
'use strict';

/**
 * 正式回答里的媒体（截图 / 模型产出的图 / 音频 / 视频）。
 *
 * 两个数据来源、一个渲染体：
 *   1. 模型显式指名：正文里的 `![alt](path)`。`renderer-answer-md.js` 只落一个占位，
 *      本文件的 `bindAnswerMarkdownMedia()` 填内容 —— 与 `bindAnswerMarkdownLinks()` 同构的
 *      第二个 bind pass，不是另一套渲染机制。图片按扩展名走 `<img>`，音视频走 `<video>/<audio>`。
 *   2. 本轮工具产出：trace 里「这个文件确实被产出 / 展示过」的结构信号，正文下方给一条缩略条。
 *      信号见 `traceToolMediaPaths()`（`tool.result.imagePaths` / 截图工具的 args.filePath /
 *      以 base64 读图）。
 *
 * 为什么两条都要：只做 1 时 computer、browser_screenshot 的图不会出现在正文里（模型也不会替它
 * 写 `![]()`，它只收到「截图已进入视觉通道」）；只做 2 时模型主动点名的图（host_exec 生成的
 * chart.png）会漏。两者共用同一个占位渲染体、同一套「怎么拿到内容」，差异只有「显示哪几张」。
 *
 * 图片与音视频拿内容的方式**不同**（这是关键差别）：
 *   - 图片：读盘 → base64 → blob URL（≤3MB，一次读完最省事）；
 *   - 音视频：不读盘，给一个可 seek 的 `dieyun-media://` URL（见 src/main/media-protocol.js），
 *     字节由 Main 按 Range 分块现取 —— 视频动辄几十上百 MB，读进 JS 既炸内存也不能拖进度。
 *
 * 明确不做：思考区（纯文本通道）、http(s) 外链、data: / file: 内联；渲染进程也不复查路径白名单
 * —— 读盘仍由 Gateway（fs / artifact 的读权限与白名单）负责，读不到就撤掉，不留空框。
 */

/** 一条回答下最多显示几个媒体（其余提示去产物面板看）；数字只在这里改 */
const ANSWER_FIGURE_MAX = 3;
/** 收集时先截断，避免超长 trace 里反复去重 */
const ANSWER_FIGURE_SCAN_MAX = 24;
/** 带协议前缀的引用一律不渲染：外链（http/https）、内联（data:）、本地直读（file:）、协议相对（//） */
const ANSWER_FIGURE_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** Windows 盘符（`C:\` / `C:/`）不是协议，先认它，否则会被当成 `c:` scheme */
const ANSWER_FIGURE_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

function answerImageExtOk(filePath) {
  if (typeof IMAGE_ARTIFACT_RE === 'undefined' || !IMAGE_ARTIFACT_RE) return false;
  return IMAGE_ARTIFACT_RE.test(String(filePath || ''));
}

/** 'video' | 'audio' | ''（扩展名判定与 Main 侧 media-protocol.js 同一份知识） */
function answerMediaKind(filePath) {
  if (typeof MEDIA_ARTIFACT_RE === 'undefined' || !MEDIA_ARTIFACT_RE) return '';
  const p = String(filePath || '').toLowerCase();
  if (!MEDIA_ARTIFACT_RE.test(p)) return '';
  return /\.(mp4|m4v|webm|ogv|mov|mkv)$/.test(p) ? 'video' : 'audio';
}

/** 图片或音视频都算「能渲染的媒体」 */
function answerFigureExtOk(filePath) {
  return answerImageExtOk(filePath) || !!answerMediaKind(filePath);
}

/** 这个引用能不能就地在回答里渲染（只判形状，不判可读性 —— 可读性归 Gateway） */
function isRenderableAnswerMediaPath(src) {
  const p = String(src || '').trim();
  if (!p) return false;
  if (!ANSWER_FIGURE_DRIVE_RE.test(p) && ANSWER_FIGURE_SCHEME_RE.test(p)) return false;
  return answerFigureExtOk(p);
}

function answerFigureName(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) || norm : norm;
}

/**
 * 正文 Markdown 图片的占位 HTML。
 *
 * 用 `<span>` 而不是 `<figure>`：图片可能落在段落里（`<p>` 内嵌 `<figure>` 是非法嵌套，
 * 浏览器会把段落拆开、留下空段）。样式全部走 `.answer-figure` 类。
 *
 * `alt` / `src` 由 `renderAnswerInline()` 传入，**已经过 escapeHtml**（引号已转义），
 * 这里直接落进属性即可；不可渲染时返回空串，调用方回退成原始字面文本（与旧行为一致）。
 *
 * @param {string} alt 已转义
 * @param {string} src 已转义
 */
function answerFigurePlaceholderHtml(alt, src) {
  if (!isRenderableAnswerMediaPath(src)) return '';
  const caption = String(alt || '').trim();
  const mediaKind = answerMediaKind(src);
  if (mediaKind) {
    // 音视频：不读字节，只记路径 + 类型，由 bind pass 挂上 `dieyun-media://` 源
    return (
      '<span class="answer-figure answer-figure-media" data-answer-figure-src="' +
      src +
      '" data-answer-media-kind="' +
      mediaKind +
      '">' +
      (caption ? '<span class="answer-figure-cap">' + caption + '</span>' : '') +
      '</span>'
    );
  }
  return (
    '<span class="answer-figure msg-md-figure" data-answer-figure-src="' +
    src +
    '">' +
    '<img class="answer-figure-img" alt="' +
    caption +
    '" decoding="async">' +
    (caption ? '<span class="answer-figure-cap">' + caption + '</span>' : '') +
    '</span>'
  );
}

/** 次要动作：跳到产物面板看这个文件本身（全屏图之外的入口，保留但不占主手势） */
function openAnswerFigureInArtifactTab(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'files' });
  if (typeof setSidePanelTab === 'function') setSidePanelTab('files');
  if (typeof openArtifactTab === 'function') openArtifactTab(p);
}

/**
 * 点图 = 全屏查看。复用 `renderer-attachments.js` 里的通用图片灯箱（composer 附件预览同一个），
 * 不另造第二个大图查看器。
 *
 * 优先用这张图**已经读好的** blob URL —— 不重复读盘、不额外占内存、关掉也不用回收。
 * 只有占位还没填（图还没读到）时才现读一次，并在灯箱关闭时释放那个临时 URL。
 */
function openAnswerFigureViewer(filePath, fig) {
  const p = String(filePath || '').trim();
  if (!p || typeof openImageLightbox !== 'function') return;
  const name = answerFigureName(p);
  const img =
    fig && typeof fig.querySelector === 'function' ? fig.querySelector('.answer-figure-img') : null;
  const ready = (img && img.getAttribute('src')) || '';
  const opts = {
    name,
    actionLabel: '在产物面板打开',
    onAction: () => openAnswerFigureInArtifactTab(p)
  };
  if (ready) {
    openImageLightbox(ready, name, opts);
    return;
  }
  if (typeof loadArtifactImageObjectUrl !== 'function') return;
  if (fig && fig.dataset.answerFigureViewerPending === '1') return;
  if (fig) fig.dataset.answerFigureViewerPending = '1';
  void (async () => {
    let url = null;
    try {
      url = await loadArtifactImageObjectUrl(p);
    } catch {
      url = null;
    }
    if (fig) delete fig.dataset.answerFigureViewerPending;
    if (!url) return;
    openImageLightbox(url, name, {
      ...opts,
      onClose: () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
    });
  })();
}

/** 媒体播不了时的兜底：优先系统播放器（桥在 renderer-artifacts.js），没有桥就退回产物面板 */
function openMediaInSystemPlayer(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  if (typeof openLocalPathInSystemPlayer === 'function' && openLocalPathInSystemPlayer(p)) return;
  openAnswerFigureInArtifactTab(p);
}

function replaceAnswerMediaWithFallback(fig, filePath) {
  if (!fig) return;
  fig.classList.add('answer-media-failed');
  const dead = fig.querySelector('.answer-media-el');
  if (dead) dead.remove();
  if (fig.querySelector('.answer-media-fallback')) return;
  const box = document.createElement('span');
  box.className = 'answer-media-fallback';
  const label = document.createElement('span');
  label.className = 'answer-media-fallback-text';
  label.textContent = '应用内播不了这个文件';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'answer-media-fallback-btn';
  openBtn.textContent = '用系统播放器打开';
  openBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMediaInSystemPlayer(filePath);
  });
  box.append(label, openBtn);
  fig.appendChild(box);
}

/** 音视频：挂一个可 seek 的 `dieyun-media://` 源（不读字节，见 src/main/media-protocol.js） */
function fillAnswerMedia(fig, filePath, kind) {
  if (!fig) return;
  if (typeof artifactMediaUrlForCurrentSession !== 'function') {
    replaceAnswerMediaWithFallback(fig, filePath);
    return;
  }
  const el = document.createElement(kind === 'video' ? 'video' : 'audio');
  el.className = 'answer-media-el';
  el.controls = true;
  el.preload = 'metadata';
  if (kind === 'video') el.playsInline = true;
  el.src = artifactMediaUrlForCurrentSession(filePath);
  el.addEventListener('error', () => replaceAnswerMediaWithFallback(fig, filePath));
  const cap = fig.querySelector('.answer-figure-cap');
  if (cap) fig.insertBefore(el, cap);
  else fig.appendChild(el);
}

function createAnswerFigure(filePath) {
  const fig = document.createElement('span');
  fig.className = 'answer-figure';
  fig.dataset.answerFigureSrc = String(filePath || '');
  const mediaKind = answerMediaKind(filePath);
  if (mediaKind) {
    fig.classList.add('answer-figure-media');
    fig.dataset.answerMediaKind = mediaKind;
  } else {
    const img = document.createElement('img');
    img.className = 'answer-figure-img';
    img.alt = answerFigureName(filePath);
    img.decoding = 'async';
    fig.appendChild(img);
  }
  const cap = document.createElement('span');
  cap.className = 'answer-figure-cap';
  cap.textContent = answerFigureName(filePath);
  fig.appendChild(cap);
  return fig;
}

/**
 * 读盘时机：进入视口再读（**懒加载**是这个功能的必要部分，不是优化）。
 *
 * 为什么必须有：computer 任务一轮能截几十张，历史会话一次渲染会把每条回答的图都读一遍；
 * 没有相交观察就是「打开老会话 = N 次 3MB 的 RPC 读盘」。环境不支持时退回立即读。
 */
const answerFigureObserver =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            answerFigureObserver.unobserve(entry.target);
            void fillAnswerFigure(entry.target, entry.target.dataset.answerFigureSrc);
          }
        },
        { rootMargin: '240px' }
      )
    : null;

function queueAnswerFigureFill(fig, filePath) {
  if (!fig) return;
  if (filePath) fig.dataset.answerFigureSrc = String(filePath);
  const p = String(fig.dataset.answerFigureSrc || '').trim();
  if (!p) {
    fig.remove();
    return;
  }
  if (!answerFigureObserver) {
    void fillAnswerFigure(fig, p);
    return;
  }
  answerFigureObserver.observe(fig);
}

/**
 * 按类型填内容：音视频挂 URL，图片读盘转 blob。
 *
 * 读不到 / 超过内联上限 / 容器已销毁 → 撤掉该占位。
 * 图片的释放约定：blob URL 写进 `data-artifact-blob-url`，由 `revokeArtifactMediaBlobUrls(container)` 统一回收。
 */
async function fillAnswerFigure(fig, filePath) {
  if (!fig || fig.dataset.answerFigureFilled === '1') return;
  fig.dataset.answerFigureFilled = '1';
  const p = String(filePath || '').trim();
  const mediaKind = String(fig.dataset.answerMediaKind || '') || answerMediaKind(p);
  if (mediaKind) {
    if (!fig.isConnected) {
      fig.remove();
      return;
    }
    fillAnswerMedia(fig, p, mediaKind);
    return;
  }
  let url = null;
  try {
    url =
      typeof loadArtifactImageObjectUrl === 'function'
        ? await loadArtifactImageObjectUrl(p)
        : null;
  } catch {
    url = null;
  }
  const img = fig.querySelector('.answer-figure-img');
  if (!url || !img || !fig.isConnected) {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    fig.remove();
    return;
  }
  fig.dataset.artifactBlobUrl = url;
  fig.classList.add('is-clickable');
  fig.title = '点击放大查看';
  fig.setAttribute('role', 'button');
  fig.tabIndex = 0;
  img.src = url;
  img.addEventListener('load', () => {
    // 图是异步长高的：落位后补一次跟底（与 mermaid 同一收尾口径）
    if (typeof nudgeChatFollowSettle === 'function') nudgeChatFollowSettle();
  });
  const open = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    openAnswerFigureViewer(p, fig);
  };
  fig.addEventListener('click', open);
  fig.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') open(ev);
  });
}

/** 正文媒体占位 → 填内容（新 bind pass；与链接绑定同样只绑一次） */
function bindAnswerMarkdownMedia(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('.answer-figure[data-answer-figure-src]').forEach((fig) => {
    if (fig.dataset.answerFigureBound === '1') return;
    fig.dataset.answerFigureBound = '1';
    queueAnswerFigureFill(fig, fig.dataset.answerFigureSrc);
  });
}

/**
 * 一条工具记录在界面上能渲染的媒体路径（**唯一判定**）。
 *
 * 四个来源，按「越结构化越优先」：
 *   - `tool.result.imagePaths`：Main 侧产图关卡写入的凭证（computer / MCP / 无落盘路径的
 *     browser_screenshot / 以 base64 读图）；只活在**实时** trace 里 —— 账本落库时会丢掉 result；
 *   - `tool.result.path` / `savePath`：browser_screenshot 自己的落盘参数（同样只活在实时 trace）；
 *   - `tool.toolArgs.filePath`：截图工具自己指定的存盘位置。这一条是历史 replay 的唯一来源
 *     （args 会随 trace 持久化），所以不能只认 result；
 *   - `isImagePreviewToolCall()`：模型用 `fs_read_file` + `encoding=base64` 把图「给用户看过」，
 *     是既有判定（产物区同一来源），只看 args，历史 replay 也能重建。
 *
 * 失败 / 进行中的调用一律不算（与产物区同一口径）。返回值不区分图片/音视频 —— 扩展名决定怎么渲染。
 */
const ANSWER_FIGURE_FILE_ARG_TOOLS = ['browser_screenshot', 'browser_observe'];

function traceToolMediaPaths(tool) {
  if (!tool || tool.failed || tool.pending) return [];
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (!v || !answerFigureExtOk(v)) return;
    if (out.indexOf(v) < 0) out.push(v);
  };
  const result = tool.result && typeof tool.result === 'object' ? tool.result : null;
  if (result) {
    if (Array.isArray(result.imagePaths)) for (const p of result.imagePaths) push(p);
    push(result.path);
    push(result.savePath);
  }
  const args = tool.toolArgs && typeof tool.toolArgs === 'object' ? tool.toolArgs : null;
  if (args && ANSWER_FIGURE_FILE_ARG_TOOLS.indexOf(String(tool.name || '').toLowerCase()) >= 0) {
    push(args.filePath);
  }
  if (!out.length && args && typeof isImagePreviewToolCall === 'function' && isImagePreviewToolCall(tool)) {
    if (typeof toolArtifactPath === 'function') push(toolArtifactPath(tool));
  }
  return out;
}

/**
 * 本轮要显示的媒体：按 trace 顺序去重，只留最后 ANSWER_FIGURE_MAX 个（最后一个是当前画面）。
 * @returns {{ paths: string[], hidden: number }}
 */
function answerMediaPathsForTrace(trace) {
  const all = [];
  const seen = new Set();
  for (const entry of Array.isArray(trace) ? trace : []) {
    for (const tool of entry && entry.tools ? entry.tools : []) {
      for (const p of traceToolMediaPaths(tool)) {
        const key = String(p).replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(p);
        if (all.length >= ANSWER_FIGURE_SCAN_MAX) break;
      }
      if (all.length >= ANSWER_FIGURE_SCAN_MAX) break;
    }
    if (all.length >= ANSWER_FIGURE_SCAN_MAX) break;
  }
  const hidden = Math.max(0, all.length - ANSWER_FIGURE_MAX);
  return { paths: all.slice(-ANSWER_FIGURE_MAX), hidden };
}

/**
 * 回答正文下方挂「本轮媒体」（图片 / 音频 / 视频）。只认 trace 的结构信号，不解析任何文案。
 *
 * 幂等：同一组重入直接返回（容器带着签名）；正文重绘前调用方先
 * `revokeAnswerFigureBlobs(host)`，blob 不会因为反复重绘而泄漏。
 */
function attachAnswerFigures(host, trace) {
  if (!host) return;
  const { paths, hidden } = answerMediaPathsForTrace(trace);
  const existing = host.querySelector(':scope > .msg-answer-figures');
  if (!paths.length) {
    if (existing) {
      revokeAnswerFigureBlobs(existing);
      existing.remove();
    }
    return;
  }
  const sig = paths.join('|') + '#' + hidden;
  if (existing && existing.dataset.figuresSig === sig) return;
  if (existing) {
    revokeAnswerFigureBlobs(existing);
    existing.remove();
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg-answer-figures';
  wrap.dataset.figuresSig = sig;
  for (const p of paths) {
    const fig = createAnswerFigure(p);
    wrap.appendChild(fig);
    queueAnswerFigureFill(fig, p);
  }
  if (hidden > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'msg-answer-figures-more';
    more.textContent = '还有 ' + hidden + ' 个，去产物面板看';
    more.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof openSidePanel === 'function') openSidePanel({ tab: 'files' });
      if (typeof setSidePanelTab === 'function') setSidePanelTab('files');
    });
    wrap.appendChild(more);
  }
  host.appendChild(wrap);
}

/** 回收某容器下所有回答媒体 blob（正文重绘 / 清空聊天区时必须调） */
function revokeAnswerFigureBlobs(container) {
  if (!container) return;
  if (answerFigureObserver) {
    container.querySelectorAll('.answer-figure[data-answer-figure-src]').forEach((fig) => {
      answerFigureObserver.unobserve(fig);
    });
  }
  // 音视频还在播就先停：容器被换掉后元素不会自己收尾（没有 blob 要回收，只有声音要停）
  container.querySelectorAll('audio, video').forEach((el) => {
    try {
      el.pause();
    } catch {
      /* ignore */
    }
  });
  if (typeof revokeArtifactMediaBlobUrls === 'function') {
    revokeArtifactMediaBlobUrls(container);
    return;
  }
  container.querySelectorAll('[data-artifact-blob-url]').forEach((el) => {
    const url = el.dataset && el.dataset.artifactBlobUrl;
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    delete el.dataset.artifactBlobUrl;
  });
}

window.isRenderableAnswerMediaPath = isRenderableAnswerMediaPath;
window.answerFigurePlaceholderHtml = answerFigurePlaceholderHtml;
window.bindAnswerMarkdownMedia = bindAnswerMarkdownMedia;
window.traceToolMediaPaths = traceToolMediaPaths;
window.answerMediaPathsForTrace = answerMediaPathsForTrace;
window.attachAnswerFigures = attachAnswerFigures;
window.revokeAnswerFigureBlobs = revokeAnswerFigureBlobs;
window.openMediaInSystemPlayer = openMediaInSystemPlayer;
