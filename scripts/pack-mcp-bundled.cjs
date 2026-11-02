'use strict';

/**
 * 把「离线预装 MCP」打进 build/mcp-bundled/，供 electron-builder 的 extraResources
 * 拷到安装包内的 <resources>/mcp/bundled（见 package.json build.extraResources）。
 *
 * 为什么必须预装：postgres-mcp-hardened 这个 npm 包只在**首次使用时**才
 *   ① npm install 下来 ② 从 GitHub Releases 下载对应平台的二进制（其 lib/install.js）。
 * 内网这两条路都不通；更关键的是它用 Node 的 fetch 下载，在企业 TLS 代理下
 * 即使「能上网」也会 fetch failed（本仓实测：curl 200 / Node fetch 失败）。
 * 于是表现为「MCP 已启用但永远连不上」。构建期取产物 + 校验 sha256 是唯一可靠做法。
 *
 * 布局（manifest.json 是布局的唯一声明，启动侧 src/mcp/bundled-launch.js 只读它）：
 *   build/mcp-bundled/<serverId>/manifest.json
 *   build/mcp-bundled/<serverId>/pkg/**             ← npm tarball 原样解包（含 bin/cli.js）
 *   build/mcp-bundled/<serverId>/pkg/vendor/<exe>   ← 平台二进制（该包 install.js 约定的位置）
 * 不放 node_modules：该包运行时零依赖；且 electron-builder 会无条件剔除 extraResources
 * 源目录根的 node_modules（见 scripts/verify-remote-gateway-pack.cjs 的注释）。
 *
 * 三处「不在这里写死」：
 * - 包名与版本：唯一来源是 src/mcp/registry.js 的启动规格（`-y <pkg>@<version>`）；
 * - 二进制 sha256：唯一来源是该 npm 包自带的 checksums.json（发布工作流产出）；
 * - 下载源仓：与包内 lib/install.js 的 REPO 一致，仅用于拼 Release 地址。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { getBuiltinMcpById } = require('../src/mcp/registry');
const {
  getMcpNpmPackageMeta,
  execFileText,
  npmCommandName
} = require('../src/mcp/package-store');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'mcp-bundled');
// 与 scripts/pack-remote-gateway.cjs 共用同一个缓存目录：构建机断网时把产物手工放进这里即可
const CACHE_DIR = path.join(ROOT, 'build', '.cache');

/** 该仓要预装的 MCP 服务 id（必须在 registry 里声明 bundledServer） */
const BUNDLED_MCP_IDS = ['mcp-postgres'];

/** 上游发布仓（与包内 npm/lib/install.js 的 REPO 常量一致） */
const RELEASE_REPO = 'Eszetael/postgres-mcp-hardened';

/**
 * npm 平台名 → Rust target（决定 Release 资源名）。
 * 与包内 npm/lib/install.js 的 TARGETS 对应，这里只声明本仓要预装的平台；
 * 交付面是 Windows NSIS 与 Ubuntu deb/AppImage，故登记 win32-x64 与 linux-x64。
 */
const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu'
};

function targetOrExplain() {
  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];
  if (target) return target;
  throw new Error(
    `预装 MCP 暂不支持 ${key}（当前只做 win32-x64 / linux-x64）。\n` +
      `  要加平台：在 scripts/pack-mcp-bundled.cjs 的 TARGETS 里补 ${key} → Rust target，\n` +
      `  并确认 package.json build.extraResources 的 mcp/bundled 只随对应平台的安装包分发。`
  );
}

function releaseUrl(version, archive) {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${archive}`;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** manifest 里的相对路径一律用正斜杠：同一份 manifest 在任何平台都能被 path.resolve 解析 */
function toManifestPath(...parts) {
  return parts.join('/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** 解压 npm tarball（package/ 前缀）到 destDir，剥掉顶层目录 */
function extractTarball(tarball, destDir) {
  execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', destDir], { stdio: 'inherit' });
}

/** 解压 zip 到 destDir。tar(bsdtar) 优先，PowerShell 兜底（与包内 npm/lib/install.js 同策略） */
function extractZip(archive, destDir) {
  try {
    execFileSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'inherit' });
    return;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    console.warn('[mcp-bundled] tar 解压失败，改用 Expand-Archive:', err.message || err);
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`
      ],
      { stdio: 'inherit' }
    );
  }
}

/** 当前平台是否需要给上游 launcher 补 windowsHide（控制台弹窗只是 Windows 的问题） */
function needsConsolePatch() {
  return process.platform === 'win32';
}

