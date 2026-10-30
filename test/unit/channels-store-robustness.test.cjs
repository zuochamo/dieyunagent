'use strict';

/* globals describe, it, expect, beforeEach, afterEach */

/**
 * 审计后补的两条硬约束（都是「静默毁数据 / 静默不干活」级）：
 *
 * A. channels.json 解析失败**不能当空状态**：以前 readState catch 后返回空，
 *    用户随便点一次保存就会把整个文件覆盖成「只有这一条频道」，其余频道与会话映射全丢。
 * B. 会话映射按 updatedAt 裁剪（500 条）：只在新建/切换时写时间，会让天天在用的群
 *    被当成最旧的先裁掉 —— 所以要能「刷新活跃时间」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannelStore, CONVERSATION_LIMIT } = require('../../src/channels/store');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-store-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('channels store 健壮性', () => {
  it('配置文件解析失败时报 CHANNEL_STORE_CORRUPT，而不是当成空状态', () => {
    const file = path.join(dir, 'channels.json');
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const store = createChannelStore({ userDataPath: dir, log: () => {} });
    let err = null;
    try {
      store.listChannels();
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe('CHANNEL_STORE_CORRUPT');
    // 关键：坏文件没有被覆盖（否则用户再也拿不回来）
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 这不是 JSON');
  });

  it('文件不存在才算空配置', () => {
    const store = createChannelStore({ userDataPath: dir, log: () => {} });
    expect(store.listChannels()).toEqual([]);
  });

  it('touchConversation 只刷新活跃时间，不动 sessionId 与工作空间', () => {
    // safeStorage 只在 Electron 里可用：用最小替身（isEncryptionAvailable + 编解码）
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(String(s), 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    };
    const store = createChannelStore({ userDataPath: dir, log: () => {}, safeStorage });
    const created = store.createChannel({
      name: '企业微信',
      botId: 'bot-1',
      secret: 'sec-1',
      workspacePath: 'F:\\项目A'
    });
    store.setConversationSession(created.id, 'single:zhangsan', 's-1');
    store.setConversationWorkspace(created.id, 'single:zhangsan', 'F:\\项目B');
    const before = store.getConversation(created.id, 'single:zhangsan');
    expect(before.workspacePath).toBe('F:\\项目B');

    const ok = store.touchConversation(created.id, 'single:zhangsan');
    expect(ok).toBe(true);
    const after = store.getConversation(created.id, 'single:zhangsan');
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.workspacePath).toBe('F:\\项目B');
    expect(store.getConversation(created.id, 'single:不存在的会话')).toBeNull();
    expect(CONVERSATION_LIMIT).toBeGreaterThan(0);
  });
});
