'use strict';

/**
 * 附件图片保留策略：容量优先 + 原地降采样。
 *
 * 为什么不是「删最早」：历史消息里保留了 `[附件图 …: <path>]` 标记，模型可能随时
 * 按路径补看。删文件会造成悬空引用（模型读到 ENOENT，还会误判「文件被删/工作区变了」）。
 * 原地降采样既把磁盘压下来，又让引用永远有效，代价只是清晰度降级。
 *
 * 约束：
 * - 只处理可安全重编码的图片（png/jpg/jpeg）；gif/webp/bmp 原样保留；
 * - 不改文件名、不改路径，因此历史标记无需任何改写；
 * - 小于「附件降采样最小体积」的图不再处理，保证多轮修剪收敛，不会反复重编码同一张；
 * - 每趟最多处理 MAX_FILES_PER_PASS 个文件，避免首次修剪把主进程卡住；
 * - 失败静默：保留策略绝不能影响正常发送附件。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { AGENT_LIMITS_DEFAULTS } = require('./agent/agent-limits');
const { resolveAttachmentsDir } = require('./attachment-store');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
/** 可原地重编码的格式：其它容器（gif 动画 / webp / bmp）不动，避免破坏内容 */
const RESIZABLE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const JPEG_QUALITY = 72;
/** 重编码后至少要小这么多比例才写回，避免无意义抖动 */
const MIN_SHRINK_RATIO = 0.9;
/** 单文件读取上限：异常巨大的图不值得为它把内存拉满 */
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** 单趟最多处理文件数（后台跑，宁可分多趟） */
const MAX_FILES_PER_PASS = 32;

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 把 agent-limits 的 MB / px / KB 口径换算成字节与像素。 */
function resolveRetentionLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  return {
    maxTotalBytes:
      toInt(l.attachmentRetentionMaxMb, AGENT_LIMITS_DEFAULTS.attachmentRetentionMaxMb) * 1024 * 1024,
    maxPx: toInt(l.attachmentDownsampleMaxPx, AGENT_LIMITS_DEFAULTS.attachmentDownsampleMaxPx),
    minBytes: toInt(l.attachmentDownsampleMinKb, AGENT_LIMITS_DEFAULTS.attachmentDownsampleMinKb) * 1024
  };
}

function isImageName(name) {
  return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase());
}

function isResizableName(name) {
  return RESIZABLE_EXT.has(path.extname(String(name || '')).toLowerCase());
}

/** 默认解码器：Electron 主进程的 nativeImage。测试可注入替身。 */
function defaultDecodeImage(buffer) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buffer);
  if (!img || img.isEmpty()) return null;
  return img;
}

/** 等比缩到最长边 maxPx，并按原扩展名重编码（不换容器，避免扩展名与内容不符）。 */
function encodeDownsampled(img, ext, maxPx) {
  const size = (img.getSize && img.getSize()) || { width: 0, height: 0 };
  const width = Number(size.width) || 0;
  const height = Number(size.height) || 0;
  const longest = Math.max(width, height);
  let out = img;
  if (maxPx > 0 && longest > maxPx) {
    const ratio = maxPx / longest;
    out = img.resize({
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
      quality: 'good'
    });
  }
  const isJpeg = ext === '.jpg' || ext === '.jpeg';
  return isJpeg ? out.toJPEG(JPEG_QUALITY) : out.toPNG();
}