/**
 * 上游资产的扩展名不统一：Windows 发 .zip，Linux 发 .tar.gz。
 * 因此**不猜扩展名**，以 npm 包内 checksums.json 的键为准（它同时是 sha256 的来源）。
 */
function archiveNameFor(name, target, checksums) {
  const prefix = `${name}-${target}.`;
  const hit = Object.keys(checksums || {}).find(
    (k) => k.startsWith(prefix) && /\.(zip|tar\.gz)$/.test(k)
  );
  if (!hit) {
    throw new Error(
      `checksums.json 里没有 ${prefix}zip / ${prefix}tar.gz —— 发布不完整，拒绝产出未校验的二进制`
    );
  }
  return hit;
}

/** 解压 tar.gz（Linux 资产内部是单个文件、无顶层目录，故不能 --strip-components） */
function extractTarballFlat(archive, destDir) {
  execFileSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' });
}

async function downloadWithCurl(url, dest) {
  const candidates = process.platform === 'win32' ? ['curl.exe', 'curl'] : ['curl'];
  let lastErr = null;
  for (const bin of candidates) {
    try {
      // -L 跟随重定向（GitHub Release 302 到 release-assets），--fail 让 4xx/5xx 走非零退出
      execFileSync(bin, ['-sSL', '--fail', '--max-time', '600', '-o', dest, url], {
        stdio: ['ignore', 'inherit', 'pipe']
      });
      return;
    } catch (err) {
      // curl 的失败原因都在 stderr（TLS/代理/404），拼进 message 方便定位
      const detail = String((err && err.stderr) || '').trim();
      if (detail) err.message = `${err.message}\n  ${detail}`;
      lastErr = err;
    }
  }
  throw lastErr || new Error('curl 不可用');
}

/**
 * 取得 Release 产物并校验 sha256（**失败关闭**：校验不过一律不产出）。
 * 命中 build/.cache/<archive> 时跳过下载，供断网构建 / 手工投放。
 */
async function ensureArchive(archive, url, expectedSha) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, archive);
  if (fs.existsSync(cached)) {
    const got = sha256File(cached);
    if (got === expectedSha) {
      console.log('[mcp-bundled] 使用缓存产物:', cached);
      return cached;
    }
    console.warn('[mcp-bundled] 缓存产物 sha256 不符，将重新下载:', cached);
    await fsp.rm(cached, { force: true });
  }

  const tmp = path.join(os.tmpdir(), archive);
  console.log('[mcp-bundled] 下载', url);
  try {
    await downloadWithCurl(url, tmp);
  } catch (err) {
    throw new Error(
      `下载失败：${url}\n  ${err.message || err}\n` +
        `  断网/内网构建：把 ${archive} 手工放到 ${cached} 后重试。`
    );
  }
  const got = sha256File(tmp);
  if (got !== expectedSha) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`sha256 不符，拒绝使用：${archive}\n  expected ${expectedSha}\n  got      ${got}`);
  }
  await fsp.copyFile(tmp, cached);
  await fsp.rm(tmp, { force: true });
  return cached;
}

