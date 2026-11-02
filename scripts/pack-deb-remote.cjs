'use strict';

/**
 * 在 Linux 构建机上打 Ubuntu 安装包（deb / AppImage），产物拉回本机 dist/。
 *
 * 为什么需要它：deb 里装的是 Linux ELF 的 dieyun-core、Linux 版 Electron 运行时和
 * Linux 版原生 .node，在 Windows 上「交叉打 deb」没有意义。本脚本只借远程机的
 * SSH shell 干活——**不绑定工作空间**：不注入 ~/.dieyun/remote-agent/、不建索引、
 * 远端目录可随时删、也不受路径白名单约束。
 *
 * 用法：
 *   npm run pack:deb:remote                 # 用 dieyun-linux-build.local.json 里的目标
 *   npm run pack:deb:remote -- --target appimage
 *   npm run pack:deb:remote -- --skip-sync  # 源码没变，只重跑远程构建
 *   npm run pack:deb:remote -- --skip-deps  # node_modules 已装好，跳过 npm ci
 *
 * 远端约定（统一放在数据盘 dieyunserver 下，与 core 构建目录同级）：
 *   /run/media/dieyunx/dieyunserver/dieyunagent/deb-build/src.tgz   ← 上传的源码包
 *   /run/media/dieyunx/dieyunserver/dieyunagent/deb-build/pkg/      ← 解包后的构建目录（含 node_modules 与 dist）
 * 路径优先级：--remote-dir > DIEYUN_DEB_REMOTE_DIR > dieyun-linux-build.local.json 的 debRemoteDir > 下面的默认值。
 *
 * 三个内网必须解决的网络问题（都集中在本文件常量里）：
 *   1. 构建机连不上 registry.npmjs.org       → npm_config_registry 指向 npmmirror
 *   2. 构建机连不上 GitHub（Electron 二进制） → ELECTRON_MIRROR
 *   3. electron-builder 打 deb 要下 fpm      → ELECTRON_BUILDER_BINARIES_MIRROR
 * 另外 pack:mcp-bundled 的二进制在 GitHub Releases，构建机取不到，
 * 由本脚本在本机（可达 GitHub）预先下载到 build/.cache/ 再随源码上传。
 */

const fs = require('fs');
const path = require('path');

const {
  run,
  shellQuote,
  sshScript,
  sshCapture,
  scpToRemote,
  scpFromRemote,
  ensureOpenSsh,
  packSources
} = require('./lib/ssh-build.cjs');

const ROOT = path.join(__dirname, '..');
const LOCAL_CONFIG = path.join(ROOT, 'dieyun-linux-build.local.json');
const DEFAULT_REMOTE_DIR = '/run/media/dieyunx/dieyunserver/dieyunagent/deb-build';
const TAR_NAME = 'dieyun-src.deb-build.tgz';
// 本机产物目录与其它构建产物的唯一来源一致（build-dist-root.cjs：dist / dist-build 由标记文件决定）
const OUT_DIR = require('./build-dist-root.cjs').getBuildDistRoot();

/** 上传源码时排除的东西：要么平台相关，要么是产物，传过去只会污染远端 */
const SRC_EXCLUDES = [
  'node_modules',
  'dist',
  'dist-build',
  'build',
  'target',
  'release',
  'models',
  '.git',
  '.dieyun',
  '.workbuddy',
  '_tmp',
  '.venv',
  'mobile-app/node_modules',
  'mobile-app/.gradle',
  'mobile-app/android/build',
  'mobile-app/android/apk-build',
  'mobile-app/android/manual-build',
  'mobile-app/android/app/build'
];

/** target → 远程执行的 npm script（build-desktop.cjs 的包装） */
const BUILD_SCRIPTS = {
  deb: 'build:linux',
  appimage: 'build:linux:appimage',
  dir: 'build:linux:dir'
};

/** 内网构建镜像 —— 单一来源，改这里即可 */
const NPM_REGISTRY = 'https://registry.npmmirror.com';
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const EB_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

