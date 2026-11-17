'use strict';

/**
 * 本机云台（desktop_camera_ptz）链路 smoke。
 *
 * 覆盖五段：
 * 1. 纯函数：弧秒↔度、`v4l2-ctl --list-ctrls` 解析、`--set-ctrl` 参数拼装；
 * 2. 语义（假 transport）：只读 / 绝对 / 相对 / 越界 / 不支持轴 / 没目标 / 没设备 / 没电机 /
 *    并发只许一次 / 没停稳时如实说没停稳；
 * 3. 单位与范围**来自设备**（换一套假范围，工具就跟着变，不写死 ±130/±90）；
 * 4. 工具表与执行：schema 的 action 枚举、main-tools 的 action → 语义映射；
 * 5. 半接线防护：权限闸（共用 desktopCamera）、生命感心跳轮**拿不到**它、渲染注入、设置页文案、
 *    agent-limits 三个数字、headless 能力清单。
 *
 * 全部靠假 transport：没有摄像头、不在 Windows 上也能跑。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  createDesktopCameraPtz,
  parseV4l2Ctrls,
  buildV4l2SetArgs,
  arcsecToDeg,
  degToArcsec
} = require(path.join(ROOT, 'src', 'agent', 'desktop-camera-ptz.js'));
const catalog = require(path.join(ROOT, 'src', 'agent', 'tool-catalog.js'));
const { createCameraHandlers } = require(path.join(ROOT, 'src', 'agent', 'main-tools', 'camera.js'));
const guardrails = require(path.join(ROOT, 'src', 'agent', 'guardrails-shared.js'));
const { AGENT_LIMITS_DEFAULTS } = require(path.join(ROOT, 'src', 'agent', 'agent-limits.js'));
const { DEFAULTS: PERM_DEFAULTS } = require(path.join(ROOT, 'src', 'gateway', 'permissions-store.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** 一台假云台：位置可写、可按脚本「慢慢动」，方便验证停稳判定。 */
function makeFakeTransport(opts = {}) {
  const state = {
    position: Object.assign({ pan: 0, tilt: -6, zoom: 0 }, opts.position || {}),
    ranges: Object.assign(
      {
        pan: { min: -130, max: 130, step: 1, default: 0 },
        tilt: { min: -90, max: 90, step: 1, default: 0 },
        zoom: { min: 0, max: 100, step: 1, default: 0 }
      },
      opts.ranges || {}
    ),
    supports: Object.assign({ pan: true, tilt: true, zoom: true }, opts.supports || {}),
    devices: opts.devices || ['Fake PTZ Cam'],
    writes: [],
    opens: 0,
    /** 剩余「还在途中」的读次数：每次 readAll 把位置朝目标挪一格 */
    slewSteps: Number.isFinite(opts.slewSteps) ? opts.slewSteps : 0,
    goal: null
  };
  return {
    label: 'fake',
    state,
    listDevices: async () => ({ all: state.devices, ptz: opts.ptzDevices === undefined ? state.devices : opts.ptzDevices }),
    open: async () => {
      state.opens += 1;
      return {
        readAll: async () => {
          if (state.slewSteps > 0 && state.goal) {
            state.slewSteps -= 1;
            for (const axis of Object.keys(state.goal)) {
              const want = state.goal[axis];
              const step = Math.max(1, Math.abs(state.ranges[axis].step) || 1);
              const cur = state.position[axis];
              if (Math.abs(want - cur) <= step) state.position[axis] = want;
              else state.position[axis] = cur + Math.sign(want - cur) * step;
            }
          }
          return {
            position: { ...state.position },
            ranges: { ...state.ranges },
            supports: { ...state.supports }
          };
        },
        write: async (values) => {
          state.writes.push({ ...values });
          state.goal = { ...values };
          // slewSteps=0 的假件是「立刻到位」；给了步数就模拟还在途中慢慢挪。
          if (state.slewSteps <= 0) Object.assign(state.position, values);
        },
        close: async () => {}
      };
    }
  };
}

