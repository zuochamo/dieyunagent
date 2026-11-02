'use strict';

/**
 * 桌面端构建编排 —— Windows / Linux 的唯一入口。
 *
 * 为什么要有这个文件：原先 package.json 的 build / build:dir / build:nsis 把同一条
 * 长链各抄了一遍，只有最后一个 electron-builder 参数不同。加 Linux 目标时再抄一份
 * 就是四份重复，步骤一变要同步四处。这里把「步骤链 + 平台差异」收敛到一处。
 *
 * 用法：
 *   node scripts/build-desktop.cjs --platform win   --target nsis      # 等同原 npm run build
 *   node scripts/build-desktop.cjs --platform win   --target dir       # 等同原 build:dir
 *   node scripts/build-desktop.cjs --platform linux --target deb       # Ubuntu deb
 *   node scripts/build-desktop.cjs --platform linux --target appimage
 *
 * 平台差异只有两处：
 *   1. core sidecar：Windows 多一个 pack:dieyun-core（.exe）；pack:dieyun-core:linux 两端都要跑
 *      （打进包的 remote-gateway-pack 里带的是 Linux core）
 *   2. electron-builder 目标参数：--win nsis / --win --dir / --linux deb / --linux --dir
 *
 * Linux 目标必须在 Linux 机器上跑：deb 里的 core 是 ELF、原生依赖 .node 也是 Linux 版，
 * 在 Windows 上「交叉打 deb」没有意义。跨机打包走 `npm run pack:deb:remote`
 * （scripts/pack-deb-remote.cjs：传源码 → 远程构建 → 拉回 deb）。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 平台 → 允许的 target（第二个是 electron-builder 用的名字，大小写敏感） */
const PLATFORM_TARGETS = {
  win: { nsis: 'nsis', dir: '--dir' },
  linux: { deb: 'deb', appimage: 'AppImage', dir: '--dir' }
};

const DEFAULT_TARGET = { win: 'nsis', linux: 'deb' };

/** 与平台无关的准备步骤（两端都要） */
const COMMON_STEPS = ['bootstrap', 'verify:bundled-skills', 'build:renderer'];

/**
 * core sidecar 构建。注意 **Windows 也要跑 pack:dieyun-core:linux**：
 * 打进包的 remote-gateway-pack 里带的是 Linux 版 core（远端 gateway 跑在 Linux 服务器上），
 * 少的后果是 SSH 远端 Agent 缺 core 而失效——原 build 链里本来就有这一步。
 */
const CORE_STEPS = {
  win: ['pack:dieyun-core', 'pack:dieyun-core:linux'],
  linux: ['pack:dieyun-core:linux']
};

/** 打进安装包的资源包（纯 JS / 按当前平台取二进制） */
const RESOURCE_STEPS = ['pack:remote-gateway', 'pack:mcp-bundled'];

/** 打包后的产物校验。Linux 首版默认跳过：verify 脚本按 Windows 包内布局断言 */
const VERIFY_STEPS = ['verify:asar', 'verify:remote-pack', 'verify:mcp-bundled'];

function printHelp() {
  console.log(`
用法: node scripts/build-desktop.cjs [选项]

选项:
  --platform <win|linux>        目标平台，默认 win
  --target <nsis|dir|deb|appimage>
                                打包目标，默认 win→nsis、linux→deb
  --verify                      打包后跑产物校验（Linux 默认关闭）
  --no-verify                   跳过产物校验（Windows 默认开启）
  --help, -h                    显示本帮助
`);
}

