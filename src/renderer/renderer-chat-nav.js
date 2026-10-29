/* global window, document, $, chatList, markChatUserScrollIntent, setChatAutoFollow, CHAT_AUTO_SCROLL_THRESHOLD */
'use strict';

/**
 * 消息导航：聊天区右缘的刻度带（每条消息一根短刻度，当前视口顶部那条变白加宽）。
 *
 * 单一来源：刻度不另存一份「消息索引」，全部来自 #chat-list 的已渲染 DOM
 * （`.msg-turn` 里的 `.msg.user`、直接挂载的 `.msg` 气泡）。消息增删由
 * MutationObserver 触发重建；滚动只换高亮（用缓存偏移），因此流式输出时
 * 也不会反复重建刻度。
 *
 * 排布模型：像 DSH 那样排成**紧凑等距一列**，不按内容比例拉伸 ——
 * 固定 10px 间距、整体在轨道里垂直居中；消息多到一列放不下时整体等比压缩
 * （间距下限 3px）；再放不下就按连续区间分组（一格代表一段消息），
 * 保证任何长度的会话都只有一列、都能导航。
 */

var CHAT_NAV_TICK_PITCH = 10;
var CHAT_NAV_MIN_PITCH = 3;
var CHAT_NAV_TICK_HEIGHT = 2;
var CHAT_NAV_MIN_COUNT = 2;
var CHAT_NAV_REBUILD_MS = 160;
var CHAT_NAV_JUMP_MARGIN = 12;
var CHAT_NAV_ACTIVE_TOL = 1;
var CHAT_NAV_EXCERPT_MAX = 96;

/** @type {HTMLElement|null} */
var chatNavRail = null;
/** @type {HTMLElement|null} */
var chatNavTip = null;
/** @type {HTMLElement|null} */
var chatNavTipMeta = null;
/** @type {HTMLElement|null} */
var chatNavTipText = null;
/** @type {{ el: HTMLElement, anchor: { el: HTMLElement, role: string }, from: number, to: number }[]} */
var chatNavTicks = [];
/** @type {HTMLElement[]} 上一轮锚点元素（顺序一致就跳过重建） */
var chatNavAnchors = [];
/** @type {(number|null)[]} 与刻度一一对应的内容偏移（量一次，滚动时复用） */
var chatNavOffsets = [];
/** 最大可滚动距离（量一次，判「是否已到最底部」） */
var chatNavMaxTop = 0;
var chatNavCapacity = 0;
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

/** 气泡可见文本（助手气泡优先取正文，别把思考区文本当摘要） */
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
 * 聊天区里的消息锚点（按 DOM 顺序，唯一来源）。
 *
 * 真实结构只有三种顶层节点（见 renderer-chat-bubbles.js / renderer-chat-render.js）：
 * - `.msg-turn`（用户回合）→ 挂在里面的 `.msg.user` 气泡
 * - `.msg-turn.msg-turn-trigger`（定时 / 目标续跑等非人类触发的一轮）→ `.msg-trigger` 触发条，
 *   它**没有** `.msg.user`，所以不能只认 `.msg.user`，否则这轮会整条漏掉
 * - `.msg.assistant` 等直接气泡
 * 其余（`.history-empty` 占位、加载失败文本等）不算消息。
 */
function collectChatNavAnchors() {
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
    const role = node.classList.contains('user')
      ? 'user'
      : node.classList.contains('assistant')
        ? 'assistant'
        : 'system';
    out.push({ el: node, role });
  }
  return out;
}

function sameChatNavAnchors(next) {
  if (next.length !== chatNavAnchors.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i].el !== chatNavAnchors[i].el) return false;
  }
  return true;
}

/** 轨道容量：按压缩下限算出最多能排几根刻度（含首根） */
function chatNavCapacityFor(railHeight) {
  if (!(railHeight > 0)) return 0;
  const inner = Math.max(0, railHeight - CHAT_NAV_TICK_HEIGHT);
  return Math.floor(inner / CHAT_NAV_MIN_PITCH) + 1;
}

