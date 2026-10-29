'use strict';

/**
 * SFTP 传输算 diff 时不许用**被截断的**旧内容。
 *
 * `readFile` 按 `maxBytes` 截断（大文件是常态）。拿前 2MB 去当「改动前」，再和整份新内容
 * 比行差异，结果是一堆假的 added/removed —— 前端改动摘要与 undo 快照都建在这个数字上。
 * 读不全就明确不给 diff（null），而不是给一个看起来精确的错数。
 */
const assert = require('node:assert/strict');

const { createRemoteFsAdapter } = require('../../src/gateway/remote-fs');

const TARGET = { kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: '/srv/ws' };

function fakeSsh({ prevText, prevTruncated = false } = {}) {
  const writes = [];
  return {
    writes,
    sftpStat: async () => ({ size: prevText ? prevText.length : 0, mode: 0o100644, mtime: 0 }),
    sftpReadFile: async () => ({
      buf: Buffer.from(prevText || '', 'utf8'),
      truncated: prevTruncated,
      read: (prevText || '').length
    }),
    sftpWriteFile: async (p, buf) => {
      writes.push({ path: p, text: buf.toString('utf8') });
    },
    sftpMkdirp: async () => {}
  };
}

describe('SFTP writeFile 的 diff', () => {
  it('旧内容完整读到时照常算 diff', async () => {
    const ssh = fakeSsh({ prevText: 'a\nb\nc\n' });
    const fs = createRemoteFsAdapter(ssh, TARGET);
    const res = await fs.writeFile('/srv/ws/f.txt', 'a\nB\nc\n');
    assert.ok(res.diff, '读全了就该有 diff');
    assert.equal(res.diff.added, 1);
    assert.equal(res.diff.removed, 1);
  });

  it('旧内容被截断时不给 diff（不拿前缀冒充全文）', async () => {
    const ssh = fakeSsh({ prevText: 'a\nb\nc\n', prevTruncated: true });
    const fs = createRemoteFsAdapter(ssh, TARGET);
    const res = await fs.writeFile('/srv/ws/f.txt', 'a\nB\nc\n');
    assert.equal(res.diff, null, '截断的旧内容算出的 diff 是假的，必须为 null');
    assert.equal(ssh.writes.length, 1, '写本身照旧要成功');
    assert.equal(res.ok, true);
  });

  it('文件不存在时按「新建」算（全新增），不影响写入', async () => {
    const ssh = fakeSsh({});
    ssh.sftpReadFile = async () => {
      throw Object.assign(new Error('No such file'), { code: 2 });
    };
    const fs = createRemoteFsAdapter(ssh, TARGET);
    const res = await fs.writeFile('/srv/ws/new.txt', 'x\n');
    assert.ok(res.diff, '新文件 = 全新增（既有语义），不是 null');
    assert.equal(res.diff.removed, 0);
    assert.ok(res.diff.added >= 1);
    assert.equal(ssh.writes[0].text, 'x\n');
  });
});
