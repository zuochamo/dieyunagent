'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'remote-gateway-pack');
const CACHE_DIR = path.join(ROOT, 'build', '.cache');
const NODE_PLATFORM = 'linux-x64';
const { ensureBundledNodeLinux, resolveNodeVersion } = require('./lib/node-linux-runtime.cjs');
const {
  REMOTE_GATEWAY_SOURCE_PATHS,
  REMOTE_PACK_CORE_REL,
  checkRemotePackSourceBoundary,
  computeRemoteGatewaySourceHash,
  inspectRemotePack
} = require('../src/remote/remote-pack-layout.js');
const {
  CORE_GLIBC_TARGET,
  compareNeed,
  glibcRequirementOf
} = require('./pack-dieyun-core-linux-lib.cjs');

const COPY_PATHS = REMOTE_GATEWAY_SOURCE_PATHS;
const NODE_VERSION = resolveNodeVersion();

/** 内置 node（与 pack-headless 共用同一份下载/解压实现，见 scripts/lib/node-linux-runtime.cjs） */
async function ensureBundledNode(outDir) {
  const { version } = await ensureBundledNodeLinux({
    outDir,
    version: NODE_VERSION,
    platform: NODE_PLATFORM,
    cacheDir: CACHE_DIR,
    log: (m) => console.log(m)
  });
  return version;
}

/**
 * 重建包时保留的顶层条目：`bin`（内置 node 94MB，重做要再解压+复制一遍）、`node_modules`
 * （重做要走一次联网 `npm install`）、以及 `pkgNeedsInstall()` 用来比对的那两份清单。
 */
const KEEP_TOP_LEVEL = new Set(['bin', 'node_modules', 'package.json', 'package-lock.json']);

/**
 * 只清**源码产物**，保住上面那两件。
 *
 * 为什么不是整目录 `rm -rf`：清了 `bin/node` 与 `node_modules`，`ensureBundledNodeLinux()` 与
 * `pkgNeedsInstall()` 每次都会判「缺」，于是每次 stale 重打都要重解压 node + 联网装 `ws`。
 * 这两件事与「源码变了」无关，不该跟着 sourceHash 一起重做 —— 尤其 `npm install` 是这条路上
 * 唯一不受控的一步（内网/断网机器上它把「启动慢」直接变成「起不来」）。
 * 源码目录是整棵删掉的（顶层条目逐个 rm），所以被移出清单的旧文件不会残留。
 */
