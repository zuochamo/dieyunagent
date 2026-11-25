'use strict';

/**
 * 「本机摄像头」的唯一出口：把一次「看一眼」变成一张 JPEG，或一句说清原因的错误。
 *
 * 与 `mobile/camera-source.js` 的分工：
 * ```
 * 手机摄像头（camera_look）        走 MobileBridge → 手机原生相机
 * 本机摄像头（desktop_camera_look）走 ffmpeg 抓一帧 → 本文件
 * ```
 * 两者都汇入同一条视觉通道（`browser-vision.js` 的 source 机制），额度各自独立计。
 *
 * 三条硬约束（与手机端同源）：
 * - **一次一张**：不做视频流、不做常开预览。要再看就再拍。
 * - **不落盘**：画面直接进内存 → base64 → 视觉缓冲。现实画面留副本等于把摄像头
 *   变成一台没人要求的录音笔（见 `vision-image.js#visionCameraText`）。
 * - **不编造**：任何失败都返回 `{ ok: false, errorCode, error }`，绝不吐空图/占位图。
 *
 * 为什么用 ffmpeg 而不是 Electron 的 getUserMedia：工具执行在 Main（`tool-bridge-main`），
 * 而 getUserMedia 只在渲染进程可用 —— 要么把抓图逻辑塞进 Renderer（工具得绕一圈 IPC，
 * 还得给应用自己的页面开 media 权限），要么在 Main 里直接取流。ffmpeg 是后者，
 * 一条命令、无窗口、无权限交互，且 Windows(dshow)/macOS(avfoundation)/Linux(v4l2) 同一套形状。
 * 代价是要有 ffmpeg：`DIEYUN_FFMPEG` 指定，或 PATH 里有；找不到就如实说
 * `DESKTOP_CAMERA_NO_FFMPEG`，不静默失败。
 *
 * 设备选择：默认挑第一台**非虚拟**摄像头（虚拟摄像头是 OBS/会议软件的产物，
 * 当「眼睛」看现实世界没有意义）；多摄像头机器用 `DIEYUN_DESKTOP_CAMERA=<设备名>` 指定。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

/**
 * 单张 base64 硬顶：与上游视觉预算**同一来源**（`agent-limits` 的 `visionMaxBase64Chars`）。
 *
 * 这里只是同步兜底（超过说明没压缩，直接拒）；真正按设置值裁决的是
 * `browser-vision.js#resolveVisionLimits`。以前这里是自写一份 `8 * 1024 * 1024`，
 * 比共享上限大一倍 —— 用户把 `visionMaxBase64Chars` 调小对摄像头路径静默无效。
 */
const MAX_BASE64_CHARS = AGENT_LIMITS_DEFAULTS.visionMaxBase64Chars;

/** ffmpeg 抓一帧的默认输出质量（MJPEG qscale）。3 ≈ 视觉无损但对模型足够。 */
const JPEG_QUALITY = 3;

function fail(errorCode, error, extra = {}) {
  return { ok: false, errorCode, error, retryable: false, ...extra };
}

/**
 * 找 ffmpeg：`DIEYUN_FFMPEG` → PATH。
 *
 * 只做「存不存在」的判断，不猜版本：版本差异由命令参数本身兜住（下面用的都是十年稳定的老参数）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 可执行文件路径；找不到返回空串
 */
