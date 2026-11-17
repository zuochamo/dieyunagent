/* global window, document, $, chatList, markChatUserScrollIntent, setChatAutoFollow, CHAT_AUTO_SCROLL_THRESHOLD */
'use strict';

/**
 * 消息导航：聊天区右缘的刻度带。
 *
 * **一格 = 一轮对话**（你开口那一下 + 它的回复；定时 / 目标续跑那种非人类触发的一轮用触发条），
 * 不是一条消息 —— 条数减半、每根信息更有用，而且和「往上翻页按轮次开头对齐」是同一套语义。
 *
 * 单一来源：刻度全部来自 `#chat-list` 的已渲染 DOM，不另存消息索引或轮次表。
 * 单一状态：`chatNavItems` 一份数组（刻度元素 ↔ 它指向的锚点元素），没有第二份平行索引。
 *
 * 排布：固定间距 10px，不压缩；**装得下整列居中，装不下改成贴底**（细轨内部滚，滚到底 = 最新一轮）。
 * 贴底之后「往上翻一页」只会在整列上方长出新刻度，已有刻度离底的距离不变 —— 一根都不动。
 *
 * 高亮：对视口顶部那一轮做**二分**（DOM 顺序天然单调），每帧约 log₂N 次 rect 读；
 * 排布本身是纯算术（条数 → 间距/内边距/top），不读布局。旧版那份 N 长的偏移表已删除。
 */

var CHAT_NAV_TICK_PITCH = 10;
var CHAT_NAV_TICK_HEIGHT = 2;
var CHAT_NAV_MIN_COUNT = 2;
var CHAT_NAV_REBUILD_MS = 160;
var CHAT_NAV_JUMP_MARGIN = 12;
var CHAT_NAV_ACTIVE_TOL = 1;
var CHAT_NAV_EXCERPT_MAX = 96;

/** @type {HTMLElement|null} */
var chatNavRail = null;
/** @type {HTMLElement|null} 轨道内部的滚动层（刻度多了以后由它滚，永远贴底） */
var chatNavScroller = null;
/** @type {HTMLElement|null} 整列容器（高度 = 整列长度） */
var chatNavTrack = null;
/** @type {{ el: HTMLElement, anchorEl: HTMLElement, role: string }[]} 刻度 ↔ 它指向的轮次锚点 */
var chatNavItems = [];
/** 轨道可视高度（由 ResizeObserver 维护，排布时不再读布局） */
var chatNavRailHeight = 0;
var chatNavPitch = CHAT_NAV_TICK_PITCH;
var chatNavPadTop = 0;
/** @type {HTMLElement|null} */
var chatNavTip = null;
/** @type {HTMLElement|null} */
var chatNavTipMeta = null;
/** @type {HTMLElement|null} */
var chatNavTipText = null;
var chatNavBuildTimer = null;
var chatNavFrame = null;
var chatNavPointerInside = false;
var chatNavPendingBuild = false;
var chatNavScrollBound = false;

function chatNavRoleLabel(role) {
  if (role === 'user') return '你';
  if (role === 'system') return '系统';
  return 'Agent';
}

/** 锚点可见文本（助手气泡优先取正文，别把思考区文本当摘要） */
function chatNavAnchorText(el) {
  if (!el) return '';
  const answer = el.querySelector('.msg-answer');
  const raw = (answer ? answer.textContent : el.textContent) || '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function chatNavExcerpt(text) {
  const t = String(text || '');
  return t.length <= CHAT_NAV_EXCERPT_MAX ? t : `${t.slice(0, CHAT_NAV_EXCERPT_MAX)}…`;
}

/**
 * 一轮对话的落点（按 DOM 顺序，唯一来源）。
 *
 * 真实结构只有三种顶层节点（见 renderer-chat-bubbles.js / renderer-chat-render.js）：
 * - `.msg-turn` → 里面的 `.msg.user`（你开口的一轮）
 * - `.msg-turn.msg-turn-trigger` → 里面的 `.msg-trigger`（定时 / 目标续跑等非人类触发的一轮）
 * - 直接挂的 `.msg` 助手气泡：通常是上面那一轮的收尾，**不另算一轮**；
 *   只有窗口第一屏就从它开始时，才需要给它一个落点（否则这一屏最上面那几条没有刻度可点）。
 * 其余（`.history-empty` 占位、加载失败文本、刻度带自己）不算。
 */