function parseArgs(argv) {
  const opts = {
    platform: 'win',
    target: '',
    verify: null,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) {
      opts.platform = String(argv[++i]).toLowerCase();
    } else if (a === '--target' && argv[i + 1]) {
      opts.target = String(argv[++i]).toLowerCase();
    } else if (a === '--verify') {
      opts.verify = true;
    } else if (a === '--no-verify') {
      opts.verify = false;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  if (!PLATFORM_TARGETS[opts.platform]) {
    throw new Error(`不支持的平台: ${opts.platform}（可选 win / linux）`);
  }
  if (!opts.target) opts.target = DEFAULT_TARGET[opts.platform];
  if (!PLATFORM_TARGETS[opts.platform][opts.target]) {
    throw new Error(
      `平台 ${opts.platform} 不支持目标 ${opts.target}（可选 ` +
        `${Object.keys(PLATFORM_TARGETS[opts.platform]).join(' / ')}）`
    );
  }
  if (opts.verify === null) opts.verify = opts.platform === 'win';
  return opts;
}

/**
 * 只有 npm 需要特殊照顾：它是 .cmd，Node 18.20+ 不允许直接 spawn .bat/.cmd（EINVAL），
 * 而 `shell: true` + args 会在新版本报 DEP0190。故显式经 cmd.exe。
 * 其余命令（node 自身跑 electron-builder 的 JS 入口）一律直接 spawn，
 * 由 Node 按 Windows argv 规则处理带空格路径（如 C:\Program Files\nodejs\node.exe）。
 */
const USE_SHELL = process.platform === 'win32';

function npmBin() {
  return USE_SHELL ? 'npm.cmd' : 'npm';
}

function run(label, cmd, args, runOpts = {}) {
  console.log(`\n=== ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...runOpts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${label} 失败（exit ${r.status}）`);
  }
}

/** npm 在 Windows 上是 npm.cmd（在 PATH 中，路径无空格），整串交给 cmd /c 即可 */
function runNpm(label, args) {
  if (!USE_SHELL) return run(label, 'npm', args);
  console.log(`\n=== ${label}`);
  const r = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', [npmBin(), ...args].join(' ')],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${label} 失败（exit ${r.status}）`);
  }
}

/** Linux 目标的前置检查：早失败，不要等到 electron-builder 深处才报 */
function assertLinuxHost() {
  if (process.platform !== 'linux') {
    throw new Error(
      `Linux 安装包只能在 Linux 上构建（当前 ${process.platform}）：\n` +
        '  跨机打包请用 `npm run pack:deb:remote`（传源码到构建机 → 远程构建 → 拉回 deb）。'
    );
  }
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  if (!fs.existsSync(electronBin)) {
    throw new Error(
      '缺少 Linux 版 Electron 运行时：' +
        `${electronBin}\n` +
        '  请先在构建机上执行 `npm ci --ignore-scripts`，' +
        '再 `node node_modules/electron/install.js`（设 ELECTRON_MIRROR 走内网镜像）。'
    );
  }
  // Linux 交付的是图标集目录（不是单张 PNG）：electron-builder 按每个文件的像素尺寸装到
  // /usr/share/icons/hicolor/<size>x<size>/apps/，而 hicolor index.theme 只声明到 512x512，
  // 少了 512 这一档，Ubuntu 应用列表里就会显示空白/齿轮图标。
  const iconDir = path.join(ROOT, 'assets', 'icons', 'linux');
  const requiredIcon = path.join(iconDir, '512x512.png');
  if (!fs.existsSync(requiredIcon)) {
    throw new Error(
      `缺少 Linux 图标集 ${iconDir}（至少要有 512x512.png）：先跑 \`npm run icons\``
    );
  }
}

function electronBuilderArgs(opts) {
  const targetArg = PLATFORM_TARGETS[opts.platform][opts.target];
  if (opts.platform === 'linux') {
    // npmRebuild=false 是刻意关的：electron-builder 默认会跑 @electron/rebuild，
    // - koffi / uiohook-napi 自带 N-API prebuild，Electron 44 直接能加载，不需重建；
    // - cpu-features（ssh2 的可选加速件）在没有完整源码/头部时会 gyp 失败，
    //   而 ssh2 有纯 JS 回退，缺它不影响 SSH 功能。
    // 真需要源码编译的场景（如换 Electron ABI）应显式去掉这个开关。
    return ['--linux', targetArg, '--config.npmRebuild=false'];
  }
  return targetArg === '--dir' ? ['--win', '--dir'] : ['--win', targetArg];
}

