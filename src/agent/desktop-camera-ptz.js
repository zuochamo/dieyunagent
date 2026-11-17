'use strict';

/**
 * 「转动这台电脑上那颗云台」的唯一出口：一次动作 → 一个**实测**朝向，或一句说清原因的错误。
 *
 * 与 `desktop-camera-source.js` 的分工（别混）：
 * ```
 * desktop_camera_look   抓一帧现实画面      → ffmpeg（dshow / avfoundation / v4l2）
 * desktop_camera_ptz    转朝向 / 读朝向      → 本文件（DirectShow COM / v4l2-ctl）
 * ```
 * 两者是同一台设备的两件事，所以**设备名的口径共用** `desktop-camera-source.js` 的
 * `pickDevice` / `BACKENDS[*].isVirtual`：用户选的「那一台」与取帧那台必须是同一台。
 *
 * 三条硬约束：
 * - **只报实测**：先读、再写、再读回。写成功不等于转到 —— 云台有惯性、有机械限位，
 *   还会有 AI 追踪在跟你抢。所以返回值里永远有 `before` / `after` / `settled` / `reached`。
 * - **不猜范围**：pan / tilt / zoom 的上下限一律取设备自己的（win32 `GetRange`、linux `--list-ctrls`）。
 *   超范围就如实报错并把真实范围还回去，不静默夹取 —— 夹取会让模型以为「转到 200° 了」。
 * - **不假装支持**：没有电机的普通 UVC 摄像头回 `PTZ_NO_PTZ`；macOS 回 `UNSUPPORTED`。
 *
 * 单位：pan / tilt 一律**度**（UVC 是弧秒，在平台边界换算完再交给上层）；
 * zoom 用设备自己的刻度（Tiny 2 是 0–100）。linux 的 `zoom_absolute` 各驱动单位不一，
 * 所以那边只声明 pan / tilt，不猜 zoom —— `supports.zoom === false` 就是「别调它」。
 */

const { spawn } = require('child_process');
const { BACKENDS, pickDevice, listVideoDevices } = require('./desktop-camera-source');

/** 模型/上层会用到的三轴（顺序即返回对象里的顺序）。 */
const AXES = Object.freeze(['pan', 'tilt', 'zoom']);
const MOVE_AXES = Object.freeze(['pan', 'tilt']);

/** UVC 弧秒与度的换算（1 度 = 3600 弧秒）。 */
const ARCSEC_PER_DEG = 3600;

/** 平台 → 传输层标签；不在表里的平台就是「本机云台还没接入」。 */
const PTZ_BACKENDS = Object.freeze({
  win32: 'DirectShow IAMCameraControl',
  linux: 'v4l2-ctl'
});

function fail(errorCode, error, extra = {}) {
  return { ok: false, errorCode, error, retryable: false, ...extra };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms) || 0)));
}

function round1(v) {
  return Math.round(Number(v) * 10) / 10;
}

function arcsecToDeg(v) {
  return Math.round(Number(v) / ARCSEC_PER_DEG);
}

function degToArcsec(v) {
  return Math.round(Number(v) * ARCSEC_PER_DEG);
}

/** 跑一条命令并收集输出（linux 的 v4l2-ctl）。超时就 kill。 */
function runCommand(spawnFn, file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message) });
      return;
    }
    const out = [];
    const errChunks = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }, Math.max(1000, Math.floor(timeoutMs) || 5000));
    if (child.stdout) child.stdout.on('data', (d) => out.push(d));
    if (child.stderr) child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(e && e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8')
      });
    });
  });
}

/**
 * 解析 `v4l2-ctl --list-ctrls` 的输出，只留云台三轴。
 *
 * 单行形状（实测）：
 * `pan_absolute 0x009a0908 (int) : min=-468000 max=468000 step=3600 default=0 value=234000`
 *
 * @param {string} text
 * @returns {{ pan?: object, tilt?: object, zoom?: object }} 值为**弧秒**
 */
