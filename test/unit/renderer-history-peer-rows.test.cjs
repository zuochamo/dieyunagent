'use strict';

/**
 * 「bot 之间的对话」在左侧历史里**看得见、认得出**的契约（`src/renderer/renderer-chat-history.js`）。
 *
 * 守三件事（2026-11-12 现场：对端会话在左侧历史里等于不存在）：
 *   1. 对端会话不按工作区归堆 —— 它单独一层「Bot 对话」，且默认展开。原来它
 *      `workspacePath` 是 null，落进折叠的「未绑定工作区」；被视图工作区绑走过的
 *      那些则藏进别人的项目文件夹，长得像一次普通任务；
 *   2. 行上有结构信号：bot 图标 + 对端名字（标题被 AI 改名后仍能认出是谁）；
 *   3. 判据只有 links（`sessionIsPeerChat`），不从标题里抠字，不影响普通会话行。
 *
 * 用 `new Function` + 极简 DOM 桩（与 `renderer-goal-panel.test.cjs` 同一手法）：
 * 这个模块是浏览器脚本，没有 module.exports；为几个渲染分支装 jsdom 不划算。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRendererFmt } = require('./lib/load-renderer-fmt.cjs');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const SOURCE = fs.readFileSync(path.join(DIR, 'renderer-chat-history.js'), 'utf8');

function makeEl(props = {}) {
  const el = {
    hidden: false,
    textContent: '',
    innerHTML: '',
    title: '',
    className: '',
    dataset: {},
    children: [],
    _attrs: {},
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    getAttribute(name) {
      return this._attrs[name];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    remove() {},
    ...props
  };
  return el;
}

/**
 * 一行历史的最小 DOM：`.history-item-icon / -main / -title / -meta` + `.history-actions`。
 * 桩只放被 `updateHistorySessionRow` 真正碰到的槽位，多放会让人误以为测的是页面。
 */
function makeRow() {
  const icon = makeEl();
  const main = makeEl();
  const title = makeEl();
  const meta = makeEl();
  const actions = makeEl();
  const slots = {
    '.history-item-icon': icon,
    '.history-item-main': main,
    '.history-item-title': title,
    '.history-item-meta': meta,
    '.history-actions': actions
  };
  const row = makeEl({
    querySelector: (sel) => slots[sel] || null
  });
  return { row, icon, main, title, meta, actions };
}

function loadModule(opts = {}) {
  const document = {
    createElement: () => makeEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeEl(),
    documentElement: makeEl()
  };
  const window = {};
  /** 图标请求记录：断言「这一行告诉共享图标表自己是 bot 会话」，SVG 内容归 chat-bubbles 管 */
  const iconRequests = [];
  const links = opts.links || {};
  const names = opts.names || {};

  const factory = new Function(
    'window',
    'document',
    'currentSessionId',
    'sessionActiveRuns',
    't',
    'uiText',
    'MESSAGE_META_PREFIX',
    'unpackMessageMeta',
    'sessionIsPeerChat',
    'peerLinkForSession',
    'peerNameForId',
    'triggerIconSvg',
    'flatFolderIconSvg',
    'rememberSessionWorkspacePath',
    'fmtRelShort',
    `${SOURCE}
     return {
       PEER_HISTORY_GROUP_KEY,
       groupSessionsByWorkspace,
       historyFolderDefaultOpen,
       isHistoryFolderExpanded,
       historyRowTitle,
       sessionListTitle,
       updateHistorySessionRow
     };`
  );

  const api = factory(
    window,
    document,
    opts.currentSessionId || 's-current',
    opts.sessionActiveRuns || new Map(),
    () => '',
    (key, fallback) => (key === 'history_peer_hover' ? '与 %s 的对话（在这里说的话直接发给它）' : fallback),
    '【叠云meta】',
    (raw) => ({ content: String(raw || ''), meta: null }),
    (sid) => !!links[String(sid || '')],
    (sid) => String(links[String(sid || '')] || ''),
    (peerId) => String(names[String(peerId || '')] || peerId || ''),
    (kind) => {
      iconRequests.push(String(kind || ''));
      return kind ? `<svg data-kind="${kind}"></svg>` : '';
    },
    () => '<svg data-folder></svg>',
    () => {},
    // 时间文案的唯一来源是 renderer-utils.js（列表不再自带一份实现）
    loadRendererFmt().fmtRelShort
  );
  return { ...api, iconRequests };
}

const PEER_ID = 'peer_52e600705f655dea7a';
const PEER_SESSION = 's-peer-1';
const PEER_NAME = 'DIEYUN11';

function sampleSessions() {
  return [
    // 对端会话：标题已被 AI 改名，而且被视图工作区绑走成了别人的 worktree
    {
      id: PEER_SESSION,
      title: 'DIEYUN11来信问候',
      workspacePath: 'ssh://dieyunx@10.0.0.2/run/dieyundaizhang/.dieyun/worktrees/sess-6ed52fd6/main',
      workspaceProjectPath: 'ssh://dieyunx@10.0.0.2/run/dieyundaizhang',
      updatedAt: 3
    },
    { id: 's-proj-1', title: '改发票模块', workspacePath: 'F:\\dieyundaizhang', workspaceProjectPath: 'F:\\dieyundaizhang', updatedAt: 2 },
    { id: 's-free-1', title: '随口一问', workspacePath: null, updatedAt: 1 }
  ];
}

function loadWithLinks() {
  return loadModule({ links: { [PEER_SESSION]: PEER_ID }, names: { [PEER_ID]: PEER_NAME } });
}

