/**
 * electron-builder 在 win.signAndEditExecutable=false 时会跳过内置 rcedit，exe 仍为 Electron 默认图标。
 * 本脚本在打包目录生成后，用 node-rcedit 写入图标与进程显示名 dieyunagent。
 *
 * 另外承担一个跨平台的硬校验：安装包里必须带可用的 core sidecar。
 * 位置按平台不同（见 assertBundledCore）：Windows 是 resources/dieyun-core/dieyun-core.exe，
 * Linux 复用远端注入包里的 resources/remote-gateway-pack/bin/dieyun-core（同一个 ELF 不存两遍）。
 * 它来自 package.json 的 extraResources；electron-builder 对不存在的 from 只 warn 不失败，
 * 所以这里补一道闸门——否则打出来的包装上去才没有 Agent。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 本地 core sidecar 必须在、且不是空壳（Windows 与 Linux 都要） */
function assertBundledCore(context) {
  const win = context.electronPlatformName === 'win32';
  const coreName = win ? 'dieyun-core.exe' : 'dieyun-core';
  const { REMOTE_PACK_DIR_NAME, REMOTE_PACK_CORE_REL } = require('../src/remote/remote-pack-layout.js');

  // 存放位置（与 src/core-bridge-path.js 的解析顺序一致）：
  //   Windows：本机 sidecar 是 PE，远端注入包里的 Linux core 不能顶替，只能两份
  //   Linux  ：本机 sidecar 与远端注入包里的 core 是**同一个 ELF**，只在 pack 里存一份
  const candidates = [path.join(context.appOutDir, 'resources', 'dieyun-core', coreName)];
  if (!win) {
    candidates.push(
      path.join(context.appOutDir, 'resources', ...REMOTE_PACK_DIR_NAME.split('/'), ...REMOTE_PACK_CORE_REL.split('/'))
    );
  }

  const coreExe = candidates.find((p) => fs.existsSync(p));
  if (!coreExe) {
    throw new Error('[afterPack] 未找到 dieyun-core 可执行文件，试过：\n  ' + candidates.join('\n  '));
  }
  const coreSize = fs.statSync(coreExe).size;
  if (coreSize < 500 * 1024) {
    throw new Error(`[afterPack] dieyun-core 体积异常 (${coreSize} bytes): ${coreExe}`);
  }
  if (!win) {
    // Linux 包里的 core 必须是 ELF：装错平台（PE）时这里当场失败，别等用户连上才报「core 起不来」
    const fd = fs.openSync(coreExe, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString('latin1') !== '\x7fELF') {
      throw new Error(`[afterPack] Linux 包里的 dieyun-core 不是 ELF：${coreExe}`);
    }
  }
  console.log('[afterPack] dieyun-core OK:', coreExe, `(${Math.round(coreSize / 1024)} KB)`);
}

/**
 * 体积预算闸门（**唯一来源**）。
 *
 * 为什么存在：2026-11 实测，koffi 把 18 个平台的 `koffi.node` 全打进了包（原始 26.6MB）、
 * mermaid 的一整套运行时依赖（d3 / dayjs / dompurify / es-toolkit…）与 xlsx 的多份 dist 也都在包里 ——
 * 安装包一路涨到 159MB，而这条打包链上没有任何一处会因为「包变大了」失败，只有发版的人自己发现。
 * 这里把「能接受多大」写成打包期断言：超了当场失败。
 *
 * 每条上限 = 裁剪之后实测值 + 约 15% 余量。真要往上调，改这里的数字并说明为什么，
 * 别在别处另写一份体积清单；要按平台区分就写进 package.json 的 build.win.files / build.linux.files。
 */
const SIZE_BUDGETS_MB = [
  ['resources', 195, 'resources/ 整体（core + 远程包 + asar + monaco + mcp）'],
  // 远程包 = 内置 node + Linux core + 纯 JS。上限只负责兜「混进了整包/多平台产物」；
  // 内置 node 自己的不变量在下一条（换 node 版本时两处一起复核）。
  ['resources/remote-gateway-pack', 106, '远程 Agent 包（含内嵌 Linux Node 运行时）'],
  ['resources/remote-gateway-pack/bin/node', 86, '内嵌 Linux Node：必须 strip 过（strip 前 94MB / 后 80MB）'],
  ['resources/app.asar', 43, 'app 主体（src + 生产依赖闭包）'],
  ['resources/app.asar.unpacked', 7, '解包的原生模块（koffi / uiohook 只留本平台）'],
  ['resources/monaco-editor', 14, 'Monaco（只打 min/）'],
  ['resources/mcp', 13, '离线预装 MCP（postgres）'],
  ['resources/dieyun-core', 18, 'core sidecar（Windows 才有；Linux 复用 pack 里那一份）']
];

/** 整个产物目录（含 Electron 运行时）的上限 */
const APP_OUT_BUDGET_MB = 520;

function dirSizeBytes(abs) {
  let total = 0;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 打包目录里偶有瞬时文件；闸门靠总量判断，忽略即可
        }
      }
    }
  }
  return total;
}

/**
 * 出包体积表 + 预算断言。跑在 afterPack（两端都跑），所以 Linux 侧 deb 也有同一道闸门 ——
 * 以前只有 Windows 侧有 verify:asar，Linux 侧体积涨了没人知道。
 */
function assertSizeBudget(context) {
  const MB = 1024 * 1024;
  const rows = [];
  for (const [rel, budget, label] of SIZE_BUDGETS_MB) {
    const abs = path.join(context.appOutDir, ...rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    rows.push({ rel, label, mb: dirSizeBytes(abs) / MB, budget });
  }
  const totalMb = dirSizeBytes(context.appOutDir) / MB;

  console.log('[afterPack] 体积表:');
  for (const r of rows) {
    const pct = String(Math.round((100 * r.mb) / r.budget)).padStart(3);
    console.log(
      `  ${r.rel.padEnd(30)} ${r.mb.toFixed(1).padStart(7)} MB / ${String(r.budget).padStart(4)} MB (${pct}%)  ${r.label}`
    );
  }
  const totalPct = String(Math.round((100 * totalMb) / APP_OUT_BUDGET_MB)).padStart(3);
  console.log(
    `  ${'<产物目录>'.padEnd(30)} ${totalMb.toFixed(1).padStart(7)} MB / ${String(APP_OUT_BUDGET_MB).padStart(4)} MB (${totalPct}%)`
  );

  const over = rows
    .filter((r) => r.mb > r.budget)
    .map((r) => `  ${r.rel}: ${r.mb.toFixed(1)}MB > 预算 ${r.budget}MB（${r.label}）`);
  if (totalMb > APP_OUT_BUDGET_MB) {
    over.push(`  产物目录: ${totalMb.toFixed(1)}MB > 预算 ${APP_OUT_BUDGET_MB}MB`);
  }
  if (over.length) {
    throw new Error(
      '[afterPack] 打包体积超预算，已中止（别把这个包发出去）：\n' +
        over.join('\n') +
        '\n  要留新东西就改 scripts/after-pack-win-icon.cjs 的 SIZE_BUDGETS_MB 并写清原因；' +
        '要区分平台就写进 package.json 的 build.win.files / build.linux.files。'
    );
  }
}

/** @type {import('electron-builder').AfterPackContext} */
module.exports = async function afterPackWinIcon(context) {
  assertBundledCore(context);
  assertSizeBudget(context);

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
}
