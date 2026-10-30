'use strict';

/* globals describe, it, expect, vi, afterEach */

/**
 * 长连接层的时序单测：用假 socket 驱动「重投 / 半开连接 / 主动推送回执」这些真机难复现的路径。
 *
 * 三件事都是线上会真的咬人的：
 * A. 同一条回调被重投时不能把 Agent 再跑一遍（副作用翻倍）；
 * B. 半开连接（没有 FIN/RST）只能靠「心跳发了没回帧」判死，否则频道静默失联；
 * C. 主动推送要区分「服务端受理 / 拒绝 / 没回执」，否则测试推送永远假绿灯。
 */

const { EventEmitter } = require('node:events');
const {
  createWecomChannelClient,
  HEARTBEAT_MS,
  DEAD_CONNECTION_MS
} = require('../../src/channels/wecom-client');

function fakeSocket() {
  const sock = new EventEmitter();
  sock.readyState = 1; // OPEN
  sock.sent = [];
  sock.send = (raw) => sock.sent.push(JSON.parse(raw));
  sock.close = () => {
    sock.readyState = 3;
    sock.emit('close', 1000);
  };
  sock.removeAllListeners = function removeAllListeners(...args) {
    EventEmitter.prototype.removeAllListeners.apply(this, args);
    return this;
  };
  return sock;
}

function makeClient(overrides = {}) {
  const sock = fakeSocket();
  const messages = [];
  const statuses = [];
  const client = createWecomChannelClient({
    channelId: 'ch_1',
    botId: 'bot',
    secret: 'sec',
    createSocket: () => sock,
    onMessage: (payload) => messages.push(payload),
    onStatus: (s) => statuses.push(s),
    ...overrides
  });
  client.start();
  sock.emit('open');
  return { client, sock, messages, statuses };
}

function msgFrame(reqId, text = '你好') {
  return JSON.stringify({
    cmd: 'aibot_msg_callback',
    headers: { req_id: reqId },
    body: { msgtype: 'text', text: { content: text }, from: { userid: 'zhangsan' }, chattype: 'single' }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('wecom client 时序', () => {
  it('同一条回调重投两次只派发一次', () => {
    const { sock, messages } = makeClient();
    sock.emit('message', msgFrame('req-1'));
    sock.emit('message', msgFrame('req-1'));
    sock.emit('message', msgFrame('req-2'));
    expect(messages.map((m) => m.reqId)).toEqual(['req-1', 'req-2']);
  });

  it('拿不到发送者时按 req_id 分桶，不把不同的人挤进一条会话', () => {
    const { sock, messages } = makeClient();
    sock.emit(
      'message',
      JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgtype: 'text', text: { content: 'a' } } })
    );
    sock.emit(
      'message',
      JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r2' }, body: { msgtype: 'text', text: { content: 'b' } } })
    );
    expect(messages[0].conversationKey).toBe('unknown:r1');
    expect(messages[1].conversationKey).toBe('unknown:r2');
  });

  it('半开连接：长时间没有任何回帧就主动重连', () => {
    vi.useFakeTimers();
    const sockets = [];
    makeClient({
      createSocket: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s;
      }
    });
    expect(sockets.length).toBe(1);
    // 连上并订阅，但之后一帧都不回（模拟静默丢包：TCP 还 OPEN，ws.send 一直「成功」）
    sockets[0].emit('open');
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(sockets.length).toBe(1); // 一个心跳周期内还没到判死门槛
    vi.advanceTimersByTime(DEAD_CONNECTION_MS);
    expect(sockets[0].readyState).toBe(3); // 判死后旧连接被摘掉
    vi.advanceTimersByTime(3_000); // 退避后重连
    expect(sockets.length).toBe(2);
  });

  it('主动推送：服务端回 errcode 时按拒绝上报，回 errcode=0 按受理', async () => {
    const { client, sock } = makeClient();
    const pending = client.sendProactiveText('single:zhangsan', '日报');
    const frame = sock.sent[sock.sent.length - 1];
    expect(frame.cmd).toBe('aibot_send_msg');
    expect(frame.body.msgtype).toBe('text');
    sock.emit(
      'message',
      JSON.stringify({ errcode: 0, headers: { req_id: frame.headers.req_id } })
    );
    await expect(pending).resolves.toMatchObject({ ok: true, ack: 'ok' });

    const rejected = client.sendProactiveText('single:zhangsan', '日报');
    const frame2 = sock.sent[sock.sent.length - 1];
    sock.emit(
      'message',
      JSON.stringify({ errcode: 93004, errmsg: 'invalid chatid', headers: { req_id: frame2.headers.req_id } })
    );
    await expect(rejected).resolves.toMatchObject({ ok: false, ack: 'rejected', errcode: 93004 });
  });

  it('主动推送：没等到回执算「已提交」，不能报失败', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    const pending = client.sendProactiveText('single:zhangsan', '日报');
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toMatchObject({ ok: true, ack: 'timeout' });
  });
});
