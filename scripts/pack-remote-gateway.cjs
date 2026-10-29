'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createWriteStream } = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'remote-gateway-pack');
const CACHE_DIR = path.join(ROOT, 'build', '.cache');
const NODE_VERSION = process.env.DIEYUN_REMOTE_NODE_VERSION || 'v20.18.2';
const NODE_PLATFORM = 'linux-x64';
const {
  REMOTE_GATEWAY_SOURCE_PATHS,
  REMOTE_PACK_CORE_REL,
  computeRemoteGatewaySourceHash,
  inspectRemotePack
} = require('../src/remote/remote-pack-layout.js');
const {
  CORE_GLIBC_TARGET,
  compareNeed,
  glibcRequirementOf
} = require('./pack-dieyun-core-linux-lib.cjs');
const NODE_MIRRORS = [
  process.env.DIEYUN_NODE_MIRROR,
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist'
].filter(Boolean);

const COPY_PATHS = REMOTE_GATEWAY_SOURCE_PATHS;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error('redirect without location'));
            return;
          }
          res.resume();
          downloadFile(loc, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        try {
          file.close();
        } catch {
          // ignore
        }
        reject(err);
      });
  });
}

async function downloadFileWithRetry(url, dest, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      await downloadFile(url, dest);
      const st = fs.statSync(dest);
      if (!st.size || st.size < 10 * 1024 * 1024) {
        throw new Error(`download too small (${st.size} bytes)`);
      }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`Download attempt ${i + 1}/${attempts} failed:`, e.message || e);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function ensureCachedTarball(tarball) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tarPath = path.join(CACHE_DIR, tarball);
  if (fs.existsSync(tarPath)) {
    const st = fs.statSync(tarPath);
    if (st.size >= 10 * 1024 * 1024) {
      console.log('Using cached tarball:', tarPath);
      return tarPath;
    }
  }
  let lastErr;
  for (const base of NODE_MIRRORS) {
    const url = `${base.replace(/\/$/, '')}/${NODE_VERSION}/${tarball}`;
    console.log('Downloading', url);
    try {
      await downloadFileWithRetry(url, tarPath, 2);
      return tarPath;
    } catch (e) {
      lastErr = e;
      console.warn('Mirror failed:', base, e.message || e);
    }
  }
  throw lastErr || new Error('All Node mirrors failed');
}

async function ensureBundledNode(outDir) {
  const binDir = path.join(outDir, 'bin');
  const nodeDest = path.join(binDir, 'node');
  if (fs.existsSync(nodeDest)) {
    const st = fs.statSync(nodeDest);
    if (st.size >= 50 * 1024 * 1024) {
      console.log('Bundled node exists:', nodeDest);
      return NODE_VERSION;
    }
  }
  await fsp.mkdir(binDir, { recursive: true });
  const tarball = `node-${NODE_VERSION}-${NODE_PLATFORM}.tar.gz`;
  const tarPath = await ensureCachedTarball(tarball);
  const tmpDir = path.join(CACHE_DIR, '.extract-node');
  const extractDir = path.join(tmpDir, 'extract');
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  // 用相对路径解压：GNU tar 会把 `E:\...` 里的盘符冒号解析成远程主机
  execSync(
    `tar -xzf ${JSON.stringify(path.basename(tarPath))} -C ${JSON.stringify(
      path.relative(CACHE_DIR, extractDir).replace(/\\/g, '/')
    )} ${`node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node`}`,
    { stdio: 'inherit', cwd: CACHE_DIR }
  );
  const extractedNode = path.join(extractDir, `node-${NODE_VERSION}-${NODE_PLATFORM}`, 'bin', 'node');
  if (!fs.existsSync(extractedNode)) {
    throw new Error('Node binary not found after extract: ' + extractedNode);
  }
  await fsp.copyFile(extractedNode, nodeDest);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  console.log('Bundled node:', nodeDest);
  return NODE_VERSION;
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
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

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