/** 把 anchors 均分成 count 段，段内取首条作为该刻度的落点 */
function buildChatNavBuckets(anchors, count) {
  const total = anchors.length;
  const buckets = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * total) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * total) / count));
    buckets.push({ anchor: anchors[from], from, to: Math.min(total, to) });
  }
  return buckets;
}

function clearChatNavTicks() {
  for (const tick of chatNavTicks) tick.el.remove();
  chatNavTicks = [];
  chatNavAnchors = [];
  chatNavOffsets = [];
  chatNavMaxTop = 0;
  chatNavCapacity = 0;
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
  const railHeight = chatNavRail.clientHeight;
  const anchors = collectChatNavAnchors();
  const capacity = chatNavCapacityFor(railHeight);
  if (anchors.length < CHAT_NAV_MIN_COUNT || capacity < CHAT_NAV_MIN_COUNT) {
    setChatNavEmpty(true);
    return;
  }
  setChatNavEmpty(false);
  if (sameChatNavAnchors(anchors) && capacity === chatNavCapacity) {
    layoutChatNav();
    return;
  }
  // 悬停期间重建会把用户正指着的刻度换掉，等指针离开再补
  if (chatNavPointerInside && chatNavTicks.length) {
    chatNavPendingBuild = true;
    return;
  }
  chatNavPendingBuild = false;

  clearChatNavTicks();
  chatNavAnchors = anchors;
  chatNavCapacity = capacity;
  const count = Math.min(anchors.length, capacity);
  const buckets = buildChatNavBuckets(anchors, count);
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-nav-tick';
    const span = bucket.to - bucket.from;
    const label = span > 1 ? `${chatNavRoleLabel(bucket.anchor.role)} · ${span} 条` : chatNavRoleLabel(bucket.anchor.role);
    btn.setAttribute('aria-label', `跳转到第 ${bucket.from + 1} 条消息（${label}）`);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToChatNavTick(i);
    });
    btn.addEventListener('mouseenter', () => showChatNavTip(btn, i));
    btn.addEventListener('mouseleave', hideChatNavTip);
    btn.addEventListener('focus', () => showChatNavTip(btn, i));
    btn.addEventListener('blur', hideChatNavTip);
    chatNavRail.appendChild(btn);
    chatNavTicks.push({ el: btn, anchor: bucket.anchor, from: bucket.from, to: bucket.to });
  }
  layoutChatNav();
}

/** 量一次偏移（判高亮 / 算跳转用），并按等距一列写好 top */
function layoutChatNav() {
  if (!chatNavRail || !chatList || !chatNavTicks.length) return;
  if (chatNavRail.classList.contains('is-empty')) return;
  const railHeight = chatNavRail.clientHeight;
  if (!(railHeight > 0)) return;
  const inner = Math.max(0, railHeight - CHAT_NAV_TICK_HEIGHT);
  const listRect = chatList.getBoundingClientRect();
  const scrollTop = chatList.scrollTop;

  // 偏移只用来判「当前视口顶部是哪条」，不参与排布
  const offsets = [];
  for (const tick of chatNavTicks) {
    const el = tick.anchor.el;
    if (!el || !el.isConnected) {
      offsets.push(null);
      continue;
    }
    offsets.push(el.getBoundingClientRect().top - listRect.top + scrollTop);
  }

  // 等距一列：目标 10px，放不下就整体压到刚好占满（下限 3px），再居中
  const count = chatNavTicks.length;
  const fitPitch = count > 1 ? inner / (count - 1) : CHAT_NAV_TICK_PITCH;
  const pitch = Math.max(CHAT_NAV_MIN_PITCH, Math.min(CHAT_NAV_TICK_PITCH, fitPitch));
  const columnHeight = (count - 1) * pitch + CHAT_NAV_TICK_HEIGHT;
  const startY = Math.max(0, (railHeight - columnHeight) / 2);

  chatNavOffsets = offsets;
  chatNavMaxTop = Math.max(0, chatList.scrollHeight - chatList.clientHeight);
  // 命中区上下各外扩「半个间距」：正常 10px 间距 = ±4px；密集压缩时自动收窄，相邻刻度不抢点击
  chatNavRail.style.setProperty('--chat-nav-hit', `${Math.max(0, (pitch - CHAT_NAV_TICK_HEIGHT) / 2)}px`);
  for (let i = 0; i < count; i++) {
    const btn = chatNavTicks[i].el;
    const top = `${Math.round(startY + i * pitch)}px`;
    if (btn.style.top !== top) btn.style.top = top;
  }
  updateChatNavActive();
}

