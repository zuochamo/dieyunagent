'use strict';

/**
 * 屏幕与摄像头：手机拍照（mobile/camera-source）与本机 UVC（desktop-camera-source）。像素本体不进工具结果，这里只取帧与额度。
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
    }
  };
}

module.exports = { createCameraHandlers };