function collectChatTurnAnchors() {
  if (!chatList) return [];
  const out = [];
  for (const node of chatList.children) {
    if (!node || !node.classList) continue;
    if (node.classList.contains('msg-turn')) {
      const userBubble = node.querySelector('.msg.user');
      if (userBubble) {
        out.push({ el: userBubble, role: 'user' });
        continue;
      }
      const triggerBar = node.querySelector('.msg-trigger');
      if (triggerBar) out.push({ el: triggerBar, role: 'system' });
      continue;
    }
    if (!node.classList.contains('msg')) continue;
    if (out.length) continue;
    out.push({
      el: node,
      role: node.classList.contains('user') ? 'user' : node.classList.contains('assistant') ? 'assistant' : 'system'
    });
  }
  return out;
}

function sameChatNavAnchors(next) {
  if (next.length !== chatNavItems.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (next[i].el !== chatNavItems[i].anchorEl) return false;
  }
  return true;
}

/**
 * 刻度带的几何：固定间距；**装得下就整列居中，装不下就贴底**。
 *
 * 间距恒定（不压缩）：压缩会按条数重算每一根的位置，加载更早时看着就是「整列跳一下」。
 * 贴底（装不下之后）：往上翻一页是在整列上方加刻度，已有刻度**离底的距离**只跟它后面还有几轮有关，
 * 跟前面又加了多少轮无关 —— 一根都不再动。
 * @param {number} count 刻度条数
 * @param {number} railHeight 轨道（可视带）高度
 * @returns {{ pitch: number, columnHeight: number, padTop: number, trackHeight: number }}
 */
function chatNavLadder(count, railHeight) {
  const pitch = CHAT_NAV_TICK_PITCH;
  const columnHeight =
    count > 1 ? (count - 1) * pitch + CHAT_NAV_TICK_HEIGHT : CHAT_NAV_TICK_HEIGHT;
  const padTop = columnHeight <= railHeight ? Math.max(0, (railHeight - columnHeight) / 2) : 0;
  return { pitch, columnHeight, padTop, trackHeight: Math.max(railHeight, columnHeight) };
}

/** 轨道内部的滚动层与整列容器（只建一次） */
function ensureChatNavTrack() {
  if (!chatNavRail) return;
  if (chatNavScroller && chatNavTrack) return;
  chatNavScroller = document.createElement('div');
  chatNavScroller.className = 'chat-nav-scroller';
  chatNavTrack = document.createElement('div');
  chatNavTrack.className = 'chat-nav-track';
  chatNavScroller.appendChild(chatNavTrack);
  chatNavRail.appendChild(chatNavScroller);
}

function clearChatNavTicks() {
  for (const item of chatNavItems) item.el.remove();
  chatNavItems = [];
  if (chatNavTrack) chatNavTrack.style.height = '';
  hideChatNavTip();
}

function setChatNavEmpty(empty) {
  if (!chatNavRail) return;
  chatNavRail.classList.toggle('is-empty', !!empty);
  chatNavRail.setAttribute('aria-hidden', empty ? 'true' : 'false');
  if (empty) clearChatNavTicks();
}

function buildChatNav() {
  chatNavBuildTimer = null;
  if (!chatNavRail) return;
  ensureChatNavTrack();
  const anchors = collectChatTurnAnchors();
  if (anchors.length < CHAT_NAV_MIN_COUNT) {
    setChatNavEmpty(true);
    return;
  }
  setChatNavEmpty(false);
  if (sameChatNavAnchors(anchors)) {
    layoutChatNav();
    return;
  }
  // 悬停期间重建会把用户正指着的刻度换掉，等指针离开再补
  if (chatNavPointerInside && chatNavItems.length) {
    chatNavPendingBuild = true;
    return;
  }
  chatNavPendingBuild = false;

  clearChatNavTicks();
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-nav-tick';
    btn.setAttribute('aria-label', `跳转到第 ${i + 1} 轮（${chatNavRoleLabel(anchor.role)}）`);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToChatNavTick(i);
    });
    btn.addEventListener('mouseenter', () => showChatNavTip(btn, i));
    btn.addEventListener('mouseleave', hideChatNavTip);
    btn.addEventListener('focus', () => showChatNavTip(btn, i));
    btn.addEventListener('blur', hideChatNavTip);
    if (chatNavTrack) chatNavTrack.appendChild(btn);
    chatNavItems.push({ el: btn, anchorEl: anchor.el, role: anchor.role });
  }
  layoutChatNav();
}