function parseV4l2Ctrls(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z0-9_]+)\s+0x[0-9a-f]+\s+\(int\)\s*:\s*(.+)$/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const axis =
      name === 'pan_absolute' ? 'pan' : name === 'tilt_absolute' ? 'tilt' : name === 'zoom_absolute' ? 'zoom' : '';
    if (!axis) continue;
    const fields = {};
    for (const part of m[2].trim().split(/\s+/)) {
      const kv = part.match(/^(min|max|step|default|value)=(-?\d+)$/);
      if (kv) fields[kv[1]] = Number(kv[2]);
    }
    if (!Number.isFinite(fields.min) || !Number.isFinite(fields.max)) continue;
    out[axis] = {
      min: fields.min,
      max: fields.max,
      step: Number.isFinite(fields.step) ? fields.step : 0,
      default: Number.isFinite(fields.default) ? fields.default : 0,
      value: Number.isFinite(fields.value) ? fields.value : 0
    };
  }
  return out;
}

/** `v4l2-ctl --set-ctrl` 的参数（只带要写的那几轴，值已是弧秒）。 */
function buildV4l2SetArgs(device, asecValues) {
  const parts = [];
  if (asecValues && Number.isFinite(Number(asecValues.pan))) {
    parts.push(`pan_absolute=${Math.round(Number(asecValues.pan))}`);
  }
  if (asecValues && Number.isFinite(Number(asecValues.tilt))) {
    parts.push(`tilt_absolute=${Math.round(Number(asecValues.tilt))}`);
  }
  const args = ['-d', String(device)];
  if (parts.length) args.push('--set-ctrl', parts.join(','));
  return args;
}

/**
 * win32 传输层：DirectShow `IAMCameraControl`（COM 细节全在 `desktop-camera-ptz-win32.js`）。
 * 那份实现是同步的，这里只做形状适配。
 */
function createWin32Transport() {
  return {
    label: PTZ_BACKENDS.win32,
    listDevices() {
      const dshow = require('./desktop-camera-ptz-win32');
      const all = dshow.listDeviceNames();
      // 虚拟摄像头（OBS Virtual Camera 等）没有云台：列出来，但不进「能转的设备」。
      const isVirtual = BACKENDS.win32.isVirtual;
      return { all, ptz: all.filter((n) => !isVirtual(n)) };
    },
    async open(device) {
      const dshow = require('./desktop-camera-ptz-win32');
      const session = dshow.openSession(device);
      return {
        readAll: async () => session.read(),
        write: async (values) => session.write(values),
        close: async () => session.close()
      };
    }
  };
}

/**
 * linux 传输层：`v4l2-ctl`。
 *
 * 为什么只声明 pan/tilt：`zoom_absolute` 在不同驱动的单位不一致（有的是 1/100 倍率，
 * 有的是步进），把它当「百分比」交给模型就是编造。所以 linux 上 `supports.zoom === false`。
 *
 * 为什么要探测控制项：一个摄像头常注册 `/dev/video0`（采集）与 `/dev/video1`（metadata），
 * 只有采集节点有云台控制。「能转的设备」= 有 `pan_absolute` 的那些节点。
 */
function createLinuxTransport(opts = {}) {
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
  const timeoutMs = Math.max(1000, Math.floor(Number(opts.commandTimeoutMs)) || 5000);
  /** 设备节点 → 最近一次读到的控制项（值会随设备移动变化，读的时候刷新）。 */
  const known = new Map();

  async function listCtrls(device) {
    const r = await runCommand(spawnFn, 'v4l2-ctl', ['-d', device, '--list-ctrls'], timeoutMs);
    if (r.code !== 0) return null;
    return parseV4l2Ctrls(r.stdout);
  }

  async function listDevices() {
    const nodes = await listVideoDevices({ spawnFn });
    const ptz = [];
    known.clear();
    for (const node of nodes) {
      const ctrls = await listCtrls(node);
      if (!ctrls || !ctrls.pan || ctrls.pan.max <= ctrls.pan.min) continue;
      known.set(node, ctrls);
      ptz.push(node);
    }
    return { all: nodes, ptz };
  }

  function snapshot(device) {
    const ctrls = known.get(device) || {};
    const position = {};
    const ranges = {};
    const supports = {};
    for (const axis of MOVE_AXES) {
      const c = ctrls[axis];
      supports[axis] = Boolean(c && c.max > c.min);
      if (!supports[axis]) continue;
      ranges[axis] = {
        min: arcsecToDeg(c.min),
        max: arcsecToDeg(c.max),
        step: arcsecToDeg(c.step) || 1,
        default: arcsecToDeg(c.default)
      };
      position[axis] = arcsecToDeg(c.value);
    }
    supports.zoom = false;
    return { position, ranges, supports };
  }

  return {
    label: PTZ_BACKENDS.linux,
    listDevices,
    async open(device) {
      if (!known.has(device)) await listDevices();
      if (!known.has(device)) {
        const e = new Error(`${device} 上没有 pan/tilt 控制（这台摄像头大概没有云台电机）`);
        e.code = 'NO_PTZ';
        throw e;
      }
      return {
        async readAll() {
          // 每次重读：位置会被 AI 追踪 / 手动拧动改变，缓存下来就是编造。
          const fresh = await listCtrls(device);
          if (fresh) {
            for (const axis of Object.keys(known.get(device) || {})) {
              if (fresh[axis]) known.get(device)[axis].value = fresh[axis].value;
            }
          }
          return snapshot(device);
        },
        async write(values) {
          const asec = {};
          if (Number.isFinite(Number(values.pan))) asec.pan = degToArcsec(values.pan);
          if (Number.isFinite(Number(values.tilt))) asec.tilt = degToArcsec(values.tilt);
          if (!Object.keys(asec).length) return;
          const r = await runCommand(spawnFn, 'v4l2-ctl', buildV4l2SetArgs(device, asec), timeoutMs);
          if (r.code !== 0) {
            const e = new Error(String(r.stderr || '').trim() || `v4l2-ctl 退出码 ${r.code}`);
            e.code = 'UVC_FAILED';
            throw e;
          }
        },
        async close() {}
      };
    }
  };
}

