/* global window, document, settings, currentSessionId, gatewayCall, showAgentToast, base64ToUint8Array, uiText, syncTtsAutoReadControl */
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

/** 气泡里「这条回复的正文」：优先取渲染时留下的原文（渲染成 HTML 后 textContent 会丢结构）。 */
function ttsTextOfBubble(bubble) {
  if (!bubble) return '';
  const answer = bubble.querySelector ? bubble.querySelector('.msg-answer') : null;
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

/**
 * 把可朗读文本切成播放块。
 *
 * 先按句末标点成句，再把短句合并到 TTS_CHUNK_TARGET；单句超长时按上限硬切。
 * 拼接结果与原文只差空白（不丢内容 —— 少念一句比念错更难发现）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTtsChunks(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!raw.trim()) return [];
  const sentences = [];
  let buf = '';
  for (const ch of raw) {
    buf += ch;
    if (TTS_CHUNK_BREAK.includes(ch)) {
      if (buf.trim()) sentences.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) sentences.push(buf.trim());

  const chunks = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = '';
  };
  for (const sentence of sentences) {
    if (cur && cur.length + sentence.length > TTS_CHUNK_TARGET) flush();
    cur += sentence;
    while (cur.length > TTS_CHUNK_MAX) {
      const head = ttsSafeSlice(cur, TTS_CHUNK_MAX);
      chunks.push(head.trim());
      cur = cur.slice(head.length);
    }
  }
  flush();
  return chunks;
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
 */
function ttsPlayChunkUrl(url) {
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
    const started = audio.play();
    if (started && typeof started.catch === 'function') started.catch((err) => settle(err));
  });
}

/**
 * 合成并播放一段文本：**分块 + 边播边合成下一块**。
 * @param {string} text
 * @param {HTMLButtonElement} [btn]
 */
async function playTtsText(text, btn) {
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

  const chunks = splitTtsChunks(content);
  /** 已发出的块：index → Promise<url|null>，用来「播一块、预取下一块」 */
  const inflight = new Map();
  const startChunk = (index) => {
    if (index >= chunks.length) return null;
    if (!inflight.has(index)) {
      const p = ttsFetchChunkUrl(chunks[index], cfg, token);
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
      await ttsPlayChunkUrl(url);
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
    void playTtsText(text, btn);
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
  void playTtsText(text, btn);
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
