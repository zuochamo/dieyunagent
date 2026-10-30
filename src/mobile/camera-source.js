'use strict';

/**
 * 「手机当摄像头」的唯一出口：把一次拍照请求变成一张图，或一句说清原因的错误。
 *
 * 分层（为什么不是直接写在工具里）：
 * ```
 * tool-bridge-main  camera_look  →  本文件（协议参数 / 结果校验 / 错误文案）
 *                                   →  MobileBridge.request('camera.capture')
 *                                   →  手机（原生拍照，见 mobile-app/android + public/app.js）
 * ```
 * 工具层只该知道「要不要看、看什么」，不该知道 `camera.capture` 的参数长什么样、
 * 手机回了什么、超时了怎么措辞。反过来，手机端也不该知道账号/权限/工具名。
 *
 * 三条硬约束：
 * - **一次一张**：不做视频流、不做常开预览。要再看就再拍——这既是成本策略（详见
 *   `docs`/AGENTS 的视觉预算），也是隐私策略（每次拍摄都必须在手机上可见）。
 * - **不编造**：任何失败都返回 `{ ok: false, ... }` 与结构化 `errorCode`，
 *   绝不返回空图或占位图让模型以为「看到了」。
 * - **文案单一来源**：所有面向模型的失败句子都在本文件，调用方不再各写一份。
 */

const { normalizeVisionImageMime } = require('../agent/guardrails-shared');

/** 手机端拍照能力标识（`MobileBridge` 的能力白名单同值）。 */
const CAMERA_CAPABILITY = 'camera';

/** 手机端上报的 mime 只认这几种（多模态上游支持的集合）。 */
const FALLBACK_MIME = 'image/jpeg';

/** 单张 base64 的兜底硬顶：超过它说明手机没压缩，直接拒掉比让它顶穿视觉上限更清楚。 */
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

/** `focus` → 用哪颗摄像头。face 用前置（正对着用户），其余用后置（看桌面/看现场）。 */
function facingForFocus(focus) {
  const v = String(focus || '').trim().toLowerCase();
  return v === 'face' || v === 'selfie' || v === 'front' ? 'user' : 'environment';
}

function fail(errorCode, error, extra = {}) {
  return { ok: false, errorCode, error, retryable: false, ...extra };
}

/**
 * 桥层错误码 → 面向模型的话。
 *
 * 为什么要分这么细：`NO_CLIENT`（手机不在）与 `TIMEOUT`（手机在但没拍成）
 * 需要模型做完全不同的事 —— 前者只能请用户去连手机，后者值得再拍一次；
 * `CAMERA_DENIED`（系统权限被拒）更是重试一百次也没用，必须让用户去改权限。
 *
 * 用表而不是 if 链：手机端新增一个失败码时，只需要在这里补一行，
 * 不会掉进「unknown → 一律 CAMERA_FAILED」的黑洞里被模型当成「再拍一次就好」。
 */
const BRIDGE_ERROR_MAP = Object.freeze({
  NO_CLIENT: [
    'CAMERA_NO_DEVICE',
    '手机端没有连上，所以看不到画面。请让用户在手机上打开叠云 App 并连到这台电脑后再试；' +
      '在此之前不要假设自己看到过任何画面。'
  ],
  TIMEOUT: [
    'CAMERA_TIMEOUT',
    '手机端在限定时间内没有回图（可能锁屏、切到后台或相机被别的应用占用）。可以再试一次；' +
      '连续两次失败就改用文字向用户确认，不要反复空等。'
  ],
  CAMERA_DENIED: [
    'CAMERA_DENIED',
    '用户在手机上拒绝了相机权限（或系统里把这个权限关了），所以没有拍到。' +
      '重试没有用：请让用户在手机「设置 → 应用 → 叠云 → 权限」里允许相机。'
  ],
  CAMERA_BUSY: [
    'CAMERA_BUSY',
    '手机上的相机正被占用（上一次拍摄还没收尾，或别的应用正在用相机）。' +
      '等一会儿再拍一次；不要连着重试。'
  ],
  CAMERA_UNAVAILABLE: [
    'CAMERA_NO_CAMERA',
    '手机端打不开这颗摄像头（机型没有该朝向的相机，或被系统相机服务拒绝）。' +
      '换一个 focus 再拍一次通常可以绕开前置/后置缺失。'
  ]
});

function describeBridgeError(err) {
  const code = String((err && err.code) || '');
  const mapped = BRIDGE_ERROR_MAP[code];
  if (mapped) return fail(mapped[0], mapped[1]);
  return fail(
    'CAMERA_FAILED',
    `手机端拍照失败：${(err && err.message) || '未知原因'}。可以重试一次，或改用文字向用户确认。`
  );
}

/**
 * 校验并归一手机回传的一张照片。
 * 不信任手机端的自述：mime 按白名单归一、尺寸必须是非负整数、base64 必须能解出字节。
 *
 * @param {object} data 手机回传的 data
 * @returns {{ ok: true, base64: string, mime: string, width: number, height: number, facing: string, capturedAt: number } | { ok: false, errorCode: string, error: string, retryable: boolean }}
 */