async function listImageFiles(target) {
  if (target.kind === 'local') {
    let entries;
    try {
      entries = await fsp.readdir(target.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const ent of entries) {
      if (!ent.isFile() || !isImageName(ent.name)) continue;
      const full = path.join(target.dir, ent.name);
      try {
        const st = await fsp.stat(full);
        out.push({ name: ent.name, full, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* 单个文件 stat 失败不影响整体 */
      }
    }
    return out;
  }
  try {
    const res = await target.ssh.browse(target.dir);
    const entries = res && Array.isArray(res.entries) ? res.entries : [];
    return entries
      .filter((e) => e && !e.isDirectory && isImageName(e.name))
      .map((e) => ({
        name: e.name,
        full: path.posix.join(target.dir, e.name),
        size: Number(e.size) || 0,
        mtimeMs: Number(e.mtimeMs) || 0
      }));
  } catch {
    return [];
  }
}

async function readImageBuffer(target, item) {
  if (target.kind === 'local') return fsp.readFile(item.full);
  const r = await target.ssh.sftpReadFile(item.full, MAX_READ_BYTES);
  if (!r || r.truncated || !r.buf) return null;
  return r.buf;
}

async function writeImageBuffer(target, item, buf) {
  if (target.kind === 'local') {
    // 临时文件 + rename：避免正在被读取时拿到半张图。
    // 名字带随机串，避免同一毫秒内两次修剪撞名；失败时清掉临时文件，不留垃圾。
    const tmp = `${item.full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, item.full);
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* 临时文件可能根本没建出来 */
      }
      throw err;
    }
    return;
  }
  await target.ssh.sftpWriteFile(item.full, buf);
}

/** 处理单张：成功返回省下的字节数，未处理/失败返回 0。 */
async function downsampleOne(target, item, cfg, decodeImage) {
  let buf;
  try {
    buf = await readImageBuffer(target, item);
  } catch {
    return 0;
  }
  if (!buf || !buf.length) return 0;
  let img;
  try {
    img = decodeImage(buf);
  } catch {
    img = null;
  }
  if (!img) return 0;
  let out;
  try {
    out = encodeDownsampled(img, path.extname(item.name).toLowerCase(), cfg.maxPx);
  } catch {
    return 0;
  }
  if (!out || !out.length) return 0;
  if (out.length >= buf.length * MIN_SHRINK_RATIO) return 0;
  try {
    await writeImageBuffer(target, item, out);
  } catch {
    return 0;
  }
  return buf.length - out.length;
}

/**
 * 按容量上限修剪附件图片：超限时从最旧的开始原地降采样。
 *
 * @param {object} [opts]
 * @param {object} [opts.localGateway] Gateway（解析工作区与 ssh）
 * @param {{ kind: 'local'|'ssh', dir: string, ssh?: object }} [opts.target] 直接指定目录（测试用）
 * @param {object} [opts.limits] agent-limits 解析结果
 * @param {Function} [opts.decodeImage] 解码器替身（测试用）
 * @returns {Promise<{ skipped?: string, totalBytes: number, downsized: number, freedBytes: number, checked: number }>}
 */
async function pruneAttachmentImages(opts = {}) {
  const target = opts.target || resolveAttachmentsDir(opts.localGateway || null);
  const base = { totalBytes: 0, downsized: 0, freedBytes: 0, checked: 0 };
  if (!target) return { ...base, skipped: 'no-workspace' };
  const cfg = resolveRetentionLimits(opts.limits);
  if (!(cfg.maxTotalBytes > 0)) return { ...base, skipped: 'disabled' };
  const decodeImage = typeof opts.decodeImage === 'function' ? opts.decodeImage : defaultDecodeImage;

  const files = await listImageFiles(target);
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes <= cfg.maxTotalBytes) return { ...base, totalBytes };

  // 最旧的先处理；mtime 相同时按名字兜底，保证顺序稳定可复现
  const candidates = files
    .filter((f) => f.size > cfg.minBytes && isResizableName(f.name))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

  let downsized = 0;
  let freedBytes = 0;
  let checked = 0;
  for (const item of candidates) {
    if (totalBytes <= cfg.maxTotalBytes) break;
    if (checked >= MAX_FILES_PER_PASS) break;
    checked += 1;
    const saved = await downsampleOne(target, item, cfg, decodeImage);
    if (saved > 0) {
      downsized += 1;
      freedBytes += saved;
      totalBytes -= saved;
    }
  }
  return { totalBytes, downsized, freedBytes, checked };
}

module.exports = {
  IMAGE_EXT,
  RESIZABLE_EXT,
  MAX_FILES_PER_PASS,
  resolveRetentionLimits,
  isImageName,
  isResizableName,
  encodeDownsampled,
  pruneAttachmentImages
};
