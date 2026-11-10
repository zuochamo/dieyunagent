'use strict';

/**
 * 本机摄像头（desktop_camera_look）链路 smoke。
 *
 * 覆盖五段：
 * 1. ffmpeg 解析（设备列表 / 设备挑选 / JPEG 尺寸 / 可执行文件查找）；
 * 2. source 语义（平台不支持 / 没 ffmpeg / 没设备 / 超时 / 取帧失败 / 成功 / 并发只许一次）；
 * 3. 视觉管线接线（来源、每轮额度、注入文案、不落盘）；
 * 4. 权限默认关 + 第二道闸（关掉后即便模型凭历史调用也拦得住，且与手机摄像头互不串门）；
 * 5. 半接线防护（工具 schema / 执行分支 / 渲染注入 / 设置页开关 / headless 能力清单）。
 *
 * 全部靠假 spawn：不装 ffmpeg、不插摄像头也能跑（CI 与 Linux 上同样通过）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const {
  createDesktopCameraSource,
  resolveFfmpegPath,
  listVideoDevices,
  backendFor,
  pickDevice,
  jpegSize,
  BACKENDS
} = require(path.join(ROOT, 'src', 'agent', 'desktop-camera-source.js'));
const vision = require(path.join(ROOT, 'src', 'agent', 'browser-vision.js'));
const catalog = require(path.join(ROOT, 'src', 'agent', 'tool-catalog.js'));
const visionImage = require(path.join(ROOT, 'src', 'agent', 'vision-image.js'));
const { AGENT_LIMITS_DEFAULTS } = require(path.join(ROOT, 'src', 'agent', 'agent-limits.js'));
const { DEFAULTS: PERM_DEFAULTS } = require(path.join(ROOT, 'src', 'gateway', 'permissions-store.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/**
 * 假的 ffmpeg 可执行文件：只需要「存在」——真正的执行被 spawn 假件接管。
 * 不这么做的话，`resolveFfmpegPath` 会先判 DIEYUN_FFMPEG 指向的路径存不存在。
 */
let FFMPEG_STUB = '';
function ensureFfmpegStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-desktop-camera-bin-'));
  const file = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(file, '');
  return file;
}

/** 8×4 的真 JPEG（Pillow 生成，286 字节）：用来验证 SOF 尺寸解析与 base64 链路。 */
const FAKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1R' +
    'V19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj' +
    'Y2NjY2NjY2NjY2P/wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QA' +
    'FAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIwDIl//2Q==',
  'base64'
);

/** dshow `-list_devices` 的真实输出形状（含音频行与非设备行，验证只挑 video） */
const DSHOW_LIST_STDERR = [
  '[dshow @ 000002209b5b2ec0] "OBS Virtual Camera" (video)',
  '[dshow @ 000002209b5b2ec0]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}"',
  '[dshow @ 000002209b5b2ec0] "OBSBOT Tiny 2 StreamCamera" (video)',
  '[dshow @ 000002209b5b2ec0] "OBSBOT Tiny2 Microphone" (audio)',
  '[dshow @ 000002209b5b2ec0] "麦克风 (AU05)" (audio)'
].join('\n');

/**
 * 假 spawn：按参数分流（-list_devices → 设备列表；否则 → 一帧 JPEG）。
 *
 * @param {{ devices?: string[], jpeg?: Buffer, listStderr?: string, hang?: boolean, fail?: string, delayMs?: number }} [plan]
 */
function makeFakeSpawn(plan = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setTimeout(() => child.emit('close', null), 5);
    };
    if (plan.hang) return child;
    const isList = args.includes('-list_devices');
    const stderrText = isList
      ? plan.listStderr != null
        ? plan.listStderr
        : (plan.devices || []).map((d) => `[dshow @ 0] "${d}" (video)`).join('\n')
      : plan.fail || '';
    const stdoutBuf = isList || plan.fail ? Buffer.alloc(0) : plan.jpeg || FAKE_JPEG;
    setTimeout(() => {
      if (isList) {
        if (stderrText) child.stderr.emit('data', Buffer.from(stderrText, 'utf8'));
        child.emit('close', 0);
        return;
      }
      if (stdoutBuf.length && opts && opts.stdio && opts.stdio[1] === 'pipe') {
        child.stdout.emit('data', stdoutBuf);
      }
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText, 'utf8'));
      child.emit('close', plan.fail ? 1 : 0);
    }, plan.delayMs || 0);
    return child;
  };
  return { spawnFn, calls };
}