function testHelpers() {
  assert(arcsecToDeg(468000) === 130, 'arcsec→deg: 468000 = 130°');
  assert(arcsecToDeg(-324000) === -90, 'arcsec→deg: -324000 = -90°');
  assert(degToArcsec(130) === 468000, 'deg→arcsec: 130° = 468000');
  assert(degToArcsec(-90) === -324000, 'deg→arcsec: -90° = -324000');

  const ctrls = parseV4l2Ctrls(
    [
      'brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128',
      'pan_absolute 0x009a0908 (int)   : min=-468000 max=468000 step=3600 default=0 value=234000',
      'tilt_absolute 0x009a0909 (int)  : min=-324000 max=324000 step=3600 default=0 value=-21600',
      'zoom_absolute 0x009a090d (int)  : min=100 max=400 step=1 default=100 value=100'
    ].join('\n')
  );
  assert(ctrls.pan && ctrls.pan.min === -468000 && ctrls.pan.value === 234000, 'v4l2 parse: pan');
  assert(ctrls.tilt && ctrls.tilt.max === 324000, 'v4l2 parse: tilt');
  assert(ctrls.zoom && ctrls.zoom.max === 400, 'v4l2 parse: zoom');
  assert(arcsecToDeg(ctrls.pan.value) === 65, 'v4l2 pan value → 65°');

  const args = buildV4l2SetArgs('/dev/video2', { pan: 7200, tilt: -3600 });
  assert(args[0] === '-d' && args[1] === '/dev/video2', 'v4l2 set keeps the device node');
  assert(args.includes('--set-ctrl'), 'v4l2 set passes --set-ctrl');
  assert(args[args.length - 1] === 'pan_absolute=7200,tilt_absolute=-3600', 'v4l2 set builds the ctrl list');
  assert(buildV4l2SetArgs('/dev/video0', {}).length === 2, 'v4l2 set without values only names the device');
}

async function testStatusAndMove() {
  const transport = makeFakeTransport();
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });

  const st = await ptz.status();
  assert(st.ok, 'status ok');
  assert(st.device === 'Fake PTZ Cam', 'status names the device');
  assert(st.position.pan === 0 && st.position.tilt === -6, 'status returns the measured position');
  assert(st.ranges.pan.max === 130, 'status returns the device ranges');
  assert(/实测读数/.test(st.note), 'status says the number is measured, not remembered');
  assert(transport.state.writes.length === 0, 'status never writes');

  const moved = await ptz.apply({ pan: 40, tilt: -20, settleTimeoutMs: 800, pollMs: 20 });
  assert(moved.ok, 'move ok');
  assert(transport.state.writes.length === 1, 'move writes exactly once');
  assert(transport.state.writes[0].pan === 40 && transport.state.writes[0].tilt === -20, 'move sends absolute degrees');
  assert(moved.before.pan === 0, 'move reports where it started');
  assert(moved.after.pan === 40, 'move reports where it actually ended');
  assert(moved.settled === true, 'move waits until it stops');
  assert(moved.reached === true, 'move reports it reached the target');
  assert(/desktop_camera_look/.test(moved.note), 'note tells the model to take a picture next');
}

