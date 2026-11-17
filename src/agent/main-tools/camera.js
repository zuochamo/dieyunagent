'use strict';

/**
 * 屏幕与摄像头：手机拍照（mobile/camera-source）、本机 UVC 取帧（desktop-camera-source）、
 * 本机云台转向（desktop-camera-ptz）。像素本体不进工具结果，这里只取帧与额度。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createCameraHandlers(shared) {
  const {
    cameraSource,
    desktopCameraSource,
    desktopCameraPtz,
    getAgentLimits,
    userDataPath
  } = shared;

  return {
    camera_look: async (a, ctx) => {
        if (!cameraSource) {
          return {
            ok: false,
            errorCode: 'CAMERA_UNAVAILABLE',
            retryable: false,
            error: '这台机器没有手机桥，无法调用手机摄像头。请改用其它方式（让用户描述，或用 computer 看屏幕）。'
          };
        }
        const cameraLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        return cameraSource.capture({
          focus: a.focus,
          maxEdge: cameraLimits.cameraShotMaxEdge,
          timeoutMs: cameraLimits.cameraCaptureTimeoutMs
        });
    },
    desktop_camera_look: async (a, ctx) => {
        const cameraLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        return desktopCameraSource.capture({
          maxEdge: cameraLimits.desktopCameraShotMaxEdge,
          timeoutMs: cameraLimits.desktopCameraCaptureTimeoutMs,
          // 用户在「设置 → 拟态 → 生命」里选的摄像头（心跳轮经 toolScope.senses 带下来）；
          // 没选就仍按 DIEYUN_DESKTOP_CAMERA → 第一台非虚拟摄像头的既有规则
          device: (ctx.senses && ctx.senses.cameraDevice) || undefined
        });
    },
    /**
     * 本机云台：`action` → 语义映射**只在这里**（模块只认「绝对值 / 相对步进 / 只读」）。
     * 为什么 action 列表不在这份代码里再写一遍：枚举的单一来源是 catalog schema
     * （`tool-validate` 也从那里取）；这里只兜「schema 里有、执行不认识」的落空。
     */
    desktop_camera_ptz: async (a, ctx) => {
        if (!desktopCameraPtz) {
          return {
            ok: false,
            errorCode: 'DESKTOP_CAMERA_PTZ_UNSUPPORTED',
            retryable: false,
            error: '这台机器没有接入本机云台。可以改用手机摄像头（camera_look）或 computer 看屏幕。'
          };
        }
        const cameraLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const device = (ctx.senses && ctx.senses.cameraDevice) || undefined;
        const settle = {
          settleTimeoutMs: cameraLimits.desktopCameraPtzSettleTimeoutMs,
          pollMs: cameraLimits.desktopCameraPtzPollMs
        };
        const action = String(a.action || 'status').trim().toLowerCase();
        if (action === 'status') return desktopCameraPtz.status({ device });
        if (action === 'move') {
          return desktopCameraPtz.apply({ device, pan: a.pan, tilt: a.tilt, zoom: a.zoom, ...settle });
        }
        if (action === 'step') {
          return desktopCameraPtz.apply({
            device,
            panDelta: a.pan_delta,
            tiltDelta: a.tilt_delta,
            ...settle
          });
        }
        if (action === 'center') return desktopCameraPtz.apply({ device, pan: 0, tilt: 0, ...settle });
        return {
          ok: false,
          errorCode: 'INVALID_ARG',
          retryable: false,
          error: `action 只能是 status / move / step / center，这次是「${a.action}」。`
        };
    }
  };
}

module.exports = { createCameraHandlers };