function readLocalConfig() {
  try {
    if (!fs.existsSync(LOCAL_CONFIG)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8')) || {};
  } catch (e) {
    console.warn('[deb:remote] 读取本地配置失败:', e.message || e);
    return {};
  }
}

function parseArgs(argv) {
  const fileCfg = readLocalConfig();
  const opts = {
    ssh: String(process.env.DIEYUN_LINUX_CORE_SSH || fileCfg.ssh || '').trim(),
    port: Number(process.env.DIEYUN_LINUX_CORE_PORT || fileCfg.port || 22),
    identityFile: String(
      process.env.DIEYUN_LINUX_CORE_IDENTITY || fileCfg.identityFile || ''
    ).trim(),
    remoteDir: String(
      process.env.DIEYUN_DEB_REMOTE_DIR || fileCfg.debRemoteDir || DEFAULT_REMOTE_DIR
    ).trim(),
    target: 'deb',
    skipSync: false,
    skipDeps: false,
    skipBuild: false,
    cleanRemote: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ssh' && argv[i + 1]) opts.ssh = String(argv[++i]).trim();
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]) || 22;
    else if (a === '--identity' || a === '-i') opts.identityFile = String(argv[++i]).trim();
    else if (a === '--remote-dir') opts.remoteDir = String(argv[++i]).trim();
    else if (a === '--target') opts.target = String(argv[++i]).toLowerCase();
    else if (a === '--skip-sync') opts.skipSync = true;
    else if (a === '--skip-deps') opts.skipDeps = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--clean-remote') opts.cleanRemote = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数: ${a}（--help 查看用法）`);
  }
  return opts;
}

function printHelp() {
  console.log(`
用法: npm run pack:deb:remote -- [选项]

在 Linux 构建机上打 Ubuntu deb / AppImage，产物拉回本机 dist/。

选项:
  --ssh <user@host>         SSH 目标（默认读 dieyun-linux-build.local.json / DIEYUN_LINUX_CORE_SSH）
  --port <n>                SSH 端口，默认 22
  --identity, -i <path>     私钥路径
  --remote-dir <path>       远端构建目录，默认 ${DEFAULT_REMOTE_DIR}
  --target <deb|appimage|dir>
                            打包目标，默认 deb
  --skip-sync               跳过源码上传（远端源码已是当前版本时用）
  --skip-deps               跳过 npm ci / electron 下载（依赖已装好时用）
  --skip-build              只同步 + 装依赖，不执行构建（排查环境问题时用）
  --clean-remote            构建成功后删除远端 pkg 目录
  --help, -h                显示本帮助
`);
}

function parseSshTarget(ssh) {
  const m = /^([^@/\s]+)@([^/\s:]+)$/.exec(String(ssh || '').trim());
  return m ? { user: m[1], host: m[2] } : null;
}

/** 远端 ~ 必须展开成绝对路径，否则后续 shellQuote 会把 ~ 当字面量 */
function resolveRemoteDir(opts) {
  const r = sshCapture(opts, 'echo "$HOME"');
  const home = r.stdout.trim();
  if (r.status !== 0 || !home) {
    throw new Error(
      `无法在远端解析 $HOME：${r.stderr.trim() || 'ssh 无输出'}\n` +
        '  检查 SSH 免密登录（BatchMode）与私钥路径。'
    );
  }
  const dir = opts.remoteDir.startsWith('~/')
    ? path.posix.join(home, opts.remoteDir.slice(2))
    : opts.remoteDir;
  return { home, dir };
}

/** 远端环境预检：早失败，别等到编译半小时后才报缺 node */
function preflight(opts) {
  const script = `
set -e
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done
fi
command -v node >/dev/null || { echo "MISSING_NODE"; exit 11; }
# cargo / zig 不在非登录 shell 的默认 PATH 里，显式加上（与 remoteBuildScript 一致）
export PATH="$HOME/.cargo/bin:$HOME/.dieyun/zig:$PATH"
command -v npm >/dev/null || { echo "MISSING_NPM"; exit 12; }
command -v cargo >/dev/null || echo "WARN_NO_CARGO"
command -v zig >/dev/null || [ -x "$HOME/.dieyun/zig/zig" ] || echo "WARN_NO_ZIG"
ldd --version 2>&1 | head -1
node -v
`;
  const r = sshCapture(opts, script);
  if (r.status === 11 || r.status === 12) {
    throw new Error('远端缺少 node/npm：请先装 Node 18+（nvm 或系统包）后重试。');
  }
  if (r.status !== 0) {
    throw new Error(`远端环境预检失败：${r.stderr.trim() || r.stdout.trim()}`);
  }
  const out = r.stdout.trim();
  console.log('[deb:remote] 远端环境:\n  ' + out.split('\n').join('\n  '));
  if (out.includes('WARN_NO_CARGO')) {
    throw new Error('远端缺少 cargo：Linux core 需要 Rust 工具链（rustup 安装后重试）。');
  }
  if (out.includes('WARN_NO_ZIG')) {
    console.warn(
      '[deb:remote] 警告：远端没有 zig。宿主 glibc 高于 2.17 时 core 必须走 zigbuild，' +
        '届时会失败；请安装 zig 或复用 ~/.dieyun/zig/zig。'
    );
  }
}

