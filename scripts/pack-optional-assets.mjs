#!/usr/bin/env node
/**
 * 打包按需下载资源到 dist/optional/，与安装包分开发布（COS optional/）。
 */
'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { MONACO_VERSION, REMOTE_NODE_VERSION, BGE_MODEL_NAME, OPTIONAL_ASSETS } = require('../src/optional-assets/manifest.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'optional');

function runOrThrow(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

async function zipDirContents(srcDir, zipPath) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) await fsp.rm(zipPath);
  if (process.platform === 'win32') {
    const srcQ = srcDir.replace(/'/g, "''");
    const zipQ = zipPath.replace(/'/g, "''");
    runOrThrow('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${srcQ}', '${zipQ}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`
    ]);
    return;
  }
  runOrThrow('zip', ['-rq', zipPath, '.'], { cwd: srcDir });
}

async function copyNodeTarball() {
  const tarball = `node-${REMOTE_NODE_VERSION}-linux-x64.tar.gz`;
  const cache = path.join(ROOT, 'build', '.cache', tarball);
  const dest = path.join(OUT, tarball);
  if (!fs.existsSync(cache)) {
    console.warn(`[optional-assets] 缺少 ${cache}，请先运行 npm run pack:remote-gateway 下载 Node`);
    return false;
  }
  await fsp.mkdir(OUT, { recursive: true });
  await fsp.copyFile(cache, dest);
  console.log('[optional-assets] OK', tarball);
  return true;
}

async function packMonaco() {
  const src = path.join(ROOT, 'node_modules', 'monaco-editor');
  if (!fs.existsSync(path.join(src, 'min', 'vs', 'editor', 'editor.main.js'))) {
    console.warn('[optional-assets] 跳过 monaco-editor（node_modules 未安装）');
    return false;
  }
  const zipPath = path.join(OUT, `monaco-editor-${MONACO_VERSION}.zip`);
  await zipDirContents(src, zipPath);
  console.log('[optional-assets] OK', path.basename(zipPath));
  return true;
}

async function packBge() {
  const src = path.join(ROOT, 'models', BGE_MODEL_NAME);
  const marker = path.join(src, 'onnx', 'model_quantized.onnx');
  if (!fs.existsSync(marker)) {
    console.warn('[optional-assets] 跳过 BGE（缺少 models/' + BGE_MODEL_NAME + '/onnx/model_quantized.onnx）');
    return false;
  }
  const def = OPTIONAL_ASSETS[BGE_MODEL_NAME];
  const zipName = (def && def.archive) || `${BGE_MODEL_NAME}.zip`;
  const zipPath = path.join(OUT, zipName);
  await zipDirContents(src, zipPath);
  console.log('[optional-assets] OK', path.basename(zipPath));
  return true;
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const results = await Promise.all([packBge(), packMonaco(), copyNodeTarball()]);
  if (!results.some(Boolean)) {
    console.warn('[optional-assets] 未生成任何 optional 包（开发机可能缺模型/onnx）');
  } else {
    console.log('[optional-assets] 输出目录:', OUT);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