test('对端会话单独一层「Bot 对话」，不跟着被绑上的工作区跑', () => {
  const mod = loadWithLinks();
  const groups = mod.groupSessionsByWorkspace(sampleSessions());

  const peerGroup = groups.find((g) => g.key === mod.PEER_HISTORY_GROUP_KEY);
  assert.ok(peerGroup, '应当有一层 Bot 对话');
  assert.equal(peerGroup.peer, true);
  assert.deepEqual(peerGroup.sessions.map((s) => s.id), [PEER_SESSION]);

  // 原来那条「被绑到 ssh worktree 的对端会话」不许再出现在别人的项目文件夹里
  for (const g of groups) {
    if (g === peerGroup) continue;
    assert.ok(!g.sessions.some((s) => s.id === PEER_SESSION), `对端会话不该出现在 ${g.key}`);
  }
  // 项目会话与未绑定会话的分组行为不变
  assert.deepEqual(
    groups.filter((g) => !g.peer).map((g) => g.key).sort(),
    ['', 'f:/dieyundaizhang']
  );
});

test('Bot 对话默认展开；项目层/未绑定层仍然按老规矩（只有当前会话在里面才展开）', () => {
  const mod = loadWithLinks();
  const groups = mod.groupSessionsByWorkspace(sampleSessions());
  const peerGroup = groups.find((g) => g.peer);
  const projGroup = groups.find((g) => g.key === 'f:/dieyundaizhang');
  const freeGroup = groups.find((g) => g.key === '');

  const ui = { collapsed: new Set(), expanded: new Set(), order: [] };
  assert.equal(mod.historyFolderDefaultOpen(peerGroup, groups, 's-current'), true);
  assert.equal(mod.isHistoryFolderExpanded(peerGroup.key, ui, true), true);

  assert.equal(mod.historyFolderDefaultOpen(projGroup, groups, 's-current'), false);
  assert.equal(mod.isHistoryFolderExpanded(projGroup.key, ui, false), false);
  assert.equal(mod.historyFolderDefaultOpen(freeGroup, groups, 's-elsewhere'), false);
  // 用户自己收起来就尊重用户：默认展开不是「永远展开」
  const collapsedUi = { collapsed: new Set([peerGroup.key]), expanded: new Set(), order: [] };
  assert.equal(mod.isHistoryFolderExpanded(peerGroup.key, collapsedUi, true), false);
});

test('对端会话行：bot 图标 + 对端名字（标题里没名字就挂上）', () => {
  const mod = loadWithLinks();
  const { row, icon, main, title } = makeRow();
  const session = { ...sampleSessions()[0], title: '来信问候' };

  mod.updateHistorySessionRow(row, session);

  assert.match(row.className, /is-peer-session/);
  assert.equal(row.dataset.peerId, PEER_ID);
  // 图标走共享的 kind → svg 表：这一行说的是 'peer'，不是它碰巧带的 triggerKind
  assert.deepEqual(mod.iconRequests, ['peer']);
  assert.match(icon.innerHTML, /data-kind="peer"/);
  assert.equal(title.textContent, `${PEER_NAME} · 来信问候`);
  assert.equal(main.title, `与 ${PEER_NAME} 的对话（在这里说的话直接发给它）`);
});

test('标题里已经有对端名字就不重复挂（现场那类「DIEYUN11来信问候」）', () => {
  const mod = loadWithLinks();
  const first = makeRow();
  mod.updateHistorySessionRow(first.row, sampleSessions()[0]);
  assert.equal(first.title.textContent, 'DIEYUN11来信问候');
});

test('标题是「与 X 的对话」原样保留，不变成「X · 与 X 的对话」', () => {
  const mod = loadWithLinks();
  const { row, title } = makeRow();
  mod.updateHistorySessionRow(row, {
    id: PEER_SESSION,
    title: `与 ${PEER_NAME} 的对话`,
    workspacePath: null,
    updatedAt: 1
  });
  assert.equal(title.textContent, `与 ${PEER_NAME} 的对话`);
});

test('普通会话行不受影响：没有 bot 标识，图标还是它自己的触发归因', () => {
  const mod = loadWithLinks();
  const { row, main, title } = makeRow();
  mod.updateHistorySessionRow(row, {
    id: 's-proj-1',
    title: '改发票模块',
    triggerKind: 'schedule',
    workspacePath: 'F:\\dieyundaizhang',
    updatedAt: 2
  });
  assert.doesNotMatch(row.className, /is-peer-session/);
  assert.equal(row.dataset.peerId, undefined);
  assert.deepEqual(mod.iconRequests, ['schedule']);
  assert.equal(title.textContent, '改发票模块');
  assert.equal(main.title, '');
});

test('还没有标题时，「Bot 对话」行的标题取对方说的话，而不是信头', () => {
  const mod = loadWithLinks();
  const inbound = [
    '【内网 Agent 来信 · DIEYUN11】',
    '来源 peerId：peer_52e600705f655dea7a；对端会话：s-1793240174114-6cc7440；跳数：1',
    '',
    '日报那个税负明细标签，进项要按历史平均算。',
    '',
    '（你的最终回复会原样回传给对方；需要继续追问可直接再发 peer_send。）'
  ].join('\n');
  assert.equal(
    mod.sessionListTitle({ id: PEER_SESSION, title: null, preview: inbound }),
    '日报那个税负明细标签，进项要按历史平均算。'
  );
  // 对方答复那条同理（信头是 `【X 的回复】`）
  assert.equal(
    mod.sessionListTitle({ id: PEER_SESSION, title: null, preview: '【DIEYUN11 的回复】\n\n收到，我这边改。' }),
    '收到，我这边改。'
  );
});
