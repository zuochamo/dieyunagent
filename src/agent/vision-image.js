'use strict';

/**
 * 视觉图片的「可寻址凭证」：落盘副本 + 统一文案 + 视觉 token 口径。
 *
 * 为什么需要它：工具产出的图片（computer 截图、MCP 图像）过去只活在运行期视觉缓冲里，
 * base64 注入完即丢。模型想再看一眼细节（裁剪放大、对照前后两帧、确认小字）只能重拍一张
 * 整屏——而重拍既可能失败（超体积被丢），也可能早已错过当时那一帧。
 * 这里把图片按内容寻址写一份只读副本，并把「凭证」交回工具结果：
 * 模型据此可以用 fs_read_file / host_exec 二次处理，视觉通道失败时也仍有可读的退路。
 *
 * 三个职责同处一文件的关系：三者都只描述「同一张图」，口径必须一致 ——
 * 幂等身份（sha256）、注入尺寸、视觉 token 成本、（成功/失败）两句文案都从同一个
 * handle 对象派生，不允许调用方各自拼一份。
 *
 * 与 browser 截图的边界：`browser_screenshot` 自己已经落盘（返回 path/savePath），
 * 调用方应把那个路径直接当 handle 用，不要再存第二份（见 tool-bridge-main 的取值顺序）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { resolveSpillRoot } = require('./tool-output-spill');
const { isVirtualWorkspacePath, workspaceRelativeSpillPath } = require('./host-sidecar');
const { normalizeVisionImageMime } = require('./guardrails-shared');

/** 落盘子目录（挂在 tool-output 根下：与其它工具产物同源，模型可用同一套路径读回）。 */
const VISION_IMAGE_DIR = 'vision';

//#region 视觉 token 口径
/**
 * DeepSeek 公开的图片 token 算法（api-docs 的 Token & Token Usage 一节）：
 * 先把小于 544×544 的图按比例放大到该下限，再按 14px patch 对齐、每轴 3:1 下采样成
 * token 格子，最后把整图控制在 1024 token 以内（按原长宽比解最大格网）。
 *
 * 用途：给「这张图在请求里花多少视觉 token」一个真实数字，写进工具结果与文案，
 * 让上下文成本可核对。**不**用它替换 `agent-limits.visionPartEqChars` ——那是账本里的
 * 保守折算系数，要覆盖所有 provider；而各家的图片换算公式并不一致，统一的单一来源
 * 只能是那个保守值（按 provider 分别定价需要适配器矩阵，属另一件事）。
 */
const PATCH_SIZE = 14;
/** 每轴 patch → token 的下采样比。 */
const DOWNSAMPLE_RATIO = 3;
/** 单张图的 token 上限。 */
const MAX_IMAGE_TOKENS = 1024;
/** 总像素下限：更小的图会先被放大到这里再投影。 */
const MIN_PIXELS = 544 * 544;
/** 一个 token 格子覆盖的像素边长。 */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

const intDiv = (value, divisor) => Math.floor(value / divisor);
const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor);

/** 一格网含多少 token：每行多一个分隔符，外加两个框定 token。 */
function gridTokens(gridHeight, gridWidth) {
  return gridHeight * (gridWidth + 1) + 2;
}

/** 某一维（已对齐 patch）覆盖的格子数。 */
function gridCells(paddedLength) {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}

/** 在 token 预算内解出最大且保持长宽比的格网。 */
function solveResizeRatio(height, width, budget) {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight;
  let bestWidth;
  if (idealGridWidth < 1) {
    // 极端竖图：宽度只剩 1 格
    const solvedGridHeight = intDiv(budget - 2, 2);
    bestWidth = CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else if (idealGridHeight < 1) {
    // 极端横图：高度只剩 1 格
    bestWidth = (intDiv(budget - 2, 1) - 1) * CELL_SIZE;
    bestHeight = CELL_SIZE;
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth);
    const solvedGridHeight = Math.trunc(idealGridHeight);
    const scale = Math.min(
      (solvedGridWidth * CELL_SIZE) / width,
      (solvedGridHeight * CELL_SIZE) / height
    );
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE;
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE;
  }
  const gridHeight = gridCells(bestHeight);
  const gridWidth = gridCells(bestWidth);
  return {
    gridHeight,
    gridWidth,
    bestHeight,
    bestWidth,
    numTokens: gridTokens(gridHeight, gridWidth)
  };
}

