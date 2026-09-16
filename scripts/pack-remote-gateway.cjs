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
  computeRemoteGatewaySourceHash
} = require('./remote-gateway-source-paths.cjs');
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
  execSync(
    `tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(extractDir)} ${`node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node`}`,
    { stdio: 'inherit' }
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
  const lite = process.argv.includes('--lite') || process.env.DIEYUN_REMOTE_PACK_LITE === '1';
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  for (const rel of COPY_PATHS) {
    const src = path.join(ROOT, rel);
    const dest = path.join(OUT, rel.replace(/^src\//, ''));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }

  const linuxCoreSrc = path.join(ROOT, 'build', 'dieyun-core-linux', 'dieyun-core');
  const linuxCoreDest = path.join(OUT, 'bin', 'dieyun-core');
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
  let nodeVer = NODE_VERSION;
  if (lite) {
    console.log('[remote-agent] lite pack: skip bundling Linux node (按需下载)');
    const nodePath = path.join(OUT, 'bin', 'node');
    if (fs.existsSync(nodePath)) {
      await fsp.unlink(nodePath);
    }
    await fsp.rm(path.join(OUT, '.tmp-node'), { recursive: true, force: true });
    if (!hasLinuxCore && fs.existsSync(path.join(OUT, 'bin'))) {
      const binEntries = await fsp.readdir(path.join(OUT, 'bin'));
      if (!binEntries.length) {
        await fsp.rm(path.join(OUT, 'bin'), { recursive: true, force: true });
      }
    }
  } else {
    nodeVer = await ensureBundledNode(OUT);
  }

  hasLinuxCore = fs.existsSync(linuxCoreDest) && fs.statSync(linuxCoreDest).size > 500 * 1024;

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
    injected: !lite,
    lite,
    sourceHash,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  for (const rel of [
    'remote/run-cli.js',
    'remote/minimal-gateway-host.js',
    'gateway/fs-read-limits.js',
    'gateway/fs-edit-file.js',
    'gateway/str-replace.js',
    'gateway/symbol-text.js',
    // 远程 LSP 定位链路，缺失会让远程 lsp.query 直接报错
    'lsp/navigate-service.js',
    'lsp/lsp-client.js',
    'lsp/language-registry.js'
  ]) {
    if (!fs.existsSync(path.join(OUT, rel))) {
      throw new Error('Remote Agent pack incomplete, missing: ' + rel);
    }
  }

  console.log('Remote Agent pack:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