/**
 * 预置 Linux 版 MCP 二进制缓存。
 *
 * pack:mcp-bundled 从 GitHub Releases 取二进制，而构建机连不上 GitHub。
 * 本机可达 → 这里下好放进 build/.cache/（与 pack-mcp-bundled 同一个缓存目录），
 * 远端构建时命中缓存，sha256 由 pack-mcp-bundled 自己按 npm 包内的 checksums.json 校验。
 */
function ensureLinuxMcpCache() {
  const { TARGETS, BUNDLED_MCP_IDS, releaseUrl, CACHE_DIR } = require('./pack-mcp-bundled.cjs');
  const { getBuiltinMcpById } = require('../src/mcp/registry');
  const { getMcpNpmPackageMeta } = require('../src/mcp/package-store');

  const rustTarget = TARGETS['linux-x64'];
  if (!rustTarget) throw new Error("pack-mcp-bundled 的 TARGETS 缺少 'linux-x64'");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const files = [];
  for (const id of BUNDLED_MCP_IDS) {
    const meta = getMcpNpmPackageMeta(getBuiltinMcpById(id));
    if (!meta || !meta.name || !meta.version) {
      throw new Error(`无法解析 ${id} 的 npm 包元信息（registry.js / package-store 变更？）`);
    }
    // 上游资产扩展名不统一（Windows .zip / Linux .tar.gz），这里按候选试而不是猜：
    // 真正的权威是包内 checksums.json，而校验发生在远端 pack:mcp-bundled 里。
    const candidates = [
      `${meta.name}-${rustTarget}.tar.gz`,
      `${meta.name}-${rustTarget}.zip`
    ].map((n) => path.join(CACHE_DIR, n));

    const existing = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 1024);
    if (existing) {
      console.log(`[deb:remote] 复用 MCP 缓存: ${path.basename(existing)}`);
      files.push(existing);
      continue;
    }

    let cached = null;
    for (const candidate of candidates) {
      const name = path.basename(candidate);
      const url = releaseUrl(meta.version, name);
      console.log(`[deb:remote] 下载 MCP 二进制: ${name}`);
      try {
        run('curl', ['-sSL', '--fail', '--max-time', '600', '-o', candidate, url]);
        const size = fs.statSync(candidate).size;
        if (size > 1024) {
          console.log(`[deb:remote] 已缓存 ${name}（${Math.round(size / 1024 / 1024)} MB）`);
          cached = candidate;
          break;
        }
      } catch {
        console.warn(`[deb:remote] 取不到 ${name}，换下一个候选`);
      }
      fs.rmSync(candidate, { force: true });
    }
    if (!cached) {
      throw new Error(
        `无法取得 ${meta.name}@${meta.version} 的 ${rustTarget} 二进制：\n` +
          candidates.map((p) => '  ' + releaseUrl(meta.version, path.basename(p))).join('\n')
      );
    }
    files.push(cached);
  }
  return files;
}