function testHelpers() {
  FFMPEG_STUB = ensureFfmpegStub();
  // 设备列表解析：只要 video 行，跳过音频与 alternative name
  const parsed = BACKENDS.win32.parseList(DSHOW_LIST_STDERR);
  assert(parsed.length === 2, `dshow parse keeps only video devices (got ${parsed.length})`);
  assert(parsed[0] === 'OBS Virtual Camera', 'dshow parse keeps first device name');
  assert(parsed[1] === 'OBSBOT Tiny 2 StreamCamera', 'dshow parse keeps OBSBOT device name');

  // 设备挑选：默认跳过虚拟摄像头（OBS/会议软件的产物），明确指定时优先
  const devices = ['OBS Virtual Camera', 'OBSBOT Tiny 2 StreamCamera'];
  assert(pickDevice(devices) === 'OBSBOT Tiny 2 StreamCamera', 'pickDevice skips virtual cameras');
  assert(pickDevice(devices, 'OBS Virtual') === 'OBS Virtual Camera', 'explicit device wins (fuzzy)');
  assert(pickDevice(['OBS Virtual Camera']) === 'OBS Virtual Camera', 'virtual-only list falls back');
  assert(pickDevice([]) === '', 'empty list yields empty device');

  // JPEG 尺寸：从 SOF 段直接读，不依赖任何图像库
  const size = jpegSize(FAKE_JPEG);
  assert(size.width === 8 && size.height === 4, `jpegSize reads SOF dims (got ${size.width}x${size.height})`);
  assert(jpegSize(Buffer.from('not-a-jpeg')).width === 0, 'jpegSize tolerates garbage');

  // ffmpeg 查找：DIEYUN_FFMPEG 优先，其次 PATH
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-desktop-camera-'));
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const fakeBin = path.join(dir, binName);
  fs.writeFileSync(fakeBin, '');
  assert(resolveFfmpegPath({ PATH: dir }) === fakeBin, 'resolveFfmpegPath finds ffmpeg on PATH');
  assert(resolveFfmpegPath({ DIEYUN_FFMPEG: fakeBin, PATH: '' }) === fakeBin, 'DIEYUN_FFMPEG wins');
  assert(resolveFfmpegPath({ PATH: path.join(dir, 'nope') }) === '', 'missing ffmpeg yields empty path');

  // 平台后端：不支持的操作系统必须如实为空（调用方据此回结构化错误）
  assert(backendFor('win32') && backendFor('darwin') && backendFor('linux'), 'known backends exist');
  assert(backendFor('aix') === null, 'unknown platform has no backend');
}

