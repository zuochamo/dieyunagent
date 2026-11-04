'use strict';
/**
 * 媒体 URL 契约（`src/renderer/renderer-artifacts.js` ↔ `src/main/media-protocol.js`）。
 *
 * 跨进程唯一耦合点就是这条 URL 的形状：`dieyun-media://file?p=<路径>&s=<会话>&w=<工作区>`。
 * 所以这里不各测一边，而是**用渲染进程造 URL、交给 Main 的协议处理器消费**，看 Gateway
 * 最终收到什么 —— 参数改名没同步、编码没对齐，这个测试就会红。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createMediaProtocolHandler } = require('../../src/main/media-protocol');

const ARTIFACTS_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-artifacts.js');

/** 万能桩：能取值、能调用、能赋属性 —— 只为让整个渲染器模块装载起来（不测它的 DOM 行为） */
function universalStub() {
  const fn = function () {
    return stub;
  };
  const stub = new Proxy(fn, {
    get(_t, key) {
      if (key === 'then') return undefined;
      if (key === 'length') return 0;
      if (key === Symbol.toPrimitive) return () => '';
      return fn;
    },
    apply() {
      return stub;
    },
    set() {
      return true;
    }
  });
  return stub;
}

/** 按真实源码装载 renderer-artifacts.js，导出媒体相关函数（不在测试里另写一份 URL 逻辑） */
function loadArtifacts() {
  const source = fs.readFileSync(ARTIFACTS_SRC, 'utf8');
  const base = { window: {}, document: universalStub(), console };
  const scope = new Proxy(base, {
    has: () => true,
    // 真全局（String / encodeURIComponent / Number …）照常可用，缺的渲染器全局才给桩
    get: (t, k) => (k in t ? t[k] : k in globalThis ? globalThis[k] : universalStub()),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    }
  });
  vm.createContext(scope);
  vm.runInContext(source, scope, { filename: 'renderer-artifacts.js' });
  return {
    mediaArtifactKind: scope.mediaArtifactKind,
    artifactMediaUrl: scope.artifactMediaUrl
  };
}

const art = loadArtifacts();

test('扩展名判定：视频 / 音频 / 非媒体', () => {
  assert.equal(art.mediaArtifactKind('out/demo.mp4'), 'video');
  assert.equal(art.mediaArtifactKind('out/demo.MOV'), 'video');
  assert.equal(art.mediaArtifactKind('out/voice.mp3'), 'audio');
  assert.equal(art.mediaArtifactKind('out/voice.flac'), 'audio');
  assert.equal(art.mediaArtifactKind('out/shot.png'), '');
  assert.equal(art.mediaArtifactKind('out/report.docx'), '');
  assert.equal(art.mediaArtifactKind(''), '');
});

test('URL 形状：p / s / w 三个参数，路径做 URL 编码', () => {
  assert.equal(art.artifactMediaUrl('out/a.mp4'), 'dieyun-media://file?p=out%2Fa.mp4');
  assert.equal(
    art.artifactMediaUrl('D:\\项目\\演示.mp4', { sessionId: 's-1' }),
    'dieyun-media://file?p=D%3A%5C%E9%A1%B9%E7%9B%AE%5C%E6%BC%94%E7%A4%BA.mp4&s=s-1'
  );
  assert.match(
    art.artifactMediaUrl('out/a.mp4', { sessionId: 's-1', workspacePath: 'D:\\ws' }),
    /&w=D%3A%5Cws$/
  );
});

test('渲染进程造的 URL 交给 Main 协议处理器：Gateway 收到正确的分块参数', async () => {
  const bytes = Buffer.from('0123456789');
  const calls = [];
  const handle = createMediaProtocolHandler({
    getLocalGateway: () => ({
      async invokeRpc(method, params) {
        calls.push({ method, params });
        const offset = Number(params.offset) || 0;
        const maxBytes = Number(params.maxBytes) || bytes.length;
        const slice = bytes.subarray(offset, offset + maxBytes);
        return { data: slice.toString('base64'), size: bytes.length, offset, path: params.filePath };
      }
    })
  });

  const url = art.artifactMediaUrl('数据/demo.mp4', {
    sessionId: 's-9',
    workspacePath: 'D:\\ws'
  });
  const res = await handle(new Request(url, { headers: { range: 'bytes=4-6' } }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '456');
  assert.deepEqual(calls[0].params, {
    filePath: '数据/demo.mp4',
    encoding: 'base64',
    offset: 4,
    maxBytes: 3,
    sessionId: 's-9',
    runWorkspaceRoot: 'D:\\ws'
  });
});

test('非 http(s) 之外的媒体路径不会被当成外链：URL 里保留原始相对路径', async () => {
  const url = art.artifactMediaUrl('.dieyun/tool-output/vision/ab/x.mp3');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('p'), '.dieyun/tool-output/vision/ab/x.mp3');
  assert.equal(parsed.searchParams.get('s'), null);
});
