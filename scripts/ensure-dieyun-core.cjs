'use strict';

const { execSync } = require('child_process');
const path = require('path');
const { packLooksComplete, packIsFresh, OUT, EXE_NAME } = require('./pack-dieyun-core.cjs');

const ROOT = path.join(__dirname, '..');

/**
 * 启动前的 sidecar 闸门：**存在**不够，还要**比源码新**。
 *
 * 2026-11-17 的坑：`ensure` 原先只要 build/ 里有产物、或 target/release 里有产物就报 OK，
 * 于是「改了 Rust 却跑旧二进制」静默发生 —— 那一轮排查全打在旧代码上。判据收成唯一一份
 * （`packIsFresh`），build/ 比 `crates/dieyun-core` 旧就重打。
 */
function runPack(reason) {
  console.log(`[dieyun-core] ${reason}，重新打包（npm run pack:dieyun-core）…`);
  execSync('npm run pack:dieyun-core', { cwd: ROOT, stdio: 'inherit' });
}

if (packIsFresh()) {
  console.log(`[dieyun-core] sidecar OK: ${path.join(OUT, EXE_NAME)}`);
  process.exit(0);
}

runPack(
  packLooksComplete() ? 'build/ 里的 sidecar 比 crates/dieyun-core 源码旧' : 'sidecar 缺失'
);

if (!packIsFresh()) {
  console.error('[dieyun-core] 打包后产物仍不可用');
  console.error('[dieyun-core] 请确认已安装 Rust (cargo)，或手动运行: npm run pack:dieyun-core');
  process.exit(1);
}
