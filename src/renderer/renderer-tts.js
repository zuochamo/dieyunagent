/* global window, document, settings, currentSessionId, gatewayCall, showAgentToast, base64ToUint8Array, uiText, syncTtsAutoReadControl, chatList */
'use strict';

/**
 * 助手回复的「朗读」（TTS）。
 *
 * 链路：气泡按钮 → gatewayCall('speech.synthesize') → Gateway（request/response 形状的
 * 唯一来源 src/gateway/speech-synthesize.js）→ 返回 base64 音频 + mimeType → 这里造 Blob 播放。
 *
 * 为什么把「哪条消息、什么文本」的决定放在点击时：流式回复期间气泡内容一直在变，
 * 提前把文本绑到按钮上会读到半截（或丢掉后到的正文）。所以按钮只持有气体元素引用，
 * 文本在点击那一刻从 DOM 读。
 *
 * 配置来源：设置里 `kind: 'tts'` 的模型（`ModelCapabilities.getTtsApiConfigFromSettings`）。
 * 没配就**不显示**朗读按钮 —— 不猜、不兜底到转写模型。
 *
 * 「读到哪一句」：朗读文本就是渲染后正文的文本（`ttsTextMapOf`），切块带原文偏移
 * （`splitTtsChunksDetailed`），偏移换成 DOM Range 交给 CSS Custom Highlight 高亮。
 * 一体化的一条链 —— 不做「按字符串在 DOM 里搜句子」的二次匹配（错位比没有更难发现）。
 */

/** 播放器单例：同一时刻只播一段；再次点同一条 = 停止。 */
let ttsAudioEl = null;
let ttsActiveBtn = null;
let ttsPending = false;
/**
 * 播放代次：每次「发起」或「取消」都 +1。
 * 合成是异步的（实测 20~60s），期间用户可能点停止、切会话、或去点另一条回复；
 * 结果回来时只有代次没变才允许落盘播放 —— 否则会出现「已经切走/已经停止，
 * 过一会儿声音自己响起来」。
 */
let ttsToken = 0;
/** 正在朗读的文本：整篇重渲染后用它把「停止」状态接回新按钮（旧按钮会脱离 DOM）。 */
let ttsPlayingText = '';
/**
 * 活着的 Blob URL（分块播放时可能同时有「正在播」+「已预取好的一块」）。
 * 统一在这里回收：单个槽位在分块后会漏掉预取那块的 URL。
 */
const ttsUrls = new Set();
/** 暂停当前这一块的 play Promise（停止时让它结算，避免 await 悬挂）。 */
let ttsSettleCurrentChunk = null;
/**
 * 一次播放尝试只报一次错。
 * 播放失败会同时触发 media 的 `error` 事件和 `play()` 的 rejection，
 * 不去重就是两条 toast 叠在一起（用户看到的是同一件事说了两遍）。
 */
let ttsFailureNotified = false;

/**
 * 「正在念哪一句」的现场状态（高亮的唯一来源）。
 * 只在两处动：`playTtsText`（一轮开始 / 每句推进）与 `teardownTtsPlayer`（收尾）。
 */
/** @type {{ text: string, parts: { node: Node, start: number, end: number }[], shift: number }|null} */
let ttsReadMap = null;
/** @type {{ text: string, start: number, end: number, sentences: { start: number, end: number }[] }[]} */
let ttsReadChunks = [];
let ttsReadChunkIndex = -1;
let ttsReadChunkSentence = -1;

/** 文案走 i18n（`renderer-i18n.js` 的 uiText），英文界面下不会冒中文。 */
function ttsMsg(key, fallback) {
  if (typeof uiText === 'function') return uiText(key, fallback);
  return fallback != null ? fallback : key;
}

function notifyTtsFailure(detail) {
  if (ttsFailureNotified) return;
  ttsFailureNotified = true;
  if (typeof showAgentToast === 'function') {
    showAgentToast(ttsMsg('tts_fail_title', '朗读失败'), detail, { variant: 'error' });
  }
}