async function testSourceSemantics() {
  // 平台不支持 / 没 ffmpeg：都要说清原因，不能假装拍到了
  const unsupported = createDesktopCameraSource({ platform: 'aix', env: {} });
  const r0 = await unsupported.capture({});
  assert(r0.ok === false && r0.errorCode === 'DESKTOP_CAMERA_UNSUPPORTED', 'unknown platform -> UNSUPPORTED');

  const noFfmpeg = createDesktopCameraSource({ platform: 'win32', env: { PATH: '' } });
  const r1 = await noFfmpeg.capture({});
  assert(r1.ok === false && r1.errorCode === 'DESKTOP_CAMERA_NO_FFMPEG', 'no ffmpeg -> NO_FFMPEG');
  assert(/ffmpeg/.test(r1.error), 'NO_FFMPEG message names ffmpeg');

  // 有 ffmpeg 但没有设备
  const empty = makeFakeSpawn({ devices: [] });
  const noDevice = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: empty.spawnFn
  });
  const r2 = await noDevice.capture({});
  assert(r2.ok === false && r2.errorCode === 'DESKTOP_CAMERA_NO_DEVICE', 'no device -> NO_DEVICE');

  // 成功路径：参数拼装 + 设备挑选 + 尺寸 + base64
  const okPlan = makeFakeSpawn({ devices: ['OBS Virtual Camera', 'OBSBOT Tiny 2 StreamCamera'] });
  const source = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: okPlan.spawnFn
  });
  const shot = await source.capture({ maxEdge: 1568, timeoutMs: 5000 });
  assert(shot.ok === true, `capture succeeds (${shot.errorCode || ''})`);
  assert(shot.mime === 'image/jpeg', 'capture declares jpeg');
  assert(shot.device === 'OBSBOT Tiny 2 StreamCamera', 'capture picks the physical camera');
  assert(shot.width === 8 && shot.height === 4, 'capture reports jpeg dims');
  assert(Buffer.from(shot.base64, 'base64').equals(FAKE_JPEG), 'capture base64 round-trips the frame');
  assert(/Tiny 2/.test(shot.note), 'note names the device');
  const captureCall = okPlan.calls[okPlan.calls.length - 1];
  const argLine = captureCall.args.join(' ');
  assert(/video=OBSBOT Tiny 2 StreamCamera/.test(argLine), 'dshow input names the device');
  assert(/-frames:v 1/.test(argLine), 'asks ffmpeg for exactly one frame');
  assert(/-f image2pipe/.test(argLine) && /mjpeg/.test(argLine), 'frame comes back as mjpeg on stdout');
  assert(/scale='min\(1568,iw\)':-2/.test(argLine), 'ffmpeg scales to the requested edge (no disk copy)');
  assert(captureCall.opts.stdio[1] === 'pipe', 'stdout is a pipe (never a temp file)');

  // 显式指定设备（DIEYUN_DESKTOP_CAMERA）
  const preferPlan = makeFakeSpawn({ devices: ['OBS Virtual Camera', 'OBSBOT Tiny 2 StreamCamera'] });
  const preferSource = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB, DIEYUN_DESKTOP_CAMERA: 'OBS Virtual' },
    spawn: preferPlan.spawnFn
  });
  const preferred = await preferSource.capture({});
  assert(preferred.device === 'OBS Virtual Camera', 'env override selects the requested device');

  // 超时：ffmpeg 挂住（设备被独占）→ TIMEOUT，且真的 kill 掉了
  const hangPlan = makeFakeSpawn({ devices: ['OBSBOT Tiny 2 StreamCamera'] });
  let hangCalls = 0;
  const hangSpawn = (cmd, args, opts) => {
    hangCalls += 1;
    // 第一次是列设备（正常返回），之后抓帧挂住
    if (args.includes('-list_devices')) return hangPlan.spawnFn(cmd, args, opts);
    return makeFakeSpawn({ hang: true }).spawnFn(cmd, args, opts);
  };
  const hangSource = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: hangSpawn
  });
  const timedOut = await hangSource.capture({ timeoutMs: 1000 });
  assert(timedOut.ok === false && timedOut.errorCode === 'DESKTOP_CAMERA_TIMEOUT', 'hanging ffmpeg -> TIMEOUT');
  assert(hangCalls >= 2, 'timeout path really ran ffmpeg');

  // 取帧失败：stdout 空 + stderr 有话说 → FAILED，且把 stderr 尾巴带给模型
  const failPlan = makeFakeSpawn({
    devices: ['OBSBOT Tiny 2 StreamCamera'],
    fail: 'Could not run graph (device in use)'
  });
  const failSource = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: failPlan.spawnFn
  });
  const failed = await failSource.capture({});
  assert(failed.ok === false && failed.errorCode === 'DESKTOP_CAMERA_FAILED', 'empty stdout -> FAILED');
  assert(/device in use/.test(failed.error), 'FAILED carries the ffmpeg stderr tail');

  // 并发：第二次直接 BUSY，不排队（排队只会让模型多等一轮还拿到旧画面）
  const slowPlan = makeFakeSpawn({ devices: ['OBSBOT Tiny 2 StreamCamera'], delayMs: 200 });
  const slowSource = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: slowPlan.spawnFn
  });
  const first = slowSource.capture({});
  const second = await slowSource.capture({});
  assert(second.ok === false && second.errorCode === 'DESKTOP_CAMERA_BUSY', 'concurrent capture -> BUSY');
  const firstResult = await first;
  assert(firstResult.ok === true, 'first capture still completes');

  // available()：没设备时 false
  const probe = createDesktopCameraSource({
    platform: 'win32',
    env: { DIEYUN_FFMPEG: FFMPEG_STUB },
    spawn: makeFakeSpawn({ devices: [] }).spawnFn
  });
  assert((await probe.available()) === false, 'available() false without devices');

  // listVideoDevices 对 .cmd/.bat shim 走 shell（否则 spawn 直接 ENOENT）
  assert(typeof listVideoDevices === 'function', 'listVideoDevices exported');
}

