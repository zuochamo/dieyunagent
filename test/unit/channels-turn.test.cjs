/* globals describe, it, expect, beforeEach, afterEach */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChannelStore } = require('../../src/channels/store');
const {
  createChannelTurnRunner,
  channelSessionTitle,
  prepareAttachments
} = require('../../src/channels/agent-turn');

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=';

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('E:' + s, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(2)
};

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-turn-'));
}

/** 记录 RPC 调用；会话类返回最小值，其余给 ok */
function makeGateway(sink) {
  return {
    invokeRpc: async (method, args) => {
      sink.push(method);
      if (method === 'memory.session_create') return { id: 'sess-1' };
      if (method === 'memory.session_get') return null;
      if (method === 'memory.messages_recent') return [];
      return { ok: true };
    }
  };
}

function makeRunner(deps) {
  return createChannelTurnRunner({
    store: deps.store,
    userData: deps.userData,
    getGateway: () => deps.gateway,
    getCoreBridge: () => deps.coreBridge,
    getMcpRuntime: () => null,
    getCompactionAgent: () => null,
    createToolBridge: () => ({ executeAgentTool: async () => ({}) }),
    notifySessionsChanged: deps.notifySessionsChanged,
    log: () => {}
  });
}

describe('channels/agent-turn', () => {
  let userData;
  let store;
  let channel;

  beforeEach(() => {
    userData = tmpUserData();
    store = createChannelStore({ userDataPath: userData, safeStorage: fakeSafeStorage, log: () => {} });
    channel = store.createChannel({ name: '研发群', botId: 'bot-1', secret: 'sec-1' });
  });

  afterEach(() => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响判定
    }
  });

  it('会话标题带频道前缀（用户在会话列表里能认出这条是微信来的）', () => {
    expect(channelSessionTitle({ name: '研发群' })).toBe('[企业微信] 研发群');
    expect(channelSessionTitle(null)).toBe('[企业微信] 未命名频道');
  });

  it('图片附件进多模态 part，并在账本里留一行落盘路径', async () => {
    // 附件 URL 必须是公网 https：出网过 SSRF 校验（回调体里的 URL 群里人人可控）。
    // 所以这里 stub 掉 fetch 喂真实字节，测的是本仓的 mime/落盘/账本逻辑，不是网络。
    const pngBytes = Buffer.from(PNG_1PX.split(',')[1], 'base64');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
    try {
      const att = await prepareAttachments({
        attachments: [{ kind: 'image', url: 'https://wwfile.example.com/a.png' }],
        userDataPath: userData,
        channelId: channel.id,
        workspacePath: ''
      });
      expect(att.imageParts).toHaveLength(1);
      expect(att.imageParts[0].type).toBe('image_url');
      expect(att.imageParts[0].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(att.ledgerNotes[0].startsWith('[图片] ')).toBe(true);
      expect(att.ledgerAttachments).toHaveLength(1);
      expect(fs.existsSync(att.ledgerAttachments[0].path)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('内网 / 非法协议的附件地址一律不取（SSRF 闸门）', async () => {
    for (const url of ['http://127.0.0.1:9/x.png', 'http://192.168.1.10/secret.png', 'file:///C:/Windows/win.ini']) {
      const att = await prepareAttachments({
        attachments: [{ kind: 'image', url }],
        userDataPath: userData,
        channelId: channel.id,
        workspacePath: ''
      });
      expect(att.imageParts).toHaveLength(0);
      expect(att.ledgerNotes[0]).toContain('下载失败');
    }
  });

  it('附件下载失败不炸整轮：只留一行说明', async () => {
    const att = await prepareAttachments({
      attachments: [{ kind: 'image', url: 'http://127.0.0.1:9/none.png' }],
      userDataPath: userData,
      channelId: channel.id,
      workspacePath: ''
    });
    expect(att.imageParts).toHaveLength(0);
    expect(att.ledgerNotes[0]).toContain('下载失败');
  });

  it('core 未就绪时明确报错，且不建会话（不留半条空会话）', async () => {
    const calls = [];
    const runner = makeRunner({
      store,
      userData,
      gateway: makeGateway(calls),
      coreBridge: { isReady: () => false }
    });
    await expect(
      runner.runTurn({ channelId: channel.id, conversationKey: 'single:u1', text: 'hi', sink: { push() {} } })
    ).rejects.toThrow(/dieyun-core 未就绪/);
    expect(calls).toHaveLength(0);
  });

  it('建会话并记住「企微联系人 → 会话」映射；缺模型配置时明确报错', async () => {
    const calls = [];
    const notified = [];
    const runner = makeRunner({
      store,
      userData,
      gateway: makeGateway(calls),
      coreBridge: { isReady: () => true },
      notifySessionsChanged: (payload) => notified.push(payload)
    });
    await expect(
      runner.runTurn({ channelId: channel.id, conversationKey: 'single:u1', text: 'hi', sink: { push() {} } })
    ).rejects.toThrow(/未配置 API Key/);
    expect(calls).toContain('memory.session_create');
    expect(store.getConversationSession(channel.id, 'single:u1')).toBe('sess-1');
    // 新会话一建出来就要通知桌面刷新历史列表（否则企微里聊过、桌面看不到）
    expect(notified).toHaveLength(1);
    expect(notified[0]).toEqual({
      channelId: channel.id,
      sessionId: 'sess-1',
      title: '[企业微信] 研发群'
    });
  });

  it('该会话显式切过的工作空间优先于频道默认（改设置不该把用户切过去的项目拽回来）', async () => {
    const created = [];
    const gw = {
      invokeRpc: async (method, args) => {
        if (method === 'memory.session_get') return null;
        if (method === 'memory.session_create') created.push(args);
        if (method === 'memory.session_create') return { id: 'sess-9' };
        if (method === 'memory.messages_recent') return [];
        return { ok: true };
      }
    };
    const bound = store.createChannel({
      name: '切过的频道',
      botId: 'bot-2',
      secret: 'sec-2',
      workspacePath: 'F:\\微信Agent对话'
    });
    store.setConversationSession(bound.id, 'single:u1', 'sess-old');
    store.setConversationWorkspace(bound.id, 'single:u1', 'F:\\dieyundaizhang');
    const runner = makeRunner({ store, userData, gateway: gw, coreBridge: { isReady: () => true } });
    await expect(
      runner.runTurn({ channelId: bound.id, conversationKey: 'single:u1', text: 'hi', sink: { push() {} } })
    ).rejects.toThrow(/未配置 API Key/);
    expect(created).toHaveLength(1);
    expect(created[0].workspacePath).toBe('F:\\dieyundaizhang');
  });

  it('频道不存在时报错，不消耗任何 RPC', async () => {
    const calls = [];
    const runner = makeRunner({ store, userData, gateway: makeGateway(calls), coreBridge: { isReady: () => true } });
    await expect(
      runner.runTurn({ channelId: 'ch_missing', conversationKey: 'single:u1', text: 'hi', sink: { push() {} } })
    ).rejects.toThrow(/频道不存在/);
    expect(calls).toHaveLength(0);
  });
});
