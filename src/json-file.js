'use strict';

const fs = require('fs');
const path = require('path');

/**
 * JSON 文件读写**全仓单一来源**（`mcp/catalog`、`skills/catalog`、`deploy-config` 都走这一份）。
 *
 * 读失败一律返回 `fallback`、不抛：调用方都是「缓存 / 配置损坏就当它不存在」的语义。
 * 记事本与部分编辑器会写入 UTF-8 BOM，直接 `JSON.parse` 会抛错并静默丢掉整份配置，
 * 所以先剥 BOM（这条教训原本只写在 `deploy-config.js` 里，其余两处各抄了一份不带 BOM 的版本）。
 *
 * 写不做原子替换：这两个使用者写的是可重建的缓存 / 目录源列表，半截文件下次读会走
 * `fallback` 重取。真要原子写（用户产物、检查点）用 `fs-atomic.js`。
 */
function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { readJsonFile, writeJsonFile };
