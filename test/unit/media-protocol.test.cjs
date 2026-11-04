'use strict';
/**
 * 媒体直出协议（`src/main/media-protocol.js`）。
 *
 * 守的语义：
 * 1. Range 语义正确：`bytes=a-b` / `bytes=a-` / `bytes=-N` 都翻成 Gateway 的
 *    `artifact.read_file{offset,maxBytes}`，并回 206 + `Content-Range: bytes a-b/总长`；
 * 2. **不重写白名单**：每一次取字节都只走 `artifact.read_file`（读权限仍在 Gateway），
 *    本模块自己不碰 fs；
 * 3. MIME 由扩展名决定（决定浏览器给 `<video>` 还是 `<audio>` 的解码器）；
 * 4. 边界不吞错：文件不存在 → 404，偏移越界 → 416，缺参数 → 400。
 */
const assert = require('node:assert/strict');

const {
  MEDIA_CHUNK_MAX_BYTES,
  mediaKindForPath,
  mediaMimeForPath,
  parseByteRange,
  createMediaProtocolHandler
} = require('../../src/main/media-protocol');

const VIDEO = Buffer.from('0123456789abcdefghijklmno'); // 25 字节
const AUDIO = Buffer.from('ID3-demo-audio-bytes');

/**
 * 假的 Gateway：只实现 artifact.read_file 的分块读语义（真实实现在 gateway）。
 * @param {Record<string, Buffer>} files
 */
function fakeGateway(files) {
  const calls = [];
  return {
    calls,
    async invokeRpc(method, params) {
      calls.push({ method, params });
      assert.equal(method, 'artifact.read_file', '媒体协议只许走 artifact.read_file');
      const buf = files[params.filePath];
      if (!buf) throw new Error('ENOENT: no such file or directory');
      const offset = Number(params.offset) || 0;
      const maxBytes = Number(params.maxBytes) || buf.length;
      const slice = buf.subarray(offset, offset + maxBytes);
      return {
        data: slice.toString('base64'),
        encoding: 'base64',
        path: params.filePath,
        size: buf.length,
        offset,
        truncated: offset + slice.length < buf.length
      };
    }
  };
}

function handlerFor(files, opts = {}) {
  const gateway = fakeGateway(files);
  return {
    gateway,
    handle: createMediaProtocolHandler({
      getLocalGateway: () => (opts.noGateway ? null : gateway),
      log: opts.log
    })
  };
}

function req(url, headers = {}, method = 'GET') {
  return new Request(url, { method, headers });
}

test('parseByteRange：闭区间 / 开区间 / 后缀 / 非法值', () => {
  assert.deepEqual(parseByteRange('bytes=0-99'), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=100-'), { start: 100, end: null });
  assert.deepEqual(parseByteRange('bytes=-500'), { suffix: 500 });
  assert.equal(parseByteRange(''), null);
  assert.equal(parseByteRange('items=0-1'), null);
  assert.equal(parseByteRange('bytes=abc-def'), null);
  assert.equal(parseByteRange('bytes=-'), null);
  assert.equal(parseByteRange('bytes=9-3'), null, 'end 小于 start 视为无效');
  // 多区间不支持（媒体元素不会发），按「没带 Range」处理
  assert.equal(parseByteRange('bytes=0-9,20-29'), null);
});

test('扩展名 → MIME / 播放器类型', () => {
  assert.equal(mediaMimeForPath('a/demo.mp4'), 'video/mp4');
  assert.equal(mediaMimeForPath('a/demo.MKV'), 'video/x-matroska');
  assert.equal(mediaMimeForPath('a/voice.mp3'), 'audio/mpeg');
  assert.equal(mediaMimeForPath('a/voice.flac'), 'audio/flac');
  assert.equal(mediaMimeForPath('a/shot.png'), '');
  assert.equal(mediaMimeForPath(''), '');
  assert.equal(mediaKindForPath('a/demo.mp4'), 'video');
  assert.equal(mediaKindForPath('a/voice.m4a'), 'audio');
  assert.equal(mediaKindForPath('a/shot.png'), '');
});

test('裸 GET：回 206 + 首段字节 + 总长（浏览器据此发起后续 Range）', async () => {
  const { gateway, handle } = handlerFor({ 'out/demo.mp4': VIDEO });
  const res = await handle(req('dieyun-media://file?p=out%2Fdemo.mp4'));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), `bytes 0-${VIDEO.length - 1}/${VIDEO.length}`);
  assert.equal(res.headers.get('content-length'), String(VIDEO.length));
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), VIDEO.toString());
  assert.equal(gateway.calls.length, 1, '不需要额外探测：一次分块读就带回 size');
  assert.equal(gateway.calls[0].params.offset, 0);
  assert.equal(gateway.calls[0].params.maxBytes, MEDIA_CHUNK_MAX_BYTES);
  assert.equal(gateway.calls[0].params.encoding, 'base64');
});

