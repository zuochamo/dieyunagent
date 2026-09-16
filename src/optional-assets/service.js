'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { OPTIONAL_ASSETS, MONACO_VERSION, BGE_MODEL_NAME, BGE_ASSET_ID, REMOTE_NODE_VERSION } = require('./manifest');

/** @type {Map<string, Promise<string>>} */
const inflight = new Map();

function getUserAssetsRoot(userDataPath) {
  return path.join(userDataPath, '.dieyun', 'optional-assets');
}

const { getDeployConfig } = require('../deploy-config');

function normalizeFeedUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  return u.endsWith('/') ? u : `${u}/`;
}

function getOptionalAssetFeedCandidates() {
  const updates = getDeployConfig().updates;
  const primary = normalizeFeedUrl(updates.primaryUrl || '');
  const fallback = normalizeFeedUrl(updates.fallbackUrl || '');
  const out = [];
  for (const u of [primary, fallback]) {
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function getMonacoOfficialUrls() {
  return [`https://registry.npmjs.org/monaco-editor/-/monaco-editor-${MONACO_VERSION}.tgz`];
}

function getNodeOfficialUrls() {
  const tarball = `node-${REMOTE_NODE_VERSION}-linux-x64.tar.gz`;
  const mirrors = [
    process.env.DIEYUN_NODE_MIRROR,
    'https://npmmirror.com/mirrors/node',
    'https://nodejs.org/dist'
  ].filter(Boolean);
  return mirrors.map((base) => `${String(base).replace(/\/$/, '')}/${REMOTE_NODE_VERSION}/${tarball}`);
}

function getDownloadUrls(def) {
  if (def.id === 'monaco-editor') {
    return [...getMonacoOfficialUrls(), ...getOptionalAssetFeedCandidates().map((b) => `${b}optional/monaco-editor-${MONACO_VERSION}.zip`)];
  }
  if (def.id === 'remote-gateway-linux-node') {
    return [...getNodeOfficialUrls(), ...getOptionalAssetFeedCandidates().map((b) => `${b}optional/${def.archive}`)];
  }
  return getOptionalAssetFeedCandidates().map((base) => `${base}optional/${def.archive}`);
}

function verifyInstalled(installRoot, def) {
  if (!installRoot || !def) return false;
  const marker = path.join(installRoot, def.verifyRel);
  try {
    return fs.existsSync(marker) && fs.statSync(marker).isFile() && fs.statSync(marker).size > 0;
  } catch {
    return false;
  }
}

function resolveRemoteGatewayNodeBundled(packRoot) {
  if (!packRoot) return null;
  const nodePath = path.join(packRoot, 'bin', 'node');
  try {
    const st = fs.statSync(nodePath);
    return st.isFile() && st.size > 50 * 1024 * 1024 ? nodePath : null;
  } catch {
    return null;
  }
}

function installedRoot(userDataPath, def) {
  return path.join(getUserAssetsRoot(userDataPath), def.installDirName);
}

async function downloadToFile(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  await fsp.rm(tmp, { force: true });

  await new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) {
          reject(new Error(`重定向无 location: ${url}`));
          return;
        }
        downloadToFile(loc, dest, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        res.resume();
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) {
          onProgress({ received, total, percent: Math.min(99, Math.round((received / total) * 100)) });
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(600000, () => {
      req.destroy(new Error('下载超时'));
    });
  });

  await fsp.rename(tmp, dest);
}

async function copyDirContents(srcDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(srcDir, ent.name);
    const to = path.join(destDir, ent.name);
    if (ent.isDirectory()) await copyDirContents(from, to);
    else await fsp.copyFile(from, to);
  }
}

async function extractZip(archivePath, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await runCommand(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destDir)} -Force`
      ],
      600000
    );
    return;
  }
  await runCommand('tar', ['-xf', archivePath, '-C', destDir], 600000);
}

async function extractNpmMonacoTgz(archivePath, destDir) {
  const tmp = path.join(path.dirname(destDir), `.extract-${path.basename(destDir)}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  await runCommand('tar', ['-xzf', archivePath, '-C', tmp], 600000);
  const pkgDir = path.join(tmp, 'package');
  if (!fs.existsSync(path.join(pkgDir, 'min', 'vs', 'editor', 'editor.main.js'))) {
    throw new Error('npm 包结构无效（缺少 min/vs）');
  }
  await fsp.rm(destDir, { recursive: true, force: true });
  await copyDirContents(pkgDir, destDir);
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function extractTgzNode(archivePath, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const inner = `node-${REMOTE_NODE_VERSION}-linux-x64`;
  await runCommand('tar', ['-xzf', archivePath, '-C', destDir, `${inner}/bin/node`], 600000);
  const extracted = path.join(destDir, inner, 'bin', 'node');
  const finalBin = path.join(destDir, 'bin');
  await fsp.mkdir(finalBin, { recursive: true });
  await fsp.copyFile(extracted, path.join(finalBin, 'node'));
  await fsp.rm(path.join(destDir, inner), { recursive: true, force: true });
}