function normalizeCapture(data) {
  const base64 = data && typeof data.base64 === 'string' ? data.base64.trim() : '';
  if (!base64) {
    return fail('CAMERA_EMPTY', '手机端回了空图（相机可能刚被唤醒还没出帧）。再拍一次通常就好。');
  }
  if (base64.length > MAX_BASE64_CHARS) {
    return fail(
      'CAMERA_TOO_LARGE',
      '手机回传的这张图太大（超过单张上限），没有进入视觉通道。让用户把手机拿远一点或降低画质后重拍。'
    );
  }
  const mime = normalizeVisionImageMime(String((data && data.mime) || FALLBACK_MIME));
  if (!mime) {
    return fail('CAMERA_BAD_FORMAT', '手机回传的图片格式上游不支持（只接受 jpeg/png/webp），这张图不能给你看。');
  }
  const width = Math.max(0, Math.floor(Number(data && data.width)) || 0);
  const height = Math.max(0, Math.floor(Number(data && data.height)) || 0);
  return {
    ok: true,
    base64,
    mime,
    width,
    height,
    facing: String((data && data.facing) || ''),
    capturedAt: Number(data && data.capturedAt) || Date.now()
  };
}

/**
 * 创建「手机摄像头」来源。
 *
 * @param {{ getBridge: () => object | null }} deps `getBridge` 用取值函数而不是实例：
 *   手机桥是 Main 启动时创建的，工具桥可能先于它装配完（也便于将来换端口/重启后仍拿得到最新实例）。
 */
function createPhoneCameraSource(deps = {}) {
  const getBridge = typeof deps.getBridge === 'function' ? deps.getBridge : () => null;
  /**
   * 同一时刻只允许一次拍摄：手机的相机硬件是独占的（同时开会抢不到，或其中一个拿到黑帧）。
   * 用「在飞」标记直接回 CAMERA_BUSY，而不是排队 —— 排队只会让模型多等 20 秒还拿到旧画面。
   */
  let inflight = false;

  /** 现在能不能拍（有手机连着且自报 camera 能力）。 */
  function available() {
    const bridge = getBridge();
    return !!(bridge && typeof bridge.hasClient === 'function' && bridge.hasClient(CAMERA_CAPABILITY));
  }

  /**
   * 让手机拍一张。
   *
   * @param {{ focus?: string, maxEdge?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<object>} 成功：`{ ok: true, base64, mime, width, height, facing, capturedAt, note }`
   */
  async function capture(opts = {}) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.request !== 'function') {
      return fail(
        'CAMERA_UNAVAILABLE',
        '这台机器没有手机桥，无法调用手机摄像头。请改用其它方式（例如让用户描述，或用 computer 看屏幕）。'
      );
    }
    if (!available()) {
      // 分清两种「看不到」：手机根本没连，和手机连了但这个页面拿不到相机
      // （浏览器直接打开 http://局域网IP 就是后者——非安全上下文没有 getUserMedia）。
      // 两者的下一步动作完全不同，所以不能合成一句话。
      const anyClient =
        typeof bridge.hasClient === 'function' && bridge.hasClient('') === true;
      if (anyClient) {
        return fail(
          'CAMERA_NO_BRIDGE',
          '手机连着，但这个手机页面拿不到摄像头（浏览器直接打开 http 页面时属于非安全上下文）。' +
            '请让用户用叠云 App 打开手机端，或改用文字描述。'
        );
      }
      return fail(
        'CAMERA_NO_DEVICE',
        '手机端没有连上，所以看不到画面。请让用户在手机上打开叠云 App 并连到这台电脑后再试；' +
          '在此之前不要假设自己看到过任何画面。'
      );
    }
    if (inflight) {
      return fail(
        'CAMERA_BUSY',
        '上一次拍照还没有回来，这次没有拍。等它返回后再决定要不要再看，不要并发连拍。'
      );
    }
    inflight = true;
    let data;
    try {
      data = await bridge.request(
        'camera.capture',
        {
          facing: facingForFocus(opts.focus),
          maxEdge: Math.max(320, Math.min(2048, Math.floor(Number(opts.maxEdge)) || 1280))
        },
        { capability: CAMERA_CAPABILITY, timeoutMs: opts.timeoutMs }
      );
    } catch (err) {
      return describeBridgeError(err);
    } finally {
      inflight = false;
    }
    const shot = normalizeCapture(data);
    if (!shot.ok) return shot;
    return {
      ...shot,
      note:
        `已让手机${shot.facing === 'user' ? '前置' : '后置'}摄像头拍了一张` +
        '（拍摄瞬间手机上会显示提示，不做常开预览）。'
    };
  }

  return { available, capture };
}

module.exports = {
  CAMERA_CAPABILITY,
  MAX_BASE64_CHARS,
  facingForFocus,
  normalizeCapture,
  describeBridgeError,
  createPhoneCameraSource
};