function remoteBuildScript(opts, remote) {
  const q = shellQuote;
  const lines = [
    'set -e',
    // node：优先 PATH，其次 nvm 目录（不硬编码版本号）
    'if ! command -v node >/dev/null 2>&1; then',
    '  for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done',
    'fi',
    'command -v node >/dev/null || { echo "远端缺少 node"; exit 11; }',
    'export PATH="$HOME/.cargo/bin:$HOME/.dieyun/zig:$PATH"',
    // 走内网镜像，用环境变量而不是 npm config set：不改动构建机的全局 ~/.npmrc
    `export npm_config_registry=${q(NPM_REGISTRY)}`,
    `export ELECTRON_MIRROR=${q(ELECTRON_MIRROR)}`,
    `export ELECTRON_BUILDER_BINARIES_MIRROR=${q(EB_BINARIES_MIRROR)}`,
    'export npm_config_fund=false',
    'export npm_config_audit=false',
    'export ELECTRON_SKIP_BINARY_DOWNLOAD=0',
    `cd ${q(path.posix.join(remote.dir, 'pkg'))}`,
    'echo "[remote] node $(node -v) npm $(npm -v)"'
  ];

  if (!opts.skipDeps) {
    lines.push(
      // --ignore-scripts 是刻意的：postinstall 的 electron-builder install-app-deps 会
      // 对 uiohook-napi 走 node-gyp 源码编译（缺 X11 头文件，需要 root 装 dev 包）。
      // 实测 koffi / uiohook-napi 自带的 prebuild 已是 N-API，Electron 44 可直接加载，
      // 不需要重建；Electron 运行时单独用 install.js 下载。
      'echo "[remote] npm ci --ignore-scripts …"',
      'npm ci --ignore-scripts',
      'if [ ! -x node_modules/electron/dist/electron ]; then',
      '  echo "[remote] 下载 Electron 运行时 …"',
      '  node node_modules/electron/install.js',
      'fi',
      '[ -x node_modules/electron/dist/electron ] || { echo "Electron 运行时缺失"; exit 13; }'
    );
  } else {
    lines.push(
      'if [ ! -d node_modules ]; then echo "跳过依赖但 node_modules 不存在"; exit 14; fi',
      'if [ ! -x node_modules/electron/dist/electron ]; then',
      '  echo "[remote] 下载 Electron 运行时 …"',
      '  node node_modules/electron/install.js',
      'fi'
    );
  }

  if (!opts.skipBuild) {
    lines.push(
      `echo "[remote] npm run ${BUILD_SCRIPTS[opts.target]} …"`,
      `npm run ${BUILD_SCRIPTS[opts.target]}`,
      'echo "[remote] 产物:"',
      'ls -la dist 2>/dev/null || { echo "dist 不存在"; exit 15; }'
    );
  } else {
    lines.push('echo "[remote] 按 --skip-build 跳过构建"');
  }
  return lines.join('\n');
}