async function testVisionWiring() {
  const tool = catalog.getToolByName('desktop_camera_look');
  assert(tool && tool.function && tool.function.name === 'desktop_camera_look', 'desktop_camera_look in catalog');
  assert(/摄像头/.test(tool.function.description), 'tool description says it is a camera');
  assert(/camera_look/.test(tool.function.description), 'tool description distinguishes phone camera');
  assert(!tool.function.parameters.required, 'desktop_camera_look needs no required args');

  // 来源映射：与手机摄像头是两个来源、两份额度
  assert(vision.SOURCE_DESKTOP_CAMERA === 'desktopCamera', 'desktop camera source constant');
  const extracted = vision.extractShot('desktop_camera_look', {
    ok: true,
    base64: FAKE_JPEG.toString('base64'),
    mime: 'image/jpeg',
    width: 8,
    height: 4
  });
  assert(extracted && extracted.source === vision.SOURCE_DESKTOP_CAMERA, 'extractShot maps to desktopCamera');
  assert(extracted.mime === 'image/jpeg', 'extractShot keeps jpeg mime');
  assert(vision.extractShot('desktop_camera_look', { ok: false }) === null, 'failed capture yields no shot');

  const limits = vision.resolveVisionLimits({
    cameraShotsPerRound: 1,
    desktopCameraShotsPerRound: 3,
    visionShotsPerRound: 4
  });
  assert(limits.maxPerSource[vision.SOURCE_DESKTOP_CAMERA] === 3, 'desktopCameraShotsPerRound honored');
  assert(limits.maxPerSource[vision.SOURCE_CAMERA] === 1, 'phone quota unaffected');
  assert(
    vision.resolveVisionLimits({}).maxPerSource[vision.SOURCE_DESKTOP_CAMERA] ===
      AGENT_LIMITS_DEFAULTS.desktopCameraShotsPerRound,
    'desktop camera cap default from agent-limits'
  );

  // 两份额度互不挤占：手机拍满后本机仍能入队
  const runId = `run-${crypto.randomBytes(4).toString('hex')}`;
  const bothLimits = { cameraShotsPerRound: 1, desktopCameraShotsPerRound: 1 };
  assert(
    vision.recordVisionImage(
      runId,
      { source: vision.SOURCE_CAMERA, mime: 'image/jpeg', base64: FAKE_JPEG.toString('base64') },
      bothLimits
    ) === true,
    'phone shot queued'
  );
  assert(
    vision.recordVisionImage(
      runId,
      { source: vision.SOURCE_DESKTOP_CAMERA, mime: 'image/jpeg', base64: FAKE_JPEG.toString('base64') },
      bothLimits
    ) === true,
    'desktop shot queued independently'
  );
  const taken = vision.takePendingVisionImages(runId);
  assert(taken.length === 2, 'both sources coexist in the buffer');
  const message = vision.buildVisionMessage(taken);
  assert(message && message.role === 'user', 'vision message built');
  assert(/手机摄像头/.test(message.content[0].text), 'message explains the phone camera');
  assert(/这台电脑上接的摄像头/.test(message.content[0].text), 'message explains the desktop camera');
  assert(
    message.content.filter((p) => p.type === 'image_url').length === 2,
    'both images injected'
  );

  // agent-limits 的数字（数字护栏唯一来源）
  for (const key of [
    'desktopCameraCaptureTimeoutMs',
    'desktopCameraShotMaxEdge',
    'desktopCameraShotsPerRound'
  ]) {
    assert(Number.isFinite(AGENT_LIMITS_DEFAULTS[key]), `agent-limits has ${key}`);
  }

  // 现实画面不落盘：文案只有「再拍一张」的退路，不给任何磁盘路径
  const note = visionImage.visionCameraText(1280, 720, '本机摄像头');
  assert(/本机摄像头/.test(note), 'camera note names the subject');
  assert(/不落盘/.test(note), 'camera note states no disk copy');
  assert(!/[A-Za-z]:\\|\/vision\//.test(note), 'camera note exposes no file path');
  assert(/手机摄像头/.test(visionImage.visionCameraText(1280, 720)), 'default subject stays the phone camera');

  // 权限默认关：拍现实世界必须由用户显式打开
  assert(PERM_DEFAULTS.desktopCamera === false, 'desktopCamera permission defaults to off');
  assert(PERM_DEFAULTS.camera === false, 'camera permission still defaults to off');
}

async function testPermissionGate() {
  const { createToolCall, runToolGateStage } = require(path.join(ROOT, 'src', 'agent', 'tool-gate'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-desktop-camera-perm-'));
  const permsPath = path.join(dir, 'host-permissions.json');
  const makeCall = () =>
    createToolCall({
      name: 'desktop_camera_look',
      args: {},
      harness: { ctx: { userDataPath: dir, contextTierId: 'default' }, fingerprints: [] }
    });

  fs.writeFileSync(permsPath, JSON.stringify({ desktopCamera: false }), 'utf8');
  const blocked = await runToolGateStage('before', makeCall());
  assert(blocked && blocked.errorCode === 'PERMISSION_DENIED', 'desktop camera blocked while permission is off');
  assert(/本机摄像头/.test(blocked.error), 'block message names the 本机摄像头 permission');

  // 手机摄像头打开 ≠ 本机摄像头打开：两个开关互不代替
  fs.writeFileSync(permsPath, JSON.stringify({ camera: true }), 'utf8');
  const stillBlocked = await runToolGateStage('before', makeCall());
  assert(stillBlocked && stillBlocked.errorCode === 'PERMISSION_DENIED', 'camera permission does not cover desktop camera');

  fs.writeFileSync(permsPath, JSON.stringify({ desktopCamera: true }), 'utf8');
  const allowed = await runToolGateStage('before', makeCall());
  assert(!allowed, 'desktop camera allowed once the user turns the permission on');

  // 权限文件缺失（旧安装）时按默认关处理
  fs.unlinkSync(permsPath);
  const missing = await runToolGateStage('before', makeCall());
  assert(missing && missing.errorCode === 'PERMISSION_DENIED', 'missing permission file defaults to off');
}

function testHalfWiringGuard() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // Main：执行分支 + 结果净化 + 来源装配 + 不落盘
  const bridgeMain = read('src/agent/tool-bridge-main.js');
  assert(/case 'desktop_camera_look'/.test(bridgeMain), 'tool-bridge handles desktop_camera_look');
  assert(/name === 'desktop_camera_look' && result\.base64/.test(bridgeMain), 'base64 stripped from tool payload');
  assert(/createDesktopCameraSource/.test(bridgeMain), 'tool-bridge builds the desktop camera source');
  assert(/desktopCameraShotMaxEdge/.test(bridgeMain), 'limits come from agent-limits');
  assert(/desktop_camera_look/.test(bridgeMain.replace(/\s+/g, ' ')), 'desktop tool named in the vision hooks');

  // 渲染进程：只在权限打开时注入
  const toolDefs = read('src/renderer/renderer-tool-defs.js');
  assert(/host\.desktopCamera && DESKTOP_CAMERA_TOOL/.test(toolDefs), 'renderer exposes the tool only when permitted');
  assert(/const desktopCamera = p\?\.desktopCamera === true/.test(toolDefs), 'desktopCamera flag read from permissions');

  // 设置页开关
  const html = read('src/renderer/index.html');
  assert(/id="perm-desktop-camera"/.test(html), 'settings page has the desktop camera toggle');
  const perms = read('src/renderer/renderer-permissions.js');
  assert(
    /desktopCamera: \$\('perm-desktop-camera'\)\?\.checked === true/.test(perms),
    'toggle persists explicitly'
  );
  assert(/'perm-desktop-camera'/.test(perms), 'toggle triggers a save on change');

  // headless：无窗口环境必须如实说没有这个能力
  const headlessBoot = read('src/headless/boot.js');
  assert(/desktop_camera_look/.test(headlessBoot), 'headless lists the tool as unavailable');
}

async function main() {
  testHelpers();
  await testSourceSemantics();
  await testVisionWiring();
  await testPermissionGate();
  testHalfWiringGuard();
  console.log('test-desktop-camera.cjs ok');
}

main().catch((e) => {
  console.error('test-desktop-camera FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