async function testStepAndCenter() {
  const transport = makeFakeTransport();
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });

  const stepped = await ptz.apply({ panDelta: 5, tiltDelta: 2, settleTimeoutMs: 500, pollMs: 20 });
  assert(stepped.ok, 'step ok');
  assert(transport.state.writes[0].pan === 5, 'step is applied on top of the measured position (pan)');
  assert(transport.state.writes[0].tilt === -4, 'step is applied on top of the measured position (tilt)');

  const handlers = createCameraHandlers({
    cameraSource: null,
    desktopCameraSource: null,
    desktopCameraPtz: ptz,
    getAgentLimits: () => AGENT_LIMITS_DEFAULTS,
    userDataPath: os.tmpdir()
  });
  const centered = await handlers.desktop_camera_ptz({ action: 'center' }, { contextTierId: 'default' });
  assert(centered.ok, 'center ok');
  const last = transport.state.writes[transport.state.writes.length - 1];
  assert(last.pan === 0 && last.tilt === 0, 'center drives pan/tilt to 0');
  assert(last.zoom === undefined, 'center leaves zoom alone');

  const beforeCount = transport.state.writes.length;
  const noTarget = await handlers.desktop_camera_ptz({ action: 'move' }, { contextTierId: 'default' });
  assert(noTarget.ok === false && noTarget.errorCode === 'DESKTOP_CAMERA_PTZ_NO_TARGET', 'move without a target says so');
  assert(transport.state.writes.length === beforeCount, 'no write when there is nothing to do');

  const badAction = await handlers.desktop_camera_ptz({ action: 'spin' }, { contextTierId: 'default' });
  assert(badAction.errorCode === 'INVALID_ARG', 'unknown action is rejected with INVALID_ARG');
}

async function testRangesComeFromDevice() {
  const transport = makeFakeTransport({
    position: { pan: 0, tilt: 0, zoom: 0 },
    ranges: {
      pan: { min: 0, max: 30, step: 1, default: 0 },
      tilt: { min: -10, max: 10, step: 5, default: 0 },
      zoom: { min: 100, max: 400, step: 1, default: 100 }
    }
  });
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });

  const oob = await ptz.apply({ pan: 200 });
  assert(oob.ok === false && oob.errorCode === 'DESKTOP_CAMERA_PTZ_OUT_OF_RANGE', 'out of range is an error');
  assert(/0\.\.30/.test(oob.error), 'the error carries the real range from the device');
  assert(transport.state.writes.length === 0, 'out of range does not touch the device');

  const ok = await ptz.apply({ pan: 30, settleTimeoutMs: 300, pollMs: 20 });
  assert(ok.ok && transport.state.writes[0].pan === 30, 'a value inside the device range is allowed');
  assert(ok.ranges.zoom && ok.ranges.zoom.min === 100, 'zoom range is the device one, not 0–100 hardcoded');
}

async function testUnsupportedAxisAndPlatform() {
  const transport = makeFakeTransport({ supports: { pan: true, tilt: true, zoom: false } });
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });
  const zoomed = await ptz.apply({ zoom: 50 });
  assert(zoomed.ok === false && zoomed.errorCode === 'DESKTOP_CAMERA_PTZ_NO_CONTROL', 'unsupported axis is named');
  assert(transport.state.writes.length === 0, 'unsupported axis never writes');

  const mac = createDesktopCameraPtz({ platform: 'darwin' });
  const st = await mac.status();
  assert(st.errorCode === 'DESKTOP_CAMERA_PTZ_UNSUPPORTED', 'macOS answers honestly instead of pretending');
  assert(/macOS/.test(st.error), 'the macOS message explains why');
}

async function testDeviceSelection() {
  const none = createDesktopCameraPtz({ platform: 'linux', transport: makeFakeTransport({ devices: [], ptzDevices: [] }) });
  const noDevice = await none.status();
  assert(noDevice.errorCode === 'DESKTOP_CAMERA_PTZ_NO_DEVICE', 'no cameras at all → NO_DEVICE');

  const fixedCam = createDesktopCameraPtz({
    platform: 'linux',
    transport: makeFakeTransport({ devices: ['Logitech C920'], ptzDevices: [] })
  });
  const noPtz = await fixedCam.status();
  assert(noPtz.errorCode === 'DESKTOP_CAMERA_PTZ_NO_PTZ', 'a camera without motors → NO_PTZ');
  assert(/Logitech C920/.test(noPtz.error), 'the message names what it did find');

  // 显式指定设备优先于默认挑选
  const multi = makeFakeTransport({ devices: ['Cam A', 'Cam B'], ptzDevices: ['Cam A', 'Cam B'] });
  const chosen = createDesktopCameraPtz({ platform: 'linux', transport: multi });
  const st = await chosen.status({ device: 'Cam B' });
  assert(st.ok && st.device === 'Cam B', 'explicit device wins');
}

