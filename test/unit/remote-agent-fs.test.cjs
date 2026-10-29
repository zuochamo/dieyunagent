'use strict';
/**
 * 走 RPC 的远端 fs 适配器（P4）。
 *
 * 锁的是三件事：
 *  1. 参数/返回形状与 SFTP 版**同一个接口**（调用方不该察觉换传输）；
 *  2. 写文件只发一次 RPC —— 以前 SFTP 路径是「整读一遍算 diff → 写 → 再补通知」，
 *     RPC 路径的 diff 与增量索引都在远端算；
 *  3. 路径白名单在本地先判一次（远端会再用同一份规则判一次，不是两套规则）。
 */
const assert = require('node:assert/strict');

const { createRemoteAgentFsAdapter } = require('../../src/gateway/remote-agent-fs');
const { createRemoteFsAdapter } = require('../../src/gateway/remote-fs');
const { DEFAULT_READ_MAX_BYTES } = require('../../src/gateway/fs-read-limits');

const WS = '/srv/projA';
const HOME = '/home/dieyunx';

function makeAdapter(responder) {
  const calls = [];
  const adapter = createRemoteAgentFsAdapter(
    { key: 'sock#/srv/projA', openChannel: () => Promise.resolve(null) },
    { kind: 'ssh', remotePath: WS },
    {
      roots: [WS, HOME, '/tmp'],
      call: async (method, params) => {
        calls.push({ method, params });
        return responder ? responder(method, params) : {};
      }
    }
  );
  return { adapter, calls };
}

describe('transport 标识（决定「要不要补增量索引通知」）', () => {
  it('RPC 适配器 = rpc；SFTP 适配器 = sftp', () => {
    const { adapter } = makeAdapter();
    assert.equal(adapter.transport, 'rpc');
    const sftp = createRemoteFsAdapter({}, { kind: 'ssh', remotePath: WS }, { roots: [WS] });
    assert.equal(sftp.transport, 'sftp');
  });

  it('两边暴露同一组方法', () => {
    const { adapter } = makeAdapter();
    const sftp = createRemoteFsAdapter({}, { kind: 'ssh', remotePath: WS }, { roots: [WS] });
    const iface = ['readFile', 'writeFile', 'listDir', 'stat', 'mkdir', 'listArtifactFiles', 'resolve'];
    for (const m of iface) {
      assert.equal(typeof adapter[m], 'function', `rpc 缺 ${m}`);
      assert.equal(typeof sftp[m], 'function', `sftp 缺 ${m}`);
    }
  });
});

describe('readFile / writeFile', () => {
  it('readFile 传绝对路径 + 规范化后的 offset/maxBytes，返回带 remote', async () => {
    const { adapter, calls } = makeAdapter(() => ({
      data: 'hello',
      encoding: 'utf8',
      path: `${WS}/a.js`,
      size: 5,
      offset: 0,
      truncated: false
    }));
    const res = await adapter.readFile('a.js', 'utf8');
    assert.deepEqual(calls, [
      {
        method: 'fs.read_file',
        params: { filePath: `${WS}/a.js`, encoding: 'utf8', offset: 0, maxBytes: DEFAULT_READ_MAX_BYTES }
      }
    ]);
    assert.equal(res.data, 'hello');
    assert.equal(res.remote, true);
  });

  it('writeFile 只发一次 RPC（diff 由远端算，不再整读一遍）', async () => {
    const { adapter, calls } = makeAdapter(() => ({
      ok: true,
      path: `${WS}/a.js`,
      diff: { added: 1, removed: 0 }
    }));
    const res = await adapter.writeFile('a.js', 'new content\n', 'utf8');
    assert.equal(calls.length, 1, `期望 1 次 RPC，实际 ${calls.map((c) => c.method).join(',')}`);
    assert.equal(calls[0].method, 'fs.write_file');
    assert.equal(calls[0].params.filePath, `${WS}/a.js`);
    assert.equal(calls[0].params.encoding, 'utf8');
    assert.deepEqual(res.diff, { added: 1, removed: 0 });
    assert.equal(res.remote, true);
  });

  it('远端报错原样上抛（错误码不许在适配器里被吞）', async () => {
    const { adapter } = makeAdapter(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await assert.rejects(() => adapter.readFile('missing.js', 'utf8'), /ENOENT/);
  });
});

describe('listDir / stat / mkdir', () => {
  it('listDir 归一成 { name, isDirectory, size, mtimeMs }', async () => {
    const { adapter } = makeAdapter(() => [
      { name: 'src', isDirectory: true, size: 4096, mtimeMs: 111 },
      { name: 'a.js', isDirectory: false, size: 12, mtimeMs: 222 }
    ]);
    const rows = await adapter.listDir('.');
    assert.deepEqual(rows, [
      { name: 'src', isDirectory: true, size: 4096, mtimeMs: 111 },
      { name: 'a.js', isDirectory: false, size: 12, mtimeMs: 222 }
    ]);
  });

  it('stat 给出 isFile/isDirectory/size/mtimeMs', async () => {
    const { adapter } = makeAdapter(() => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 9 }));
    assert.deepEqual(await adapter.stat('a.js'), { isFile: true, isDirectory: false, size: 7, mtimeMs: 9 });
  });

  it('mkdir 打到 fs.mkdir 且返回 remote', async () => {
    const { adapter, calls } = makeAdapter(() => ({ ok: true, path: `${WS}/sub` }));
    const res = await adapter.mkdir('sub');
    assert.equal(calls[0].method, 'fs.mkdir');
    assert.equal(res.remote, true);
  });
});

describe('路径白名单（本地先判一次，远端同一份规则再判一次）', () => {
  it('工作空间 / HOME / /tmp 都放行，并解析成绝对路径', () => {
    const { adapter } = makeAdapter();
    assert.equal(adapter.resolve('a.js'), `${WS}/a.js`);
    assert.equal(adapter.resolve(`${HOME}/.dieyun/workspace/shot.png`), `${HOME}/.dieyun/workspace/shot.png`);
    assert.equal(adapter.resolve('/tmp/x.log'), '/tmp/x.log');
  });

  it('白名单外直接拒绝（PATH_NOT_ALLOWED），不发 RPC', async () => {
    const { adapter, calls } = makeAdapter();
    await assert.rejects(
      () => adapter.readFile('/etc/passwd', 'utf8'),
      (err) => err.code === 'PATH_NOT_ALLOWED'
    );
    assert.deepEqual(calls, []);
  });
});

describe('listArtifactFiles（遍历规则复用 artifact-scan）', () => {
  it('用 fs.list_dir 当 readdir，结果标 remote', async () => {
    const { adapter, calls } = makeAdapter((method, params) => {
      if (method !== 'fs.list_dir') return {};
      if (params.dirPath === WS) {
        return [
          { name: 'a.js', isDirectory: false, size: 10, mtimeMs: 2000 },
          { name: 'b.md', isDirectory: false, size: 20, mtimeMs: 3000 },
          { name: 'node_modules', isDirectory: true, size: 4096, mtimeMs: 1000 }
        ];
      }
      return [];
    });
    const res = await adapter.listArtifactFiles(10);
    assert.ok(res.files.length >= 2, `应扫到两个文件，实际 ${res.files.length}`);
    assert.ok(res.files.every((f) => f.remote === true));
    assert.ok(res.files.every((f) => !String(f.path || f.name).includes('node_modules')));
    assert.ok(calls.every((c) => c.method === 'fs.list_dir'), '遍历只该用 fs.list_dir');
  });
});