function createTransport(platform, opts = {}) {
  if (platform === 'win32') return createWin32Transport();
  if (platform === 'linux') return createLinuxTransport(opts);
  return null;
}

function busy() {
  return fail(
    'DESKTOP_CAMERA_PTZ_BUSY',
    '上一次云台动作还没结束（正在等它停稳），这次没有执行。等它返回后再决定要不要继续转。',
    { retryable: true }
  );
}

function transportError(err, stage) {
  const code = err && err.code;
  if (code === 'NO_DEVICE') return fail('DESKTOP_CAMERA_PTZ_NO_DEVICE', String(err.message));
  if (code === 'NO_PTZ') {
    return fail(
      'DESKTOP_CAMERA_PTZ_NO_PTZ',
      '这台摄像头没有云台控制（没有电机，或驱动没暴露 pan/tilt）。看画面仍然用 `desktop_camera_look`。'
    );
  }
  return fail(
    'DESKTOP_CAMERA_PTZ_FAILED',
    `云台${stage === 'status' ? '读取' : '动作'}失败：${String((err && err.message) || err)}`,
    { retryable: true }
  );
}

function supportedText(supports) {
  const list = AXES.filter((a) => supports && supports[a]);
  return list.length ? list.join(' / ') : '无';
}

function positionText(position) {
  const parts = [];
  if (Number.isFinite(Number(position && position.pan))) parts.push(`水平 ${round1(position.pan)}°`);
  if (Number.isFinite(Number(position && position.tilt))) parts.push(`俯仰 ${round1(position.tilt)}°`);
  if (Number.isFinite(Number(position && position.zoom))) parts.push(`变焦 ${round1(position.zoom)}`);
  return parts.length ? parts.join('，') : '位置不可读';
}

/** 连续两次读到同一位置 = 停了（设备按 step 量化，别用浮点比较）。 */
function keyOf(position, plan) {
  return Object.keys(plan)
    .map((axis) => String(round1(position[axis])))
    .join('|');
}

function judge(position, plan) {
  let maxMiss = 0;
  for (const [axis, want] of Object.entries(plan)) {
    const got = Number(position[axis]);
    if (!Number.isFinite(got)) continue;
    maxMiss = Math.max(maxMiss, Math.abs(got - Number(want)));
  }
  return { reached: maxMiss <= 1, maxMiss: round1(maxMiss) };
}

async function waitForSettle(session, plan, opts = {}) {
  const timeoutMs = Math.max(200, Math.floor(Number(opts.timeoutMs)) || 4000);
  const pollMs = Math.max(30, Math.floor(Number(opts.pollMs)) || 120);
  const started = Date.now();
  let last = await session.readAll();
  let prevKey = keyOf(last.position, plan);
  for (;;) {
    if (Date.now() - started >= timeoutMs) {
      return { settled: false, ...judge(last.position, plan), position: last.position, elapsedMs: Date.now() - started };
    }
    await sleep(pollMs);
    const next = await session.readAll();
    const key = keyOf(next.position, plan);
    if (key === prevKey) {
      return { settled: true, ...judge(next.position, plan), position: next.position, elapsedMs: Date.now() - started };
    }
    prevKey = key;
    last = next;
  }
}