/** 只做播放器清理（不动代次 / pending）：新一轮开始前换掉旧音频时共用。 */
function teardownTtsPlayer() {
  if (ttsAudioEl) {
    try {
      ttsAudioEl.pause();
    } catch {
      // ignore：元素已失效
    }
    ttsAudioEl = null;
  }
  for (const url of ttsUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  ttsUrls.clear();
  const settle = ttsSettleCurrentChunk;
  ttsSettleCurrentChunk = null;
  if (settle) settle(); // 让正在 await 的播放循环结算，靠代次退出
  const btn = ttsActiveBtn;
  ttsActiveBtn = null;
  ttsPlayingText = '';
  if (btn) setTtsBtnState(btn, false);
  // 高亮跟着一起收（否则停了声音还留着「正在念这句」的记号）
  clearTtsReadingMark();
  ttsReadMap = null;
  ttsReadChunks = [];
  ttsReadChunkIndex = -1;
  ttsReadChunkSentence = -1;
}

function stopTtsPlayback() {
  ttsToken += 1; // 作废在途合成，迟到的结果不再播
  ttsPending = false;
  teardownTtsPlayer();
}

function ttsConfigFromSettings(source) {
  const mc = window.ModelCapabilities;
  if (!mc || typeof mc.getTtsApiConfigFromSettings !== 'function') return null;
  const cfg = mc.getTtsApiConfigFromSettings(source || settings);
  if (!cfg || !cfg.baseUrl || !cfg.model) return null;
  return cfg;
}

/** 设置里有没有可用的朗读模型（决定是否渲染按钮）。 */
function ttsAvailable() {
  return !!ttsConfigFromSettings();
}

/**
 * Markdown → 可朗读纯文本。
 *
 * 只做「不该念出来的东西」的剔除：代码块、行内代码标记、链接 URL、强调/标题/列表符号。
 * 不做翻译、不改写措辞（念错内容比念少更难发现）。
 *
 * @param {string} raw
 * @returns {string}
 */
function ttsSpeakableText(raw) {
  let text = String(raw == null ? '' : raw);
  // 围栏代码整块不念（念出来是噪音，且没有语义）
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  // 行内代码保留文字内容，去掉反引号
  text = text.replace(/`([^`]*)`/g, '$1');
  // 图片/链接：留文字，去掉 URL
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 强调、标题、引用、列表符号
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  // 表格分隔线与多余空白
  text = text.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * 不念也不高亮的子树：代码块（念出来是噪音）、流程图（SVG 里全是标签文字）、按钮。
 * 行内代码不在其中 —— 它本来就该念。
 */
const TTS_SKIP_SELECTOR = 'pre, svg, button, script, style, .msg-mermaid';
/** 这些标签的文字之间要断句（相邻段落不能被当成同一句话连读）。 */
const TTS_BLOCK_TAGS =
  'p, li, ol, ul, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption, summary, div';

/**
 * 气泡里的正文元素：可朗读文本与逐句高亮都以它为根。
 *
 * 大多数气泡有 `.msg-answer`（正文与思考区分开）。历史消息没有 trace 时走的是
 * 「纯文本直接塞进气泡」那条渲染路，此时正文就是气泡本身 —— 只有确认气泡里
 * 没有思考区才认它，避免把思考过程念出来。
 */
function ttsAnswerElOf(bubble) {
  if (!bubble || typeof bubble.querySelector !== 'function') return null;
  const answer = bubble.querySelector('.msg-answer');
  if (answer) return answer;
  if (bubble.querySelector('.msg-thinking-outer, .msg-thinking')) return null;
  return bubble;
}

/**
 * 渲染后正文 → `{ text, parts, shift }`：朗读文本 ↔ DOM 节点的一一映射。
 *
 * 为什么要映射：逐句高亮必须落成 DOM Range，只有「念的文本就是这份 DOM 的文本」时，
 * 切块偏移才对得上。所以正文优先用这里的文本，`rawContent` 只在 DOM 不可用时退化
 * （气泡还没渲染、或单测没有真实 DOM）。
 *
 * - `parts` 是每个文本节点在 `text` 里的区间（用于偏移 → Range）；
 * - `shift` 是首尾空白被裁掉的长度（偏移先加 `shift` 再落回 `parts`）。
 *
 * @param {HTMLElement|null} root
 * @returns {{ text: string, parts: { node: Node, start: number, end: number }[], shift: number }|null}
 */
function ttsTextMapOf(root) {
  if (!root || !root.childNodes) return null;
  if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null;
  const NF = typeof window !== 'undefined' ? window.NodeFilter : null;
  if (!NF || typeof NF.SHOW_TEXT !== 'number') return null;
  let walker;
  try {
    walker = document.createTreeWalker(root, NF.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue || '';
        // HTML 解析器不会留下 \r，出现就说明不是正常渲染结果 —— 不参与映射（偏移会失真）
        if (!value.trim() || value.includes('\r')) return NF.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent && typeof parent.closest === 'function' && parent.closest(TTS_SKIP_SELECTOR)) {
          return NF.FILTER_REJECT;
        }
        return NF.FILTER_ACCEPT;
      }
    });
  } catch {
    return null;
  }
  let text = '';
  const parts = [];
  let lastBlock = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const block = parent && typeof parent.closest === 'function' ? parent.closest(TTS_BLOCK_TAGS) : null;
    // 换块补一个断句符：否则相邻段落会被当成同一句话连读（长短与停顿都乱）
    if (text && block !== lastBlock) text += '\n';
    lastBlock = block;
    const start = text.length;
    text += node.nodeValue || '';
    parts.push({ node, start, end: text.length });
  }
  const shift = text.length - text.trimStart().length;
  const trimmed = text.trim();
  if (!trimmed || !parts.length) return null;
  return { text: trimmed, parts, shift };
}

/** 气泡里「这条回复的正文」：优先渲染后的正文（可与高亮共用同一份偏移）。 */
function ttsTextOfBubble(bubble) {
  if (!bubble) return '';
  const answer = ttsAnswerElOf(bubble);
  const map = ttsTextMapOf(answer);
  if (map) return map.text;
  const raw = String(answer?.dataset?.rawContent || '').trim();
  const text = ttsSpeakableText(raw || answer?.innerText || bubble.innerText || bubble.textContent || '');
  return text;
}

function setTtsBtnState(btn, speaking) {
  if (!btn) return;
  btn.classList.toggle('is-speaking', !!speaking);
  btn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
  const label = btn.querySelector('.msg-tts-label');
  if (label) label.textContent = speaking ? ttsMsg('tts_stop', '停止') : ttsMsg('tts_read', '朗读');
  btn.title = speaking ? ttsMsg('tts_btn_title_stop', '停止朗读') : ttsMsg('tts_btn_title', '朗读这条回复');
  // 播放中即使鼠标移开也保持操作条可见（否则「正在播什么、点哪停」看不见）
  const bar = btn.parentElement;
  if (bar && bar.classList) bar.classList.toggle('has-active-run', !!speaking);
}

/**
 * 每一块的目标 / 上限长度（字符）。
 *
 * 为什么切块：这家服务器合成 72 字要 2.3 秒，但 566 字要 15 秒、699 字要 90 秒 ——
 * 整段一次合成 = 点下去先干等十几秒才开始出声。切成一句一块后，**第一块 2~3 秒
 * 就能出声**（实测 62 字 2.8s、88 字 4.5s），后面在播放的同时合成下一块。
 *
 * 手机端有一份等价实现（`src/mobile/public/app.js#splitTtsChunks`）—— 那是独立
 * bundle、没有模块系统可共享。改这里的切块规则时同步改那边，否则两端语速/切句不一致。
 */
const TTS_CHUNK_TARGET = 90;
const TTS_CHUNK_MAX = 180;

/** 句末标点：优先在这些位置切，念起来才连贯（不在数字小数点、代码标记上切）。 */
const TTS_CHUNK_BREAK = '。！？!?；;\n';

/** 按 UTF-16 安全切片（不切半个代理对，否则会出现孤立代理项）。 */
function ttsSafeSlice(str, max) {
  if (str.length <= max) return str;
  let end = max;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

/** 裁掉空白后的句子（带原文偏移，供高亮定位）。 */
function ttsTrimSpan(raw, start, end) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(raw[from])) from += 1;
  while (to > from && /\s/.test(raw[to - 1])) to -= 1;
  if (to <= from) return null;
  return { text: raw.slice(from, to), start: from, end: to };
}