/** 一次「放大 → 对齐 → 投影」；由调用方迭代到不动点。 */
function resizeOnce(width, height) {
  let scaledWidth = width;
  let scaledHeight = height;
  const pixels = scaledWidth * scaledHeight;
  if (pixels > 0 && pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    scaledWidth = Math.trunc(scaledWidth * scale);
    scaledHeight = Math.trunc(scaledHeight * scale);
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
  const gridHeight = gridCells(paddedHeight);
  const gridWidth = gridCells(paddedWidth);
  const direct = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth)
  };
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct;
  const solved = solveResizeRatio(scaledHeight, scaledWidth, MAX_IMAGE_TOKENS);
  // 闭式解在任意正几何下都应落在预算内；真越界时退回直接投影，保证只多不少、不抛错。
  return solved.numTokens <= MAX_IMAGE_TOKENS ? solved : direct;
}

/**
 * 一张 `width × height` 的图在请求里要花多少视觉 token（0 → 尺寸不可用）。
 * @param {number} width 注入尺寸的宽
 * @param {number} height 注入尺寸的高
 * @returns {number} 视觉 token 数（≤ 1024；尺寸非法时为 0）
 */
function visionTokensForSize(width, height) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return 0;
  let result = resizeOnce(w, h);
  for (let i = 0; i < 10; i += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight);
    if (
      next.gridWidth === result.gridWidth &&
      next.gridHeight === result.gridHeight &&
      next.bestWidth === result.bestWidth &&
      next.bestHeight === result.bestHeight
    ) {
      return result.numTokens;
    }
    result = next;
  }
  return result.numTokens;
}
//#endregion

//#region 落盘
function imageExtension(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.png';
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * 只留最新的 keep 张（按 mtime），并清掉空目录。best-effort：任何异常都不影响本次写入。
 * keep ≤ 0 表示不裁剪（测试与「显式关掉」都用它）。
 * 为什么要裁：电脑控制一次任务能动辄几十张整屏截图，不裁就是无上限占盘。
 */
function pruneVisionImages(root, keep) {
  const limit = Math.floor(Number(keep));
  if (!(limit > 0)) return 0;
  const files = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(root, ent.name);
    let names;
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(sub, name);
      const st = statSafe(file);
      if (st && st.isFile()) files.push({ file, dir: sub, mtime: st.mtimeMs });
    }
  }
  if (files.length <= limit) return 0;
  files.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const item of files.slice(limit)) {
    try {
      fs.unlinkSync(item.file);
      removed += 1;
    } catch {
      /* 单个删不掉不影响其它 */
    }
  }
  for (const dir of new Set(files.slice(limit).map((f) => f.dir))) {
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {
      /* 目录非空或已被删 */
    }
  }
  return removed;
}

/**
 * 把一张工具产出的图片写一份只读副本（内容寻址：同图同路径，天然去重）。
 *
 * @param {{ base64?: string, mime?: string, width?: number, height?: number }} shot 工具结果里的图片字段
 * @param {{ workspacePath?: string, userDataPath?: string, limits?: object }} [opts]
 * @returns {{ id: string, path: string, width: number, height: number, mime: string, bytes: number, tokens: number, deduped: boolean } | null}
 *   写盘失败（或图片字段不完整）时返回 null，调用方据此走「没有可读副本」的文案。
 */
function storeVisionImage(shot, opts = {}) {
  const base64 = shot && typeof shot.base64 === 'string' ? shot.base64 : '';
  if (!base64) return null;
  const fallbackMime = 'image/png';
  const mime = normalizeVisionImageMime(String(shot.mime || fallbackMime)) || '';
  if (!mime) return null;
  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  const hex = crypto.createHash('sha256').update(bytes).digest('hex');
  const shard = hex.slice(0, 2);
  const fileName = hex + imageExtension(mime);
  const root = path.join(
    resolveSpillRoot(opts.workspacePath, opts.userDataPath),
    VISION_IMAGE_DIR
  );
  const dir = path.join(root, shard);
  const file = path.join(dir, fileName);
  const deduped = !!statSafe(file);
  if (!deduped) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, bytes, { flag: 'w' });
    } catch {
      return null;
    }
    const keep =
      (opts.limits && opts.limits.visionImageKeepFiles) ||
      AGENT_LIMITS_DEFAULTS.visionImageKeepFiles;
    pruneVisionImages(root, keep);
  }
  const width = Math.floor(Number(shot.width)) || 0;
  const height = Math.floor(Number(shot.height)) || 0;
  // 远程 / 虚拟工作区必须交「虚拟路径」：副本落在**本机** userData 下，
  // 给绝对本地路径会让模型去远端主机找同一个文件（那里没有），与 tool-output-spill 同口径。
  const visiblePath = isVirtualWorkspacePath(opts.workspacePath)
    ? workspaceRelativeSpillPath(`${VISION_IMAGE_DIR}/${shard}`, fileName)
    : file;
  return {
    id: `sha256:${hex}`,
    path: visiblePath,
    width,
    height,
    mime,
    bytes: bytes.length,
    tokens: visionTokensForSize(width, height),
    deduped
  };
}
//#endregion

