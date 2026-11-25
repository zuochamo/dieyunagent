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

const { applyMirrorEnv } = require('./mirrors.cjs');

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

/** 打包后的产物校验（两端同一套脚本，按当前平台取 <dist>/<platform>-unpacked） */
const VERIFY_STEPS = ['verify:asar', 'verify:remote-pack', 'verify:mcp-bundled'];

/**
 * 打包前的测试门禁。
 *
 * 跑 `npm test`（= scripts/test-agent-smoke.cjs：先 check:contracts，再按 git diff 选测）。
 * 不在这里固定 `test:agent --all` 的原因：那 43 项里有 sandbox-real / browser-smoke 等
 * 依赖本机环境的套件，做成每次打包的硬闸门就会「平时常红」→ 大家一律 `--no-tests`，
 * 门禁等于没有。要发布级全量，显式跑 `npm run test:agent-full`（或 .agents/skills/full-test）。
 */
const TEST_STEPS = ['test'];

/**
 * dist/ 里的产物回收（按版本保留最近 N 版）。
 *
 * 为什么要在打包链里做：一版安装包 ~160MB（exe + deb + blockmap），一版一版往下堆，
 * dist 三个月就能到 1GB；而 `workspace-cleanup.ps1 -Deep` 是整个 dist 删掉，
 * 想留「上一版」做增量更新测试就只能手工翻目录。
 *
 * 只删这里认得的产物文件名（安装包 / blockmap），目录（win-unpacked、mobile、
 * optional 之类）一律不碰——那些要么是这一轮的打包产物，要么是手工投放物。
 */
const ARTIFACT_PATTERNS = [
  { re: /^dieyunagent-Setup-(.+)\.exe$/, platform: 'win' },
  { re: /^dieyunagent-Setup-(.+)\.exe\.blockmap$/, platform: 'win' },
  { re: /^dieyunagent_(.+)_amd64\.deb$/, platform: 'linux' },
  { re: /^dieyunagent-(.+)-x86_64\.AppImage$/, platform: 'linux' },
  { re: /^dieyunagent-(.+)-x86_64\.AppImage\.blockmap$/, platform: 'linux' }
];

/** 版本号比较（只认数字段；同段数不同就按字符串兜底，避免 NaN 让排序塌成「都一样」） */
function compareVersionDesc(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return nb - na;
    } else if (String(pa[i] || '') !== String(pb[i] || '')) {
      return String(pb[i] || '').localeCompare(String(pa[i] || ''));
    }
  }
  return 0;
}

/**
 * @param {{ distRoot: string, keep: number, log?: Function }} opts
 * @returns {{ removed: {name: string, bytes: number}[], kept: string[] }}
 */
function pruneOldArtifacts(opts) {
  const log = typeof opts.log === 'function' ? opts.log : console.log;
  const distRoot = opts.distRoot;
  const keep = Number.isFinite(opts.keep) ? Math.max(1, Math.floor(opts.keep)) : 2;
  let names = [];
  try {
    names = fs.readdirSync(distRoot);
  } catch {
    return { removed: [], kept: [] };
  }

  /** @type {Map<string, {name: string, bytes: number}[]>} */
  const byVersion = new Map();
  for (const name of names) {
    const hit = ARTIFACT_PATTERNS.find((p) => p.re.test(name));
    if (!hit) continue;
    const version = hit.re.exec(name)[1];
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(distRoot, name)).size;
    } catch {
      continue;
    }
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push({ name, bytes });
  }

  const versions = [...byVersion.keys()].sort(compareVersionDesc);
  const kept = versions.slice(0, keep);
  // 本次构建的版本**无条件保留**：dist 里已经有 ≥keep 个比它更新的产物时（回滚打 hotfix、
  // 重跑旧 tag），只按「版本号从大到小取前 N」会把刚打出来的安装包删掉 —— 而 latest.yml
  // 正指向它，于是构建报成功、安装包和 blockmap 却不见了。
  const pinned = String(opts.keepVersion || '').trim();
  if (pinned && byVersion.has(pinned) && !kept.includes(pinned)) kept.push(pinned);
  const dropped = versions.filter((v) => !kept.includes(v));
  const removed = [];
  for (const version of dropped) {
    for (const item of byVersion.get(version)) {
      try {
        fs.rmSync(path.join(distRoot, item.name), { force: true });
        removed.push(item);
      } catch (e) {
        log(`[build-desktop] 回收 ${item.name} 失败：${(e && e.message) || e}`);
      }
    }
  }
  if (removed.length) {
    const mb = removed.reduce((a, r) => a + r.bytes, 0) / (1024 * 1024);
    log(
      `[build-desktop] 回收旧产物 ${removed.length} 个（${mb.toFixed(0)}MB）：` +
        `保留 ${kept.join(', ') || '(无)'}；删掉 ${dropped.join(', ')}`
    );
  }
  return { removed, kept };
}

