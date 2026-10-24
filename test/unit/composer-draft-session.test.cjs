'use strict';
/**
 * 输入框未发送文字必须按会话绑定。
 *
 * 复现的问题：在 A 对话打了没发的字，切到 B 后那段文字原样跟过去 —— 输入框只有一个
 * DOM 值，而待发附件 / 排队消息都按 sessionId 隔离，唯独文字没有归属。
 *
 * `src/renderer/renderer-chat-state.js` 是纯浏览器脚本（<script> 直接加载，没有
 * module.exports），所以这里用 `new Function` 造一个只带 window/document/$ 的求值环境，
 * 取出真实的 setCurrentSessionId / bindComposerDraftToSession 来断言。
 * 环境里模拟生产的调用顺序：`currentSessionId = id; setCurrentSessionId(id);`
 * —— 4 处切换会话的代码都长这样，绑定就挂在 setCurrentSessionId 上。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-state.js');
const SESSION_KEY = 'diecloud.active.session.v1';

function loadChatState(options = {}) {
  const store = new Map();
  if (options.initialSessionId) store.set(SESSION_KEY, options.initialSessionId);
  const input = { value: '' };
  const win = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
  };
  const doc = { querySelector: () => ({}) };
  const $ = (id) =>
    id === 'chat-input'
      ? input
      : {
          value: '',
          hidden: false,
          classList: { add() {}, remove() {}, contains: () => false },
          addEventListener() {},
          setAttribute() {}
        };
  const chipRenders = { count: 0 };
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    '$',
    'renderAttachmentChips',
    'refreshContextProgress',
    'getComposerQueueEditing',
    `${source}
    return {
      // 生产代码就是「先改 currentSessionId，再落 localStorage」，这里一比一照搬
      activate(id) { currentSessionId = id; setCurrentSessionId(id); },
      current: () => currentSessionId,
      owner: () => composerDraftOwnerSessionId,
      storedId: () => window.localStorage.getItem(${JSON.stringify(SESSION_KEY)}),
      getSessionComposerDraft,
      clearSessionComposerDraft,
      stashComposerDraft
    };`
  );
  const api = factory(
    win,
    doc,
    $,
    () => {
      chipRenders.count += 1;
    },
    () => {},
    () => options.editingSlot || null
  );
  return { ...api, input, store, chipRenders };
}

describe('输入框未发送文字按会话绑定', () => {
  it('切到别的对话不再把草稿带过去（A 的字留在 A）', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    assert.equal(env.owner(), 'A');

    env.input.value = '你好。';
    env.activate('B');

    assert.equal(env.input.value, '', '新会话输入框必须是空的，不能带着 A 的文字');
    assert.equal(env.getSessionComposerDraft('A'), '你好。', 'A 的草稿要存在 A 名下');
    assert.equal(env.storedId(), 'B', '当前会话 id 仍要落 localStorage');
  });

  it('切回原对话能取回原文（含换行与首尾空白，不 trim）', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    const draft = '  你好。\n第二行  ';
    env.input.value = draft;
    env.activate('B');
    env.input.value = 'B 的草稿';
    env.activate('A');

    assert.equal(env.input.value, draft, '草稿要原样还原');
    assert.equal(env.getSessionComposerDraft('B'), 'B 的草稿');

    env.activate('B');
    assert.equal(env.input.value, 'B 的草稿', '两个会话各自记各自的');
  });

  it('已经发出去的文字不会在切回来时复活', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    env.input.value = '你好。';
    env.activate('B');
    env.activate('A');
    assert.equal(env.input.value, '你好。');

    // 发送：清空输入框并清掉本会话草稿（composer-form 的 clearComposerPendingAndRefresh）
    env.input.value = '';
    env.clearSessionComposerDraft('A');
    env.activate('B');
    env.activate('A');
    assert.equal(env.input.value, '', '发出过的内容不许再被还原');
  });

  it('新建的会话不会继承上一个会话的草稿', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    env.input.value = '你好。';
    env.activate('brand-new-session-id');
    assert.equal(env.input.value, '');
    env.activate('A');
    assert.equal(env.input.value, '你好。');
  });

  it('排队项编辑中切走：存回编辑前的草稿，而不是队列项文本', () => {
    const editingSlot = {
      sessionId: 'A',
      composerDraftBefore: { text: '原草稿', attachments: [] }
    };
    const env = loadChatState({ initialSessionId: 'A', editingSlot });
    // 进入编辑后输入框里是「编辑缓冲」（队列项文本），不是会话草稿
    env.input.value = '队列里那条消息';
    env.activate('B');
    env.activate('A');
    assert.equal(env.input.value, '原草稿', '编辑缓冲不许被复制成会话草稿');
  });

  it('同一会话重复设置 id 时不动输入框（onComposerSessionActivated 等路径）', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    env.input.value = '正在打字';
    env.activate('A');
    assert.equal(env.input.value, '正在打字');
    assert.equal(env.chipRenders.count, 0, '同会话不应触发附件区重绘');
  });

  it('切会话时会刷新附件区与会话 id 归属', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    env.activate('B');
    assert.equal(env.owner(), 'B');
    assert.ok(env.chipRenders.count >= 1, '附件按会话隔离，切会话要重绘 chips');

    env.activate('A');
    assert.equal(env.owner(), 'A');
  });

  // 首装 / 清过 localStorage 的启动态：currentSessionId 是占位 id 'default'（LEGACY_SESSION），
  // 不是真实会话。此时打的字没有归属，不许「切到第一个会话就把它冲掉」。
  it('还没有活跃会话（占位 default）时打下的字，进第一个会话时不丢', () => {
    const env = loadChatState({});
    assert.equal(env.owner(), 'default', '没有活跃会话时 id 是占位 default');
    env.input.value = '首装就打下的字';
    env.activate('A');
    assert.equal(env.input.value, '首装就打下的字');
    assert.equal(env.getSessionComposerDraft('A'), '首装就打下的字');
  });

  it('孤儿文字不覆盖目标会话已有的草稿', () => {
    const env = loadChatState({ initialSessionId: 'A' });
    env.input.value = 'A 的草稿';
    env.activate('B');
    env.activate(''); // 回到「无活跃会话」
    env.input.value = '无归属的字';
    env.activate('A');
    assert.equal(env.input.value, 'A 的草稿', '已有草稿优先，孤儿文字不覆盖');
  });
});
