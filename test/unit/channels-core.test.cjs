'use strict';

/* globals describe, it, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createChannelStore, normalizeWorkspacePath } = require('../../src/channels/store');
const {
  normalizeInboundBody,
  conversationKeyOf,
  frames,
  newStreamId,
  REPLY_STREAM_PREFIX
} = require('../../src/channels/wecom-client');

/**
 * 频道（企微）核心单测：只有纯逻辑与落盘在这一层，连接与 Agent 执行不在这里。
 *
 * 钉住两件事：
 * 1. Secret 永不出现在对外视图 / 明文只在内存里出现一次（`channel-store` 与 ssh 同一套闸门）；
 * 2. 企微帧形状与 v1 外挂转接器一致（协议来源：工具/wecom-agent-bridge/bridge.py），
 *    改动帧字段等于改线上协议，必须有测试挡着。
 */

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
  };
}

describe('channel store', () => {
  let dir;
  let logs;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-channels-'));
    logs = [];
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeStore(safeStorage = fakeSafeStorage()) {
    return createChannelStore({
      userDataPath: dir,
      safeStorage,
      log: (m) => logs.push(m)
    });
  }

  it('creates a channel and never leaks the secret in public views', () => {
    const store = makeStore();
    const created = store.createChannel({
      name: '研发群',
      botId: 'bot-123',
      secret: 'super-secret',
      workspacePath: 'F:\\定时任务\\指标汇总报告'
    });
    expect(created.id).toBeTruthy();
    expect(created.hasSecret).toBe(true);
    expect(created.workspacePath).toBe(path.resolve('F:\\定时任务\\指标汇总报告'));
    expect(JSON.stringify(created)).not.toContain('super-secret');

    const onDisk = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');
    expect(onDisk).not.toContain('super-secret');
    expect(onDisk).toContain('secretEnc');

    const secrets = store.getChannelSecrets(created.id);
    expect(secrets.secret).toBe('super-secret');
    expect(secrets.botId).toBe('bot-123');
  });

  it('rejects a second channel with the same Bot ID', () => {
    const store = makeStore();
    store.createChannel({ botId: 'bot-1', secret: 'a' });
    expect(() => store.createChannel({ botId: 'bot-1', secret: 'b' })).toThrow(/Bot ID/);
  });

  it('keeps the stored secret when only the workspace changes', () => {
    const store = makeStore();
    const created = store.createChannel({ botId: 'bot-1', secret: 'keep-me' });
    store.updateChannel(created.id, { workspacePath: 'F:\\工作\\A' });
    expect(store.getChannelSecrets(created.id).secret).toBe('keep-me');
    expect(store.getChannel(created.id).workspacePath).toBe(path.resolve('F:\\工作\\A'));
  });

  it('refuses to save without an encryptable safeStorage', () => {
    const store = makeStore({ isEncryptionAvailable: () => false });
    expect(() => store.createChannel({ botId: 'bot-1', secret: 'x' })).toThrow(/加密/);
  });

  it('maps conversations to sessions and clears them on demand', () => {
    const store = makeStore();
    const created = store.createChannel({ botId: 'bot-1', secret: 'x' });
    store.setConversationSession(created.id, 'single:zhangsan', 'sess-1');
    expect(store.getConversationSession(created.id, 'single:zhangsan')).toBe('sess-1');
    expect(store.getChannel(created.id).conversationCount).toBe(1);
    store.clearConversationSession(created.id, 'single:zhangsan');
    expect(store.getConversationSession(created.id, 'single:zhangsan')).toBe('');
  });

  it('normalizes workspace input through the same parser as the gateway write gate', () => {
    expect(normalizeWorkspacePath('')).toBeNull();
    expect(normalizeWorkspacePath(null)).toBeNull();
    expect(normalizeWorkspacePath('F:\\工作\\A')).toBe(path.resolve('F:\\工作\\A'));
    expect(normalizeWorkspacePath('ssh://me@host:2222/work')).toMatch(/^ssh:\/\/me@host/);
  });
});

describe('wecom inbound normalization', () => {
  it('reads a plain text message', () => {
    const n = normalizeInboundBody({ msgtype: 'text', text: { content: ' 你好 ' } });
    expect(n.text).toBe('你好');
    expect(n.images).toEqual([]);
  });

  it('reads the speech-to-text of a voice message', () => {
    const n = normalizeInboundBody({ msgtype: 'voice', voice: { content: '帮我跑一下日报' } });
    expect(n.voiceText).toBe('帮我跑一下日报');
  });

  it('collects image urls from image and mixed messages', () => {
    expect(normalizeInboundBody({ msgtype: 'image', image: { url: 'https://x/1.jpg' } }).images).toEqual([
      'https://x/1.jpg'
    ]);
    const mixed = normalizeInboundBody({
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '看这张' } },
          { msgtype: 'image', image: { pic_url: 'https://x/2.jpg' } }
        ]
      }
    });
    expect(mixed.text).toBe('看这张');
    expect(mixed.images).toEqual(['https://x/2.jpg']);
  });

  it('keys group chats by chatid and direct chats by single:userid', () => {
    expect(conversationKeyOf({ chattype: 'group', chatid: 'chat-9', from: { userid: 'u1' } })).toBe('chat-9');
    expect(conversationKeyOf({ chattype: 'single', from: { userid: 'u1' } })).toBe('single:u1');
  });
});

describe('wecom protocol frames', () => {
  it('subscribes with bot_id and secret', () => {
    const f = frames.subscribe('bot-1', 'sec');
    expect(f.cmd).toBe('aibot_subscribe');
    expect(f.body).toEqual({ bot_id: 'bot-1', secret: 'sec' });
    expect(typeof f.headers.req_id).toBe('string');
    expect(f.headers.req_id.length).toBeGreaterThan(8);
  });

  it('streams a reply on a stable stream id and finishes it', () => {
    const id = newStreamId();
    expect(id.startsWith(REPLY_STREAM_PREFIX)).toBe(true);
    const mid = frames.stream('req-1', id, '部分', false);
    expect(mid).toEqual({
      cmd: 'aibot_respond_msg',
      headers: { req_id: 'req-1' },
      body: { msgtype: 'stream', stream: { id, finish: false, content: '部分' } }
    });
    const end = frames.stream('req-1', id, '完整答复', true);
    expect(end.body.stream).toEqual({ id, finish: true, content: '完整答复' });
  });

  it('pushes proactive text to a group chat or a direct user', () => {
    const group = frames.proactiveText('chat-9', '日报已生成');
    expect(group.cmd).toBe('aibot_send_msg');
    expect(group.body).toEqual({ msgtype: 'text', text: { content: '日报已生成' }, chatid: 'chat-9' });
    const direct = frames.proactiveText('single:u1', 'hi');
    expect(direct.body.userid).toBe('u1');
    expect(direct.body.chatid).toBeUndefined();
  });
});