test('Range: bytes=a-b 只取这一段（拖动进度条即这条路径）', async () => {
  const { gateway, handle } = handlerFor({ 'out/demo.mp4': VIDEO });
  const res = await handle(req('dieyun-media://file?p=out%2Fdemo.mp4', { range: 'bytes=10-14' }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-14/${VIDEO.length}`);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'abcde');
  assert.equal(gateway.calls[0].params.offset, 10);
  assert.equal(gateway.calls[0].params.maxBytes, 5);
});

test('Range: bytes=a-（开区间）与 bytes=-N（后缀）', async () => {
  const open = handlerFor({ 'out/demo.mp4': VIDEO });
  const r1 = await open.handle(req('dieyun-media://file?p=out%2Fdemo.mp4', { range: 'bytes=20-' }));
  assert.equal(r1.headers.get('content-range'), `bytes 20-24/${VIDEO.length}`);
  assert.equal(Buffer.from(await r1.arrayBuffer()).toString(), 'klmno');

  const tail = handlerFor({ 'out/demo.mp4': VIDEO });
  const r2 = await tail.handle(req('dieyun-media://file?p=out%2Fdemo.mp4', { range: 'bytes=-5' }));
  assert.equal(r2.headers.get('content-range'), `bytes 20-24/${VIDEO.length}`);
  assert.equal(tail.gateway.calls.length, 2, '后缀区间要先探一次总长');
  assert.equal(tail.gateway.calls[0].params.maxBytes, 1, '探测只读 1 字节');
  assert.equal(tail.gateway.calls[1].params.offset, 20);
});

test('音频：Content-Type 决定解码器', async () => {
  const { handle } = handlerFor({ 'out/voice.mp3': AUDIO });
  const res = await handle(req('dieyun-media://file?p=out%2Fvoice.mp3'));
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.status, 206);
});

test('HEAD 只回头（不带正文）', async () => {
  const { handle } = handlerFor({ 'out/demo.mp4': VIDEO });
  const res = await handle(req('dieyun-media://file?p=out%2Fdemo.mp4', {}, 'HEAD'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(VIDEO.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('偏移越界 → 416；文件不存在 → 404；缺路径 → 400；Gateway 未就绪 → 503', async () => {
  const { handle } = handlerFor({ 'out/demo.mp4': VIDEO });
  const res416 = await handle(req('dieyun-media://file?p=out%2Fdemo.mp4', { range: 'bytes=100-' }));
  assert.equal(res416.status, 416);
  assert.equal(res416.headers.get('content-range'), `bytes */${VIDEO.length}`);

  const res404 = await handle(req('dieyun-media://file?p=out%2Fmissing.mp4'));
  assert.equal(res404.status, 404);

  const res400 = await handle(req('dieyun-media://file'));
  assert.equal(res400.status, 400);

  const noGw = handlerFor({}, { noGateway: true });
  const res503 = await noGw.handle(req('dieyun-media://file?p=out%2Fdemo.mp4'));
  assert.equal(res503.status, 503);
});

test('会话 / 工作区上下文原样带给 Gateway（多工作区与远端会话靠它定位）', async () => {
  const { gateway, handle } = handlerFor({ 'out/demo.mp4': VIDEO });
  await handle(
    req('dieyun-media://file?p=out%2Fdemo.mp4&s=s-123&w=D%3A%5Cws%5Cproj')
  );
  assert.equal(gateway.calls[0].params.sessionId, 's-123');
  assert.equal(gateway.calls[0].params.runWorkspaceRoot, 'D:\\ws\\proj');
});