/**
 * 按句末标点成句（带原文偏移）。切块与高亮都只认这一个句界，不会出现
 * 「念的是这句、高亮的是那句」。
 * @param {string} raw 已做换行归一化的文本
 * @returns {{ text: string, start: number, end: number }[]}
 */
function ttsSentenceSpans(raw) {
  const spans = [];
  let bufStart = 0;
  let inBuf = false;
  for (let i = 0; i < raw.length; i += 1) {
    if (!inBuf) {
      bufStart = i;
      inBuf = true;
    }
    if (TTS_CHUNK_BREAK.includes(raw[i])) {
      const span = ttsTrimSpan(raw, bufStart, i + 1);
      if (span) spans.push(span);
      inBuf = false;
    }
  }
  if (inBuf) {
    const span = ttsTrimSpan(raw, bufStart, raw.length);
    if (span) spans.push(span);
  }
  return spans;
}

/**
 * 把可朗读文本切成播放块，并报出每块覆盖原文的哪一段、由哪几句组成。
 *
 * 先按句末标点成句，再把短句合并到 TTS_CHUNK_TARGET；单句超长时按上限硬切。
 * 拼接结果与原文只差空白（不丢内容 —— 少念一句比念错更难发现）。
 *
 * 块是为了「合成延迟」而合并的，用户要看的是**句**：`sentences` 记下这块由哪几句
 * 拼成，播放时按音频进度把高亮在句之间推进（见 `playTtsText`）。
 *
 * `start/end` 是字面偏移（不含首尾空白）：正常块 = 首句起点到末句终点；
 * 硬切出来的块仍指回它所在的那一句（同一句被切成几口，高亮看不出差别）。
 *
 * @param {string} text
 * @returns {{ text: string, start: number, end: number, sentences: { start: number, end: number }[] }[]}
 */
