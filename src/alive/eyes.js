'use strict';

/**
 * 「醒来时先看一眼」—— 唤醒轮**开始之前**替它取一帧（唯一装配点）。
 *
 * 与 `camera_look` / `desktop_camera_look` 的分工（别混）：
 *   - 那两个是它**自己决定**去调的 host 工具（心跳轮白名单里，受 `ALIVE_SENSE_TOOLS` 限制）；
 *   - 这里是用户勾了「醒来时先看一眼」之后，**这一轮的输入**：画面必须在 `runMainTurn`
 *     之前拿到并作为 image part 递进去，否则模型没有理由去调工具 ——
 *     「醒了却什么都不做」的一半原因就在这里。
 *
 * 三条硬边界：
 *   1. **默认关**：`alive/settings.json` 的 `wakeLookCamera` / `wakeLookScreen`（都是 false）；
 *   2. **两道锁**：摄像头还要 `senses.eyes` + `permissions.desktopCamera`；
 *      屏幕要 `permissions.osControl`（与 `computer` 工具同一份授权，不另立一套）；
 *   3. **画面不落盘**：只在内存里拼成 image part 随请求发出去，与"现实画面不落盘"同一口径。
 *
 * 失败一律回「没看到 + 为什么」（`seen` 里带 errorCode），绝不抛：看不着不该让这一轮醒不来。
 */

const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

/** 与 `main-turn-runner` 的 imageParts 同一形状（OpenAI 兼容 image_url，data URL） */
function toImagePart(mime, base64) {
  const type = String(mime || 'image/jpeg');
  return { type: 'image_url', image_url: { url: `data:${type};base64,${base64}` } };
}

function noShot(tool, errorCode, error) {
  return { tool, ok: false, errorCode, error, width: 0, height: 0 };
}

/**
 * 抓本机摄像头一帧（UVC）。
 *
 * @param {{ device?: string, maxEdge?: number, createSource?: Function }} opts
 */
async function captureCameraShot(opts = {}) {
  const maxEdge = Number(opts.maxEdge) || AGENT_LIMITS_DEFAULTS.visionShotMaxEdge;
  let res = null;
  try {
    // eslint-disable-next-line global-require
    const { createDesktopCameraSource } = require('../agent/desktop-camera-source');
    const source =
      typeof opts.createSource === 'function' ? opts.createSource() : createDesktopCameraSource({});
    res = await source.capture({ device: opts.device || '', maxEdge });
  } catch (err) {
    return { shot: noShot('wake_camera', 'WAKE_LOOK_FAILED', String((err && err.message) || err)), part: null };
  }
  if (!res || res.ok !== true || !res.base64) {
    return {
      shot: noShot(
        'wake_camera',
        (res && res.errorCode) || 'WAKE_LOOK_FAILED',
        String((res && res.error) || '没有取到画面')
      ),
      part: null
    };
  }
  return {
    shot: {
      tool: 'wake_camera',
      ok: true,
      device: res.device ? String(res.device) : undefined,
      width: Number(res.width) || 0,
      height: Number(res.height) || 0
    },
    part: toImagePart(res.mime || 'image/jpeg', res.base64)
  };
}

/**
 * 抓主屏一帧（Electron desktopCapturer，仅 Main 进程）。
 *
 * @param {{ maxEdge?: number, listDisplays?: Function, grabDisplay?: Function, encode?: Function }} opts
 */
async function captureScreenShot(opts = {}) {
  try {
    // eslint-disable-next-line global-require
    const capture = require('../computer/capture');
    const listDisplays = typeof opts.listDisplays === 'function' ? opts.listDisplays : capture.listDisplays;
    const grabDisplay = typeof opts.grabDisplay === 'function' ? opts.grabDisplay : capture.grabDisplay;
    const encode = typeof opts.encode === 'function' ? opts.encode : capture.encodeWithinBudget;
    const displays = listDisplays();
    const display = (Array.isArray(displays) ? displays : []).find((d) => d && d.primary) || displays[0];
    if (!display) return { shot: noShot('wake_screen', 'WAKE_LOOK_NO_DISPLAY', '没找到显示器'), part: null };
    const { image } = await grabDisplay(display);
    const encoded = encode(image, {
      maxEdge: Number(opts.maxEdge) || AGENT_LIMITS_DEFAULTS.visionShotMaxEdge
    });
    if (!encoded || !encoded.base64) {
      return { shot: noShot('wake_screen', 'WAKE_LOOK_EMPTY', '截图是空的'), part: null };
    }
    return {
      shot: {
        tool: 'wake_screen',
        ok: true,
        device: `display ${display.index}`,
        width: Number(encoded.width) || 0,
        height: Number(encoded.height) || 0
      },
      part: toImagePart(encoded.mime || 'image/png', encoded.base64)
    };
  } catch (err) {
    return {
      shot: noShot('wake_screen', 'WAKE_LOOK_FAILED', String((err && err.message) || err)),
      part: null
    };
  }
}

/**
 * 按开关与权限取这一轮要用的画面。
 *
 * @param {{ wants?: {camera?: boolean, screen?: boolean}, senses?: object,
 *           permissions?: object, cameraDevice?: string, maxEdge?: number,
 *           createSource?: Function, listDisplays?: Function,
 *           grabDisplay?: Function, encode?: Function }} opts
 * @returns {Promise<{ parts: Array<object>, seen: Array<object> }>}
 */
async function captureWakeShots(opts = {}) {
  const wants = opts.wants || {};
  const senses = opts.senses || {};
  const perms = opts.permissions || {};
  const parts = [];
  const seen = [];

  if (wants.camera === true) {
    if (senses.eyes !== true) {
      seen.push(noShot('wake_camera', 'SENSE_DISABLED', '「眼睛」这个感官是关着的'));
    } else if (perms.desktopCamera !== true) {
      seen.push(noShot('wake_camera', 'PERMISSION_DENIED', '「设置 → 权限 → 本机摄像头」没打开'));
    } else {
      const { shot, part } = await captureCameraShot({
        device: opts.cameraDevice,
        maxEdge: opts.maxEdge,
        createSource: opts.createSource
      });
      seen.push(shot);
      if (part) parts.push(part);
    }
  }

  if (wants.screen === true) {
    if (perms.osControl !== true) {
      seen.push(noShot('wake_screen', 'PERMISSION_DENIED', '「设置 → 权限 → 电脑控制」没打开'));
    } else {
      const { shot, part } = await captureScreenShot({
        maxEdge: opts.maxEdge,
        listDisplays: opts.listDisplays,
        grabDisplay: opts.grabDisplay,
        encode: opts.encode
      });
      seen.push(shot);
      if (part) parts.push(part);
    }
  }

  return { parts, seen };
}

module.exports = { captureWakeShots, captureCameraShot, captureScreenShot, toImagePart };