async function cleanPackDir(outDir) {
  let entries;
  try {
    entries = await fsp.readdir(outDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (KEEP_TOP_LEVEL.has(name)) continue;
    await fsp.rm(path.join(outDir, name), { recursive: true, force: true });
  }
}

function pkgNeedsInstall(outDir, pkgJson) {
  const pkgPath = path.join(outDir, 'package.json');
  const lockPath = path.join(outDir, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(lockPath)) return true;
  try {
    const prev = fs.readFileSync(pkgPath, 'utf8');
    return prev !== JSON.stringify(pkgJson, null, 2);
  } catch {
    return true;
  }
}

async function main() {
  // 拍平 src/ 之后仍能加载：清单与包内相对 require 都不得越出 src/（见 remote-pack-layout）
  const boundary = checkRemotePackSourceBoundary({ rootDir: ROOT });
  if (!boundary.ok) {
    const detail = boundary.violations
      .map((v) =>
        v.kind === 'entry-outside-src'
          ? `${v.rel} 不在 src/ 下`
          : `${v.rel} require('${v.spec}') → ${v.target}（越出 src/）`
      )
      .join('；');
    throw new Error(`远程 Agent 打包清单越界：${detail}`);
  }

  await fsp.mkdir(OUT, { recursive: true });
  await cleanPackDir(OUT);

  for (const rel of COPY_PATHS) {
    const src = path.join(ROOT, rel);
    const dest = path.join(OUT, rel.replace(/^src\//, ''));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }

  const linuxCoreSrc = path.join(ROOT, 'build', 'dieyun-core-linux', 'dieyun-core');
  const linuxCoreDest = path.join(OUT, REMOTE_PACK_CORE_REL);
  let hasLinuxCore = false;
  if (fs.existsSync(linuxCoreSrc)) {
    await fsp.mkdir(path.dirname(linuxCoreDest), { recursive: true });
    await fsp.copyFile(linuxCoreSrc, linuxCoreDest);
    hasLinuxCore = true;
    const coreSize = fs.statSync(linuxCoreDest).size;
    console.log(
      '[remote-agent] bundled dieyun-core:',
      linuxCoreDest,
      `(${Math.round(coreSize / 1024)} KB)`
    );
    if (coreSize > 20 * 1024 * 1024) {
      console.warn(
        '[remote-agent] Linux dieyun-core > 20MB，可能未 strip。请确认 pack:dieyun-core:linux 使用 release + strip'
      );
    }
  } else {
    // `bin/` 是保留目录：源码侧的 linux core 不在了，包里那份也必须清掉，
    // 否则下面按「文件在不在」重算的 hasLinuxCore 会虚报，远端拿到一个用不了的核心。
    await fsp.rm(linuxCoreDest, { force: true });
    console.warn(
      '[remote-agent] 未找到 Linux dieyun-core，远程项目内索引不可用。请运行: npm run pack:dieyun-core:linux'
    );
  }

  const appVersion = require(path.join(ROOT, 'package.json')).version;
  // 内置 Node 是预装的一部分：没有「lite 不带 Node」的变体，远程机器不需要装 Node。
  const nodeVer = await ensureBundledNode(OUT);

  hasLinuxCore = fs.existsSync(linuxCoreDest) && fs.statSync(linuxCoreDest).size > 500 * 1024;

  // 远端包能跑在「多老的机器」上 = 包里所有 ELF 里**最高**的那个 glibc 需求。
  // 这条只能在这里算（core 与 node 同时在场）。约束：core 不得成为那个上限 ——
  // 否则 host 上 node 起得来、core 起不来，症状是「远端索引莫名不可用」。
  if (hasLinuxCore) {
    const core = glibcRequirementOf(linuxCoreDest);
    const node = glibcRequirementOf(path.join(OUT, 'bin', 'node'));
    const floor = core.maxGlibc && node.maxGlibc
      ? compareNeed(core.maxGlibc, node.maxGlibc) >= 0
        ? core.maxGlibc
        : node.maxGlibc
      : core.maxGlibc || node.maxGlibc || '';
    console.log(
      `[remote-agent] GLIBC 地板: core ${core.maxGlibc || '—'} / node ${node.maxGlibc || '—'} → 生效 ${floor || '未知'}`
    );
    if (core.maxGlibc && node.maxGlibc && compareNeed(core.maxGlibc, node.maxGlibc) > 0) {
      throw new Error(
        `Remote Agent pack: bundled dieyun-core 需要 GLIBC ${core.maxGlibc}，比同包的 node（${node.maxGlibc}）还新。` +
          `core 一旦成为地板，宿主就会出现「node 起得来、索引起不来」。请用 npm run pack:dieyun-core:linux 重建（zig 目标 ${CORE_GLIBC_TARGET}）`
      );
    }
  }

  const pkg = {
    name: 'dieyun-remote-agent',
    private: true,
    version: appVersion,
    dependencies: {
      ws: require(path.join(ROOT, 'package.json')).dependencies.ws
    }
  };
  const pkgText = JSON.stringify(pkg, null, 2);
  const pkgPath = path.join(OUT, 'package.json');
  const needInstall = pkgNeedsInstall(OUT, pkg);
  await fsp.writeFile(pkgPath, pkgText, 'utf8');

  if (needInstall) {
    console.log('npm install in remote-gateway-pack…');
    execSync('npm install --omit=dev --no-audit --no-fund', { cwd: OUT, stdio: 'inherit' });
  } else {
    console.log('remote-gateway-pack node_modules up to date, skip npm install');
  }

  const sourceHash = computeRemoteGatewaySourceHash(ROOT);
  const manifest = {
    version: appVersion,
    nodeVersion: nodeVer,
    platform: NODE_PLATFORM,
    entry: 'remote/run-cli.js',
    runtime: 'bin/node',
    indexCore: hasLinuxCore,
    sourceHash,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 必需文件清单来自 src/remote/remote-pack-layout.js（本地打包 / 部署包装配 /
  // 远程注入校验共用同一份），缺项必须在打包阶段就失败。
  const packCheck = inspectRemotePack(OUT);
  if (!packCheck.ok) {
    throw new Error('Remote Agent pack incomplete, missing: ' + packCheck.missing.join(', '));
  }

  console.log('Remote Agent pack:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
