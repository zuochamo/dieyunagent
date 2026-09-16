/**
 * electron-builder 在 win.signAndEditExecutable=false 时会跳过内置 rcedit，exe 仍为 Electron 默认图标。
 * 本脚本在打包目录生成后，用 node-rcedit 写入图标与进程显示名 dieyunagent。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** @type {import('electron-builder').AfterPackContext} */
module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = require('rcedit');
  const name = context.packager.appInfo.productFilename;
  const exe = path.join(context.appOutDir, `${name}.exe`);
  if (!fs.existsSync(exe)) {
    console.warn('[afterPack-win-icon] 未找到 exe:', exe);
    return;
  }
  const icon = path.join(context.packager.projectDir, 'assets', 'icon.ico');
  if (!fs.existsSync(icon)) {
    console.warn('[afterPack-win-icon] 未找到 icon:', icon);
    return;
  }

  const version = context.packager.appInfo.version || '0.0.0';
  console.log('[afterPack-win-icon] 写入图标与进程名:', path.basename(exe));
  await rcedit(exe, {
    icon,
    'product-version': version,
    'file-version': version,
    'version-string': {
      FileDescription: '叠云 agent',
      ProductName: 'dieyunagent',
      OriginalFilename: 'dieyunagent.exe',
      InternalName: 'dieyunagent',
      CompanyName: 'dieyunagent'
    }
  });

  const coreName = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
  const coreExe = path.join(context.appOutDir, 'resources', 'dieyun-core', coreName);
  if (!fs.existsSync(coreExe)) {
    throw new Error('[afterPack] 未找到 dieyun-core sidecar: ' + coreExe);
  }
  const coreSize = fs.statSync(coreExe).size;
  if (coreSize < 500 * 1024) {
    throw new Error(`[afterPack] dieyun-core 体积异常 (${coreSize} bytes): ${coreExe}`);
  }
  console.log('[afterPack] dieyun-core OK:', coreExe, `(${Math.round(coreSize / 1024)} KB)`);
};
