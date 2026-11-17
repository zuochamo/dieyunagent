'use strict';

/**
 * 浏览器产物的落盘/上传也要认「本机 vs 会话工作空间」（`local:` 前缀）。
 *
 * 内置浏览器跑在本机：截图 / PDF / HAR 可以落到远端工作区（默认，跟随会话），
 * 也可以落到**本机**磁盘（`local:`）—— SSH 会话里后者是唯一能把产物交到用户手上的方式。
 * 上传方向只有一个：上传的永远是本机文件，所以远端路径必须明确拒绝并给出替代路径
 * （否则会被当相对路径拼成越界，报一句与病因无关的 PATH_NOT_ALLOWED）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBrowserHandlers } = require('../../src/gateway/handlers/browser');
const { decideFsTarget } = require('../../src/gateway/host-local');
const { normalizeFilePathInput } = require('../../src/gateway/host-control');
const { assertAllowedPath } = require('../../src/gateway/path-policy');

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

function makeRemote() {
  const calls = { writeFile: [], readFile: [] };
  return {
    transport: 'rpc',
    root: '/srv/app',
    calls,
    resolve: (p, base) => (String(p).startsWith('/') ? String(p) : `${base || '/srv/app'}/${p}`),
    writeFile: async (p, data, enc) => {
      calls.writeFile.push({ p, enc });
      return { ok: true, path: p };
    }
  };
}

function makeHandlers({ remote = null, allowedRoots = [] } = {}) {
  const calls = { screenshot: [], upload: [], sandboxWrites: [] };
  const handlers = createBrowserHandlers({
    assertBrowserEnabled: () => {},
    resolveFsTarget: (p) =>
      decideFsTarget(p, {
        remote,
        defaultCwd: allowedRoots[0] || null,
        sessionCwd: remote ? '/srv/app' : allowedRoots[0] || null
      }),
    roots: allowedRoots,
    writable: allowedRoots,
    writeRootsForCall: () => allowedRoots,
    readRootsForCall: () => allowedRoots,
    defaultCwd: allowedRoots[0],
    normalizeFilePathInput,
    assertAllowedPath,
    assertSandboxWritable: async (p, tool, opts) =>
      calls.sandboxWrites.push({ p, tool, remote: !!(opts && opts.remote) }),
    browser: {
      screenshot: async (params) => {
        calls.screenshot.push(params);
        return { ok: true, base64: PNG_BASE64, mime: 'image/png', width: 4, height: 4 };
      },
      uploadFile: async (params) => {
        calls.upload.push(params);
        return { ok: true };
      }
    }
  });
  return { handlers, calls };
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-browser-local-'));
});

describe('browser_screenshot 落盘', () => {
  it('local: 前缀 → 落到本机磁盘（过本机沙箱与写白名单），不写远端', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHandlers({ remote, allowedRoots: [dir] });
    const dest = path.join(dir, 'shot.png');
    const out = await handlers['browser.screenshot']({ filePath: `local:${dest}` });
    expect(remote.calls.writeFile).toHaveLength(0);
    expect(calls.sandboxWrites.map((c) => c.tool)).toEqual(['browser_artifact']);
    expect(fs.readFileSync(dest).length).toBeGreaterThan(0);
    expect(out.path).toBe(dest);
  });

  it('不带前缀 → 仍写到远端工作区，并且过远端档位判定（remote:true）', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHandlers({ remote, allowedRoots: [dir] });
    const out = await handlers['browser.screenshot']({ filePath: 'shots/a.png' });
    expect(remote.calls.writeFile).toHaveLength(1);
    expect(remote.calls.writeFile[0].p).toBe('shots/a.png');
    // 远端产物落盘与 fs.write_file 同一条档位链（按远端绝对路径判）
    expect(calls.sandboxWrites).toHaveLength(1);
    expect(calls.sandboxWrites[0]).toMatchObject({
      tool: 'browser_artifact',
      remote: true
    });
    expect(calls.sandboxWrites[0].p).toContain('shots/a.png');
    expect(out.path).toBe('shots/a.png');
  });
});

describe('browser_upload_file 的机器边界', () => {
  it('local: 前缀 → 上传本机文件（绝对路径）', async () => {
    const remote = makeRemote();
    const local = path.join(dir, 'a.pdf');
    fs.writeFileSync(local, 'x');
    const { handlers, calls } = makeHandlers({ remote, allowedRoots: [dir] });
    await handlers['browser.upload_file']({ ref: 'e1', filePath: `local:${local}` });
    expect(calls.upload[0].filePath).toBe(local);
  });

  it('远端路径 → 明确拒绝（浏览器在本机），并给出 local: / host_exec 两条替代路径', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHandlers({ remote, allowedRoots: [dir] });
    await expect(
      handlers['browser.upload_file']({ ref: 'e1', filePath: '/srv/app/a.pdf' })
    ).rejects.toMatchObject({
      code: 'BROWSER_UPLOAD_LOCAL_ONLY',
      retryable: false,
      suggestedFix: expect.stringContaining('local:')
    });
    expect(calls.upload).toHaveLength(0);
  });
});