/** 纯算术排布：条数 → 间距 / 内边距 / 每根的 top；不读布局，值没变就不写 */
function layoutChatNav() {
  if (!chatNavRail || !chatNavTrack || !chatNavItems.length) return;
  if (chatNavRail.classList.contains('is-empty')) return;
  const count = chatNavItems.length;
  const { pitch, padTop, trackHeight } = chatNavLadder(count, chatNavRailHeight);
  chatNavPitch = pitch;
  chatNavPadTop = padTop;
  const heightCss = `${trackHeight}px`;
  if (chatNavTrack.style.height !== heightCss) chatNavTrack.style.height = heightCss;
  const hit = `${Math.max(0, (pitch - CHAT_NAV_TICK_HEIGHT) / 2)}px`;
  if (chatNavRail.style.getPropertyValue('--chat-nav-hit') !== hit) {
    chatNavRail.style.setProperty('--chat-nav-hit', hit);
  }
  for (let i = 0; i < count; i += 1) {
    const top = `${Math.round(padTop + i * pitch)}px`;
    const el = chatNavItems[i].el;
    if (el.style.top !== top) el.style.top = top;
  }
  // 装得下：居中、不会滚；装不下：贴底（滚到最底 = 最新一轮）
  if (chatNavScroller) chatNavScroller.scrollTop = Math.max(0, trackHeight - chatNavRailHeight);
  updateChatNavActive();
}

/**
 * 高亮 = 「视口顶部那一轮」；已经在最底部时就是最新一轮。
 *
 * 锚点按 DOM 顺序排，位置天然单调，所以二分即可 —— 不必像以前那样维护一张 N 长的偏移表、
 * 每次都把 N 根重量一遍（流式回答时那是每 160ms 一轮全量强制布局）。
 * 容差 1px：滚动位置按设备像素取整，跳转落地时可能差零点几像素，严格 `<=` 会把刚跳到的那轮判成上一轮。
 */
