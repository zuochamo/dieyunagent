'use strict';

/**
 * 构建 dieyun-core release 并写入 build/dieyun-core/，供 electron-builder extraResources 打包。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'dieyun-core');
const EXE_NAME = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
const RELEASE_BIN = path.join(ROOT, 'target', 'release', EXE_NAME);
const MIN_BYTES = 500 * 1024;

function readCoreVersion() {
  try {
    const wsToml = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8');
    const m = wsToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return '0.1.0';
}

function packLooksComplete() {
  const dest = path.join(OUT, EXE_NAME);
  const manifestPath = path.join(OUT, 'manifest.json');
  if (!fs.existsSync(dest) || !fs.existsSync(manifestPath)) return false;
  try {
    const st = fs.statSync(dest);
    if (!st.isFile() || st.size < MIN_BYTES) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest && manifest.binary === EXE_NAME && manifest.version === readCoreVersion();
  } catch {
    return false;
  }
}

/**
 * crates/dieyun-core 与其工作区清单里最新的一个 mtime。
 *
 * 为什么需要它：`packLooksComplete()` 只看「产物在不在、版本号对不对」，看不出
 * 「代码改了但没重打」——2026-11-17 就栽在这上面：改了 `agent/llm.rs` 却因为 dev 报
 * 「sidecar OK」直接启动，跑的还是旧二进制，白查了一轮。产物比源码新才算新鲜。
 */
function newestCoreSourceMtime() {
  const targets = [
    path.join(ROOT, 'crates', 'dieyun-core', 'src'),
    path.join(ROOT, 'crates', 'dieyun-core', 'Cargo.toml'),
    path.join(ROOT, 'Cargo.toml'),
    path.join(ROOT, 'Cargo.lock')
  ];
  let newest = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const t of targets) walk(t);
  return newest;
}

/**
 * 产物是否**最新**（不只是「存在」）：`packLooksComplete()` + 产物不比源码旧。
 * `ensure-dieyun-core.cjs` 用它决定要不要重打。
 */
function packIsFresh() {
  if (!packLooksComplete()) return false;
  const dest = path.join(OUT, EXE_NAME);
  try {
    return fs.statSync(dest).mtimeMs >= newestCoreSourceMtime();
  } catch {
    return false;
  }
}

async function main() {
  const skipBuild = process.env.DIEYUN_SKIP_CARGO_BUILD === '1';
  const dest = path.join(OUT, EXE_NAME);

  if (!skipBuild) {
    console.log('[dieyun-core] cargo build --release …');
    execSync('cargo build -p dieyun-core --release', { cwd: ROOT, stdio: 'inherit' });
  } else if (!fs.existsSync(RELEASE_BIN)) {
    throw new Error(`DIEYUN_SKIP_CARGO_BUILD=1 但未找到 ${RELEASE_BIN}`);
  }

  if (!fs.existsSync(RELEASE_BIN)) {
    throw new Error('Release binary not found: ' + RELEASE_BIN);
  }

  await fsp.mkdir(OUT, { recursive: true });
  try {
    await fsp.copyFile(RELEASE_BIN, dest);
  } catch (e) {
    // Windows 上正在运行的 sidecar 会锁住这个文件：别让用户对着 EBUSY 发愣
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      throw new Error(
        `${dest} 正被运行中的进程占用 —— 先退出叠云 Agent（Ctrl+C / 关窗口），再重跑本命令`
      );
    }
    throw e;
  }

  const st = fs.statSync(dest);
  if (st.size < MIN_BYTES) {
    throw new Error(`dieyun-core 体积异常 (${st.size} bytes): ${dest}`);
  }

  const manifest = {
    version: readCoreVersion(),
    platform: process.platform,
    arch: process.arch,
    binary: EXE_NAME,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[dieyun-core] pack OK:', dest, `(${Math.round(st.size / 1024)} KB)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[dieyun-core] pack failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  OUT,
  EXE_NAME,
  packLooksComplete,
  packIsFresh,
  newestCoreSourceMtime,
  readCoreVersion
};