function resolveFfmpegPath(env = process.env) {
  const explicit = String((env && env.DIEYUN_FFMPEG) || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `ffmpeg${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 无权限/坏路径：继续找 */
      }
    }
  }
  return '';
}

/**
 * 每个平台的 ffmpeg 输入形状（唯一定义处）。
 *
 * 三行差异全在这张表里：Windows 要设备名、macOS 要索引、Linux 要设备节点。
 * 抓帧与缩放参数三者共用，因此不写三份。
 */
const BACKENDS = Object.freeze({
  win32: Object.freeze({
    inputFormat: 'dshow',
    listArgs: ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    /** dshow 的 `[dshow @ …] "名称" (video)` → 名称 */
    parseList: (text) =>
      String(text)
        .split(/\r?\n/)
        .map((line) => line.match(/"([^"]+)"\s*\(video\)/))
        .filter(Boolean)
        .map((m) => m[1].trim()),
    inputFor: (device) => `video=${device}`,
    // `\bobs\b` 而不是 `obs`：OBSBOT 是真实摄像头品牌，泛匹配会把它当虚拟设备筛掉。
    isVirtual: (name) => /\bvirtual\b|\bobs\b|manycam|snap camera|droidcam/i.test(String(name || ''))
  }),
  darwin: Object.freeze({
    inputFormat: 'avfoundation',
    listArgs: ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    /** avfoundation 的 `[0] FaceTime HD Camera` → 索引字符串 */
    parseList: (text) =>
      String(text)
        .split(/\r?\n/)
        .map((line) => line.match(/\[(\d+)\]\s+(.+)$/))
        .filter(Boolean)
        .map((m) => m[2].trim()),
    inputFor: (device) => device,
    isVirtual: (name) => /\bvirtual\b|\bobs\b|manycam/i.test(String(name || ''))
  }),
  linux: Object.freeze({
    inputFormat: 'v4l2',
    listArgs: [],
    /** Linux 没有 list 命令：直接看 /dev/video*
     *  （枚举在 listVideoDevices 里特判，parseList 不参与） */
    parseList: () => [],
    inputFor: (device) => device,
    isVirtual: (name) => /virtual/i.test(String(name || ''))
  })
});

/** 当前平台的后端；不支持的平台返回 null（调用方据此回结构化错误，而不是假装能拍）。 */
function backendFor(platform = process.platform) {
  return BACKENDS[platform] || null;
}

/**
 * 跑一条 ffmpeg 并收集输出。
 *
 * `timeoutMs` 到点就 kill：摄像头被别的程序独占时 ffmpeg 会一直挂着等设备，
 * 不设上限会让整轮对话卡死（与手机端 `cameraCaptureTimeoutMs` 同一考虑）。
 *
 * @param {string} ffmpegPath
 * @param {string[]} args
 * @param {{ timeoutMs?: number, collectStdout?: boolean, spawnFn?: typeof spawn }} [opts]
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string, timedOut: boolean }>}
 */
function runFfmpeg(ffmpegPath, args, opts = {}) {
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
  const timeoutMs = Math.max(1000, Math.floor(Number(opts.timeoutMs)) || 15000);
  // .cmd/.bat 壳（scoop/choco 的 shim）必须过 shell，否则 spawn 直接 ENOENT。
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(ffmpegPath);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, {
        windowsHide: true,
        shell: needsShell,
        stdio: ['ignore', opts.collectStdout ? 'pipe' : 'ignore', 'pipe']
      });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err && err.message), timedOut: false });
      return;
    }
    const chunks = [];
    const errChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => chunks.push(d));
    if (child.stderr) child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err && err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut
      });
    });
  });
}

/**
 * 列出可用视频输入设备（名称数组）。
 * @param {{ ffmpegPath?: string, platform?: string, timeoutMs?: number, spawnFn?: typeof spawn }} [opts]
 * @returns {Promise<string[]>}
 */
async function listVideoDevices(opts = {}) {
  const platform = opts.platform || process.platform;
  const backend = backendFor(platform);
  if (!backend) return [];
  if (platform === 'linux') {
    try {
      return fs
        .readdirSync('/dev')
        .filter((f) => /^video\d+$/.test(f))
        .sort()
        .map((f) => `/dev/${f}`);
    } catch {
      return [];
    }
  }
  const ffmpegPath = opts.ffmpegPath || resolveFfmpegPath();
  if (!ffmpegPath) return [];
  const out = await runFfmpeg(ffmpegPath, ['-hide_banner', ...backend.listArgs], {
    timeoutMs: opts.timeoutMs || 8000,
    spawnFn: opts.spawnFn
  });
  // 设备列表走 stderr（ffmpeg 把 -list_devices 的输出当「日志」）
  return backend.parseList(out.stderr);
}

/**
 * 从 JPEG 字节里读尺寸（SOF0–SOF3 段）：视觉文案要报「多大一张」，
 * 而 ffmpeg 的单帧管道输出不带结构化元数据。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { width: 0, height: 0 };
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return { width: 0, height: 0 };
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

/** 挑设备：显式指定优先，否则第一台非虚拟摄像头，再不行就第一台。 */
function pickDevice(devices, preferred, platform = process.platform) {
  const list = Array.isArray(devices) ? devices : [];
  const want = String(preferred || '').trim();
  if (want) {
    const hit = list.find((d) => d === want) || list.find((d) => d.includes(want));
    if (hit) return hit;
  }
  const backend = backendFor(platform);
  const physical = backend ? list.filter((d) => !backend.isVirtual(d)) : list;
  return physical[0] || list[0] || '';
}

/**
 * 创建「本机摄像头」来源。
 *
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, ffmpegPath?: string }} [deps]
 *   依赖可注入是为了 smoke 测试：不装 ffmpeg、不插摄像头也能验证错误文案与参数拼装。
 */
function createDesktopCameraSource(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const backend = backendFor(platform);
  /** 测试/宿主可替换的 spawn（默认 child_process.spawn） */
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;
  /** 独占：摄像头同一时刻只喂一路（ffmpeg 抢设备会拿到黑帧或直接报 busy）。 */
  let inflight = false;

  function ffmpegPath() {
    return deps.ffmpegPath || resolveFfmpegPath(env);
  }

  /** 现在能不能拍（有 ffmpeg + 至少一台设备）。 */
  async function available() {
    if (!backend || !ffmpegPath()) return false;
    const devices = await listVideoDevices({ ffmpegPath: ffmpegPath(), platform, spawnFn });
    return devices.length > 0;
  }

  /**
   * 抓一帧。
   *
   * @param {{ maxEdge?: number, timeoutMs?: number, device?: string }} [opts]
   * @returns {Promise<object>} 成功：`{ ok: true, base64, mime, width, height, device, capturedAt, note }`
   */
  async function capture(opts = {}) {
    if (!backend) {
      return fail(
        'DESKTOP_CAMERA_UNSUPPORTED',
        `这个平台（${platform}）还没有接入本机摄像头。请改用手机摄像头（camera_look）或 computer 看屏幕。`
      );
    }
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) {
      return fail(
        'DESKTOP_CAMERA_NO_FFMPEG',
        '这台机器上没有找到 ffmpeg，所以打不开本机摄像头。' +
          '请让用户装 ffmpeg（或把路径写进环境变量 DIEYUN_FFMPEG）；在此之前不要假设自己看到过画面。'
      );
    }
    if (inflight) {
      return fail('DESKTOP_CAMERA_BUSY', '上一次取画面还没结束，这次没有拍。等它返回后再决定要不要再看，不要并发连拍。');
    }
    inflight = true;
    try {
      const devices = await listVideoDevices({ ffmpegPath: ffmpeg, platform, spawnFn });
      if (!devices.length) {
        return fail(
          'DESKTOP_CAMERA_NO_DEVICE',
          '这台机器上没找到可用的摄像头（可能是没插、被禁用，或驱动没装）。' +
            '可以改用手机摄像头（camera_look）或 computer 看屏幕。'
        );
      }
      const device = pickDevice(devices, opts.device || env.DIEYUN_DESKTOP_CAMERA, platform);
      const maxEdge = Math.max(320, Math.min(2048, Math.floor(Number(opts.maxEdge)) || 1280));
      // 长边缩放放在 ffmpeg 里做（-2 保持偶数宽高，MJPEG 要求）：
      // 传输出来的就是模型要的那一份，不在 Node 里再解一遍图。
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-f', backend.inputFormat,
        '-i', backend.inputFor(device),
        '-frames:v', '1',
        '-vf', `scale='min(${maxEdge},iw)':-2`,
        '-q:v', String(JPEG_QUALITY),
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-'
      ];
      const out = await runFfmpeg(ffmpeg, args, {
        timeoutMs: opts.timeoutMs || 15000,
        collectStdout: true,
        spawnFn
      });
      if (out.timedOut) {
        return fail(
          'DESKTOP_CAMERA_TIMEOUT',
          '摄像头在限定时间内没有出图（可能被别的程序占用，或设备睡着了）。可以再试一次；连续两次失败就改用文字问用户。'
        );
      }
      if (!out.stdout || !out.stdout.length) {
        const tail = String(out.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ');
        return fail(
          'DESKTOP_CAMERA_FAILED',
          `ffmpeg 没有取到画面${tail ? `（${tail}）` : ''}。确认摄像头没被别的程序独占后再试一次。`
        );
      }
      const base64 = out.stdout.toString('base64');
      if (base64.length > MAX_BASE64_CHARS) {
        return fail('DESKTOP_CAMERA_TOO_LARGE', '这张图太大（超过单张上限），没有进入视觉通道。让用户调低分辨率后再拍。');
      }
      const { width, height } = jpegSize(out.stdout);
      return {
        ok: true,
        base64,
        mime: 'image/jpeg',
        width,
        height,
        device,
        capturedAt: Date.now(),
        note: `已用本机摄像头「${device}」抓了一张（一次性取帧，不做常开预览）。`
      };
    } finally {
      inflight = false;
    }
  }

  return {
    available,
    capture,
    devices: () => listVideoDevices({ ffmpegPath: ffmpegPath(), platform, spawnFn })
  };
}

module.exports = {
  MAX_BASE64_CHARS,
  JPEG_QUALITY,
  BACKENDS,
  backendFor,
  resolveFfmpegPath,
  runFfmpeg,
  listVideoDevices,
  jpegSize,
  pickDevice,
  createDesktopCameraSource
};