function splitTtsChunksDetailed(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!raw.trim()) return [];
  const chunks = [];
  /** @type {{ text: string, start: number, end: number, sentences: { start: number, end: number }[] }|null} */
  let cur = null;
  const flush = () => {
    const body = cur && cur.text.trim();
    if (body) chunks.push({ text: body, start: cur.start, end: cur.end, sentences: cur.sentences });
    cur = null;
  };
  for (const sentence of ttsSentenceSpans(raw)) {
    const span = { start: sentence.start, end: sentence.end };
    if (cur && cur.text.length + sentence.text.length > TTS_CHUNK_TARGET) flush();
    if (!cur) {
      cur = { text: sentence.text, start: sentence.start, end: sentence.end, sentences: [span] };
    } else {
      cur.text += sentence.text;
      cur.end = sentence.end;
      cur.sentences.push(span);
    }
    while (cur.text.length > TTS_CHUNK_MAX) {
      const head = ttsSafeSlice(cur.text, TTS_CHUNK_MAX);
      const body = head.trim();
      if (body) chunks.push({ text: body, start: cur.start, end: cur.end, sentences: cur.sentences.slice() });
      cur.text = cur.text.slice(head.length);
      // 切剩的部分在同一句里：进度与高亮都按这一句算
      cur.start = sentence.start;
      cur.end = sentence.end;
      cur.sentences = [span];
    }
    if (!cur.text.trim()) cur = null;
  }
  flush();
  return chunks;
}

/**
 * 把可朗读文本切成播放块（只要文本）。
 * 切块规则与偏移的唯一实现在 `splitTtsChunksDetailed`。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTtsChunks(text) {
  return splitTtsChunksDetailed(text).map((chunk) => chunk.text);
}

/** CSS Custom Highlight 名字（样式在 styles.css 的 `::highlight(tts-reading)`）。 */
const TTS_HIGHLIGHT_NAME = 'tts-reading';