//#region 文案（模型可见的唯一一份）
function formatBytes(bytes) {
  const n = Math.floor(Number(bytes)) || 0;
  if (!n) return '大小未知';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * 一张图的凭证文案：身份 / 注入尺寸 / 体积 / 视觉 token / 只读副本路径。
 * 模型据此知道「盘上还有一份」，并能在需要细节时自己读回来。
 * @param {{ id?: string, path?: string, width?: number, height?: number, mime?: string, bytes?: number, tokens?: number } | null} handle
 * @param {string} [hint] 追加的行动建议（各调用点语境不同，不写进本函数）
 * @returns {string} 无 handle 时返回空串
 */
function visionHandleText(handle, hint) {
  if (!handle || !handle.path) return '';
  const dims =
    handle.width > 0 && handle.height > 0 ? `${handle.width}×${handle.height}` : '尺寸未知';
  const facts = [
    handle.mime || 'image/png',
    formatBytes(handle.bytes),
    handle.tokens > 0 ? `视觉约 ${handle.tokens} token` : ''
  ].filter(Boolean);
  const head = handle.id ? `图片 ${handle.id}，` : '图片，';
  const base = `${head}预览 ${dims}（${facts.join('，')}）；只读副本：${handle.path}。`;
  return hint ? `${base}${hint}` : base;
}

/**
 * 图没进视觉通道时的文案：说清看不到 + 原因 + 还剩什么退路。
 *
 * 这条文案存在的理由：注入失败原本是静默的，而工具结果默认还写着「将作为视觉输入附到
 * 下一轮」—— 模型就会一直等一张永不到来的图。必须把失败与退路一起摊开。
 *
 * @param {string} reason 失败原因（体积 / 张数 / 格式 / 未开启视觉）
 * @param {{ path?: string, width?: number, height?: number } | null} [handle] 已落盘的副本（可能没有）
 * @returns {string}
 */
function visionOmitText(reason, handle) {
  const why = reason ? `（${reason}）` : '';
  const head = `这张图没有进入视觉通道${why}，所以你看不到画面，也不要假设自己已经看过。`;
  if (!handle || !handle.path) return `${head}这张图也没有留下可读副本。`;
  const dims = handle.width > 0 && handle.height > 0 ? `，${handle.width}×${handle.height}` : '';
  return `${head}只读副本仍在：${handle.path}${dims}；要看就 fs_read_file 它，或用 host_exec 裁剪放大。`;
}

/**
 * 摄像头那一张的「进视觉通道」文案（**没有**落盘副本）。
 *
 * 为什么与 `visionHandleText` 分开：现实画面（你本人、房间、桌上的东西）默认**不留副本** ——
 * 屏幕截图留副本是为了「用 fs_read_file 再看局部」，而现实画面要看就再拍一张，
 * 落盘只会让摄像头变成一台没人要求的录音笔。所以这里的文案不给路径，只给「再拍」的退路。
 *
 * 手机与本机摄像头共用这一段（`subject` 只换称呼）：两者的契约完全一样
 * （一次一张、不落盘、要细节就再拍），各写一份只会让措辞慢慢分叉。
 *
 * @param {number} width
 * @param {number} height
 * @param {string} [subject] 「手机摄像头」/「本机摄像头」
 * @returns {string}
 */
function visionCameraText(width, height, subject = '手机摄像头') {
  const dims = width > 0 && height > 0 ? `（${width}×${height}）` : '';
  return (
    `这张${subject}照片${dims}会作为图片输入附在下一轮，请直接据此回答。` +
    '现实画面不落盘、也没有可读副本：需要更清楚或换个角度，就再拍一张（或请用户调整机位），' +
    '不要凭记忆补细节。'
  );
}

module.exports = {
  MAX_IMAGE_TOKENS,
  visionTokensForSize,
  storeVisionImage,
  pruneVisionImages,
  visionHandleText,
  visionCameraText,
  visionOmitText
};
