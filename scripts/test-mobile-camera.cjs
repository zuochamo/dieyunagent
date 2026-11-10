'use strict';

/**
 * 手机摄像头（camera_look）链路 smoke。
 *
 * 覆盖四段：
 * 1. 手机桥的「服务端 → 手机」请求/响应（含能力路由、超时、断线）；
 * 2. camera-source 的语义（无桥/无设备/成功/空图/并发只允许一次）；
 * 3. 工具与视觉管线接线（schema、视觉来源、每轮额度）；
 * 4. 权限默认关 + 页面原生拍照钩子存在（防止只改一半）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 20000 + (process.pid % 9000);
process.env.DIEYUN_MOBILE_PORT = String(PORT);
process.env.DIEYUN_MOBILE_HOST = '127.0.0.1';

const ROOT = path.join(__dirname, '..');
const { MobileBridge } = require(path.join(ROOT, 'src', 'mobile', 'bridge.js'));
const {
  createPhoneCameraSource,
  facingForFocus,
  normalizeCapture
} = require(path.join(ROOT, 'src', 'mobile', 'camera-source.js'));
const vision = require(path.join(ROOT, 'src', 'agent', 'browser-vision.js'));
const catalog = require(path.join(ROOT, 'src', 'agent', 'tool-catalog.js'));
const { AGENT_LIMITS_DEFAULTS } = require(path.join(ROOT, 'src', 'agent', 'agent-limits.js'));
const { DEFAULTS: PERM_DEFAULTS } = require(path.join(ROOT, 'src', 'gateway', 'permissions-store.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_JPEG_BASE64 = Buffer.from('fake-jpeg-bytes').toString('base64');

async function testBridgeRoundTrip() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mobile-camera-'));
  const bridge = new MobileBridge({
    agentService: { info: () => ({ ok: true }) },
    userDataPath,
    log: () => {}
  });
  await bridge.start();
  await sleep(150);
  const token = bridge.token;
  assert(token, 'bridge token');

  const clients = [];
  const connect = async (capabilities, onRequest) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    clients.push(ws);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'request' && onRequest) onRequest(ws, msg);
    });
    ws.send(JSON.stringify({ type: 'auth', token, capabilities }));
    await sleep(120);
    return ws;
  };

  // —— 无客户端：立即失败，不等超时（模型要能马上知道「手机不在」）——
  let noClient = null;
  try {
    await bridge.request('camera.capture', {}, { capability: 'camera', timeoutMs: 500 });
  } catch (e) {
    noClient = e;
  }
  assert(noClient && noClient.code === 'NO_CLIENT', 'no client rejects NO_CLIENT');
  assert(bridge.hasClient('camera') === false, 'hasClient false without client');

  // —— 客户端只报 audio 能力：不能被当成拍照目标 ——
  const audioOnly = await connect(['audio']);
  assert(bridge.hasClient('camera') === false, 'audio-only client is not a camera');
  assert(bridge.hasClient('') === true, 'audio-only client still counts for generic requests');
  audioOnly.close();
  await sleep(120);

  // —— 正常一拍 ——
  await connect(['camera'], (ws, msg) => {
    ws.send(
      JSON.stringify({
        type: 'response',
        id: msg.id,
        ok: true,
        data: { base64: FAKE_JPEG_BASE64, mime: 'image/jpeg', width: 1280, height: 720, facing: 'environment' }
      })
    );
  });
  assert(bridge.hasClient('camera') === true, 'camera client routed');
  const data = await bridge.request(
    'camera.capture',
    { facing: 'environment' },
    { capability: 'camera', timeoutMs: 2000 }
  );
  assert(data && data.base64 === FAKE_JPEG_BASE64, 'round trip returns payload');
  assert(data.width === 1280 && data.height === 720, 'round trip keeps dimensions');

  // —— 手机不回话：按超时失败，且不留残留等待 ——
  const silent = await connect(['camera']);
  let timeoutErr = null;
  try {
    await bridge.request('camera.capture', {}, { capability: 'camera', timeoutMs: 250 });
  } catch (e) {
    timeoutErr = e;
  }
  assert(timeoutErr && timeoutErr.code === 'TIMEOUT', 'silent client times out');
  assert(bridge.pending.size === 0, 'timed out request cleaned up');

  // —— 等着的请求遇到手机断开：立刻失败（不能挂到超时）——
  const pendingCall = bridge
    .request('camera.capture', {}, { capability: 'camera', timeoutMs: 5000 })
    .then(() => null, (e) => e);
  await sleep(80);
  silent.close();
  const closedErr = await pendingCall;
  assert(closedErr && closedErr.code === 'NO_CLIENT', 'disconnect rejects pending');

  // —— 错误回包：code 透传 ——
  const slow = await connect(['camera'], (ws, msg) => {
    ws.send(
      JSON.stringify({ type: 'response', id: msg.id, ok: false, error: { code: 'CAMERA_DENIED', message: 'denied' } })
    );
  });
  assert(slow.readyState === 1, 'client open');
  let denied = null;
  try {
    await bridge.request('camera.capture', {}, { capability: 'camera', timeoutMs: 2000 });
  } catch (e) {
    denied = e;
  }
  assert(denied && denied.code === 'CAMERA_DENIED', 'client error code preserved');

  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  bridge.stop();
  assert(bridge.pending.size === 0, 'stop clears pending');
}

async function testCameraSource() {
  // 没有桥
  const noBridge = createPhoneCameraSource({});
  const r1 = await noBridge.capture({});
  assert(r1.ok === false && r1.errorCode === 'CAMERA_UNAVAILABLE', 'no bridge -> CAMERA_UNAVAILABLE');

  // 有桥但没有相机客户端（手机压根没连）
  const noDev = createPhoneCameraSource({
    getBridge: () => ({ hasClient: () => false, request: async () => ({}) })
  });
  const r2 = await noDev.capture({});
  assert(r2.ok === false && r2.errorCode === 'CAMERA_NO_DEVICE', 'no device -> CAMERA_NO_DEVICE');
  assert(/手机/.test(r2.error), 'no device message mentions the phone');

  // 手机连上了但页面拿不到相机（浏览器直接开 http 页面）：错误码必须不同，
  // 否则模型会一直建议用户「去连手机」，而用户明明已经连上了
  const noCameraBridge = createPhoneCameraSource({
    getBridge: () => ({ hasClient: (cap) => cap === '', request: async () => ({}) })
  });
  const r2b = await noCameraBridge.capture({});
  assert(r2b.ok === false && r2b.errorCode === 'CAMERA_NO_BRIDGE', 'connected-but-no-camera -> CAMERA_NO_BRIDGE');
  assert(/App/.test(r2b.error), 'no-bridge message points at the app');

  // 成功：focus → facing 映射要真的传下去
  let seen = null;
  const ok = createPhoneCameraSource({
    getBridge: () => ({
      hasClient: () => true,
      request: async (method, params, opts) => {
        seen = { method, params, opts };
        return { base64: FAKE_JPEG_BASE64, mime: 'image/jpeg', width: 1000, height: 800, facing: 'user' };
      }
    })
  });
  const r3 = await ok.capture({ focus: 'face', maxEdge: 1000, timeoutMs: 3000 });
  assert(r3.ok === true, 'capture ok');
  assert(seen.method === 'camera.capture', 'uses camera.capture');
  assert(seen.params.facing === 'user', 'face focus -> front camera');
  assert(seen.params.maxEdge === 1000, 'maxEdge forwarded');
  assert(seen.opts.capability === 'camera', 'capability declared');
  assert(seen.opts.timeoutMs === 3000, 'timeout forwarded');
  assert(r3.mime === 'image/jpeg' && r3.width === 1000, 'normalized result');

  // 空图 / 坏格式
  const empty = createPhoneCameraSource({
    getBridge: () => ({ hasClient: () => true, request: async () => ({ base64: '' }) })
  });
  const r4 = await empty.capture({});
  assert(r4.ok === false && r4.errorCode === 'CAMERA_EMPTY', 'empty -> CAMERA_EMPTY');

  const badFormat = normalizeCapture({ base64: FAKE_JPEG_BASE64, mime: 'image/heic' });
  assert(badFormat.ok === false && badFormat.errorCode === 'CAMERA_BAD_FORMAT', 'unsupported mime rejected');

  // 桥报超时 → CAMERA_TIMEOUT（可重试语义不同）
  const timingOut = createPhoneCameraSource({
    getBridge: () => ({
      hasClient: () => true,
      request: async () => {
        const e = new Error('timeout');
        e.code = 'TIMEOUT';
        throw e;
      }
    })
  });
  const r5 = await timingOut.capture({});
  assert(r5.ok === false && r5.errorCode === 'CAMERA_TIMEOUT', 'timeout -> CAMERA_TIMEOUT');

  // 手机报的失败码要各自落到不同的 errorCode：权限被拒重试无用，超时值得再试
  const phoneError = async (code) => {
    const src = createPhoneCameraSource({
      getBridge: () => ({
        hasClient: () => true,
        request: async () => {
          const e = new Error(code);
          e.code = code;
          throw e;
        }
      })
    });
    return src.capture({});
  };
  const denied = await phoneError('CAMERA_DENIED');
  assert(denied.ok === false && denied.errorCode === 'CAMERA_DENIED', 'denied -> CAMERA_DENIED');
  assert(/权限/.test(denied.error), 'denied message points at permissions');
  const occupied = await phoneError('CAMERA_BUSY');
  assert(occupied.errorCode === 'CAMERA_BUSY', 'phone busy -> CAMERA_BUSY');
  const noLens = await phoneError('CAMERA_UNAVAILABLE');
  assert(noLens.errorCode === 'CAMERA_NO_CAMERA', 'no lens -> CAMERA_NO_CAMERA');

  // 并发：第二次必须立刻 CAMERA_BUSY，不排队
  let release = null;
  const busySource = createPhoneCameraSource({
    getBridge: () => ({
      hasClient: () => true,
      request: () =>
        new Promise((resolve) => {
          release = () => resolve({ base64: FAKE_JPEG_BASE64, mime: 'image/jpeg', width: 10, height: 10 });
        })
    })
  });
  const first = busySource.capture({});
  await sleep(10);
  const second = await busySource.capture({});
  assert(second.ok === false && second.errorCode === 'CAMERA_BUSY', 'concurrent capture -> CAMERA_BUSY');
  release();
  const finished = await first;
  assert(finished.ok === true, 'first capture still completes');

  assert(facingForFocus('face') === 'user', 'focus face');
  assert(facingForFocus('desk') === 'environment', 'focus desk');
  assert(facingForFocus(undefined) === 'environment', 'default focus is back camera');
}

function testWiring() {
  // schema
  const tool = catalog.getToolByName('camera_look');
  assert(tool && tool.function && tool.function.name === 'camera_look', 'camera_look in catalog');
  assert(/手机/.test(tool.function.description), 'description says it is the phone camera');
  assert(!tool.function.parameters.required, 'camera_look needs no required args');

  // 视觉来源
  const shot = vision.extractShot('camera_look', {
    ok: true,
    base64: FAKE_JPEG_BASE64,
    mime: 'image/jpeg',
    width: 800,
    height: 600
  });
  assert(shot && shot.source === vision.SOURCE_CAMERA, 'camera_look extracts camera source');
  assert(shot.mime === 'image/jpeg', 'camera defaults to jpeg');
  assert(vision.extractShot('camera_look', { ok: false }) === null, 'failed capture yields no shot');

  // 额度：单独一项，不和浏览器截图抢
  const limits = vision.resolveVisionLimits({ cameraShotsPerRound: 1, visionShotsPerRound: 4 });
  assert(limits.maxPerSource[vision.SOURCE_CAMERA] === 1, 'cameraShotsPerRound honored');
  assert(limits.maxPerSource[vision.SOURCE_BROWSER] === 4, 'browser cap independent');
  const defaults = vision.resolveVisionLimits({});
  assert(
    defaults.maxPerSource[vision.SOURCE_CAMERA] === AGENT_LIMITS_DEFAULTS.cameraShotsPerRound,
    'camera cap default from agent-limits'
  );

  // 入队 + 注入文案
  const runId = `run-${crypto.randomBytes(4).toString('hex')}`;
  const queued = vision.recordVisionImage(
    runId,
    { source: vision.SOURCE_CAMERA, mime: 'image/jpeg', base64: FAKE_JPEG_BASE64, width: 800, height: 600 },
    { cameraShotsPerRound: 2 }
  );
  assert(queued === true, 'camera image queued');
  const taken = vision.takePendingVisionImages(runId);
  assert(taken.length === 1 && taken[0].source === vision.SOURCE_CAMERA, 'camera image taken by source');
  const message = vision.buildVisionMessage(taken);
  assert(message && message.role === 'user', 'vision message built');
  assert(/手机摄像头/.test(message.content[0].text), 'message explains it is the phone camera');
  assert(
    message.content.some((part) => part.type === 'image_url' && /^data:image\/jpeg;base64,/.test(part.image_url.url)),
    'jpeg data url injected'
  );

  // agent-limits 里的数字
  for (const key of ['cameraCaptureTimeoutMs', 'cameraShotMaxEdge', 'cameraShotsPerRound']) {
    assert(Number.isFinite(AGENT_LIMITS_DEFAULTS[key]), `agent-limits has ${key}`);
  }

  // 现实画面不落盘：模型只能「再拍一张」，不能像截图那样读副本
  const visionImage = require(path.join(ROOT, 'src', 'agent', 'vision-image.js'));
  assert(typeof visionImage.visionCameraText === 'function', 'visionCameraText exists');
  const cameraNote = visionImage.visionCameraText(1280, 720);
  assert(/不落盘/.test(cameraNote), 'camera note states no disk copy');
  assert(!/[A-Za-z]:\\|\/vision\//.test(cameraNote), 'camera note exposes no file path');

  // 权限默认关：拍现实世界必须是用户显式打开
  assert(PERM_DEFAULTS.camera === false, 'camera permission defaults to off');
}

async function testPermissionGate() {
  const { createToolCall, runToolGateStage } = require(path.join(ROOT, 'src', 'agent', 'tool-gate'));

  // 注入之外的第二道闸：用户关掉权限后，模型仍可能凭历史里的名字调用 camera_look
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-camera-perm-'));
  const permsPath = path.join(dir, 'host-permissions.json');

  const makeCall = () =>
    createToolCall({
      name: 'camera_look',
      args: {},
      harness: { ctx: { userDataPath: dir, contextTierId: 'default' }, fingerprints: [] }
    });

  fs.writeFileSync(permsPath, JSON.stringify({ camera: false }), 'utf8');
  const blocked = await runToolGateStage('before', makeCall());
  assert(blocked && blocked.errorCode === 'PERMISSION_DENIED', 'camera blocked while permission is off');
  assert(/没有打开/.test(blocked.error), 'block message explains the permission is off');

  fs.writeFileSync(permsPath, JSON.stringify({ camera: true }), 'utf8');
  const allowed = await runToolGateStage('before', makeCall());
  assert(!allowed, 'camera allowed once the user turns the permission on');

  // 权限文件缺失（旧安装）时按默认关处理，不能当成「没限制」
  fs.unlinkSync(permsPath);
  const missing = await runToolGateStage('before', makeCall());
  assert(missing && missing.errorCode === 'PERMISSION_DENIED', 'missing permission file defaults to off');
}

function testHalfWiringGuard() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // 电脑端：工具执行 + 结果净化 + 手机桥注入
  const bridgeMain = read('src/agent/tool-bridge-main.js');
  assert(/case 'camera_look'/.test(bridgeMain), 'tool-bridge handles camera_look');
  assert(/name === 'camera_look' && result\.base64/.test(bridgeMain), 'camera base64 stripped from tool payload');
  assert(/createPhoneCameraSource/.test(bridgeMain), 'tool-bridge builds the camera source');
  assert(/const isCameraShot = c\.name === 'camera_look'/.test(bridgeMain), 'camera shots skip the disk copy');
  assert(/isCameraShot\s*\? visionCameraText/.test(bridgeMain), 'camera shots get the no-copy note');
  assert(
    /\(c\.name === 'computer' \|\| CAMERA_TOOL_NAMES\.includes\(c\.name\)\)\s*&&\s*c\.result\s*&&\s*c\.result\.base64/.test(bridgeMain),
    'text-only models are told they cannot see the photo'
  );

  const mainEntry = read('src/main-entry.js');
  assert(/getMobileBridge: \(\) => mobileBridge/.test(mainEntry), 'main-entry passes the mobile bridge getter');

  // 工具注入：只在权限打开时给模型
  const toolDefs = read('src/renderer/renderer-tool-defs.js');
  assert(/host\.camera && CAMERA_TOOL/.test(toolDefs), 'renderer exposes camera_look only when permitted');
  assert(/const camera = p\?\.camera === true/.test(toolDefs), 'camera flag read from permissions');

  // 设置页开关
  const html = read('src/renderer/index.html');
  assert(/id="perm-camera"/.test(html), 'settings page has the camera toggle');
  const perms = read('src/renderer/renderer-permissions.js');
  assert(/camera: \$\('perm-camera'\)\?\.checked === true/.test(perms), 'toggle persists explicitly');

  // 手机页面：请求处理 + 原生回调
  const appJs = read('src/mobile/public/app.js');
  assert(/async function handleRequest/.test(appJs), 'page handles server requests');
  assert(/window\.__dieyunCameraResult = function/.test(appJs), 'page registers the native camera callback');
  assert(/capabilities: cameraCapabilities\(\)/.test(appJs), 'page declares the camera capability');
  assert(/camera\.capture/.test(appJs), 'page implements camera.capture');
  // 非安全上下文里 getUserMedia 必然失败：不能先声明能力再失败
  assert(/window\.isSecureContext/.test(appJs), 'browser fallback requires a secure context');

  // Android 侧：原生同步拍照接口
  const activity = read('mobile-app/android/app/src/main/java/com/dieyun/agent/mobile/MainActivity.java');
  assert(/public void capturePhoto\(String requestId, String facing, int maxEdge\)/.test(activity), 'native bridge exposes capturePhoto');
  assert(/takePicture\(/.test(activity), 'native capture uses takePicture');
  assert(/__dieyunCameraResult/.test(activity), 'native capture calls back into the page');
  assert(/CaptureFormat/.test(activity) === false, 'no stale formatter reference');
  assert(/REQ_CAMERA_CAPTURE/.test(activity), 'runtime camera permission requested on demand');
  assert(/android\.permission\.CAMERA/.test(read('mobile-app/android/app/src/main/AndroidManifest.xml')), 'manifest declares CAMERA');
}

async function main() {
  await testBridgeRoundTrip();
  await testCameraSource();
  testWiring();
  await testPermissionGate();
  testHalfWiringGuard();
  console.log('test-mobile-camera.cjs ok');
}

main().catch((e) => {
  console.error('test-mobile-camera FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