function settleNote(device, before, plan, settle) {
  const want = Object.entries(plan)
    .map(([axis, v]) => `${axis} ${round1(v)}`)
    .join('，');
  const got = Object.entries(settle.position)
    .map(([axis, v]) => `${axis} ${round1(v)}`)
    .join('，');
  const gap = settle.maxMiss > 0 ? `（离目标还差 ${settle.maxMiss}）` : '';
  const head = `${device}：下达 ${want}；读回 ${got}${gap}（下达前 ${positionText(before)}）`;
  if (!settle.settled) {
    return (
      `${head}。**动作结束时它还在动**（${Math.round(settle.elapsedMs)}ms 内没停稳）：` +
      '可能转得远、被挡住，或 AI 追踪在抢。拍之前再读一次位置（action=status），或稍等再拍。'
    );
  }
  if (!settle.reached) {
    return (
      `${head}。**停住了但没到位**（机械限位 / 精度 / AI 追踪都会这样）。` +
      '画面要按**读回的位置**理解，不要按你要的角度理解。'
    );
  }
  return `${head}。已停稳。要画面就再调 \`desktop_camera_look\` 拍一张 —— 那一帧才是转过去之后的。`;
}

/**
 * 创建「本机云台」来源。
 *
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, transport?: object,
 *   spawn?: typeof spawn, commandTimeoutMs?: number }} [deps]
 *   `transport` 可注入是为了 smoke 测试：没有摄像头 / 不在 Windows 上也能验证语义。
 */