async function testBusy() {
  const transport = makeFakeTransport({ slewSteps: 40 });
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });
  const first = ptz.apply({ pan: 100, settleTimeoutMs: 600, pollMs: 20 });
  const second = await ptz.apply({ pan: -100 });
  assert(second.ok === false && second.errorCode === 'DESKTOP_CAMERA_PTZ_BUSY', 'concurrent PTZ is refused');
  const done = await first;
  assert(done.ok, 'the first call still completes');
}

async function testNotSettled() {
  // slewSteps 远大于超时窗口：位置一直在变，必须如实说「没停稳」
  const transport = makeFakeTransport({ position: { pan: 0, tilt: 0, zoom: 0 }, slewSteps: 500 });
  const ptz = createDesktopCameraPtz({ platform: 'linux', transport });
  const res = await ptz.apply({ pan: 120, settleTimeoutMs: 200, pollMs: 20 });
  assert(res.ok, 'a still-moving gimbal is not an error');
  assert(res.settled === false, 'settled=false when it never stops');
  assert(res.reached === false, 'reached=false when it never arrives');
  assert(/还在动/.test(res.note), 'the note says it was still moving');
  assert(/读回的位置/.test(res.note) || /status/.test(res.note), 'the note tells the model what to do about it');
}

function testToolSurface() {
  const def = catalog.DESKTOP_CAMERA_PTZ_TOOL;
  assert(def && def.function && def.function.name === 'desktop_camera_ptz', 'catalog exports the PTZ tool');
  const props = def.function.parameters.properties;
  assert(Array.isArray(props.action.enum), 'action is an enum in the schema');
  assert(props.action.enum.join('|') === 'status|move|step|center', 'action enum is the documented four');
  assert(def.function.parameters.required.includes('action'), 'action is required');
  assert(/ranges/.test(def.function.description), 'the description tells the model to read ranges first');
  assert(/after/.test(def.function.description), 'the description says to trust the measured `after`');

  const byName = catalog.getToolByName('desktop_camera_ptz');
  assert(byName === def, 'the tool is indexed by name (validation + grouping read the same object)');
  assert(catalog.ALL_STATIC_TOOLS.includes(def), 'the tool is part of the static table');

  const handlers = createCameraHandlers({
    cameraSource: null,
    desktopCameraSource: null,
    desktopCameraPtz: { status: async () => ({ ok: true }), apply: async () => ({ ok: true }) },
    getAgentLimits: () => AGENT_LIMITS_DEFAULTS,
    userDataPath: os.tmpdir()
  });
  assert(typeof handlers.desktop_camera_ptz === 'function', 'main-tools registers the handler');
  const missingSource = createCameraHandlers({
    cameraSource: null,
    desktopCameraSource: null,
    desktopCameraPtz: null,
    getAgentLimits: () => AGENT_LIMITS_DEFAULTS,
    userDataPath: os.tmpdir()
  });
  assert(typeof missingSource.desktop_camera_ptz === 'function', 'handler exists even without a source (structured error)');
}