function ttsHighlightSupported() {
  return (
    typeof CSS !== 'undefined' &&
    !!CSS &&
    !!CSS.highlights &&
    typeof window !== 'undefined' &&
    typeof window.Highlight === 'function'
  );
}

/**
 * 文本偏移 → DOM Range（一块可能横跨多个文本节点，也可能只覆盖某句的一部分）。
 * @param {typeof ttsReadMap} map
 */
function ttsRangesForSpan(map, start, end) {
  if (!map || typeof document === 'undefined' || typeof document.createRange !== 'function') return [];
  const from = start + map.shift;
  const to = end + map.shift;
  const out = [];
  for (const part of map.parts) {
    const a = Math.max(from, part.start);
    const b = Math.min(to, part.end);
    if (b <= a) continue;
    try {
      const range = document.createRange();
      range.setStart(part.node, a - part.start);
      range.setEnd(part.node, b - part.start);
      out.push(range);
    } catch {
      // 节点已脱离文档（整篇重渲染）：这一块不留高亮，重渲染后的重新认领会重算
    }
  }
  return out;
}

/** 念到看不见的位置时把这一句带进视野（本来就看得到就不动，不抢用户的滚动）。 */
function ttsScrollRangeIntoView(range) {
  const host = typeof chatList !== 'undefined' ? chatList : null;
  if (!host || typeof host.getBoundingClientRect !== 'function') return;
  if (!range || typeof range.getBoundingClientRect !== 'function') return;
  const rect = range.getBoundingClientRect();
  if (!rect.height && !rect.width) return;
  const box = host.getBoundingClientRect();
  if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 8) return;
  const delta = rect.top - box.top - box.height / 2 + rect.height / 2;
  try {
    host.scrollTo({ top: Math.max(0, host.scrollTop + delta), behavior: 'smooth' });
  } catch {
    // ignore：老滚动容器 / 元素已失效
  }
}

/**
 * 把高亮落在「正在念的这一句」上；没有映射或不支持 Highlight API 时清掉（朗读不受影响）。
 * @param {{ start: number, end: number }|null} span
 */
function markTtsReadingSpan(span) {
  if (!ttsHighlightSupported()) return;
  const ranges = span ? ttsRangesForSpan(ttsReadMap, span.start, span.end) : [];
  if (!ranges.length) {
    CSS.highlights.delete(TTS_HIGHLIGHT_NAME);
    return;
  }
  CSS.highlights.set(TTS_HIGHLIGHT_NAME, new window.Highlight(...ranges));
  ttsScrollRangeIntoView(ranges[0]);
}

function clearTtsReadingMark() {
  if (typeof CSS !== 'undefined' && CSS && CSS.highlights && CSS.highlights.delete) {
    CSS.highlights.delete(TTS_HIGHLIGHT_NAME);
  }
}

/**
 * 一块之内按音频进度在句子之间推进高亮。
 *
 * 块是为了合成延迟才把几句合并起来的，念的时候是连续的：用 `currentTime / duration`
 * 按字数加权落到具体的句子上（不需要服务器给时间戳）。拿不到 duration 时退回整块高亮。
 *
 * @param {{ sentences: { start: number, end: number }[], start: number, end: number }} chunk
 * @returns {{ show: (ratio: number) => void, current: () => { start: number, end: number } }}
 */
function ttsSentenceCursor(chunk) {
  const spans = chunk && chunk.sentences && chunk.sentences.length
    ? chunk.sentences
    : [{ start: chunk.start, end: chunk.end }];
  const weights = spans.map((span) => Math.max(1, span.end - span.start));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let index = -1;
  const pick = (ratio) => {
    const target = Math.max(0, Math.min(1, ratio)) * total;
    let acc = 0;
    for (let i = 0; i < spans.length; i += 1) {
      acc += weights[i];
      if (target < acc) return i;
    }
    return spans.length - 1;
  };
  return {
    show(ratio) {
      const next = pick(ratio);
      if (next === index) return;
      index = next;
      ttsReadChunkSentence = next;
      markTtsReadingSpan(spans[next]);
    },
    current: () => spans[Math.max(0, index)]
  };
}