/**
 * 打包前的最小产物闸门。
 *
 * electron-builder 对**不存在的** `extraResources.from` 只 `log.warn`（app-builder-lib
 * fileMatcher），不会失败；Windows 侧还有 `verify:asar/remote-pack/mcp-bundled` 与
 * after-pack 的体积检查兜底，Linux 侧此前一个都没有 —— 于是「某个 pack 步骤静默出了空目录」
 * 会一路走到出包、拉回、发布，装出来才发现远端 Agent 没有 core。
 *
 * 这里只断言「本平台必需的产物在、且不是空壳」：判据就是 electron-builder 配置里
 * `extraResources` 的 from 路径，别在这里另立一套清单。
 */
const REQUIRED_ARTIFACTS = {
  win: [
    ['build/dieyun-core/dieyun-core.exe', 500 * 1024, 'sidecar（pack:dieyun-core）'],
    ['build/dieyun-core-linux/dieyun-core', 500 * 1024, 'remote-gateway 里的 Linux core（pack:dieyun-core:linux）'],
    ['build/remote-gateway-pack/manifest.json', 1, '远端 Agent 包（pack:remote-gateway）'],
    ['build/mcp-bundled', 1, '离线预装 MCP（pack:mcp-bundled）']
  ],
  linux: [
    ['build/dieyun-core-linux/dieyun-core', 500 * 1024, 'Linux core（pack:dieyun-core:linux）'],
    ['build/remote-gateway-pack/manifest.json', 1, '远端 Agent 包（pack:remote-gateway）'],
    ['build/mcp-bundled', 1, '离线预装 MCP（pack:mcp-bundled）']
  ]
};

function assertBuildArtifacts(platform) {
  const missing = [];
  for (const [rel, minBytes, label] of REQUIRED_ARTIFACTS[platform]) {
    const abs = path.join(ROOT, rel);
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (!st) {
      missing.push(`${label}：缺少 ${rel}`);
    } else if (st.isFile() && st.size < minBytes) {
      missing.push(`${label}：${rel} 只有 ${st.size} 字节（应 ≥ ${minBytes}）`);
    } else if (st.isDirectory() && !fs.readdirSync(abs).length) {
      missing.push(`${label}：${rel} 是空目录`);
    }
  }
  if (missing.length) {
    throw new Error(
      '打包产物不完整，已中止（否则会出一个装上去才发现缺件的安装包）：\n  ' + missing.join('\n  ')
    );
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.platform === 'linux') assertLinuxHost();

  // electron-builder 直接用 node 跑它的 JS 入口：
  // 无需 cmd/shell（避开 Windows 上 spawn .cmd 的 EINVAL 与引号地狱），两端同一路径。
  const ebEntry = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(ebEntry)) {
    throw new Error(`未找到 electron-builder：${ebEntry}（先 npm install）`);
  }

  console.log(
    `[build-desktop] 平台=${opts.platform} 目标=${opts.target} 校验=${opts.verify ? 'on' : 'off'}`
  );

  for (const step of COMMON_STEPS) runNpm(`npm run ${step}`, ['run', step]);
  for (const step of CORE_STEPS[opts.platform]) runNpm(`npm run ${step}`, ['run', step]);
  for (const step of RESOURCE_STEPS) runNpm(`npm run ${step}`, ['run', step]);

  assertBuildArtifacts(opts.platform);

  const ebArgs = electronBuilderArgs(opts);
  run(`electron-builder ${ebArgs.join(' ')}`, process.execPath, [ebEntry, ...ebArgs]);

  if (opts.verify) {
    for (const step of VERIFY_STEPS) runNpm(`npm run ${step}`, ['run', step]);
  } else {
    console.log('\n[build-desktop] 已跳过产物校验（--verify 打开）');
  }

  console.log(`\n[build-desktop] 完成：平台=${opts.platform} 目标=${opts.target} → dist/`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[build-desktop] failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, electronBuilderArgs, assertBuildArtifacts, PLATFORM_TARGETS };
