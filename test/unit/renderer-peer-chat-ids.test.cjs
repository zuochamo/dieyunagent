'use strict';

/**
 * 「哪条会话算 bot 对话」的判据（`src/renderer/renderer-peer.js#sessionIsPeerChat`）。
 *
 * 这条线踩过一次：一开始拿 `links` 当判据，于是**任何在本机任务会话里调过一次
 * `peer_send` 的会话**都会被当成 bot 对话，从项目文件夹里搬进「Bot 对话」层。
 * 真判据是 Main 的 `chatSessions`（通道新建 / 用户点「发消息」打开的会话），
 * `links` 只回答「这个会话绑了哪台对端」（发送路由用）。
 *
 * 加载方式同 `renderer-history-peer-rows.test.cjs`：浏览器脚本 + 极简桩。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const SOURCE = fs.readFileSync(path.join(DIR, 'renderer-peer.js'), 'utf8');

function makeEl() {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    title: '',
    className: '',
    dataset: {},
    setAttribute() {},
    getAttribute() {
      return undefined;
    },
    appendChild(child) {
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    remove() {}
  };
}

function loadModule() {
  /** @type {Function | null} 面板注册的那一个事件回调 */
  let onPeerEvent = null;
  const listEl = makeEl();
  const document = {
    readyState: 'complete',
    getElementById: (id) => (id === 'peer-session-row' || id === 'peer-list' ? makeEl() : null),
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeEl(),
    documentElement: makeEl()
  };
  const window = {
    diecloud: {
      peerStatus: () => Promise.resolve({ ok: true, status: { links: {}, chatSessions: [], peers: [], trusted: [] } }),
      onPeerEvent: (cb) => {
        onPeerEvent = cb;
      }
    },
    addEventListener() {}
  };

  const factory = new Function(
    'window',
    'document',
    '$',
    'uiText',
    'escapeHtml',
    'showAgentToast',
    'gatewayCall',
    'currentSessionId',
    'switchSession',
    'loadChatFromGateway',
    'refreshHistoryList',
    'openConnectModal',
    'closeConnectModal',
    'isConnectModalOpen',
    'activeConnectTabId',
    'isSidePanelOpen',
    'getSidePanelTab',
    `${SOURCE}
     return { peerApplyStatus, sessionIsPeerChat, peerLinkForSession, peerNameForId };`
  );

  const api = factory(
    window,
    document,
    (id) => (id === 'peer-list' ? listEl : null),
    (key, fallback) => fallback,
    (s) => String(s == null ? '' : s),
    () => {},
    () => Promise.resolve({}),
    's-current',
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => {},
    () => {},
    () => false,
    () => '',
    () => false,
    () => ''
  );

  return {
    ...api,
    emit(event) {
      assert.equal(typeof onPeerEvent, 'function', '面板应当注册了 peer 事件回调');
      onPeerEvent(event);
    }
  };
}

test('只有 chatSessions 里的会话算 bot 对话；links 里的本机任务会话不算', () => {
  const api = loadModule();
  api.peerApplyStatus({
    links: { s_task: 'peer_a' },
    chatSessions: ['s_chat'],
    peers: [{ peerId: 'peer_a', name: 'DIEYUN11' }]
  });

  assert.equal(api.sessionIsPeerChat('s_chat'), true);
  assert.equal(api.sessionIsPeerChat('s_task'), false, '调过 peer_send 的项目会话不许被当成 bot 对话');
  // 发送路由那一侧仍然认 links（两件事，两个判据）
  assert.equal(api.peerLinkForSession('s_task'), 'peer_a');
  assert.equal(api.peerLinkForSession('s_chat'), '');
  assert.equal(api.peerNameForId('peer_a'), 'DIEYUN11');
});

test('links-changed 推送里带的 chatSessions 会整体替换缓存（解绑后不再是 bot 对话）', () => {
  const api = loadModule();
  api.peerApplyStatus({ links: { s_chat: 'peer_a' }, chatSessions: ['s_chat'] });
  assert.equal(api.sessionIsPeerChat('s_chat'), true);

  api.emit({ kind: 'links-changed', links: {}, chatSessions: [] });
  assert.equal(api.sessionIsPeerChat('s_chat'), false);
  assert.equal(api.peerLinkForSession('s_chat'), '');
});

test('状态里没有 chatSessions 字段时按「没有 bot 对话」处理（老版本 Main 也不会让列表乱搬）', () => {
  const api = loadModule();
  api.peerApplyStatus({ links: { s_task: 'peer_a' } });
  assert.equal(api.sessionIsPeerChat('s_task'), false);
});