/** 合成一块，返回可直接播放的 Blob URL。 */
async function ttsFetchChunkUrl(chunkText, cfg, token) {
  const res = await gatewayCall('speech.synthesize', {
    text: chunkText,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    voice: cfg.voice,
    format: cfg.format,
    headers: cfg.headers,
    authMode: cfg.authMode,
    userAgent: cfg.userAgent,
    sessionId: typeof currentSessionId !== 'undefined' ? currentSessionId : undefined
  });
  if (token !== ttsToken) return null;
  const audioBase64 = String(res?.audioBase64 || '');
  if (!audioBase64) throw new Error(ttsMsg('tts_empty_audio', '合成结果为空'));
  // base64 → 字节：复用 renderer-artifacts.js 的全局实现（勿再写一份）
  const blob = new Blob([base64ToUint8Array(audioBase64)], {
    type: String(res?.mimeType || 'audio/mpeg')
  });
  const url = URL.createObjectURL(blob);
  ttsUrls.add(url);
  return url;
}

/**
 * 播一块，等到播完（或被停止 / 出错）才 resolve。
 * 停止时 `teardownTtsPlayer` 会调 `ttsSettleCurrentChunk` 让这里结算，不悬挂。
 *
 * @param {string} url
 * @param {(ratio: number) => void} [onProgress] 播放进度（0~1），用来推进句级高亮
 */
function ttsPlayChunkUrl(url, onProgress) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    ttsAudioEl = audio;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (ttsSettleCurrentChunk === settle) ttsSettleCurrentChunk = null;
      if (ttsAudioEl === audio) ttsAudioEl = null;
      if (err) reject(err);
      else resolve();
    };
    ttsSettleCurrentChunk = () => settle(null);
    audio.addEventListener('ended', () => settle(null));
    audio.addEventListener('error', () => {
      const code = audio.error ? audio.error.code : 0;
      const detail = audio.error && audio.error.message ? `：${audio.error.message}` : '';
      const err = new Error(
        ttsMsg('tts_audio_error', '音频无法播放（code %s）').replace('%s', String(code)) + detail
      );
      settle(err);
    });
    if (typeof onProgress === 'function') {
      audio.addEventListener('timeupdate', () => {
        const total = audio.duration;
        if (!Number.isFinite(total) || total <= 0) return;
        onProgress(Math.min(1, audio.currentTime / total));
      });
    }
    const started = audio.play();
    if (started && typeof started.catch === 'function') started.catch((err) => settle(err));
  });
}

/**
 * 合成并播放一段文本：**分块 + 边播边合成下一块**。
 * @param {string} text
 * @param {HTMLButtonElement} [btn]
 * @param {HTMLElement} [bubble] 这条回复的气泡：给了才知道该高亮正文里的哪一句
 */
