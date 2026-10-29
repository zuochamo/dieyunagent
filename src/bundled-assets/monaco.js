'use strict';

/**
 * 随安装包预装的前端资产（当前只有 Monaco 编辑器）。
 *
 * 曾经的「组件」机制是：设置页里手动下载 / 安装 zip / 记录引用计数。
 * 现在 Monaco 直接随包发布，这里只负责把「它在哪」告诉渲染进程，
 * 不再有下载、进度、启用状态这些概念。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** extraResources 里的目录名（package.json build.extraResources → resources/monaco-editor）。 */
const MONACO_RESOURCE_DIR = 'monaco-editor';
/** 存在这个文件才算「装好了」，避免把空目录当资产。 */
const MONACO_MARKER_REL = path.join('min', 'vs', 'editor', 'editor.main.js');

/**
 * @param {{ resourcesPath?: string }} [opts]
 * @returns {string} Monaco 包根目录；找不到返回 ''
 */
function resolveMonacoRoot(opts = {}) {
  const resourcesPath = opts.resourcesPath || process.resourcesPath || '';
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, MONACO_RESOURCE_DIR));
  // 开发态：直接从 node_modules 读，和安装包里的目录结构一致（min/vs/...）
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', MONACO_RESOURCE_DIR));
  return candidates.find((root) => fs.existsSync(path.join(root, MONACO_MARKER_REL))) || '';
}

/**
 * Monaco 的 `vs` 目录 URL（file: 形式，渲染进程直接给 loader.js / editor.main.css 拼路径）。
 * @param {{ resourcesPath?: string }} [opts]
 * @returns {string}
 */
function getMonacoVsUrl(opts = {}) {
  const root = resolveMonacoRoot(opts);
  if (!root) return '';
  return pathToFileURL(path.join(root, 'min', 'vs')).href.replace(/\/+$/, '');
}

module.exports = {
  MONACO_RESOURCE_DIR,
  MONACO_MARKER_REL,
  resolveMonacoRoot,
  getMonacoVsUrl
};