async function testPermissionGate() {
  const { createToolCall, runToolGateStage } = require(path.join(ROOT, 'src', 'agent', 'tool-gate'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ptz-perm-'));
  const permsPath = path.join(dir, 'host-permissions.json');
  const makeCall = () =>
    createToolCall({
      name: 'desktop_camera_ptz',
      args: { action: 'status' },
      harness: { ctx: { userDataPath: dir, contextTierId: 'default' }, fingerprints: [] }
    });

  assert(PERM_DEFAULTS.desktopCamera === false, 'desktopCamera is off by default');

  fs.writeFileSync(permsPath, JSON.stringify({ desktopCamera: false }), 'utf8');
  const blocked = await runToolGateStage('before', makeCall());
  assert(blocked && blocked.errorCode === 'PERMISSION_DENIED', 'PTZ blocked while the permission is off');
  assert(/本机摄像头/.test(blocked.error), 'the block message reuses the 本机摄像头 label (one switch, one name)');

  fs.writeFileSync(permsPath, JSON.stringify({ desktopCamera: true }), 'utf8');
  const allowed = await runToolGateStage('before', makeCall());
  assert(!allowed, 'PTZ allowed once the user turns the desktop camera on');

  assert(
    guardrails.PERMISSION_GATED_TOOLS.desktop_camera_ptz === 'desktopCamera',
    'the gate reads the same single switch as the capture tool'
  );
}

function testAliveNeverGetsIt() {
  // 心跳轮拿不到云台：移动物理姿态不是「看一眼」，且 ALIVE.md 的负向清单就是这么写的。
  assert(
    !guardrails.ALIVE_READ_ONLY_TOOL_NAMES.has('desktop_camera_ptz'),
    'the heartbeat read-only whitelist must not contain the PTZ tool'
  );
  for (const power of ['read', 'write', 'exec']) {
    const names = guardrails.aliveWakeToolNames(power, { drawer: true, eyes: true, voice: true, mic: true });
    assert(!names.includes('desktop_camera_ptz'), `the heartbeat (${power}) must not get the PTZ tool`);
  }
  assert(
    guardrails.ALIVE_SENSE_TOOLS.desktop_camera_ptz === undefined,
    'PTZ is not a sense (senses stay read-only)'
  );
}

function testHalfWiringGuard() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const bridgeMain = read('src/agent/tool-bridge-main.js');
  assert(/createDesktopCameraPtz/.test(bridgeMain), 'tool-bridge builds the PTZ source');
  assert(/desktopCameraPtz,/.test(bridgeMain), 'the PTZ source is handed to main-tools');

  const cameraHandlers = read('src/agent/main-tools/camera.js');
  assert(/desktop_camera_ptz: async \(a, ctx\) =>/.test(cameraHandlers), 'main-tools has the handler');
  assert(/desktopCameraPtzSettleTimeoutMs/.test(cameraHandlers), 'settle numbers come from agent-limits');

  const toolDefs = read('src/renderer/renderer-tool-defs.js');
  assert(/host\.desktopCamera && DESKTOP_CAMERA_PTZ_TOOL/.test(toolDefs), 'renderer injects it under the same switch');

  const html = read('src/renderer/index.html');
  assert(/perm-desktop-camera/.test(html), 'settings page still has the (shared) toggle');
  assert(/读当前朝向/.test(html), 'the settings hint mentions the gimbal');

  const headless = read('src/headless/boot.js');
  assert(/desktop_camera_ptz/.test(headless), 'headless lists the capability it does not have');

  for (const key of ['desktopCameraPtzSettleTimeoutMs', 'desktopCameraPtzPollMs', 'desktopCameraPtzCommandTimeoutMs']) {
    assert(Number.isFinite(AGENT_LIMITS_DEFAULTS[key]) && AGENT_LIMITS_DEFAULTS[key] > 0, `agent-limits has ${key}`);
  }
}

async function main() {
  testHelpers();
  await testStatusAndMove();
  await testStepAndCenter();
  await testRangesComeFromDevice();
  await testUnsupportedAxisAndPlatform();
  await testDeviceSelection();
  await testBusy();
  await testNotSettled();
  testToolSurface();
  await testPermissionGate();
  testAliveNeverGetsIt();
  testHalfWiringGuard();
  console.log('test-desktop-camera-ptz.cjs ok');
}

main().catch((e) => {
  console.error('test-desktop-camera-ptz FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
