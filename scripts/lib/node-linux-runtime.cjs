'use strict';

/**
 * 「把 Linux x64 的 node 运行时取进产物目录」的唯一实现。
 *
 * 为什么单独成模块：远端 Agent 包（`scripts/pack-remote-gateway.cjs`）与
 * headless 包（`scripts/pack-headless.cjs`）都要内置同一个 node 运行时。两处各写一份
 * 下载/解压逻辑，迟早会在 Node 版本、镜像顺序、缓存目录上漂移，产出的包就会「远端能跑、
 * headless 起不来」，且症状只会表现为「某个 ELF 起不来」。
 *
 * 约束：只用 `https` + `tar`（两平台都有），不引第三方下载库。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createWriteStream } = require('fs');

/** 内置 Node 版本：两个包共用同一个默认值（可用环境变量覆盖，便于临时验证新版本） */
const DEFAULT_NODE_VERSION = 'v20.18.2';

const NODE_MIRRORS = [
  process.env.DIEYUN_NODE_MIRROR,
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist'
].filter(Boolean);

/** 包内 node 的最小合理体积：太小的文件一定是下载被截断或解压失败 */
const MIN_NODE_BYTES = 50 * 1024 * 1024;
const MIN_TARBALL_BYTES = 10 * 1024 * 1024;

function resolveNodeVersion(env = process.env) {
  return (
    String(env.DIEYUN_HEADLESS_NODE_VERSION || '').trim() ||
    String(env.DIEYUN_REMOTE_NODE_VERSION || '').trim() ||
    DEFAULT_NODE_VERSION
  );
}

/**
 * 下载到 `dest`。写流必须在**确认 200 之后**才打开：
 * 否则非 200 / 无 Location 的早退路径会留下一个没关的 fd（Windows 上表现为下一次重试
 * 的 `unlinkSync` 抛 EPERM，把一次网络抖动放大成「所有镜像都失败」），
 * 重定向分支还会对同一路径开第二次写流。
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          if (!loc) {
            res.resume();
            reject(new Error('redirect without location'));
            return;
          }
          res.resume();
          downloadFile(loc, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('error', (err) => {
          try {
            file.destroy();
          } catch {
            // ignore
          }
          reject(err);
        });
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => reject(err));
  });
}

async function downloadFileWithRetry(url, dest, attempts = 3, log = console.warn) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      await downloadFile(url, dest);
      const st = fs.statSync(dest);
      if (!st.size || st.size < MIN_TARBALL_BYTES) {
        throw new Error(`download too small (${st.size} bytes)`);
      }
      return;
    } catch (err) {
      lastErr = err;
      log(`Download attempt ${i + 1}/${attempts} failed: ${(err && err.message) || err}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function ensureCachedTarball({ cacheDir, tarball, log = console.log }) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const tarPath = path.join(cacheDir, tarball);
  if (fs.existsSync(tarPath) && fs.statSync(tarPath).size >= MIN_TARBALL_BYTES) {
    log(`使用缓存 tarball：${tarPath}`);
    return tarPath;
  }
  let lastErr;
  // 镜像布局统一是 <mirror>/<version>/node-<version>-<platform>.tar.gz
  const versionMatch = tarball.match(/^node-(v[^-]+)-/);
  const version = versionMatch ? versionMatch[1] : '';
  for (const base of NODE_MIRRORS) {
    const url = `${base.replace(/\/$/, '')}/${version}/${tarball}`;
    log(`下载 ${url}`);
    try {
      await downloadFileWithRetry(url, tarPath, 2, log);
      return tarPath;
    } catch (err) {
      lastErr = err;
      log(`镜像失败（${base}）：${(err && err.message) || err}`);
    }
  }
  throw lastErr || new Error('All Node mirrors failed');
}

/**
 * 把 Linux x64 的 node 放到 `<outDir>/bin/node`。已有且体积合理时直接复用（离线可用）。
 *
 * @param {{ outDir: string, version?: string, platform?: string, cacheDir: string, log?: Function }} opts
 * @returns {Promise<{ version: string, nodePath: string }>}
 */
async function ensureBundledNodeLinux(opts) {
  const log = typeof opts.log === 'function' ? opts.log : console.log;
  const version = String(opts.version || resolveNodeVersion()).trim();
  const platform = String(opts.platform || 'linux-x64');
  const cacheDir = path.resolve(opts.cacheDir);
  const binDir = path.join(opts.outDir, 'bin');
  const nodeDest = path.join(binDir, 'node');

  if (fs.existsSync(nodeDest) && fs.statSync(nodeDest).size >= MIN_NODE_BYTES) {
    log(`复用已内置的 node：${nodeDest}`);
    return { version, nodePath: nodeDest };
  }

  await fsp.mkdir(binDir, { recursive: true });
  const tarball = `node-${version}-${platform}.tar.gz`;
  const tarPath = await ensureCachedTarball({ cacheDir, tarball, log });

  const tmpDir = path.join(cacheDir, '.extract-node');
  const extractDir = path.join(tmpDir, 'extract');
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  // 用相对路径解压：GNU tar 会把 `E:\...` 里的盘符冒号当成远程主机名
  execSync(
    `tar -xzf ${JSON.stringify(path.basename(tarPath))} -C ${JSON.stringify(
      path.relative(cacheDir, extractDir).replace(/\\/g, '/')
    )} ${`node-${version}-${platform}/bin/node`}`,
    { stdio: 'inherit', cwd: cacheDir }
  );
  const extracted = path.join(extractDir, `node-${version}-${platform}`, 'bin', 'node');
  if (!fs.existsSync(extracted)) throw new Error(`解压后找不到 node：${extracted}`);
  await fsp.copyFile(extracted, nodeDest);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  const size = fs.statSync(nodeDest).size;
  if (size < MIN_NODE_BYTES) throw new Error(`内置 node 体积异常（${size} bytes）`);
  log(`内置 node：${nodeDest}（${Math.round(size / 1024 / 1024)} MB）`);
  return { version, nodePath: nodeDest };
}

module.exports = {
  DEFAULT_NODE_VERSION,
  NODE_MIRRORS,
  MIN_NODE_BYTES,
  resolveNodeVersion,
  ensureCachedTarball,
  ensureBundledNodeLinux
};
