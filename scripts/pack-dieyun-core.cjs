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
const DEST_BIN = path.join(OUT, EXE_NAME);
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

/** 产物完整性：在、够大、manifest 版本对得上。**不判新旧**（新旧交给 cargo）。 */
function packLooksComplete() {
  const manifestPath = path.join(OUT, 'manifest.json');
  if (!fs.existsSync(DEST_BIN) || !fs.existsSync(manifestPath)) return false;
  try {
    const st = fs.statSync(DEST_BIN);
    if (!st.isFile() || st.size < MIN_BYTES) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest && manifest.binary === EXE_NAME && manifest.version === readCoreVersion();
  } catch {
    return false;
  }
}

/** `target/release` 里的产物（够大才算），否则 null。 */
function releaseArtifact() {
  try {
    const st = fs.statSync(RELEASE_BIN);
    return st.isFile() && st.size >= MIN_BYTES ? st : null;
  } catch {
    return null;
  }
}

/**
 * build/ 里的产物要不要**重新复制**：只比两个产物（`target/release` vs `build/`）。
 *
 * 为什么不再比源码 mtime：源码变没变，cargo 自己的指纹（Cargo.lock + 每个 crate 的源与清单，
 * 含 build.rs / 新加 crate）比手写路径清单更全，而且**不会漂移**；mtime 只说明「文件被写过」，
 * 不等于「内容变了」—— 合并、切分支、编辑器重存都会刷新 mtime，于是合入 main 之后的第一次
 * `npm run dev` 白等一次完整 release 编译（本机实测 82s）。把判据交给 cargo 之后，这些情况
 * 退化成 0.3s 空跑。
 *
 * 代价是每次启动都调一次 `cargo build --release`（无变化 0.29s 实测）。那本来就该由它决定。
 */
function packIsFresh() {
  if (!packLooksComplete()) return false;
  const rel = releaseArtifact();
  if (!rel) return false;
  try {
    const dest = fs.statSync(DEST_BIN);
    // mtime 挡「源码改过但没重打」，size 挡「复制到一半被打断」
    return dest.mtimeMs >= rel.mtimeMs && dest.size === rel.size;
  } catch {
    return false;
  }
}

/**
 * 让 cargo 决定要不要编译。`DIEYUN_SKIP_CARGO_BUILD=1` 用于「已经编好、只借本脚本复制」的流水线。
 */
function buildRelease() {
  if (process.env.DIEYUN_SKIP_CARGO_BUILD === '1') {
    if (!releaseArtifact()) {
      throw new Error(`DIEYUN_SKIP_CARGO_BUILD=1 但未找到 ${RELEASE_BIN}`);
    }
    return;
  }
  console.log('[dieyun-core] cargo build -p dieyun-core --release …');
  try {
    execSync('cargo build -p dieyun-core --release', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(
        '找不到 cargo（Rust 工具链未安装）：既无法编译 sidecar，也无法判断 build/ 里的产物是否最新。' +
          '装 Rust 后重试，或直接用安装包（不要从源码跑 dev）。'
      );
    }
    throw e;
  }
}

/** 复制产物 + 重写 manifest（唯一写 `build/dieyun-core/` 的地方）。 */
async function copyArtifact() {
  await fsp.mkdir(OUT, { recursive: true });
  try {
    await fsp.copyFile(RELEASE_BIN, DEST_BIN);
  } catch (e) {
    // Windows 上正在运行的 sidecar 会锁住这个文件：别让用户对着 EBUSY 发愣
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      throw new Error(
        `${DEST_BIN} 正被运行中的进程占用 —— 先退出叠云 Agent（Ctrl+C / 关窗口），再重跑本命令`
      );
    }
    throw e;
  }

  const st = fs.statSync(DEST_BIN);
  if (st.size < MIN_BYTES) {
    throw new Error(`dieyun-core 体积异常 (${st.size} bytes): ${DEST_BIN}`);
  }

  const manifest = {
    version: readCoreVersion(),
    platform: process.platform,
    arch: process.arch,
    binary: EXE_NAME,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[dieyun-core] pack OK:', DEST_BIN, `(${Math.round(st.size / 1024)} KB)`);
  return st;
}

/**
 * 同步 build/ 产物的**唯一入口**（`npm run pack:dieyun-core` 与 `ensure-dieyun-core.cjs` 共用）：
 * 先让 cargo 判指纹并编译，再按「产物比产物」决定要不要复制。
 *
 * @returns {Promise<{ copied: boolean }>}
 */
async function syncArtifact() {
  buildRelease();
  if (packIsFresh()) {
    console.log('[dieyun-core] 产物已最新（cargo 无变化）:', DEST_BIN);
    return { copied: false };
  }
  await copyArtifact();
  return { copied: true };
}

if (require.main === module) {
  syncArtifact().catch((e) => {
    console.error('[dieyun-core] pack failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  OUT,
  EXE_NAME,
  packLooksComplete,
  packIsFresh,
  readCoreVersion,
  syncArtifact
};