async function playTtsText(text, btn, bubble) {
  const content = String(text || '').trim();
  if (!content) {
    if (typeof showAgentToast === 'function') {
      showAgentToast(ttsMsg('tts_fail_title', '朗读失败'), ttsMsg('tts_empty_text', '没有可朗读的文本'), {
        variant: 'error'
      });
    }
    return;
  }
  const cfg = ttsConfigFromSettings();
  if (!cfg) {
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        ttsMsg('tts_no_model_title', '未配置朗读模型'),
        ttsMsg('tts_no_model_hint', '在设置 → 模型里添加一个「语音合成」类型的模型'),
        { variant: 'error' }
      );
    }
    return;
  }
  // 不用 ttsPending 挡住第二次点击：用户点另一条回复的「朗读」应当**切歌**
  // （作废旧请求、立刻开始新的），而不是毫无反应。
  const token = ++ttsToken;
  ttsPending = true;
  ttsFailureNotified = false;
  teardownTtsPlayer();
  // 合成期间也把它认成「当前按钮」：这样点它就能中止（按钮显示的是「停止」）
  ttsActiveBtn = btn || null;
  ttsPlayingText = content;
  setTtsBtnState(ttsActiveBtn, true);

  // 「正在念哪一句」的现场：同一个文本里出切块偏移，映射也必须来自这份文本
  // （对不上就宁可不高亮 —— 错位高亮比没有高亮更难发现）
  const map = bubble ? ttsTextMapOf(ttsAnswerElOf(bubble)) : null;
  ttsReadMap = map && map.text === content ? map : null;
  if (map && !ttsReadMap) {
    // 不静默降级：正文与朗读文本对不上就标不出位置，留一句可排查的日志（朗读照常）
    console.warn('[tts] 逐句高亮不可用：朗读文本与正文 DOM 不一致，本次只朗读、不标位置');
  }

  const chunks = splitTtsChunksDetailed(content);
  ttsReadChunks = chunks;
  ttsReadChunkIndex = -1;
  ttsReadChunkSentence = -1;
  /** 已发出的块：index → Promise<url|null>，用来「播一块、预取下一块」 */
  const inflight = new Map();
  const startChunk = (index) => {
    if (index >= chunks.length) return null;
    if (!inflight.has(index)) {
      const p = ttsFetchChunkUrl(chunks[index].text, cfg, token);
      // 预取的块失败不该变成 unhandled rejection：真错会在 await 处抛出
      p.catch(() => {});
      inflight.set(index, p);
    }
    return inflight.get(index);
  };

  try {
    startChunk(0); // 立刻开始合成第一块（不等播放）
    for (let index = 0; index < chunks.length; index += 1) {
      const url = await startChunk(index);
      if (token !== ttsToken) return;
      // 期间被整篇重渲染过：把「停止」接回新按钮
      if (!ttsActiveBtn || ttsActiveBtn.isConnected === false) ttsActiveBtn = btn || null;
      if (ttsActiveBtn) setTtsBtnState(ttsActiveBtn, true);
      startChunk(index + 1); // 边播边合成下一块
      if (!url) continue;
      // 出声的同时把高亮挪到这一句（合成等待期间不挪，避免「还没念就跳过去」）：
      // 一块里有好几句，先亮第一句，之后按音频进度在句之间推进
      ttsReadChunkIndex = index;
      const cursor = ttsSentenceCursor(chunks[index]);
      cursor.show(0);
      await ttsPlayChunkUrl(url, (ratio) => {
        if (token !== ttsToken) return;
        cursor.show(ratio);
      });
      if (token !== ttsToken) return;
    }
  } catch (err) {
    // 过期的失败不打扰用户（他可能已经点了停止）
    if (token !== ttsToken) return;
    teardownTtsPlayer();
    notifyTtsFailure(err?.message || String(err));
    return;
  } finally {
    if (token === ttsToken) ttsPending = false;
  }
  // 全部念完：收尾（按钮回到「朗读」、URL 全部回收）
  if (token === ttsToken) stopTtsPlayback();
}

/**
 * 给一个助手气泡挂「朗读」按钮（气泡的**兄弟节点** —— 气泡内部在流式/重渲染时会被
 * `replaceChildren` 清空，挂在里面会被一起抹掉）。
 *
 * @param {HTMLElement} bubble
 * @returns {HTMLElement|null} 挂上的操作条；未配置朗读模型时返回 null
 */
