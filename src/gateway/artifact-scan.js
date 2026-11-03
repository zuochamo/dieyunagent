'use strict';

/**
 * 「按 mtime 窗口列出工作区文件」的**唯一实现**（本地 fs / 远端 SFTP / 远程 Agent 共用）。
 *
 * 为什么需要它：产物区（本会话 Agent 产出过什么）过去只认 `fs_write_file` / `fs_edit`
 * 两个工具的路径参数，于是 `host_exec` 跑 python-docx / openpyxl、浏览器截图、插件落盘的
 * docx / xlsx / png / html 全都不进列表 —— 产物区变成「只有代码和 md」。
 * 判定产物不该问「哪个工具写的」，而该问「这个文件在本会话期间被改过没有」，这件事只有
 * 持有文件系统的一层知道，形态就是「按 mtime 过滤的目录遍历」。
 *
 * 本文件之前这门逻辑在三个地方各写一份（rpc.js 本地版 / remote-fs.js SFTP 版 /
 * minimal-gateway-host.js 远程版），排除表还各不完全一致。这里收敛成一份：
 * 差异只剩「怎么读目录」——由调用方注入 io 适配器。
 */

/** 遍历时不进入的目录：依赖 / 构建产物 / VCS 与 Agent 元数据。 */
const ARTIFACT_SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.codex',
  '.dieyun',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  'dist',
  'build',
  'out',
  'release',
  'target',
  'vendor',
  'win-unpacked'
]);

const DEFAULT_ARTIFACT_SCAN_LIMIT = 200;
const MAX_ARTIFACT_SCAN_LIMIT = 500;
const DEFAULT_ARTIFACT_SCAN_MAX_DEPTH = 4;
/** 访问文件数硬上限：巨型工作区里一次面板刷新不能变成秒级扫描。 */
const MAX_ARTIFACT_SCAN_VISITED = 20000;

function normalizeScanLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ARTIFACT_SCAN_LIMIT;
  return Math.min(MAX_ARTIFACT_SCAN_LIMIT, Math.max(1, Math.floor(n)));
}

function normalizeScanMaxDepth(depth) {
  const n = Number(depth);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ARTIFACT_SCAN_MAX_DEPTH;
  return Math.min(12, Math.floor(n));
}

/**
 * 遍历 base 下的文件，返回 mtime >= sinceMs 的（按 mtime 倒序，最多 limit 条）。
 *
 * `sinceMs = 0` 表示不设时间窗（等价于「列出最近改过的文件」，老调用方的口径）。
 *
 * @param {{ readdir: (dir: string) => Promise<Array<{name: string, isDirectory?: boolean, isFile?: boolean, mtimeMs?: number, size?: number}>>, stat?: (full: string) => Promise<{mtimeMs?: number, size?: number}>, join: (dir: string, name: string) => string, relative: (base: string, full: string) => string }} io
 * @param {{ base: string, sinceMs?: number, limit?: number, maxDepth?: number }} opts
 * @returns {Promise<{ base: string, files: Array<{path: string, relativePath: string, size: number, mtimeMs: number}>, total: number, truncated: boolean }>}
 */
async function scanRecentArtifactFiles(io, opts = {}) {
  const base = String(opts.base || '').trim();
  if (!base) return { base: '', files: [], total: 0, truncated: false };
  const sinceMs = Math.max(0, Number(opts.sinceMs) || 0);
  const limit = normalizeScanLimit(opts.limit);
  const maxDepth = normalizeScanMaxDepth(opts.maxDepth);

  const found = [];
  let visited = 0;
  let truncated = false;
  const stack = [{ dir: base, depth: 0 }];

  while (stack.length && !truncated) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await io.readdir(cur.dir);
    } catch {
      continue; // 无权限 / 目录被删掉：跳过，不让一个坏目录毒掉整次扫描
    }
    if (!Array.isArray(entries)) continue;
    for (const ent of entries) {
      if (!ent || !ent.name) continue;
      // Office 锁文件（~$xxx.docx）是打开文档时生成的临时文件，不是产物
      if (ent.name.startsWith('~$')) continue;
      const full = io.join(cur.dir, ent.name);
      if (ent.isDirectory) {
        if (cur.depth < maxDepth && !ARTIFACT_SKIP_DIRS.has(ent.name)) {
          stack.push({ dir: full, depth: cur.depth + 1 });
        }
        continue;
      }
      // 既不是目录也不是普通文件（符号链接 / 设备文件）：不当产物
      if (ent.isFile === false) continue;
      visited += 1;
      if (visited > MAX_ARTIFACT_SCAN_VISITED) {
        truncated = true;
        break;
      }
      let meta = null;
      if (ent.mtimeMs != null) {
        meta = { mtimeMs: Number(ent.mtimeMs) || 0, size: Number(ent.size) || 0 };
      } else if (typeof io.stat === 'function') {
        try {
          meta = await io.stat(full);
        } catch {
          meta = null;
        }
      }
      if (!meta) continue;
      const mtimeMs = Number(meta.mtimeMs) || 0;
      if (sinceMs && mtimeMs < sinceMs) continue;
      found.push({
        path: full,
        relativePath: io.relative(base, full) || ent.name,
        size: Number(meta.size) || 0,
        mtimeMs
      });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { base, files: found.slice(0, limit), total: found.length, truncated };
}

/** 本地 fs 的 io 适配器（唯一一份；dirent 不带 mtime，故按需 stat） */
function createLocalScanIo() {
  const fsp = require('fs/promises');
  const path = require('path');
  return {
    async readdir(dir) {
      const list = await fsp.readdir(dir, { withFileTypes: true });
      return list.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile()
      }));
    },
    async stat(full) {
      const st = await fsp.stat(full);
      return { mtimeMs: st.mtimeMs, size: st.size };
    },
    join: (dir, name) => path.join(dir, name),
    relative: (base, full) => path.relative(base, full)
  };
}

module.exports = {
  ARTIFACT_SKIP_DIRS,
  DEFAULT_ARTIFACT_SCAN_LIMIT,
  scanRecentArtifactFiles,
  createLocalScanIo
};