/**
 * 高亮 = 「视口顶部那条消息」；已经在最底部时就是最新一条。
 *
 * 容差 1px：滚动位置会按设备像素取整（跳转目标 `offset - 12` 落地时可能差零点几像素），
 * 用严格 `<=` 会把刚跳到的那条判成上一条，看起来像指针错了一格。
 */
function updateChatNavActive() {
  if (!chatList || !chatNavTicks.length) return;
  if (!chatNavOffsets.length) return;
  const scrollTop = chatList.scrollTop;
  const lastIndex = chatNavOffsets.length - 1;
  let active = 0;
  if (chatNavMaxTop - scrollTop <= CHAT_NAV_ACTIVE_TOL) {
    active = lastIndex;
  } else {
    const mine = scrollTop + CHAT_NAV_JUMP_MARGIN + CHAT_NAV_ACTIVE_TOL;
    for (let i = 0; i < chatNavOffsets.length; i++) {
      if (chatNavOffsets[i] != null && chatNavOffsets[i] <= mine) active = i;
    }
  }
  for (let i = 0; i < chatNavTicks.length; i++) {
    const btn = chatNavTicks[i].el;
    const isActive = i === active;
    if (btn.classList.contains('is-active') !== isActive) btn.classList.toggle('is-active', isActive);
  }
}

function chatNavJumpTarget(tick) {
  if (!chatList || !tick) return null;
  const el = tick.anchor.el;
  if (!el || !el.isConnected) return null;
  const listRect = chatList.getBoundingClientRect();
  const offsetTop = el.getBoundingClientRect().top - listRect.top + chatList.scrollTop;
  const maxTop = Math.max(0, chatList.scrollHeight - chatList.clientHeight);
  return Math.max(0, Math.min(maxTop, offsetTop - CHAT_NAV_JUMP_MARGIN));
}

function jumpToChatNavTick(index) {
  const tick = chatNavTicks[index];
  const top = chatNavJumpTarget(tick);
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
  const tick = chatNavTicks[index];
  const tip = ensureChatNavTip();
  if (!tip || !tick || !chatNavRail) return;
  const span = tick.to - tick.from;
  const meta = span > 1 ? `${chatNavRoleLabel(tick.anchor.role)} · 第 ${tick.from + 1}–${tick.to} 条` : `${chatNavRoleLabel(tick.anchor.role)} · 第 ${tick.from + 1} 条`;
  chatNavTipMeta.textContent = meta;
  chatNavTipText.textContent = chatNavExcerpt(chatNavAnchorText(tick.anchor.el)) || '（空消息）';
  tip.hidden = false;
  const railHeight = chatNavRail.clientHeight;
  const tipHeight = tip.offsetHeight;
  const tickTop = Number.parseFloat(btn.style.top || '0') || 0;
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

/** 滚动只换高亮（用缓存偏移），不重量位置；量位置只由「内容/轨道变了」触发 */
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
    // 消息增删 / 会话整体重绘 → 重建；气泡内部流式变长 → 只重算位置（列表不变时重建会跳过）
    const observer = new MutationObserver(() => scheduleChatNavBuild());
    observer.observe(chatList, { childList: true, subtree: true, characterData: true });
  }
  // 轨道高度变了（窗口缩放 / 拖输入框 / 面板开合）→ 容量变 → 重建
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleChatNavBuild()).observe(chatNavRail);
  }
  buildChatNav();
}

window.initChatNav = initChatNav;
