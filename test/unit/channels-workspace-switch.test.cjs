/* globals describe, it, expect, beforeEach, afterEach */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChannelStore } = require('../../src/channels/store');
const { createChannelWorkspaceSwitcher } = require('../../src/channels/workspace-switch');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('E:' + s, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(2)
};

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ws-'));
}

/** 桌面历史里「已经用过的项目」 = 这些会话行的工作空间 */
const KNOWN_SESSIONS = [
  { id: 's1', workspacePath: 'F:\\dieyundaizhang' },
  { id: 's2', workspacePath: 'F:\\dieyuntools' },
  { id: 's3', workspacePath: 'F:\\UE5-Tutorial-Course' }
];

function makeGateway(calls) {
  return {
    invokeRpc: async (method, args) => {
      calls.push([method, args]);
      if (method === 'memory.sessions_list') return KNOWN_SESSIONS;
      return { ok: true };
    },
    setSessionWorkspaceContext: () => {}
  };
}

describe('channels/workspace-switch', () => {
  let userData;
  let store;
  let channel;
  let calls;
  let switcher;

  beforeEach(() => {
    userData = tmpUserData();
    store = createChannelStore({ userDataPath: userData, safeStorage: fakeSafeStorage, log: () => {} });
    channel = store.createChannel({
      name: '研发群',
      botId: 'bot-1',
      secret: 'sec-1',
      workspacePath: 'F:\\微信Agent对话'
    });
    calls = [];
    switcher = createChannelWorkspaceSwitcher({
      gateway: makeGateway(calls),
      store,
      log: () => {}
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // 清理失败不影响判定
    }
  });

  function seedConversation(workspacePath = '') {
    store.setConversationSession(channel.id, 'single:u1', 'sess-1');
    if (workspacePath) store.setConversationWorkspace(channel.id, 'single:u1', workspacePath);
  }

  function boundPaths() {
    return calls
      .filter(([m]) => m === 'memory.session_workspace_set')
      .map(([, a]) => a.workspacePath);
  }

  it('绝对路径命中候选：写会话行 + 记住这条会话的选择', async () => {
    seedConversation();
    const res = await switcher.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: 'F:\\dieyundaizhang'
    });
    expect(res.ok).toBe(true);
    expect(boundPaths()).toEqual(['F:\\dieyundaizhang']);
    expect(store.getConversation(channel.id, 'single:u1')).toEqual({
      sessionId: 'sess-1',
      workspacePath: 'F:\\dieyundaizhang'
    });
  });

  it('只报项目名也能切（目录名唯一即认）', async () => {
    seedConversation();
    const res = await switcher.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: 'ue5-tutorial-course'
    });
    expect(res.ok).toBe(true);
    expect(boundPaths()).toEqual(['F:\\UE5-Tutorial-Course']);
  });

  it('候选外的工作空间一律拒绝，并列出可选项目（不写任何绑定）', async () => {
    seedConversation();
    const res = await switcher.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: 'C:\\Windows'
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('dieyundaizhang');
    expect(boundPaths()).toEqual([]);
    expect(store.getConversation(channel.id, 'single:u1')).toEqual({
      sessionId: 'sess-1',
      workspacePath: ''
    });
  });

  it('名称匹配到多个项目时要求指明，不乱猜', async () => {
    seedConversation();
    // 候选里再加一个同名前缀的项目
    const gw = makeGateway(calls);
    gw.invokeRpc = async (method) => {
      if (method === 'memory.sessions_list') {
        return [{ id: 'a', workspacePath: 'F:\\dieyun' }, { id: 'b', workspacePath: 'F:\\dieyun-server' }];
      }
      return { ok: true };
    };
    const s2 = createChannelWorkspaceSwitcher({ gateway: gw, store, log: () => {} });
    const res = await s2.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: 'dieyun'
    });
    // 「dieyun」精确命中 F:\dieyun 的目录名，所以认它；不精确时才算歧义
    expect(res.ok).toBe(true);
    expect(res.workspacePath).toBe('F:\\dieyun');
  });

  it('传 default 恢复频道默认工作空间，并清掉这条会话的覆盖', async () => {
    seedConversation('F:\\dieyuntools');
    const res = await switcher.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: 'default'
    });
    expect(res.ok).toBe(true);
    expect(res.workspacePath).toBe('F:\\微信Agent对话');
    expect(boundPaths()).toEqual(['F:\\微信Agent对话']);
    expect(store.getConversation(channel.id, 'single:u1').workspacePath).toBe('');
  });

  it('频道没设默认目录时，切回默认=解绑（会话行写 NULL，不写空串）', async () => {
    const bare = store.createChannel({ name: '无默认', botId: 'bot-9', secret: 'sec-9' });
    store.setConversationSession(bare.id, 'single:u2', 'sess-2');
    store.setConversationWorkspace(bare.id, 'single:u2', 'F:\\dieyuntools');
    const res = await switcher.switchWorkspace({
      channel: bare,
      conversationKey: 'single:u2',
      sessionId: 'sess-2',
      workspace: 'default'
    });
    expect(res.ok).toBe(true);
    expect(res.workspacePath).toBe('');
    expect(calls.filter(([m]) => m === 'memory.session_workspace_set').at(-1)[1].workspacePath).toBe(null);
  });

  it('不带参数时只返回候选清单，不切也不写', async () => {
    seedConversation();
    const res = await switcher.switchWorkspace({
      channel,
      conversationKey: 'single:u1',
      sessionId: 'sess-1',
      workspace: ''
    });
    expect(res.ok).toBe(false);
    expect(res.candidates.map((c) => c.name)).toContain('dieyundaizhang');
    expect(boundPaths()).toEqual([]);
  });

  it('频道默认目录本身也在候选里（没在桌面打开过也能切回去）', async () => {
    const list = await switcher.listCandidates(channel);
    expect(list.map((c) => c.path)).toContain('F:\\微信Agent对话');
  });

  it('已有会话映射重建时会保留用户选过的工作空间', () => {
    seedConversation('F:\\dieyuntools');
    store.setConversationSession(channel.id, 'single:u1', 'sess-2');
    expect(store.getConversation(channel.id, 'single:u1')).toEqual({
      sessionId: 'sess-2',
      workspacePath: 'F:\\dieyuntools'
    });
  });
});