/** 取 npm tarball（npm pack 只下载已发布 tarball，不会触发它的 postinstall） */
async function ensureNpmTarball(name, version) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const spec = `${name}@${version}`;
  const tgzName = `${name}-${version}.tgz`;
  const cached = path.join(CACHE_DIR, tgzName);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1024) {
    console.log('[mcp-bundled] 使用缓存 tarball:', cached);
    return cached;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dieyun-mcp-pack-'));
  try {
    console.log('[mcp-bundled] npm pack', spec);
    await execFileText(npmCommandName(), ['pack', spec, '--pack-destination', tmpDir, '--silent'], {
      timeout: 300000
    });
    const produced = path.join(tmpDir, tgzName);
    if (!fs.existsSync(produced)) throw new Error(`npm pack 未产出 ${tgzName}`);
    await fsp.copyFile(produced, cached);
    return cached;
  } catch (err) {
    throw new Error(
      `取 npm 包失败：${spec}\n  ${err.message || err}\n` +
        `  断网/内网构建：把 ${tgzName} 手工放到 ${cached} 后重试。`
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 上游 launcher（pkg/bin/cli.js）把控制台交给原生二进制时**没传 windowsHide**：
 *
 *   const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });   ← 上游原文
 *
 * 后果不是「多了个进程」，而是**每次连接都弹一个黑窗口**：app 与 launcher 自己都是
 * GUI 子系统 / 无控制台进程（Electron），Windows 对「父进程没有控制台」的控制台子进程
 * 必须**新分配**一个控制台，Win11 默认终端是 Windows Terminal，于是弹出一个标题为
 * `…\pkg\vendor\postgres-mcp-hardened.exe` 的窗口（2026-10-16 实测：electron 父进程复现 11→12 个窗口）。
 * 用 node.exe 当父进程复现不出来 —— 控制台子系统 + CREATE_NO_WINDOW 拿到的是「隐藏控制台」，
 * 孙进程能继承，所以这个坑只在 app 里出现。
 *
 * 补一个 windowsHide: true（控制台子进程于是拿到隐藏控制台）即无窗口。
 * 锚点找不到就**失败关闭**：上游改了这段结构必须人工确认，不能静默产出带窗口的包。
 */
const LAUNCHER_SPAWN_ANCHOR = "spawn(bin, process.argv.slice(2), { stdio: 'inherit' })";
const LAUNCHER_SPAWN_PATCHED =
  "spawn(bin, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })";

/** @returns {{ ok: boolean, changed: boolean, text: string }} ok=false 表示上游结构变了，拒绝产出 */
function patchLauncherHideConsole(source) {
  const text = String(source || '');
  if (text.includes(LAUNCHER_SPAWN_PATCHED)) return { ok: true, changed: false, text };
  // 上游自己补上了（写法可能不同）：只要这行 spawn 里已有 windowsHide 就放行
  if (!text.includes(LAUNCHER_SPAWN_ANCHOR)) {
    if (/spawn\(bin,[^\n]*windowsHide/.test(text)) return { ok: true, changed: false, text };
    return { ok: false, changed: false, text };
  }
  return { ok: true, changed: true, text: text.replace(LAUNCHER_SPAWN_ANCHOR, LAUNCHER_SPAWN_PATCHED) };
}

/** 产物里的 launcher 是否已经不会给孙进程弹控制台窗口 */
function launcherHidesConsole(entryPath) {
  try {
    return fs.readFileSync(entryPath, 'utf8').includes('windowsHide');
  } catch {
    return false;
  }
}

/** 读已存在的 manifest（没有/坏掉都返回 null） */
function readManifest(dir) {
  try {
    const raw = readJson(path.join(dir, 'manifest.json'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 完成判定：manifest 与 registry 一致，入口、二进制都在（二进制按 manifest 的 sha256 复校），且入口已打过防弹窗补丁 */
function packLooksComplete(dir, meta) {
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = readJson(manifestPath);
    if (!manifest || manifest.packageName !== meta.name || manifest.version !== meta.version) return false;
    // 平台也要对得上：同一份 build/ 目录被多个平台构建复用时，不能把 Windows 产物当 Linux 的用
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) return false;
    const entry = path.join(dir, manifest.entry || '');
    const binary = path.join(dir, manifest.binary || '');
    if (!manifest.entry || !manifest.binary) return false;
    if (!fs.existsSync(entry) || !fs.existsSync(binary)) return false;
    // 补丁是同版本下也必须重打包的一项：否则旧产物会被判定「已是最新」而继续弹窗
    if (needsConsolePatch() && !launcherHidesConsole(entry)) return false;
    return sha256File(binary) === manifest.binarySha256;
  } catch {
    return false;
  }
}

async function packOne(serverId, target, force) {
  const server = getBuiltinMcpById(serverId);
  if (!server) throw new Error(`registry 里没有 ${serverId}`);
  if (!server.bundledServer) {
    throw new Error(
      `${serverId} 未声明 bundledServer —— 预装产物的目录名/启动解析都以它为准，请先在 registry 里声明`
    );
  }
  const meta = getMcpNpmPackageMeta(server);
  if (!meta || !meta.name || !meta.version) {
    throw new Error(`${serverId} 的 registry 启动规格必须锁定包名与版本（形如 -y <pkg>@<version>）`);
  }

  const dir = path.join(OUT, server.bundledServer);
  if (!force && packLooksComplete(dir, meta)) {
    console.log(`[mcp-bundled] ${serverId} 已是最新（${meta.name}@${meta.version}），跳过`);
    return;
  }

  // 只有「同一版本被强制重打包」才原地覆盖：同一版本的输入字节相同，不会留下陈旧文件。
  // 换版本 / 无 manifest / 上次中断（manifest 缺失或不匹配）一律整目录清掉重来，
  // 避免旧版本残留文件混进产物 —— 那类残留只在换版本时可能发生，所以清目录也只在这里做。
  const sameVersion = readManifest(dir)?.version === meta.version;
  if (!sameVersion) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  await fsp.mkdir(dir, { recursive: true });

  const pkgDir = path.join(dir, 'pkg');
  await fsp.mkdir(pkgDir, { recursive: true });
  const tarball = await ensureNpmTarball(meta.name, meta.version);
  extractTarball(tarball, pkgDir);

  const checksums = readJson(path.join(pkgDir, 'checksums.json'));
  const archive = archiveNameFor(meta.name, target, checksums);
  const expectedSha = checksums[archive];
  if (!expectedSha) {
    throw new Error(
      `${meta.name}@${meta.version} 的 checksums.json 里没有 ${archive} —— 发布不完整，拒绝产出未校验的二进制`
    );
  }
  const archivePath = await ensureArchive(archive, releaseUrl(meta.version, archive), expectedSha);

  const vendorDir = path.join(pkgDir, 'vendor');
  await fsp.mkdir(vendorDir, { recursive: true });
  if (archive.endsWith('.tar.gz')) extractTarballFlat(archivePath, vendorDir);
  else extractZip(archivePath, vendorDir);
  // 资产内部的可执行名：Windows 带 .exe，Linux 无扩展名（实测 tar.gz 里就叫包名）
  const exeName = needsConsolePatch() ? `${meta.name}.exe` : meta.name;
  const exePath = path.join(vendorDir, exeName);
  if (!fs.existsSync(exePath)) {
    throw new Error(`${archive} 解压后未找到 ${exeName}（该包 install.js 约定的位置是 pkg/vendor/）`);
  }

  const entry = toManifestPath('pkg', 'bin', 'cli.js');
  if (!fs.existsSync(path.join(dir, entry))) {
    throw new Error(`${meta.name}@${meta.version} 里没有 ${entry}，与上游包结构不符`);
  }

  // 给上游 launcher 补 windowsHide（理由见 patchLauncherHideConsole 的注释）：
  // 不改这一行，app 每次连接 mcp-postgres 都会弹一个黑窗口。
  const entryAbs = path.join(dir, entry);
  const needsPatch = needsConsolePatch();
  const patched = needsPatch
    ? patchLauncherHideConsole(fs.readFileSync(entryAbs, 'utf8'))
    : { ok: true, changed: false, text: '' };
  if (!patched.ok) {
    throw new Error(
      `${meta.name}@${meta.version} 的 ${entry} 结构与补丁锚点不符，拒绝产出：\n` +
        `  期望找到：${LAUNCHER_SPAWN_ANCHOR}\n` +
        `  上游可能已重构起原生二进制的调用。请人工确认它是否已传 windowsHide；\n` +
        `  若上游自己修好了，更新 scripts/pack-mcp-bundled.cjs 的 patchLauncherHideConsole 即可。`
    );
  }
  if (patched.changed) {
    fs.writeFileSync(entryAbs, patched.text, 'utf8');
    console.log(`[mcp-bundled] patched ${entry}: 起原生二进制时补 windowsHide（防弹控制台窗口）`);
  }

  const manifest = {
    id: serverId,
    packageName: meta.name,
    version: meta.version,
    platform: process.platform,
    arch: process.arch,
    // 入口用包自带的 JS launcher：它会在启动时校验参数（打错 --stdio 会拒绝而不是去开 HTTP 监听），
    // 且因为 pkg/vendor/<exe> 已就位，它的「缺二进制就下载」分支不会被触发。
    entry,
    binary: toManifestPath('pkg', 'vendor', exeName),
    binarySha256: sha256File(exePath),
    // 本仓对上游字节做过的改动（目前一项）：launcher 起原生二进制时补 windowsHide。
    // 打包侧的唯一声明；`packLooksComplete` 按它复检，缺了视为产物过期。
    patches: needsPatch ? ['launcher-windowsHide'] : [],
    archive,
    archiveSha256: expectedSha,
    packedAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const size = fs.statSync(exePath).size;
  console.log(
    `[mcp-bundled] pack OK: ${serverId} ← ${meta.name}@${meta.version} ` +
      `(${Math.round(size / 1024 / 1024 * 10) / 10} MB) → ${dir}`
  );
}

async function main() {
  const target = targetOrExplain();
  const force = process.env.DIEYUN_MCP_BUNDLED_FORCE === '1';
  await fsp.mkdir(OUT, { recursive: true });
  for (const id of BUNDLED_MCP_IDS) {
    await packOne(id, target, force);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[mcp-bundled] pack failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  OUT,
  CACHE_DIR,
  BUNDLED_MCP_IDS,
  TARGETS,
  releaseUrl,
  packLooksComplete,
  patchLauncherHideConsole,
  launcherHidesConsole,
  readJson
};
