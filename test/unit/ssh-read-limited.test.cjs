'use strict';

/**
 * `sftpReadFile` 的「读前 N 字节」曾经是坏的：
 *
 *   read += c.length;
 *   if (read <= limit) chunks.push(c);   // ← 跨过 limit 的那一整块被丢掉
 *
 * SFTP 的 ReadStream 按 ~64KB 一块交付，所以 `maxBytes=4096` 读一个 1MB 文件返回的是
 * **空内容**；而且到限不停流，只要 2MB 也要把整个文件走完。这里用假流复刻这两种形状：
 * 大块一到就超限、以及大文件必须「够数就停」。
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { readLimitedFromStream } = require('../../src/ssh/read-limited');

/** ssh2 ReadStream 替身：手动 push 数据块，destroy 记在案。 */
function fakeStream() {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = () => {
    stream.destroyed = true;
    stream.emit('close');
  };
  return stream;
}

describe('readLimitedFromStream（远端 fs 读取的唯一实现）', () => {
  it('第一块就超过 limit 时切出 limit 字节，而不是返回空内容', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 4097);
    s.emit('data', Buffer.alloc(64 * 1024, 0x61)); // ~64KB 一块
    const r = await p;
    assert.equal(r.buf.length, 4097);
    assert.equal(r.truncated, true);
    assert.equal(r.buf.toString('utf8'), 'a'.repeat(4097));
    assert.equal(s.destroyed, true, '够数必须立刻停流，不能把整个文件走完');
  });

  it('File 比 limit 短：读满全部内容且不标 truncated', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 1024);
    s.emit('data', Buffer.from('hello '));
    s.emit('data', Buffer.from('world'));
    s.emit('end');
    const r = await p;
    assert.equal(r.buf.toString('utf8'), 'hello world');
    assert.equal(r.truncated, false);
    assert.equal(r.read, 11);
    assert.equal(s.destroyed, false);
  });

  it('分块边界落在 limit 中间：切掉多余部分且只读一次多余块', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 10);
    s.emit('data', Buffer.from('0123456'));
    s.emit('data', Buffer.from('789ABCDEF')); // 第二块只有前 3 字节该留下
    const r = await p;
    assert.equal(r.buf.toString('utf8'), '0123456789');
    assert.equal(r.truncated, true);
    assert.equal(s.destroyed, true);
  });

  it('文件正好等于 limit：truncated 为 true（调用方传 maxBytes+1，等于说明还有更多）', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 4);
    s.emit('data', Buffer.from('abcd'));
    s.emit('end');
    const r = await p;
    assert.equal(r.buf.toString('utf8'), 'abcd');
    assert.equal(r.truncated, true);
  });

  it('流报错时 reject，不静默返回半截内容', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 100);
    const boom = Object.assign(new Error('no such file'), { code: 2 });
    s.emit('error', boom);
    await assert.rejects(p, (e) => e === boom);
  });

  it('只发 close 不发 end（对端直接关掉）时按已读内容收尾', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 100);
    s.emit('data', Buffer.from('partial'));
    s.emit('close');
    const r = await p;
    assert.equal(r.buf.toString('utf8'), 'partial');
    assert.equal(r.truncated, false);
  });

  it('停流之后迟到的 data 不再影响结果，也不会二次 resolve', async () => {
    const s = fakeStream();
    const p = readLimitedFromStream(s, 3);
    s.emit('data', Buffer.from('abcdef'));
    s.emit('data', Buffer.from('ghijkl'));
    const r = await p;
    assert.equal(r.buf.length, 3);
    assert.equal(r.truncated, true);
  });

  it('limit 非法（0 / undefined）时按 1 字节兜底，不会变成无限读', async () => {
    for (const bad of [0, undefined, null, -5]) {
      const s = fakeStream();
      const p = readLimitedFromStream(s, bad);
      s.emit('data', Buffer.from('xyz'));
      const r = await p;
      assert.equal(r.buf.toString('utf8'), 'x', `limit=${bad} 应兜底为 1`);
    }
  });
});