function updateChatNavActive() {
  if (!chatList || !chatNavItems.length) return;
  const listRect = chatList.getBoundingClientRect();
  const scrollTop = chatList.scrollTop;
  const maxTop = Math.max(0, chatList.scrollHeight - chatList.clientHeight);
  let active = 0;
  if (maxTop - scrollTop <= CHAT_NAV_ACTIVE_TOL) {
    active = chatNavItems.length - 1;
  } else {
    const limit = CHAT_NAV_JUMP_MARGIN + CHAT_NAV_ACTIVE_TOL;
    let lo = 0;
    let hi = chatNavItems.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const anchor = chatNavItems[mid].anchorEl;
      const top = anchor.isConnected ? anchor.getBoundingClientRect().top - listRect.top : Number.POSITIVE_INFINITY;
      if (top <= limit) {
        active = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }
  for (let i = 0; i < chatNavItems.length; i += 1) {
    const btn = chatNavItems[i].el;
    const isActive = i === active;
    if (btn.classList.contains('is-active') !== isActive) btn.classList.toggle('is-active', isActive);
  }
}

function chatNavJumpTarget(index) {
  if (!chatList) return null;
  const item = chatNavItems[index];
  const el = item && item.anchorEl;
  if (!el || !el.isConnected) return null;
  const listRect = chatList.getBoundingClientRect();
  const offsetTop = el.getBoundingClientRect().top - listRect.top + chatList.scrollTop;
  const maxTop = Math.max(0, chatList.scrollHeight - chatList.clientHeight);
  return Math.max(0, Math.min(maxTop, offsetTop - CHAT_NAV_JUMP_MARGIN));
}

function jumpToChatNavTick(index) {
  const top = chatNavJumpTarget(index);
  if (top == null) return;
  // 交回既有滚动机制：标记为用户主动接管，别让流式贴底把视口抢回去
  if (typeof markChatUserScrollIntent === 'function') markChatUserScrollIntent();
  if (typeof setChatAutoFollow === 'function') {
    const list = chatList;
    const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
    const threshold = typeof CHAT_AUTO_SCROLL_THRESHOLD === 'number' ? CHAT_AUTO_SCROLL_THRESHOLD : 72;
    setChatAutoFollow(maxTop - top <= threshold);
  }
  chatList.scrollTo({ top, behavior: 'smooth' });
  hideChatNavTip();
}

function ensureChatNavTip() {
  if (chatNavTip || !chatNavRail) return chatNavTip;
  chatNavTip = document.createElement('div');
  chatNavTip.className = 'chat-nav-tip';
  chatNavTip.setAttribute('role', 'tooltip');
  chatNavTip.hidden = true;
  chatNavTipMeta = document.createElement('div');
  chatNavTipMeta.className = 'chat-nav-tip-meta';
  chatNavTipText = document.createElement('div');
  chatNavTipText.className = 'chat-nav-tip-text';
  chatNavTip.appendChild(chatNavTipMeta);
  chatNavTip.appendChild(chatNavTipText);
  chatNavRail.appendChild(chatNavTip);
  return chatNavTip;
}

function showChatNavTip(btn, index) {
  const item = chatNavItems[index];
  const tip = ensureChatNavTip();
  if (!tip || !item || !chatNavRail) return;
  chatNavTipMeta.textContent = `${chatNavRoleLabel(item.role)} · 第 ${index + 1} 轮`;
  chatNavTipText.textContent = chatNavExcerpt(chatNavAnchorText(item.anchorEl)) || '（空消息）';
  tip.hidden = false;
  const railHeight = chatNavRailHeight || chatNavRail.clientHeight;
  const tipHeight = tip.offsetHeight;
  const scrollOffset = chatNavScroller ? chatNavScroller.scrollTop : 0;
  // 位置直接算：不用反解析 style.top
  const tickTop = chatNavPadTop + index * chatNavPitch - scrollOffset;
  const half = Math.min(tipHeight / 2, railHeight / 2);
  const center = tickTop + CHAT_NAV_TICK_HEIGHT / 2;
  const top = Math.min(Math.max(center, half + 4), Math.max(half + 4, railHeight - half - 4));
  tip.style.top = `${Math.round(top)}px`;
}

function hideChatNavTip() {
  if (!chatNavTip) return;
  chatNavTip.hidden = true;
}

function scheduleChatNavBuild() {
  if (chatNavBuildTimer) return;
  chatNavBuildTimer = setTimeout(buildChatNav, CHAT_NAV_REBUILD_MS);
}

/** 滚动只换高亮（二分），不重量位置；量位置只由「内容/轨道结构变了」触发 */
function scheduleChatNavActive() {
  if (chatNavFrame) return;
  chatNavFrame = requestAnimationFrame(() => {
    chatNavFrame = null;
    updateChatNavActive();
  });
}

function initChatNav() {
  if (chatNavRail || typeof document === 'undefined') {
    scheduleChatNavBuild();
    return;
  }
  chatNavRail = $('chat-nav');
  if (!chatNavRail) return;
  chatNavRailHeight = chatNavRail.clientHeight;
  ensureChatNavTrack();
  ensureChatNavTip();
  chatNavRail.addEventListener('pointerenter', () => {
    chatNavPointerInside = true;
  });
  chatNavRail.addEventListener('pointerleave', () => {
    chatNavPointerInside = false;
    hideChatNavTip();
    if (chatNavPendingBuild) scheduleChatNavBuild();
  });
  if (chatList) {
    if (!chatNavScrollBound) {
      chatNavScrollBound = true;
      chatList.addEventListener('scroll', scheduleChatNavActive, { passive: true });
    }
    // 只在结构变化时重建。流式改文本不改变刻度集合（摘要文本 hover 时才取），
    // 所以不再监听 characterData —— 那会让流式期间每 160ms 无谓地重建一遍。
    new MutationObserver(() => scheduleChatNavBuild()).observe(chatList, {
      childList: true,
      subtree: true
    });
  }
  // 轨道尺寸变了（窗口缩放 / 拖输入框 / 面板开合）→ 更新缓存高度并重排
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!chatNavRail) return;
      chatNavRailHeight = chatNavRail.clientHeight;
      scheduleChatNavBuild();
    }).observe(chatNavRail);
  }
  buildChatNav();
}

window.initChatNav = initChatNav;