function printHelp() {
  console.log(`
用法: node scripts/build-desktop.cjs [选项]

选项:
  --platform <win|linux>        目标平台，默认 win
  --target <nsis|dir|deb|appimage>
                                打包目标，默认 win→nsis、linux→deb
  --verify                      打包后跑产物校验（两端默认开启）
  --no-verify                   跳过产物校验（排障用）
  --tests                       打包前跑测试门禁（Windows 默认开启）
  --no-tests                    跳过测试门禁（排障用；发布不要用）
  --keep-artifacts <n>          出包后按版本保留最近 n 版安装包（默认 2）
  --prune-only                  只回收 dist/ 里的旧版本产物，不打包
  --help, -h                    显示本帮助
`);
}

function parseArgs(argv) {
  const opts = {
    platform: 'win',
    target: '',
    verify: null,
    tests: null,
    keepArtifacts: 2,
    pruneOnly: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) {
      opts.platform = String(argv[++i]).toLowerCase();
    } else if (a === '--target' && argv[i + 1]) {
      opts.target = String(argv[++i]).toLowerCase();
    } else if (a === '--keep-artifacts' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error(`--keep-artifacts 需要一个 ≥1 的数字：${argv[i]}`);
      opts.keepArtifacts = Math.floor(n);
    } else if (a === '--prune-only') {
      opts.pruneOnly = true;
    } else if (a === '--verify') {
      opts.verify = true;
    } else if (a === '--no-verify') {
      opts.verify = false;
    } else if (a === '--tests') {
      opts.tests = true;
    } else if (a === '--no-tests') {
      opts.tests = false;
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
  if (opts.verify === null) opts.verify = true;
  // 测试门禁默认只在 Windows 侧跑：发布链（build-installer.bat）从 PC 包开始，
  // 源是同一份；而 Linux 包在远端构建，源码包里**不含 .git**（pack-deb-remote 的
  // SRC_EXCLUDES），`npm test` 的 diff 选测会退化成最小集 —— 在那里跑只是假绿。
  if (opts.tests === null) opts.tests = opts.platform === 'win';
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
  // npmRebuild=false 两端都关（2026-11 起，原来只有 Linux 关）：
  // - koffi / uiohook-napi 都是自带 prebuild 的 N-API 模块，Electron 44 直接能加载，
  //   不需要 @electron/rebuild 按 ABI 重编（node-gyp-build 优先取 prebuilds/，重编产物根本没人读）；
  // - 之前唯一真要重编的是 cpu-features（ssh2 的可选加速件），它已经不进安装包了
  //   （package.json build.files 里排除；ssh2 有纯 JS 回退）；
  // - 于是那一步只剩成本：实测 Windows 上白跑约 40s，且它失败时会把打包卡在一个
  //   与我们无关的 gyp 错误上。
  // 真需要按 Electron ABI 重编时（换 ABI 的极端情况）显式去掉这个开关再打，别改默认值。
  const noRebuild = ['--config.npmRebuild=false'];
  if (opts.platform === 'linux') {
    return ['--linux', targetArg, ...noRebuild];
  }
  return [...(targetArg === '--dir' ? ['--win', '--dir'] : ['--win', targetArg]), ...noRebuild];
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

/**
 * 签名状态的诚实播报。
 *
 * electron-builder 的 `• signing with signtool.exe` 是**开工前的无条件日志**
 * （app-builder-lib/out/codeSign/windowsCodeSign.js），没有证书时它只在 debug 级打一句
 * skipped —— 日志看着像签了，产物其实是 NotSigned（2026-11 实测：Get-AuthenticodeSignature
 * 返回 NotSigned）。这里把真实判定打出来，别让发版日志自欺。
 */
function reportSigningState(opts) {
  if (opts.platform !== 'win') return;
  const winOptions = require(path.join(ROOT, 'package.json')).build.win || {};
  const signtoolOptions = winOptions.signtoolOptions || {};
  const configured = Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_KEY_PASSWORD ||
      winOptions.certificateFile ||
      winOptions.certificateSubjectName ||
      signtoolOptions.certificateFile
  );
  console.log(
    configured
      ? '[build-desktop] 代码签名：检测到证书配置，产物请用 signtool verify 复核'
      : '[build-desktop] 代码签名：未配置证书（CSC_LINK / certificateFile）→ 产物未签名，' +
          'SmartScreen 会拦；electron-builder 的 "signing with signtool.exe" 不代表签上了'
  );
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.pruneOnly) {
    const { getBuildDistRoot } = require('./build-dist-root.cjs');
    const distRoot = getBuildDistRoot();
    const res = pruneOldArtifacts({
      distRoot,
      keep: opts.keepArtifacts,
      keepVersion: require(path.join(ROOT, 'package.json')).version
    });
    console.log(
      `[build-desktop] --prune-only：${distRoot} 保留 ${res.kept.join(', ') || '(无)'}，` +
        `删除 ${res.removed.length} 个文件`
    );
    return;
  }
  // 内网镜像走环境变量（唯一来源 scripts/mirrors.cjs）：
  // electron-builder 及其「下载 Electron 运行时」子进程都读 ELECTRON_MIRROR。
  applyMirrorEnv();
  if (opts.platform === 'linux') assertLinuxHost();

  // electron-builder 直接用 node 跑它的 JS 入口：
  // 无需 cmd/shell（避开 Windows 上 spawn .cmd 的 EINVAL 与引号地狱），两端同一路径。
  const ebEntry = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(ebEntry)) {
    throw new Error(`未找到 electron-builder：${ebEntry}（先 npm install）`);
  }

  console.log(
    `[build-desktop] 平台=${opts.platform} 目标=${opts.target} ` +
      `校验=${opts.verify ? 'on' : 'off'} 测试=${opts.tests ? 'on' : 'off'}`
  );

  for (const step of COMMON_STEPS) runNpm(`npm run ${step}`, ['run', step]);
  for (const step of CORE_STEPS[opts.platform]) runNpm(`npm run ${step}`, ['run', step]);
  for (const step of RESOURCE_STEPS) runNpm(`npm run ${step}`, ['run', step]);

  assertBuildArtifacts(opts.platform);

  // 门禁卡在 pack 之后、packaging 之前：
  //   ① 有用例要读 build/dieyun-core 等打包输入，先有产物才不会误报；
  //   ② packaging 最贵（2-3 分钟），失败要卡在它前面。
  if (opts.tests) {
    for (const step of TEST_STEPS) runNpm(`npm run ${step}`, ['run', step]);
  } else {
    console.log('\n[build-desktop] 已跳过测试门禁（--tests 打开；发布链默认在 Windows 侧跑）');
  }

  const ebArgs = electronBuilderArgs(opts);
  run(`electron-builder ${ebArgs.join(' ')}`, process.execPath, [ebEntry, ...ebArgs]);

  reportSigningState(opts);

  if (opts.verify) {
    for (const step of VERIFY_STEPS) runNpm(`npm run ${step}`, ['run', step]);
  } else {
    console.log('\n[build-desktop] 已跳过产物校验（--verify 打开）');
  }

  // 回收旧版本产物：只有真正出安装包的目标才有可回收物（--dir 只有一个解包目录）。
  if (opts.target !== 'dir') {
    const { getBuildDistRoot } = require('./build-dist-root.cjs');
    pruneOldArtifacts({
      distRoot: getBuildDistRoot(),
      keep: opts.keepArtifacts,
      keepVersion: require(path.join(ROOT, 'package.json')).version
    });
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

module.exports = {
  main,
  parseArgs,
  electronBuilderArgs,
  assertBuildArtifacts,
  reportSigningState,
  pruneOldArtifacts,
  compareVersionDesc,
  PLATFORM_TARGETS
};
