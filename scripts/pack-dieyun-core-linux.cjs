'use strict';

/**
 * 构建 Linux x86_64 dieyun-core，供 Remote Agent 在服务器上做项目内索引。
 *
 * 方式（按优先级）：
 * 1. 本机交叉编译（需 x86_64-linux-gnu-gcc，如 MSYS2）
 * 2. DIEYUN_LINUX_CORE_SRC=已有二进制路径（跳过编译）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REMOTE_CONFIG = path.join(ROOT, 'dieyun-linux-build.local.json');
const TARGET = 'x86_64-unknown-linux-gnu';
const CROSS_BIN = path.join(ROOT, 'target', TARGET, 'release', 'dieyun-core');
const NATIVE_BIN = path.join(ROOT, 'target', 'release', 'dieyun-core');
const {
  OUT_DIR,
  OUT_BIN,
  MIN_BYTES,
  isLinuxElf,
  installLinuxCoreBin,
  localCoreUsable,
  localCoreFingerprintMatches,
  computeSourceFingerprint,
  readLinuxCoreManifest
} = require('./pack-dieyun-core-linux-lib.cjs');

function crossGccAvailable() {
  if (process.env.CC_x86_64_unknown_linux_gnu || process.env['CC_x86_64-unknown-linux-gnu']) {
    return true;
  }
  const names =
    process.platform === 'win32'
      ? ['x86_64-linux-gnu-gcc', 'x86_64-linux-gnu-gcc.exe']
      : ['x86_64-linux-gnu-gcc'];
  for (const name of names) {
    try {
      execSync(process.platform === 'win32' ? `where ${name}` : `command -v ${name}`, {
        stdio: 'ignore'
      });
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

function buildCross() {
  try {
    execSync(`rustup target add ${TARGET}`, { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.warn('[dieyun-core-linux] rustup target add failed:', e.message || e);
  }
  console.log(`[dieyun-core-linux] cargo build --release --target ${TARGET} …`);
  execSync(`cargo build -p dieyun-core --release --target ${TARGET}`, { cwd: ROOT, stdio: 'inherit' });
  if (!fs.existsSync(CROSS_BIN)) {
    throw new Error('交叉编译产物未找到: ' + CROSS_BIN);
  }
  return CROSS_BIN;
}

function copyFromSrc(src) {
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) {
    throw new Error('DIEYUN_LINUX_CORE_SRC 不存在: ' + abs);
  }
  if (!isLinuxElf(abs)) {
    throw new Error('DIEYUN_LINUX_CORE_SRC 不是 Linux ELF: ' + abs);
  }
  return abs;
}

function printHelp() {
  console.error(`
[dieyun-core-linux] 在 Windows 上交叉编译需要 Linux GCC 工具链，当前未找到 x86_64-linux-gnu-gcc。

可选方案（任选其一）：

  A) MSYS2 交叉工具链
     pacman -S mingw-w64-cross-x86_64-linux-gnu-gcc
     # 把 x86_64-linux-gnu-gcc 加入 PATH 后重试

  B) 在 Linux 服务器上编译后拷回
     scp user@server:~/dieyunagent/target/release/dieyun-core build/dieyun-core-linux/
     set DIEYUN_LINUX_CORE_SRC=build\\dieyun-core-linux\\dieyun-core
     set DIEYUN_SKIP_CARGO_BUILD=1
     npm run pack:dieyun-core:linux
`);
}

function readRemoteBuildConfig() {
  try {
    if (!fs.existsSync(REMOTE_CONFIG)) return null;
    const cfg = JSON.parse(fs.readFileSync(REMOTE_CONFIG, 'utf8'));
    return cfg && cfg.ssh ? cfg : null;
  } catch {
    return null;
  }
}

async function buildRemote() {
  try {
    const { main: remoteMain } = require('./pack-dieyun-core-linux-remote.cjs');
    await remoteMain();
  } catch (e) {
    if (localCoreFingerprintMatches()) {
      console.warn('[dieyun-core-linux] 远程不可用，改用本地已有产物:', OUT_BIN);
      console.warn('[dieyun-core-linux] 远程错误:', e && e.message ? e.message : e);
      return OUT_BIN;
    }
    if (localCoreUsable()) {
      console.error(
        '[dieyun-core-linux] 远程编译失败且本地产物与当前源码指纹不一致，不能复用旧二进制'
      );
    }
    throw e;
  }
  if (!localCoreUsable()) {
    throw new Error('SSH 远程编译未完成或产物无效');
  }
  return OUT_BIN;
}

function shouldPreferRemoteBuild(via) {
  if (via === 'remote') return true;
  if (process.env.DIEYUN_LINUX_CORE_VIA === 'remote') return true;
  if (process.env.DIEYUN_FORCE_LINUX_CORE_REMOTE === '1') return true;
  if (localCoreFingerprintMatches()) return false;
  if (process.platform !== 'win32') return false;
  if (!readRemoteBuildConfig()) return false;
  if (crossGccAvailable()) return false;
  return true;
}

async function main() {
  const skipBuild = process.env.DIEYUN_SKIP_CARGO_BUILD === '1';
  const via =
    process.argv.includes('--cross')
      ? 'cross'
      : process.argv.includes('--remote')
        ? 'remote'
        : String(process.env.DIEYUN_LINUX_CORE_VIA || '').trim().toLowerCase();
  const srcOverride = process.env.DIEYUN_LINUX_CORE_SRC;

  if (
    !skipBuild &&
    localCoreFingerprintMatches() &&
    process.env.DIEYUN_FORCE_LINUX_CORE_REMOTE !== '1' &&
    via !== 'remote' &&
    !srcOverride
  ) {
    console.log('[dieyun-core-linux] 源码未变，复用本地 Linux core:', OUT_BIN);
    return;
  }

  if (
    !skipBuild &&
    localCoreUsable() &&
    !localCoreFingerprintMatches() &&
    process.env.DIEYUN_REUSE_LINUX_CORE !== '1'
  ) {
    console.log('[dieyun-core-linux] 源码已变更（或缺少 manifest 指纹），将重新编译');
  }

  if (!skipBuild && process.env.DIEYUN_REUSE_LINUX_CORE === '1' && localCoreUsable()) {
    console.log('[dieyun-core-linux] 复用已有产物:', OUT_BIN);
    return;
  }

  let releaseBin = null;

  if (skipBuild) {
    if (srcOverride) releaseBin = copyFromSrc(srcOverride);
    else if (fs.existsSync(OUT_BIN)) releaseBin = OUT_BIN;
    else if (fs.existsSync(CROSS_BIN)) releaseBin = CROSS_BIN;
    else if (fs.existsSync(NATIVE_BIN) && isLinuxElf(NATIVE_BIN)) releaseBin = NATIVE_BIN;
    else throw new Error('DIEYUN_SKIP_CARGO_BUILD=1 但未找到可用的 Linux dieyun-core');
  } else if (srcOverride) {
    releaseBin = copyFromSrc(srcOverride);
  } else if (shouldPreferRemoteBuild(via)) {
    console.log('[dieyun-core-linux] 使用 SSH 远程编译（dieyun-linux-build.local.json）');
    await buildRemote();
    return;
  } else if (via === 'cross') {
    releaseBin = buildCross();
  } else if (process.platform === 'linux') {
    console.log('[dieyun-core-linux] cargo build --release …');
    execSync('cargo build -p dieyun-core --release', { cwd: ROOT, stdio: 'inherit' });
    releaseBin = NATIVE_BIN;
  } else if (crossGccAvailable()) {
    releaseBin = buildCross();
  } else {
    try {
      releaseBin = buildCross();
    } catch (e) {
      if (readRemoteBuildConfig()) {
        console.warn('[dieyun-core-linux] 本机交叉编译失败，改用 SSH 远程编译…');
        await buildRemote();
        return;
      }
      printHelp();
      throw e;
    }
  }

  if (!releaseBin || !fs.existsSync(releaseBin)) {
    throw new Error('Linux release binary not found');
  }
  await installLinuxCoreBin(releaseBin);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[dieyun-core-linux] failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  OUT_DIR,
  OUT_BIN,
  MIN_BYTES,
  isLinuxElf,
  installLinuxCoreBin,
  localCoreUsable,
  localCoreFingerprintMatches,
  computeSourceFingerprint,
  readLinuxCoreManifest
};