function attachTtsBarToBubble(bubble) {
  if (!bubble || !bubble.parentNode || !ttsAvailable()) return null;
  // 幂等：历史渲染与「本轮跑完」两条路都可能挂，重复插入会长出第二个按钮
  const existing = bubble.nextElementSibling;
  if (existing && existing.classList && existing.classList.contains('msg-tts-bar')) {
    return existing;
  }
  const bar = document.createElement('div');
  bar.className = 'msg-tts-bar';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-tts-btn';
  btn.setAttribute('aria-pressed', 'false');
  btn.title = ttsMsg('tts_btn_title', '朗读这条回复');
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>' +
    `<span class="msg-tts-label">${ttsMsg('tts_read', '朗读')}</span>`;
  btn.addEventListener('click', () => {
    if (ttsActiveBtn === btn) {
      stopTtsPlayback();
      setTtsBtnState(btn, false);
      return;
    }
    const text = ttsTextOfBubble(bubble);
    if (!text) {
      if (typeof showAgentToast === 'function') {
        showAgentToast(ttsMsg('tts_fail_title', '朗读失败'), ttsMsg('tts_empty_bubble', '这条回复没有可朗读的文本'), {
          variant: 'error'
        });
      }
      return;
    }
    void playTtsText(text, btn, bubble);
  });
  bar.appendChild(btn);
  bubble.parentNode.insertBefore(bar, bubble.nextSibling);
  // 整篇重渲染（每轮结束、切主题、切会话都会重建气泡）之后，正在播的那条要能拿回
  // 「停止」：旧按钮已经脱离 DOM，按正文认领，只有旧按钮失效时才认领（同文两条不抢）。
  const staleBtn = !ttsActiveBtn || ttsActiveBtn.isConnected === false;
  if (
    staleBtn &&
    ttsPlayingText &&
    (ttsAudioEl || ttsPending) &&
    ttsTextOfBubble(bubble) === ttsPlayingText
  ) {
    ttsActiveBtn = btn;
    setTtsBtnState(btn, true);
    // 重渲染换了整棵 DOM：旧 Range 全部失效，映射与高亮按新节点重算一次
    const map = ttsTextMapOf(ttsAnswerElOf(bubble));
    ttsReadMap = map && map.text === ttsPlayingText ? map : null;
    const chunk = ttsReadChunks[ttsReadChunkIndex];
    const sentences = chunk ? chunk.sentences || [] : [];
    markTtsReadingSpan(sentences[ttsReadChunkSentence] || (chunk ? { start: chunk.start, end: chunk.end } : null));
  }
  return bar;
}

/**
 * 自动朗读（设置里的 `ttsAutoRead`）的**唯一入口**。
 *
 * 调用点只有一个：`renderer-chat-live-run.js#dispatchAgentRunEvent` 收到 DONE 事件、
 * 气泡已被渲染成终态的那一拍。历史渲染、流式中间态、ERROR / STOPPED / 轮次上限、
 * 以及后台会话都不触发 —— 否则切会话会念旧回复，或者把「已停止生成」念出来。
 *
 * （别挂到 `finalizeAssistantBubble`：正常完成走事件路径，那个函数只被中断/失败用到。）
 *
 * @param {HTMLElement} bubble 已完成的助手气泡
 * @param {{ error?: boolean, stopped?: boolean, hitRoundLimit?: boolean }} [opts]
 * @returns {boolean} 是否真的开始朗读
 */
function maybeAutoReadAssistantBubble(bubble, opts = {}) {
  if (!bubble) return false;
  if (opts.error || opts.stopped || opts.hitRoundLimit) return false;
  const s = typeof settings !== 'undefined' && settings ? settings : {};
  if (s.ttsAutoRead !== true) return false;
  if (!ttsAvailable()) return false;
  const text = ttsTextOfBubble(bubble);
  if (!text) return false;
  if (ttsPending) return false;
  const btn = bubble.nextElementSibling?.querySelector?.('.msg-tts-btn') || null;
  void playTtsText(text, btn, bubble);
  return true;
}

window.ttsAvailable = ttsAvailable;
window.stopTtsPlayback = stopTtsPlayback;
window.playTtsText = playTtsText;
window.attachTtsBarToBubble = attachTtsBarToBubble;
window.maybeAutoReadAssistantBubble = maybeAutoReadAssistantBubble;

// 切界面语言：操作条的「朗读/停止」是 JS 生成的（不走 data-i18n），这里自己刷一遍；
// 设置页的自动朗读说明文案也是状态相关的，一并重算。
if (typeof window.addEventListener === 'function') {
  window.addEventListener('dieyun:language-change', () => {
    document.querySelectorAll('.msg-tts-btn').forEach((btn) => {
      setTtsBtnState(btn, btn.classList.contains('is-speaking'));
    });
    if (typeof syncTtsAutoReadControl === 'function') {
      syncTtsAutoReadControl(typeof settings !== 'undefined' ? settings : {});
    }
  });
}