function createDesktopCameraPtz(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const transport =
    deps.transport ||
    createTransport(platform, { spawn: deps.spawn, commandTimeoutMs: deps.commandTimeoutMs });
  const backend = (transport && transport.label) || PTZ_BACKENDS[platform] || '';
  /** 同时只允许一次云台动作：并发 Set 会让读回的位置没有意义。 */
  let inflight = false;

  function unavailable() {
    if (transport) return null;
    return fail(
      'DESKTOP_CAMERA_PTZ_UNSUPPORTED',
      platform === 'darwin'
        ? 'macOS 上的本机云台还没接入（那边没有 v4l2-ctl，也没做 AVFoundation 的 PTZ 通道）。' +
          '可以在手机端连电脑后用 camera_look 让用户把手机转过去看。'
        : `这个平台（${platform}）还没有接入本机云台。可以改用手机摄像头（camera_look）或 computer 看屏幕。`
    );
  }

  /** 挑设备：显式指定优先；否则第一台非虚拟的能转设备。 */
  async function resolveDevice(preferred) {
    let listed;
    try {
      listed = await transport.listDevices();
    } catch (err) {
      return {
        error: fail('DESKTOP_CAMERA_PTZ_FAILED', `枚举摄像头失败：${String(err && err.message)}`, {
          retryable: true
        })
      };
    }
    const want = String(preferred || env.DIEYUN_DESKTOP_CAMERA || '').trim();
    const pick = pickDevice(listed.ptz, want, platform);
    if (pick) return { device: pick };
    if (!listed.all.length) {
      return {
        error: fail(
          'DESKTOP_CAMERA_PTZ_NO_DEVICE',
          '这台机器上没找到摄像头（可能没插、被禁用，或驱动没装）。可以改用手机摄像头或 computer 看屏幕。'
        )
      };
    }
    return {
      error: fail(
        'DESKTOP_CAMERA_PTZ_NO_PTZ',
        `找到了摄像头（${listed.all.join('、')}），但它们都没有云台电机（没有 pan/tilt 控制）。` +
          '`desktop_camera_ptz` 只能转有电机的机型（如 OBSBOT Tiny 2）；' +
          '看画面仍然用 `desktop_camera_look`。'
      )
    };
  }

  /** 读一次朝向（不动）。 */
  async function status(opts = {}) {
    const bad = unavailable();
    if (bad) return bad;
    if (inflight) return busy();
    inflight = true;
    try {
      const target = await resolveDevice(opts.device);
      if (target.error) return target.error;
      const session = await transport.open(target.device);
      try {
        const snap = await session.readAll();
        return {
          ok: true,
          device: target.device,
          backend,
          position: snap.position,
          ranges: snap.ranges,
          supports: snap.supports,
          note: `${target.device} 现在朝向：${positionText(snap.position)}（实测读数，不是记忆里的）`
        };
      } finally {
        await session.close();
      }
    } catch (err) {
      return transportError(err, 'status');
    } finally {
      inflight = false;
    }
  }

  /**
   * 转过去，并读回是否真的到了。
   *
   * 绝对值（pan / tilt / zoom）与相对步进（panDelta / tiltDelta）二选一；
   * 同一轴都给了就以绝对值为准。
   */
  async function apply(opts = {}) {
    const bad = unavailable();
    if (bad) return bad;

    const absolute = {};
    for (const axis of AXES) {
      const v = opts[axis];
      if (v === undefined || v === null || v === '') continue;
      absolute[axis] = Number(v);
    }
    const delta = {};
    if (opts.panDelta !== undefined && opts.panDelta !== null && opts.panDelta !== '') {
      delta.pan = Number(opts.panDelta);
    }
    if (opts.tiltDelta !== undefined && opts.tiltDelta !== null && opts.tiltDelta !== '') {
      delta.tilt = Number(opts.tiltDelta);
    }
    if (!Object.keys(absolute).length && !Object.keys(delta).length) {
      return fail(
        'DESKTOP_CAMERA_PTZ_NO_TARGET',
        '这次没有给要转到哪里：给绝对角度（pan / tilt / zoom）或相对步进（pan_delta / tilt_delta）都行；' +
          '想回中就用 center。'
      );
    }
    for (const [axis, v] of [...Object.entries(absolute), ...Object.entries(delta)]) {
      if (!Number.isFinite(v)) return fail('DESKTOP_CAMERA_PTZ_BAD_ARG', `${axis} 不是数字。`);
    }
    if (inflight) return busy();
    inflight = true;
    try {
      const target = await resolveDevice(opts.device);
      if (target.error) return target.error;
      const session = await transport.open(target.device);
      try {
        const before = await session.readAll();
        const wanted = new Set([...Object.keys(absolute), ...Object.keys(delta)]);
        for (const axis of wanted) {
          if (!before.supports[axis]) {
            return fail(
              'DESKTOP_CAMERA_PTZ_NO_CONTROL',
              `这台摄像头不支持 ${axis} 控制（支持的：${supportedText(before.supports)}）。不要重复试同一个参数。`
            );
          }
        }

        const plan = {};
        for (const [axis, v] of Object.entries(absolute)) plan[axis] = v;
        for (const [axis, d] of Object.entries(delta)) {
          if (plan[axis] !== undefined) continue; // 绝对值优先
          plan[axis] = (Number(before.position[axis]) || 0) + d;
        }

        for (const [axis, want] of Object.entries(plan)) {
          const range = before.ranges[axis];
          if (!range) continue;
          // 容差一个 step：设备本身按 step 量化，差半度不算越界。
          const tol = Math.max(1, Math.abs(Number(range.step) || 1));
          if (want < range.min - tol || want > range.max + tol) {
            return fail(
              'DESKTOP_CAMERA_PTZ_OUT_OF_RANGE',
              `${axis} 只能到 ${range.min}..${range.max}（单位：${axis === 'zoom' ? '设备刻度' : '度'}），` +
                `这次要的是 ${round1(want)}。请按设备的真实范围重给一个值。`
            );
          }
          plan[axis] = Math.min(range.max, Math.max(range.min, want));
        }

        await session.write(plan);
        const settle = await waitForSettle(session, plan, {
          timeoutMs: opts.settleTimeoutMs,
          pollMs: opts.pollMs
        });

        return {
          ok: true,
          device: target.device,
          backend,
          before: before.position,
          target: plan,
          after: settle.position,
          ranges: before.ranges,
          settled: settle.settled,
          reached: settle.reached,
          // 差多少度也算事实：`reached` 的容差是一个 step，1° 的差就是「没到位」
          // （实测 Tiny 2 的 tilt 读回会系统性差 1°；写死了就等于替设备编了个校准）。
          miss: settle.maxMiss,
          note: settleNote(target.device, before.position, plan, settle)
        };
      } finally {
        await session.close();
      }
    } catch (err) {
      return transportError(err, 'apply');
    } finally {
      inflight = false;
    }
  }

  return { status, apply, backend, platform };
}

module.exports = {
  createDesktopCameraPtz,
  parseV4l2Ctrls,
  buildV4l2SetArgs,
  arcsecToDeg,
  degToArcsec
};
