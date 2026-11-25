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
const { execSync, execFileSync } = require('child_process');
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
 * ELF strip 工具的解析（**单一来源**）。
 *
 * 为什么要 strip：Node 官方 linux-x64 产物是**带符号表的**。实测 v20.18.2 的 `bin/node`
 * 93.87MB 里，`.symtab` 2.54 + `.strtab` 7.22 + 一段 `.debug_*` 2.10 = 11.86MB（13%）；
 * `--strip-all` 后 80.3MB，跑得一模一样（远端 Ubuntu 实测 `--version` / Intl / crypto / zlib 全 OK）。
 * 这 13MB 会跟着**每一个**安装包分发给**每一个**用户，一个字节也用不上。
 *
 * 解析顺序：
 *   1. `DIEYUN_ELF_STRIP`（显式指定，路径或命令名）
 *   2. rustup toolchain 自带的 rust-objcopy / llvm-objcopy（cargo 是本仓构建前提，最可移植）
 *   3. PATH 上的 llvm-strip / llvm-objcopy / strip / x86_64-linux-gnu-strip
 * Windows 上把 rustup 那组放在前面：PATH 上的 `strip.exe` 多半是 MinGW/MSYS2 的 **PE 版** binutils，
 * 对 ELF 会直接 `file format not recognized`，而 toolchain 里的 llvm-objcopy 才是对的。
 *
 * 找不到工具就**报错**，不回退成「悄悄不 strip」：那样包会大 13MB 且没人发现
 * （afterPack 的体积预算只兜得住失控的失控，兜不住这种「刚好还没超」的慢性流失）。
 *
 * @returns {{ cmd: string, args: string[], source: string } | null}
 */
function resolveElfStrip() {
  /**
   * 只验证「这个命令能跑」。之前用 `<tool> --strip-all --version` 探活，等于要求工具能同时接受
   * 两个开关；某个实现不认就会把**可用工具**误判成不可用，然后报「找不到 strip 工具」。
   */
  const probe = (cmd, source) => {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 15000 });
      return { cmd, args: ['--strip-all'], source };
    } catch {
      return null;
    }
  };

  const explicit = String(process.env.DIEYUN_ELF_STRIP || '').trim();
  if (explicit) {
    const found = probe(explicit, 'DIEYUN_ELF_STRIP');
    if (!found) throw new Error(`DIEYUN_ELF_STRIP=${explicit} 不可用（--version 失败）`);
    return found;
  }

  const rustupCandidates = [];
  try {
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
    const vv = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const host = (/^host:\s*(\S+)/m.exec(vv) || [])[1] || '';
    const dirs = [];
    if (sysroot && host) dirs.push(path.join(sysroot, 'lib', 'rustlib', host, 'bin'));
    if (sysroot) dirs.push(path.join(sysroot, 'bin'));
    const names = ['rust-objcopy.exe', 'rust-objcopy', 'llvm-objcopy.exe', 'llvm-objcopy', 'llvm-strip.exe', 'llvm-strip'];
    for (const dir of dirs) {
      for (const name of names) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) rustupCandidates.push({ cmd: full, source: `rustup:${name}` });
      }
    }
  } catch {
    // rustc 不存在：只用 PATH 那组
  }

  const pathCandidates = ['llvm-strip', 'llvm-objcopy', 'strip', 'x86_64-linux-gnu-strip'].map((cmd) => ({
    cmd,
    source: `PATH:${cmd}`
  }));

  const ordered =
    process.platform === 'win32'
      ? [...rustupCandidates, ...pathCandidates]
      : [...pathCandidates, ...rustupCandidates];

  for (const c of ordered) {
    const found = probe(c.cmd, c.source);
    if (found) return found;
  }

  return null;
}

/** 只读前 4 字节判 ELF（strip 前后各用一次；不解析其它）。 */
function readElfMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    return magic.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把内置的 Linux node 就地 strip（幂等：已 strip 过再跑一次体积不变）。
 *
 * 调用点只有 ensureBundledNodeLinux（远端 pack 与 headless 包共用），
 * 所以「strip 过没有」不需要第二个判据：这里跑过就是 strip 过。
 */
function stripBundledNode(file, log = console.log) {
  const tool = resolveElfStrip();
  if (!tool) {
    throw new Error(
      '找不到 ELF strip 工具，拒绝产出未 strip 的 Linux node（会白多 13MB）。\n' +
        '  任选其一：\n' +
        '    rustup component add llvm-tools          # 提供 rust-objcopy / llvm-objcopy\n' +
        '    set DIEYUN_ELF_STRIP=llvm-strip          # 或指向任意 llvm-strip / objcopy / strip\n' +
        '  说明见 docs/HEADLESS.md 与 scripts/lib/node-linux-runtime.cjs'
    );
  }
  // strip 前先确认目标是 ELF：bin/node 若是半个下载 / 别的平台产物，让报错说清是什么，
  // 而不是让 strip 工具吐一句 "file format not recognized"。
  const magicBefore = readElfMagic(file);
  if (magicBefore !== '\x7fELF') {
    throw new Error(
      `内置 node 不是 Linux ELF（前 4 字节 ${JSON.stringify(magicBefore)}）：${file}\n` +
        '  删掉它所在的 pack 目录（build/remote-gateway-pack/bin/node）后重跑打包，会重新下载。'
    );
  }

  const before = fs.statSync(file).size;
  execFileSync(tool.cmd, [...tool.args, file], { stdio: 'inherit' });
  const after = fs.statSync(file).size;

  // 二次确认：产物仍是 ELF（别让某个把参数当输出的"strip"毁了二进制）
  const magicAfter = readElfMagic(file);
  if (magicAfter !== '\x7fELF') {
    throw new Error(`strip 后不是 ELF（前 4 字节 ${JSON.stringify(magicAfter)}）：${file}（工具 ${tool.source}）`);
  }
  if (after < MIN_NODE_BYTES) {
    throw new Error(`strip 后体积异常（${after} bytes < ${MIN_NODE_BYTES}）：${file}`);
  }
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  log(
    after < before
      ? `内置 node strip（${tool.source}）：${mb(before)}MB → ${mb(after)}MB，省 ${mb(before - after)}MB`
      : `内置 node 已是 strip 态（${tool.source}）：${mb(after)}MB`
  );
  return { before, after, tool: tool.source };
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
    stripBundledNode(nodeDest, log);
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
  stripBundledNode(nodeDest, log);
  return { version, nodePath: nodeDest };
}

module.exports = {
  DEFAULT_NODE_VERSION,
  NODE_MIRRORS,
  MIN_NODE_BYTES,
  resolveNodeVersion,
  ensureCachedTarball,
  ensureBundledNodeLinux,
  resolveElfStrip,
  stripBundledNode
};