async function extractArchive(def, archivePath, installRoot) {
  if (def.kind === 'tgz') await extractTgzNode(archivePath, installRoot);
  else if (def.kind === 'npm-tgz') await extractNpmMonacoTgz(archivePath, installRoot);
  else await extractZip(archivePath, installRoot);
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      reject(new Error(`${cmd} 超时`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}`));
    });
  });
}

async function installArchiveForDef(def, archivePath, userDataPath, onProgress) {
  const installRoot = installedRoot(userDataPath, def);
  if (onProgress) onProgress({ phase: 'extract', message: `正在安装 ${def.label}…`, percent: 99 });
  await extractArchive(def, archivePath, installRoot);
  await flattenNestedAssetDir(installRoot, def);
  if (!verifyInstalled(installRoot, def)) {
    throw new Error(`安装后校验失败: ${def.verifyRel}`);
  }
  if (onProgress) onProgress({ phase: 'done', message: `${def.label} 已就绪`, percent: 100 });
  return installRoot;
}

async function flattenNestedAssetDir(installRoot, def) {
  if (verifyInstalled(installRoot, def)) return;
  const nested = path.join(installRoot, def.installDirName);
  if (!verifyInstalled(nested, def)) return;
  const tmp = `${installRoot}.flatten`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rename(nested, tmp);
  await fsp.rm(installRoot, { recursive: true, force: true });
  await fsp.rename(tmp, installRoot);
}

async function downloadAndExtract(def, userDataPath, onProgress) {
  const cacheDir = getUserAssetsRoot(userDataPath);
  await fsp.mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, def.archive);
  const installRoot = installedRoot(userDataPath, def);
  const urls = getDownloadUrls(def);
  let lastErr = null;
  for (const url of urls) {
    try {
      if (onProgress) onProgress({ phase: 'download', message: `正在下载 ${def.label}…`, percent: 0, url });
      await downloadToFile(url, archivePath, (p) => {
        if (onProgress) {
          onProgress({
            phase: 'download',
            message: `正在下载 ${def.label}… ${p.percent || 0}%`,
            percent: p.percent || 0,
            url
          });
        }
      });
      return await installArchiveForDef(def, archivePath, userDataPath, onProgress);
    } catch (err) {
      lastErr = err;
      await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastErr || new Error(`无法下载 ${def.label}`);
}

async function installOptionalAssetFromFile(assetId, filePath, userDataPath, onProgress) {
  const baseDef = OPTIONAL_ASSETS[assetId];
  if (!baseDef) throw new Error(`未知可选资源: ${assetId}`);
  const def = { ...baseDef };
  const lower = String(filePath || '').toLowerCase();
  if (def.id === 'monaco-editor' && lower.endsWith('.zip')) {
    def.kind = 'zip';
  }
  if (!filePath || !fs.existsSync(filePath)) throw new Error('安装包不存在');
  return installArchiveForDef(def, filePath, userDataPath, onProgress);
}

/**
 * @param {string} assetId
 * @param {{ userDataPath: string, resourcesPath?: string, onProgress?: Function, remoteGatewayPackRoot?: string }} opts
 * @returns {Promise<string>}
 */
async function ensureOptionalAsset(assetId, opts = {}) {
  const def = OPTIONAL_ASSETS[assetId];
  if (!def) throw new Error(`未知可选资源: ${assetId}`);
  const userDataPath = opts.userDataPath;
  if (!userDataPath) throw new Error('userDataPath 必填');
  const force = opts.force === true;

  if (def.id === 'remote-gateway-linux-node' && !force) {
    const bundledNode = resolveRemoteGatewayNodeBundled(opts.remoteGatewayPackRoot);
    if (bundledNode) return path.dirname(bundledNode);
  }

  if (def.id === 'monaco-editor' && !force) {
    const bundledMonaco = resolveMonacoBundled(opts.resourcesPath);
    if (bundledMonaco) return bundledMonaco;
  }

  const root = installedRoot(userDataPath, def);
  if (force) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  } else if (verifyInstalled(root, def)) {
    return root;
  }

  if (def.id === BGE_ASSET_ID && !force) {
    const bundledBge = resolveBgeBundled(opts.resourcesPath);
    if (bundledBge) return bundledBge;
  }

  const key = force ? `${assetId}:force` : assetId;
  if (inflight.has(key)) return inflight.get(key);

  const job = downloadAndExtract(def, userDataPath, opts.onProgress).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

function getMonacoVsUrl(installRoot) {
  const vsDir = path.join(installRoot, 'min', 'vs');
  const fileUrl = require('url').pathToFileURL(vsDir).href;
  return fileUrl.endsWith('/') ? fileUrl.slice(0, -1) : fileUrl;
}

async function ensureRemoteGatewayDeployPack({ userDataPath, resourcesPath, litePackRoot, appVersion, onProgress }) {
  const nodeBundled = resolveRemoteGatewayNodeBundled(litePackRoot);
  if (nodeBundled) return litePackRoot;

  await ensureOptionalAsset('remote-gateway-linux-node', {
    userDataPath,
    resourcesPath,
    remoteGatewayPackRoot: litePackRoot,
    onProgress
  });

  const cacheRoot = path.join(userDataPath, '.dieyun', 'remote-gateway-deploy', String(appVersion || '0'));
  const nodeDest = path.join(cacheRoot, 'bin', 'node');
  if (fs.existsSync(nodeDest) && fs.statSync(nodeDest).size > 50 * 1024 * 1024) {
    await syncLitePackFiles(litePackRoot, cacheRoot);
    return cacheRoot;
  }

  await fsp.mkdir(cacheRoot, { recursive: true });
  const nodeSrcRoot = installedRoot(userDataPath, OPTIONAL_ASSETS['remote-gateway-linux-node']);
  const nodeSrc = path.join(nodeSrcRoot, 'bin', 'node');
  await fsp.mkdir(path.dirname(nodeDest), { recursive: true });
  await fsp.copyFile(nodeSrc, nodeDest);
  await syncLitePackFiles(litePackRoot, cacheRoot);
  return cacheRoot;
}

async function syncLitePackFiles(litePackRoot, cacheRoot) {
  if (!litePackRoot || !fs.existsSync(litePackRoot)) return;
  const skip = new Set(['bin']);
  async function walk(rel) {
    const abs = path.join(litePackRoot, rel);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      if (skip.has(rel.split(/[/\\]/)[0])) return;
      const entries = await fsp.readdir(abs);
      for (const name of entries) await walk(path.join(rel, name));
      return;
    }
    const dest = path.join(cacheRoot, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(abs, dest);
  }
  const top = await fsp.readdir(litePackRoot);
  for (const name of top) {
    if (skip.has(name)) continue;
    await walk(name);
  }
  const linuxCoreSrc = path.join(litePackRoot, 'bin', 'dieyun-core');
  if (fs.existsSync(linuxCoreSrc)) {
    const linuxCoreDest = path.join(cacheRoot, 'bin', 'dieyun-core');
    await fsp.mkdir(path.dirname(linuxCoreDest), { recursive: true });
    await fsp.copyFile(linuxCoreSrc, linuxCoreDest);
  }
  const manifestSrc = path.join(litePackRoot, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    await fsp.copyFile(manifestSrc, path.join(cacheRoot, 'manifest.json'));
  }
}

function resolveMonacoBundled(resourcesPath) {
  if (!resourcesPath) return null;
  const root = path.join(resourcesPath, 'monaco-editor');
  const def = OPTIONAL_ASSETS['monaco-editor'];
  if (def && verifyInstalled(root, def)) return root;
  return null;
}

function resolveBgeModelDir(dir) {
  const def = OPTIONAL_ASSETS[BGE_ASSET_ID];
  if (!def || !dir) return null;
  return verifyInstalled(dir, def) ? dir : null;
}

function resolveBgeBundled(resourcesPath) {
  if (!resourcesPath) return null;
  return resolveBgeModelDir(path.join(resourcesPath, 'models', BGE_MODEL_NAME));
}

function resolveBgeDev() {
  const roots = [
    path.resolve(__dirname, '..', '..', 'models', BGE_MODEL_NAME),
    path.resolve(process.cwd(), 'models', BGE_MODEL_NAME)
  ];
  for (const dir of roots) {
    const hit = resolveBgeModelDir(dir);
    if (hit) return hit;
  }
  return null;
}

function assetStatus(assetId, { userDataPath, resourcesPath, remoteGatewayPackRoot } = {}) {
  const def = OPTIONAL_ASSETS[assetId];
  if (!def) return { installed: false };
  if (def.id === 'monaco-editor') {
    const bundled = resolveMonacoBundled(resourcesPath);
    if (bundled) {
      return { installed: true, source: 'bundled', path: bundled };
    }
  }
  if (def.id === 'remote-gateway-linux-node') {
    if (resolveRemoteGatewayNodeBundled(remoteGatewayPackRoot)) {
      return { installed: true, source: 'lite-pack' };
    }
  }
  const root = installedRoot(userDataPath || '', def);
  if (verifyInstalled(root, def)) {
    return { installed: true, source: 'downloaded', path: root };
  }
  if (def.id === BGE_ASSET_ID) {
    const bundled = resolveBgeBundled(resourcesPath);
    if (bundled) return { installed: true, source: 'bundled', path: bundled };
    const dev = resolveBgeDev();
    if (dev) return { installed: true, source: 'dev', path: dev };
  }
  return {
    installed: false,
    source: 'missing',
    path: root
  };
}

function isInflight(assetId) {
  return inflight.has(assetId);
}

module.exports = {
  OPTIONAL_ASSETS,
  ensureOptionalAsset,
  ensureRemoteGatewayDeployPack,
  installOptionalAssetFromFile,
  getMonacoVsUrl,
  assetStatus,
  verifyInstalled,
  getOptionalAssetFeedCandidates,
  getDownloadUrls,
  resolveRemoteGatewayNodeBundled,
  resolveMonacoBundled,
  resolveBgeBundled,
  resolveBgeDev,
  getUserAssetsRoot,
  isInflight
};