function pullArtifacts(opts, remote) {
  // --skip-build 时远端 dist/ 已被源码同步清空，本来就没有新产物；
  // 这里直接返回，避免把「没构建」误报成「构建失败」。
  if (opts.skipBuild) {
    console.log('[deb:remote] 按 --skip-build 跳过产物拉回（本次无新安装包）');
    return [];
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const patterns =
    opts.target === 'deb'
      ? ['dist/*.deb']
      : opts.target === 'appimage'
        ? ['dist/*.AppImage']
        : [];

  if (patterns.length === 0) {
    console.log('[deb:remote] target=dir：不做产物拉回（产物留在远端目录）');
    return [];
  }

  // 先列远端文件，避免 scp 通配符无匹配时静默什么都不拉
  const listing = sshCapture(
    opts,
    `cd ${shellQuote(path.posix.join(remote.dir, 'pkg'))} && ls -1 ${patterns.join(' ')} 2>/dev/null || true`
  );
  const names = listing.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      `远端没有产出安装包（${patterns.join(', ')}）：构建可能未真正执行，检查上面的输出`
    );
  }

  const saved = [];
  for (const name of names) {
    const base = path.basename(name);
    const localPath = path.join(OUT_DIR, base);
    console.log(`[deb:remote] 拉回 ${base} …`);
    scpFromRemote(opts, path.posix.join(remote.dir, 'pkg', name), localPath);
    const mb = Math.round((fs.statSync(localPath).size / 1024 / 1024) * 10) / 10;
    console.log(`[deb:remote] 已保存 ${localPath}（${mb} MB）`);
    saved.push({ path: localPath, sizeMb: mb });
  }
  return saved;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.ssh) {
    printHelp();
    throw new Error(
      '缺少 SSH 目标：--ssh user@host 或 DIEYUN_LINUX_CORE_SSH / dieyun-linux-build.local.json'
    );
  }
  if (!parseSshTarget(opts.ssh)) {
    throw new Error(`SSH 目标格式无效: ${opts.ssh}（应为 user@host）`);
  }
  if (!BUILD_SCRIPTS[opts.target]) {
    throw new Error(`不支持的 target: ${opts.target}（可选 deb / appimage / dir）`);
  }

  ensureOpenSsh();
  console.log(`[deb:remote] 目标 ${opts.ssh}:${opts.port}，target=${opts.target}`);
  preflight(opts);

  const remote = resolveRemoteDir(opts);
  console.log(`[deb:remote] 远端目录 ${remote.dir}`);

  if (opts.cleanRemote) {
    console.log('[deb:remote] 清理远端 pkg …');
    sshScript(opts, `rm -rf ${shellQuote(path.posix.join(remote.dir, 'pkg'))}`, {
      timeoutMs: 120000
    });
    opts.skipSync = false;
    opts.skipDeps = false;
  }

  if (!opts.skipSync) {
    const mcpFiles = ensureLinuxMcpCache();
    const tgz = packSources(ROOT, TAR_NAME, SRC_EXCLUDES);
    const sizeMb = Math.round((fs.statSync(tgz).size / 1024 / 1024) * 10) / 10;
    console.log(`[deb:remote] 源码包 ${sizeMb} MB，上传中 …`);

    sshScript(
      opts,
      [
        'set -e',
        `mkdir -p ${shellQuote(remote.dir)} ${shellQuote(path.posix.join(remote.dir, 'pkg'))}`,
        // 只清源码，保留 node_modules / target / build：
        //   node_modules —— 依赖没变就不必重装；
        //   target       —— Rust 增量编译（否则每次全量重编 40s+）；
        //   build        —— core/mcp 产物与 .cache，按指纹/jssha 自行判定是否能复用。
        // 依赖真变了用 --clean-remote 从零开始。
        `find ${shellQuote(path.posix.join(remote.dir, 'pkg'))} -mindepth 1 -maxdepth 1 ! -name node_modules ! -name target ! -name build -exec rm -rf {} +`,
        `mkdir -p ${shellQuote(path.posix.join(remote.dir, 'pkg', 'build', '.cache'))}`
      ].join('\n'),
      { timeoutMs: 120000 }
    );

    const remoteTar = path.posix.join(remote.dir, 'src.tgz');
    scpToRemote(opts, tgz, remoteTar);
    // MCP 二进制走同一个缓存目录，让远端 pack:mcp-bundled 命中缓存（省掉 GitHub）
    for (const f of mcpFiles) {
      scpToRemote(
        opts,
        f,
        path.posix.join(remote.dir, 'pkg', 'build', '.cache', path.basename(f))
      );
    }
    sshScript(
      opts,
      `set -e\ncd ${shellQuote(path.posix.join(remote.dir, 'pkg'))} && tar -xzf ${shellQuote(remoteTar)} && rm -f ${shellQuote(remoteTar)}`,
      { timeoutMs: 300000 }
    );
    try {
      fs.unlinkSync(tgz);
    } catch {
      // ignore
    }
    console.log('[deb:remote] 源码与 MCP 缓存已就位');
  } else {
    console.log('[deb:remote] 按 --skip-sync 跳过源码上传');
  }

  console.log('[deb:remote] 远端构建开始（首次编译 core 可能十几分钟）…');
  sshScript(opts, remoteBuildScript(opts, remote), { timeoutMs: 60 * 60 * 1000 });

  const saved = pullArtifacts(opts, remote);

  if (opts.cleanRemote && saved.length > 0) {
    console.log('[deb:remote] 清理远端 pkg …');
    sshScript(opts, `rm -rf ${shellQuote(path.posix.join(remote.dir, 'pkg'))}`, {
      timeoutMs: 120000
    });
  }

  console.log(`\n[deb:remote] 完成：${saved.length} 个产物 → ${OUT_DIR}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[deb:remote] failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, BUILD_SCRIPTS };
