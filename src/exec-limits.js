'use strict';

/**
 * 「一条命令能跑多久、能带回多少输出」的唯一来源。
 *
 * 本机 `runShell`（gateway/host-control.js）与远端 `exec`（ssh/session-manager.js）必须用
 * **同一份**契约：同一条 host_exec 调用，只因工作区在本地还是远端，就该得到同样的超时上限与
 * 同样的截断行为。历史事故：远端侧自己写了 `Math.min(180000, …)`，把工具声明允许的 600s
 * 静默夹成 180s —— 长构建在远端必然失败、在本地必然成功。
 *
 * 数字只在这里改；两个传输层都从这里取。
 */

/** 未指定超时时的默认值（与 host_exec 工具描述里的默认一致）。 */
const EXEC_TIMEOUT_DEFAULT_MS = 90000;

/** 单条命令的硬上限：10 分钟（编译/渲染/打包常见量级，与工具 schema 的 max 一致）。 */
const EXEC_TIMEOUT_MAX_MS = 600000;

/**
 * 单条命令输出缓冲上限（字符）：超过就丢头部留尾部，并回传丢弃量。
 * 长任务的报错与进度都在尾部；不设上限时一条 `yes` 就能把主进程内存吃光。
 */
const EXEC_OUTPUT_MAX_CHARS = 512 * 1024;

/**
 * 把调用方给的超时夹到契约区间内（唯一实现）。
 * @param {unknown} raw
 * @returns {number}
 */
function clampExecTimeoutMs(raw) {
  return Math.min(EXEC_TIMEOUT_MAX_MS, Math.max(1000, Number(raw) || EXEC_TIMEOUT_DEFAULT_MS));
}

module.exports = {
  EXEC_TIMEOUT_DEFAULT_MS,
  EXEC_TIMEOUT_MAX_MS,
  EXEC_OUTPUT_MAX_CHARS,
  clampExecTimeoutMs
};
