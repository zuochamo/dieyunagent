'use strict';

/**
 * 媒体（音频 / 视频）直出协议：`dieyun-media://file?p=<路径>&s=<sessionId>`
 *
 * 为什么需要它（而不是像图片那样内联 base64）：
 *   图片 ≤3MB，一次读完塞进 blob URL 没问题；视频动辄几十上百 MB，base64 再涨 33%，
 *   一次性读进渲染进程既炸内存也不支持拖动进度。媒体要的是**可 seek 的 URL**，
 *   也就是 HTTP 那套 Range 语义 —— 所以这里给它一个自定义协议，按 Range 分块取字节。
 *
 * 字节从哪来：**不在这里重写白名单**。每一次分块都走 Gateway 的既有 RPC
 * `artifact.read_file`（offset / maxBytes），读权限、工作区根、远端映射全在 Gateway 里，
 * 本文件只是把「Range 请求」翻译成「几次分块读」。远端工作区也因此同样能播（字节经远端
 * agent 传输回来），且没有第二份路径策略。
 *
 * 注册时机：`registerMediaScheme()` 必须在 app ready **之前**调用（Electron 的硬性要求）；
 * `attachMediaProtocol()` 在 ready 之后、拿到 localGateway 时调用。
 *
 * 渲染进程侧镜像同一份扩展名知识（`renderer-artifacts.js:MEDIA_ARTIFACT_RE`）：
 * 跨进程无法共享模块，与 `IMAGE_ARTIFACT_RE` 的既有做法一致。
 */

/** 协议名：渲染进程拼 URL 时用的就是它 */
const MEDIA_SCHEME = 'dieyun-media';
/** 单次分块上限：拖动进度条时浏览器会连着发几个 Range，块太小=请求多，太大=首帧慢 */
const MEDIA_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
/** 读一块字节的超时（远端会话经 SSH 传输，给足余量） */
const MEDIA_READ_TIMEOUT_MS = 30 * 1000;

/** 扩展名 → MIME（只列真正会内联播放的容器；Electron 自带 Chrome 版 ffmpeg，H.264/AAC 可用） */
const MEDIA_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac'
};

function mediaExtOf(filePath) {
  const p = String(filePath || '').trim().toLowerCase();
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i + 1) : '';
}

function mediaMimeForPath(filePath) {
  return MEDIA_MIME[mediaExtOf(filePath)] || '';
}

/** 'video' | 'audio' | '' —— 决定渲染成 <video> 还是 <audio> */
function mediaKindForPath(filePath) {
  const mime = mediaMimeForPath(filePath);
  if (!mime) return '';
  return mime.startsWith('video/') ? 'video' : 'audio';
}

/**
 * 解析 `Range: bytes=...`。
 * @returns {{ start?: number, end?: number|null, suffix?: number } | null} 无法识别/没带 → null
 */
function parseByteRange(headerValue) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(headerValue || '').trim());
  if (!m) return null;
  const rawStart = m[1];
  const rawEnd = m[2];
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { suffix };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!rawEnd) return { start, end: null };
  const end = Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function registerMediaScheme() {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // 媒体元素要求 scheme 可流式：缺了它 Chromium 会以 URL safety check 拒播
        stream: true
      }
    }
  ]);
}

/**
 * 把一次 Range 请求翻译成一次分块读，并拼出 206 响应。
 * @param {{ getLocalGateway: () => any, log?: (msg: string) => void }} deps
 */
function createMediaProtocolHandler({ getLocalGateway, log }) {
  const warn = typeof log === 'function' ? log : () => {};

  async function readChunk(gateway, { filePath, offset, maxBytes, sessionId, workspacePath }) {
    const params = { filePath, encoding: 'base64', offset, maxBytes };
    if (sessionId) params.sessionId = sessionId;
    // 与渲染进程的 RPC 同一套上下文：多工作区 / 远端会话靠它定位到正确的目录
    if (workspacePath) params.runWorkspaceRoot = workspacePath;
    return gateway.invokeRpc('artifact.read_file', params, { timeoutMs: MEDIA_READ_TIMEOUT_MS });
  }

  function respondError(status, message) {
    return new Response(String(message || ''), {
      status,
      headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  return async function handleMediaRequest(request) {
    const gateway = getLocalGateway();
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      return respondError(503, 'gateway not ready');
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return respondError(400, 'bad url');
    }
    const filePath = String(url.searchParams.get('p') || '').trim();
    const sessionId = String(url.searchParams.get('s') || '').trim();
    const workspacePath = String(url.searchParams.get('w') || '').trim();
    if (!filePath) return respondError(400, 'missing p');

    const mime = mediaMimeForPath(filePath) || 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      // 边播边改的文件（正在写的录屏）不能被缓存住
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    };

    let wanted = parseByteRange(request.headers.get('range') || '');

    try {
      // 后缀区间（`bytes=-N`）要先知道总长才能定位
      if (wanted && wanted.suffix) {
        const tail = await readChunk(gateway, {
          filePath,
          offset: 0,
          maxBytes: 1,
          sessionId,
          workspacePath
        });
        const size = Number(tail && tail.size) || 0;
        if (!size) return respondError(416, 'unknown size');
        wanted = { start: Math.max(0, size - wanted.suffix), end: null };
      }

      const start = wanted ? wanted.start : 0;
      const wantBytes =
        wanted && wanted.end != null ? Math.max(1, wanted.end - start + 1) : MEDIA_CHUNK_MAX_BYTES;

      const res = await readChunk(gateway, {
        filePath,
        offset: start,
        maxBytes: Math.min(wantBytes, MEDIA_CHUNK_MAX_BYTES),
        sessionId,
        workspacePath
      });
      const base64 = String((res && res.data) || '');
      const size = Number(res && res.size) || 0;
      const buf = base64 ? Buffer.from(base64, 'base64') : Buffer.alloc(0);

      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(size || 0) }
        });
      }
      if (size && start >= size) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` }
        });
      }
      if (!buf.length) return respondError(404, 'empty or unreadable');

      const end = start + buf.length - 1;
      const headers = { ...baseHeaders, 'Content-Length': String(buf.length) };
      if (size) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      // 没带 Range 的裸 GET 也回 206：媒体元素下一次就会带 Range 来，语义一致
      return new Response(buf, { status: size ? 206 : 200, headers });
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      warn(`[media] ${filePath} 读取失败: ${msg}`);
      const missing = /ENOENT|not found|不存在|No such file|EACCES|denied|不允许/i.test(msg);
      return respondError(missing ? 404 : 500, msg.slice(0, 200));
    }
  };
}

function attachMediaProtocol(deps) {
  const { protocol } = require('electron');
  protocol.handle(MEDIA_SCHEME, createMediaProtocolHandler(deps));
}

module.exports = {
  MEDIA_SCHEME,
  MEDIA_CHUNK_MAX_BYTES,
  MEDIA_READ_TIMEOUT_MS,
  MEDIA_MIME,
  mediaMimeForPath,
  mediaKindForPath,
  parseByteRange,
  createMediaProtocolHandler,
  registerMediaScheme,
  attachMediaProtocol
};
