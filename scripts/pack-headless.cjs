'use strict';

/**
 * 打「无界面运行」的 Linux 包：`dist/dieyun-headless-<ver>-linux-x64.tgz`。
 *
 * 产出的目录就是服务器上的 `/opt/dieyun-headless`：
 *
 *   bin/node                     内置 node（`--no-node` 时不带，用系统 node ≥ 20）
 *   bin/dieyun-headless          sh 启动器（等价 `node src/headless/main.js "$@"`）
 *   src/**                       全部源码（含 src/mobile/public —— Web 界面就是它）
 *   assets/**                    dieyun.md 模板等（dieyun-instructions 按相对路径读）
 *   build/dieyun-core/dieyun-core  dieyun-core（**这个位置是 core-bridge-path 的既有探测路径**）
 *   build/mcp-bundled/**         离线预装 MCP（bundled-launch 也按这个相对路径找）
 *   node_modules/**              仅运行时真正 require 到的 prod 依赖
 *   package.json / manifest.json / HEADLESS.md
 *
 * 三条「为什么这样做」：
 * 1. **依赖清单从入口推**，不是手写清单：手写的清单会在加了 require 之后忘记更新，
 *    症状是服务器上 import 时报 MODULE_NOT_FOUND。这里从 `src/headless/main.js` 走一遍
 *    相对 require 图，收集真正的裸包名，再与 package.json 的 dependencies 求交。
 * 2. **不装桌面/原生模块**：`koffi`（Windows 输入注入）与 `playwright-core`（内嵌浏览器）
 *    在无窗口环境既没有对应工具、又会把 win32 二进制带进 Linux 包。装完还会扫一遍
 *    `*.node`，有原生二进制直接失败 —— 宁可打包阶段报错，也不要服务器上「起不来」。
 * 3. **core 放 build/dieyun-core/**：`src/core-bridge-path.js` 的探测顺序里就有这一条，
 *    因此零配置即可启动；不额外引入一个 `DIEYUN_CORE_BIN` 必填项。
 *
 * 用法：
 *   node scripts/pack-headless.cjs                 # 完整打包（内置 node + 预装 MCP）→ tgz
 *   node scripts/pack-headless.cjs --deb           # 另加 Debian 包（tgz 仍会产出）
 *   node scripts/pack-headless.cjs --no-node       # 不带 node（更小，需系统 node ≥ 20）
 *   node scripts/pack-headless.cjs --no-mcp        # 不带离线 MCP
 *   node scripts/pack-headless.cjs --offline       # npm install 走本地缓存
 *   node scripts/pack-headless.cjs --verify-only <tgz|deb|目录>
 *
 * 关于 `--deb`：Debian 包只是**同一份 payload 的分发外壳**，装完仍然是同一套
 * `src/headless/main.js`（终端 / run / Web 三种用法都在里面），**不含 Electron/Chromium**
 * —— 服务器上跑 CLI 没必要背图形栈。deb 里额外做的三件事（都在 postinst 里，幂等）：
 *   1. 建 `dieyun` 系统用户 + `/var/lib/dieyun-agent`、`/srv/agent-workspace` 目录；
 *   2. 首次安装生成 `/etc/dieyun/secret.key`（凭据密钥，**绝不覆盖**已有文件）；
 *   3. 从 `headless.env.example` 复制出 `/etc/dieyun/headless.env`（已有则不动）。
 * ar 容器由本脚本用 Node 拼（不依赖 dpkg-deb），因此在 Windows 构建机上也能出 deb；
 * 有 `dpkg-deb` 时额外跑一遍它的 `-I` / `-c` 做交叉校验。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build', 'headless-pack');
const DIST = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(ROOT, 'build', '.cache');

const { ensureBundledNodeLinux, resolveNodeVersion } = require('./lib/node-linux-runtime.cjs');
const { writeTarGz } = require('./lib/tar-writer.cjs');
const { CORE_GLIBC_TARGET, compareNeed, glibcRequirementOf } = require('./pack-dieyun-core-linux-lib.cjs');
const appPkg = require(path.join(ROOT, 'package.json'));

const PLATFORM = 'linux-x64';
const ENTRY_REL = 'src/headless/main.js';
/** core 的位置必须与 src/core-bridge-path.js 的探测路径一致（`<root>/build/dieyun-core/<exe>`） */
const CORE_REL = 'build/dieyun-core/dieyun-core';
const CORE_SRC = path.join(ROOT, 'build', 'dieyun-core-linux', 'dieyun-core');
const MCP_BUNDLE_REL = 'build/mcp-bundled';

/**
 * 打包时的权限位（唯一声明处）：只有真正要执行的几个文件是 0755，其余 0644。
 * 不用系统 tar 的原因见 `scripts/lib/tar-writer.cjs` 的头注释（Windows 上会写成 0666/0777）。
 */
const EXEC_IN_PAYLOAD = new Set(['bin/node', 'bin/dieyun-headless', CORE_REL]);

function payloadMode(rel, isDir) {
  if (isDir) return 0o755;
  return EXEC_IN_PAYLOAD.has(rel.replace(/\\/g, '/')) ? 0o755 : 0o644;
}

function rootfsMode(rel, isDir) {
  const norm = rel.replace(/\\/g, '/');
  if (isDir) return 0o755;
  if (norm === 'usr/bin/dieyun-headless') return 0o755;
  if (EXEC_IN_PAYLOAD.has(norm.replace(/^opt\/dieyun-headless\//, ''))) return 0o755;
  return 0o644;
}

function controlMode(rel, isDir) {
  if (isDir) return 0o755;
  return rel === 'control' ? 0o644 : 0o755;
}

/** `node_modules/.bin` 是 npm 在打包机上生成的 shell/cmd 垫片，平台相关且运行时用不到 */
function skipPackaging(rel, isDir) {
  const norm = rel.replace(/\\/g, '/');
  return isDir && (norm === 'node_modules/.bin' || norm.endsWith('/node_modules/.bin'));
}

/** 桌面/渲染层专用依赖：headless 不需要，且会拖进 native 或几十 MB 资源 */
const EXCLUDED_DEPS = new Map([
  ['koffi', 'Windows 输入注入（computer_* 工具；无窗口时本来就不可用）'],
  ['playwright-core', '内嵌浏览器（browser_* 工具；无窗口时本来就不可用）']
]);

/** 允许出现但不在 dependencies 里的裸名：electron 由宿主提供，playwright 是桌面可选依赖 */
const NON_DEP_ALLOWED = new Map([
  ['electron', 'Electron 宿主模块（纯 Node 下这些 require 都在 try/函数体内，不会执行）'],
  ['playwright', '桌面浏览器自动化的可选依赖（browser_* 未纳入 headless 工具表）']
]);

const REQUIRED_ENTRIES = [
  'package.json',
  'manifest.json',
  'HEADLESS.md',
  'bin/dieyun-headless',
  ENTRY_REL,
  'src/headless/boot.js',
  'src/headless/local-executor.js',
  'src/agent/main-turn-runner.js',
  'src/mobile/public/app.js',
  'src/mobile/bridge.js',
  'assets/dieyun.md',
  CORE_REL,
  'node_modules/ws/package.json',
  'node_modules/@modelcontextprotocol/sdk/package.json'
];

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { node: true, mcp: true, offline: false, deb: false, verifyOnly: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-node') opts.node = false;
    else if (a === '--no-mcp') opts.mcp = false;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--deb') opts.deb = true;
    else if (a === '--verify-only') {
      opts.verifyOnly = String(argv[i + 1] || '');
      i += 1;
      if (!opts.verifyOnly) throw new Error('--verify-only 需要一个 tgz / deb 或目录路径');
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------- 依赖闭包

const BUILTINS = new Set(require('module').builtinModules);
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function isBuiltin(spec) {
  return spec.startsWith('node:') || BUILTINS.has(spec);
}

function packageNameOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      // 不存在就试下一个
    }
  }
  return null;
}

/**
 * 从入口走 require 图，取出**真正会加载**的裸包名。
 * 只做静态字面量匹配：本仓没有 `require(变量)` 形态（打包时会打印计数，出现就不是 0）。
 */
function scanRuntimeDeps(entryAbs) {
  const seen = new Set();
  const bare = new Map();
  const dynamic = [];
  const queue = [entryAbs];
  while (queue.length) {
    const file = path.resolve(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const dyn = text.match(/require\(\s*[^'")\s]/g);
    if (dyn) dynamic.push(path.relative(ROOT, file));
    REQUIRE_RE.lastIndex = 0;
    let m;
    while ((m = REQUIRE_RE.exec(text))) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target) queue.push(target);
      } else if (!spec.startsWith('/') && !isBuiltin(spec)) {
        const name = packageNameOf(spec);
        if (!bare.has(name)) bare.set(name, path.relative(ROOT, file));
      }
    }
  }
  return { files: seen, bare, dynamic };
}

function resolveDependencies(entryAbs) {
  const scan = scanRuntimeDeps(entryAbs);
  const declared = appPkg.dependencies || {};
  const deps = {};
  const skipped = [];
  const unknown = [];
  for (const name of [...scan.bare.keys()].sort()) {
    if (EXCLUDED_DEPS.has(name)) {
      skipped.push(name);
      continue;
    }
    if (declared[name]) deps[name] = declared[name];
    else if (!NON_DEP_ALLOWED.has(name)) unknown.push(name);
  }
  return { scan, deps, skipped, unknown };
}

// ---------------------------------------------------------------- 文件操作

function copyTree(srcDir, destDir, opts = {}) {
  const skip = opts.skip || (() => false);
  let count = 0;
  const walk = (rel) => {
    const src = path.join(srcDir, rel);
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (skip(childRel.replace(/\\/g, '/'))) continue;
      const from = path.join(srcDir, childRel);
      const to = path.join(destDir, childRel);
      if (ent.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(childRel);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        count += 1;
      }
    }
  };
  fs.mkdirSync(destDir, { recursive: true });
  walk('');
  return count;
}

/** 扫描 node_modules 里的原生二进制（`.node`）—— 出现就说明把桌面依赖带进来了 */
function findNativeBinaries(dir) {
  const hits = [];
  const walk = (abs, depth) => {
    if (depth > 6) return;
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.bin' || ent.name === '.cache') continue;
        walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.node')) {
        hits.push(path.relative(STAGE, p));
      }
    }
  };
  walk(dir, 0);
  return hits;
}

/**
 * `--verify-only` 的入参归一：目录里有 manifest.json 就当产物目录；否则当 dist 目录，
 * 按 `preferDeb` 取最新的 `.deb` 或 `.tgz`（`npm run verify:headless-pack` / `verify:headless-deb` 走这条）。
 */
function resolveVerifyTarget(target, preferDeb = false) {
  if (!fs.existsSync(target)) throw new Error(`--verify-only 路径不存在：${target}`);
  if (fs.statSync(target).isFile()) return target;
  if (fs.existsSync(path.join(target, 'manifest.json'))) return target;
  const want = preferDeb ? /\.deb$/i : /\.tgz$/i;
  const artifacts = fs
    .readdirSync(target)
    .filter((n) => /^dieyun-headless[_-].*\.(tgz|deb)$/i.test(n) && want.test(n))
    .map((n) => path.join(target, n));
  if (!artifacts.length) {
    throw new Error(
      `${target} 里没有 ${preferDeb ? '.deb' : '.tgz'} 产物（先跑 npm run ${preferDeb ? 'pack:deb:headless' : 'pack:headless'}）`
    );
  }
  artifacts.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return artifacts[0];
}

/** 固定必需项（`bin/node` 不在其中：`--no-node` 的包用系统 node，是合法产物） */
function verifyLayout(rootDir) {
  const missing = REQUIRED_ENTRIES.filter((rel) => !fs.existsSync(path.join(rootDir, rel)));
  return { ok: missing.length === 0, missing };
}

function verifyTarball(tgzPath) {
  const listing = execSync(`tar -tzf ${JSON.stringify(path.basename(tgzPath))}`, {
    cwd: path.dirname(tgzPath),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const entries = new Set(
    listing
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\.\//, ''))
      .filter(Boolean)
  );
  const missing = REQUIRED_ENTRIES.filter((rel) => !entries.has(rel));
  return { ok: missing.length === 0, missing, count: entries.size };
}

// ---------------------------------------------------------------- 冷启动闸门
//
// 为什么必须在**仓库外**跑：`build/headless-pack/src/...` 仍然在仓库目录树里，Node 解析
// `require('electron')` 会一路往上走到仓库自己的 `node_modules/electron` —— 于是「包能启动」
// 这个结论是假的。第一次打包就踩到了：`src/browser/controller.js` 顶部 require('electron')，
// 在仓库里跑得好好的，解到干净目录立刻 MODULE_NOT_FOUND。
//
// 做法：把 payload 的 src/assets/package.json 复制到临时目录，`node_modules` 与 `build`
// 用**指向打包目录的符号链接**（不复制 150MB），然后跑入口的 `--help`。这一条覆盖
// 「所有顶层 require 在无 Electron、无桌面依赖的环境里能否加载」，秒级且不联网。

function linkDir(target, linkPath) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(target, linkPath, type);
}

function verifyColdStart() {
  const tmp = path.join(os.tmpdir(), `dieyun-headless-coldstart-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fs.cpSync(path.join(STAGE, 'src'), path.join(tmp, 'src'), { recursive: true });
    fs.cpSync(path.join(STAGE, 'assets'), path.join(tmp, 'assets'), { recursive: true });
    fs.copyFileSync(path.join(STAGE, 'package.json'), path.join(tmp, 'package.json'));
    linkDir(path.join(STAGE, 'node_modules'), path.join(tmp, 'node_modules'));
    linkDir(path.join(STAGE, 'build'), path.join(tmp, 'build'));

    const env = { ...process.env, DIEYUN_CORE: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    let out = '';
    try {
      out = execSync(`"${process.execPath}" "${path.join(tmp, 'src', 'headless', 'main.js')}" --help`, {
        cwd: tmp,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000
      });
    } catch (err) {
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n') || err.message;
      throw new Error(
        '冷启动闸门失败：payload 在「干净目录 + 只有包内 node_modules」的环境里加载不起来。\n' +
          '通常是某个可达模块顶部仍在 `require(\'electron\')` 或依赖桌面包（正确做法是延迟取用，' +
          '参考 src/browser/electron-host.js）。\n--- 输出 ---\n' +
          String(detail).split('\n').slice(0, 25).join('\n')
      );
    }
    if (!/dieyun-headless/.test(out)) {
      throw new Error(`冷启动闸门：入口 --help 输出异常：${out.slice(0, 200)}`);
    }
    return { ok: true };
  } finally {
    // Windows 上 junction 与已打开的句柄会拖住删除，重试几次即可
    for (let i = 0; i < 5; i += 1) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        execSync(process.platform === 'win32' ? 'timeout /t 1 >nul' : 'sleep 1', { stdio: 'ignore', shell: true });
      }
    }
  }
}

// ---------------------------------------------------------------- Debian 包（--deb）
//
// deb 的结构是 ar 容器里放三个成员：`debian-binary`、`control.tar.gz`、`data.tar.gz`。
// 这里用 Node 直接写 ar（60 字节头 + 偶数对齐），不调用 dpkg-deb —— 因为打包机是
// Windows，dpkg-deb 不在场；而 payload 与 tar 都与平台无关。有 dpkg-deb 时再交叉校验。

const DEB_WORK = path.join(ROOT, 'build', 'headless-deb');
const DEB_ROOTFS = path.join(DEB_WORK, 'rootfs');
const DEB_PAYLOAD = path.join(DEB_ROOTFS, 'opt', 'dieyun-headless');
const DEB_CONTROL = path.join(DEB_WORK, 'DEBIAN');
const DEB_PKG = 'dieyun-headless';

/** `/usr/bin` 里的入口：只做一层转发，真正的逻辑仍在包内 bin/dieyun-headless */
const DEB_USR_BIN = `#!/bin/sh
exec /opt/dieyun-headless/bin/dieyun-headless "$@"
`;

const DEB_ENV_EXAMPLE = `# dieyun-headless 服务环境（deb 安装时从 headless.env.example 复制而来，已有则不会被覆盖）
# 数据目录：SQLite 账本 / 设置 / 索引都在这里
DIEYUN_USER_DATA=/var/lib/dieyun-agent
# 凭据密钥（MCP / SSH / 频道 Secret）；缺失时这些凭据不可写，不会回退明文
DIEYUN_SECRET_KEY_FILE=/etc/dieyun/secret.key
# 浏览器界面监听地址与端口（默认只听回环；端口被别的服务占了就改这里）
# DIEYUN_WEB_HOST=127.0.0.1
# DIEYUN_WEB_PORT=17331
# Agent 默认工作空间（目录需存在且 dieyun 用户可写；不是 /srv/agent-workspace 就改这里）
# DIEYUN_WORKSPACE=/srv/agent-workspace
# 日志级别：error | warn | info | debug
# DIEYUN_LOG_LEVEL=info
# 可选：显式指定 core（默认探测 /opt/dieyun-headless/build/dieyun-core/dieyun-core）
# DIEYUN_CORE_BIN=/opt/dieyun-headless/build/dieyun-core/dieyun-core
# 可选：本地 Gateway 端口（一个数据目录只跑一个进程）
# DIECLOUD_GATEWAY_PORT=17330
`;

/** postinst / prerm / postrm 的共同前提：全部幂等，且绝不覆盖用户已有配置。
 *  真正打包时用 `buildDebPostinst(resolveAptBase())`（把内网 apt 源一起编进去），
 *  这里的无源版本只作为「没有部署配置时」的形状与默认值。 */
const DEB_POSTINST = buildDebPostinst('');

/**
 * 生成 postinst。`aptBase` 非空时额外写一行内网 apt 源 ——
 * **和普通消费版的更新源是同一个站点**（`deploy.json` 的 `updates.primaryUrl`，
 * 内网 `http://192.168.31.62:3099/`，COS 是兜底），apt 仓库就放在该站点的 `apt/dieyun/pool/` 下：
 * 发布用 `node scripts/publish-headless-apt.cjs --out <站点根>/apt/dieyun`。
 *
 * 为什么让包自己写源：装了服务器版却「永远查不到新版本」，是因为没人告诉他源在哪；
 * 让运维每台机器手抄一行 `echo deb ...` 是把同一条信息重复 N 次，抄错就是静默不更新。
 * 仍然守住两条：① 文件存在就**绝不覆盖**（用户自己配的源优先）；② 不改系统其它源。
 *
 * @param {string} aptBase 形如 `http://192.168.31.62:3099/apt/dieyun/`；空串 = 不写源
 */
function buildDebPostinst(aptBase) {
  const base = String(aptBase || '').trim();
  const aptBlock = base
    ? `
# —— 内网 apt 源（与普通消费版同一个站点的子路径）：装完就能 apt upgrade dieyun-headless ——
# 只在文件不存在时写：你自己配过源就完全以你那份为准（含指到别的镜像）。
DIEYUN_SRC=/etc/apt/sources.list.d/dieyun-headless.list
if [ ! -f "$DIEYUN_SRC" ]; then
  printf 'deb [trusted=yes] ${base} ./\\n' > "$DIEYUN_SRC"
  chmod 0644 "$DIEYUN_SRC" 2>/dev/null || true
  echo "dieyun-headless: 已写入 apt 源 ${base}（下一版起可直接 apt upgrade；现在请跑一次 apt-get update）"
fi
`
    : '';
  return `#!/bin/sh
# 由 dieyun-headless 包生成：建用户/目录、补可执行位、首次生成密钥，均幂等
set -e

if ! getent group dieyun >/dev/null 2>&1; then
  (addgroup --system dieyun >/dev/null 2>&1 || groupadd -r dieyun) || true
fi
if ! getent passwd dieyun >/dev/null 2>&1; then
  (adduser --system --ingroup dieyun --home /var/lib/dieyun-agent --no-create-home --disabled-login dieyun >/dev/null 2>&1 \\
    || useradd -r -g dieyun -d /var/lib/dieyun-agent -s /usr/sbin/nologin dieyun) || true
fi

install -d -o dieyun -g dieyun -m 0750 /var/lib/dieyun-agent 2>/dev/null || install -d -m 0750 /var/lib/dieyun-agent
install -d -o dieyun -g dieyun -m 0755 /srv/agent-workspace 2>/dev/null || install -d -m 0755 /srv/agent-workspace
# /etc/dieyun 必须对 dieyun **组**可通行：headless.env 与 secret.key 都是 root:dieyun 0640，
# 目录若是 root:root 0750，服务用户就连 read(2) 都到不了 —— systemd 以 root 读 EnvironmentFile
# 所以服务照常起，但手工跑 CLI 看不到配置、运行时也读不到 secret.key（真机踩过）。
install -d -o root -g dieyun -m 0750 /etc/dieyun 2>/dev/null || install -d -m 0750 /etc/dieyun
chgrp dieyun /etc/dieyun 2>/dev/null || true
chmod 0750 /etc/dieyun 2>/dev/null || true

# 跨平台打包可能丢可执行位（tar 在 Windows 上不保留 0755）
chmod +x /opt/dieyun-headless/bin/dieyun-headless /usr/bin/dieyun-headless 2>/dev/null || true
chmod +x /opt/dieyun-headless/build/dieyun-core/dieyun-core 2>/dev/null || true
[ -f /opt/dieyun-headless/bin/node ] && chmod +x /opt/dieyun-headless/bin/node 2>/dev/null || true

if [ ! -f /etc/dieyun/headless.env ]; then
  cp /etc/dieyun/headless.env.example /etc/dieyun/headless.env
  chown root:dieyun /etc/dieyun/headless.env 2>/dev/null || true
  chmod 0640 /etc/dieyun/headless.env
fi

# 密钥只在缺失时生成：覆盖掉等于把已有 MCP/SSH/频道凭据全部作废
if [ ! -f /etc/dieyun/secret.key ]; then
  /opt/dieyun-headless/bin/dieyun-headless gen-key --out /etc/dieyun/secret.key >/dev/null 2>&1 || true
  chown root:dieyun /etc/dieyun/secret.key 2>/dev/null || true
  chmod 0640 /etc/dieyun/secret.key 2>/dev/null || true
fi
${aptBlock}
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  # 升级后必须让新版本真正跑起来：apt 只换热文件，老进程会一直跑旧代码。
  # 「try-restart」只在服务已运行时重启 —— 首次安装不会擅自拉起（起不起由管理员决定）。
  systemctl try-restart dieyun-headless.service >/dev/null 2>&1 || true
fi
exit 0
`;
}

/**
 * 包内要写的内网 apt 源地址：`DIEYUN_APT_BASE` 显式给，否则取
 * `deploy.json` 的 `updates.primaryUrl` + `apt/dieyun/pool/`（与普通消费版同一个站点）。
 *
 * 末尾的 `pool/` 不是随意加的：`scripts/publish-headless-apt.cjs` 把 deb 与
 * `Packages` / `Packages.gz` / `Release` 都放在 `<out>/pool/` 里（flat 仓库的根就是它），
 * 索引里的 `Filename:` 也是裸文件名 —— 所以源地址必须指到 `pool/`。
 * 两者都没有就返回空串 —— 那台机器装完只会有「没配源」的如实提示，不会被写进一个假地址。
 */
function resolveAptBase() {
  const explicit = String(process.env.DIEYUN_APT_BASE || '').trim();
  let base = explicit;
  if (!base) {
    try {
      const { getDeployConfig } = require('../src/deploy-config');
      const primary = String((getDeployConfig().updates || {}).primaryUrl || '').trim();
      if (primary) base = `${primary.replace(/\/+$/, '')}/apt/dieyun/pool/`;
    } catch {
      // 读不到部署配置就当没有源，不编一个
    }
  }
  if (!base) return '';
  return base.endsWith('/') ? base : `${base}/`;
}

const DEB_PRERM = `#!/bin/sh
# 只在「卸载」时停服务。**升级不停也不 disable**：apt upgrade 会先跑 prerm upgrade，
# 若在这里 disable，unattended-upgrade 之后服务再也不会随开机启动（升级完像被悄悄关掉了）。
set -e
case "\${1:-}" in
  remove|deconfigure)
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
      systemctl stop dieyun-headless.service >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
`;

const DEB_POSTRM = `#!/bin/sh
# 只重载 unit，**不删数据**：/var/lib/dieyun-agent 与 /etc/dieyun 属于用户资产
set -e
case "\${1:-}" in
  purge)
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
      systemctl disable dieyun-headless.service >/dev/null 2>&1 || true
    fi
    ;;
esac
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
exit 0
`;

function dirSizeBytes(dir) {
  let total = 0;
  const walk = (abs) => {
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

function buildControlText({ version, installedKb, libcMin }) {
  const depends = libcMin ? `libc6 (>= ${libcMin})` : 'libc6';
  return [
    `Package: ${DEB_PKG}`,
    `Version: ${version}`,
    'Architecture: amd64',
    'Maintainer: dieyun <dev@dieyun.local>',
    `Installed-Size: ${installedKb}`,
    `Depends: ${depends}`,
    'Section: utils',
    'Priority: optional',
    'Homepage: https://dieyun.local',
    'Description: dieyun agent, headless runtime (terminal / one-shot run / web UI)',
    ' Same agent as the desktop app, without Electron: run it in a terminal,',
    ' as a one-shot command for cron/CI, or as a local web UI on 127.0.0.1.',
    ' .',
    ' Ships its own Node runtime, dieyun-core and the prebundled MCP',
    ' servers, so the target host only needs libc6. No Chromium, no X11,',
    ' no keyring: credentials are encrypted with a local key file.'
  ].join('\n') + '\n';
}

// ar 容器的读写只有一份实现：`scripts/lib/deb-archive.cjs`（发布 apt 索引时也用它读 control，
// 避免「打包按一种理解、发布按另一种理解」）。这里只保留打包侧的调用。
const { writeAr, readArMembers } = require('./lib/deb-archive.cjs');


function verifyDeb(debPath) {
  const problems = [];
  const members = readArMembers(debPath);
  const names = members.map((m) => m.name);
  if (names[0] !== 'debian-binary') problems.push(`第一个成员应是 debian-binary，实际 ${names[0] || '（无）'}`);
  if (!names.includes('control.tar.gz')) problems.push('缺少 control.tar.gz');
  if (!names.includes('data.tar.gz')) problems.push('缺少 data.tar.gz');
  const bin = members.find((m) => m.name === 'debian-binary');
  if (bin && bin.data.toString('ascii').trim() !== '2.0') problems.push('debian-binary 内容应为 2.0');
  if (problems.length) return { ok: false, problems };

  const tmp = path.join(DEB_WORK, '_verify');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const unpack = (member, dirName) => {
    const file = path.join(tmp, `${dirName}.tar.gz`);
    fs.writeFileSync(file, member.data);
    const dir = path.join(tmp, dirName);
    fs.mkdirSync(dir, { recursive: true });
    execSync(`tar -xzf ${JSON.stringify(file)} -C ${JSON.stringify(dir)}`, { stdio: 'inherit' });
    return dir;
  };
  const controlDir = unpack(members.find((m) => m.name === 'control.tar.gz'), 'control');
  const dataDir = unpack(members.find((m) => m.name === 'data.tar.gz'), 'data');

  const controlText = fs.readFileSync(path.join(controlDir, 'control'), 'utf8');
  for (const field of ['Package:', 'Version:', 'Architecture:', 'Depends:', 'Description:']) {
    if (!controlText.includes(field)) problems.push(`control 缺少字段 ${field}`);
  }
  if (!/Architecture:\s*amd64/.test(controlText)) problems.push('Architecture 不是 amd64');
  for (const script of ['postinst', 'prerm', 'postrm']) {
    if (!fs.existsSync(path.join(controlDir, script))) problems.push(`control 缺少 ${script}`);
  }
  const debRequired = [
    'opt/dieyun-headless/package.json',
    'opt/dieyun-headless/manifest.json',
    `opt/dieyun-headless/${ENTRY_REL}`,
    `opt/dieyun-headless/${CORE_REL}`,
    'opt/dieyun-headless/bin/dieyun-headless',
    'usr/bin/dieyun-headless',
    'lib/systemd/system/dieyun-headless.service',
    'etc/dieyun/headless.env.example'
  ];
  for (const rel of debRequired) {
    if (!fs.existsSync(path.join(dataDir, rel))) problems.push(`data 缺少 /${rel}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // 有 dpkg-deb 时再按发行版的真实解析器验一遍（Windows 打包机上没有，跳过）。
  // 「有没有装 dpkg-deb」与「这个 deb 能不能被解析」必须分开判：合成一个 try 会把
  // 校验失败也当成「本机没装」，坏包照样发布。
  let dpkgChecked = false;
  let hasDpkg = true;
  try {
    execSync('dpkg-deb --version', { stdio: 'ignore' });
  } catch {
    hasDpkg = false;
  }
  if (hasDpkg) {
    for (const args of [['-I'], ['-c']]) {
      try {
        execSync(`dpkg-deb ${args[0]} ${JSON.stringify(debPath)}`, { stdio: 'ignore' });
      } catch (err) {
        const detail = String((err && (err.stderr || err.message)) || err)
          .trim()
          .split('\n')
          .slice(-3)
          .join(' ');
        problems.push(`dpkg-deb ${args[0]} 解析失败：${detail}`);
      }
    }
    dpkgChecked = problems.length === 0 || problems.every((p) => !p.startsWith('dpkg-deb'));
  }
  return { ok: problems.length === 0, problems, dpkgChecked, members: names };
}

async function buildDeb({ manifest }) {
  const version = appPkg.version;
  const libcMin = String(manifest.glibcFloor || '').replace(/^GLIBC_/, '');

  await fsp.rm(DEB_WORK, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(DEB_PAYLOAD), { recursive: true });
  await fsp.cp(STAGE, DEB_PAYLOAD, { recursive: true });

  const writeFile = async (rel, content, mode = 0o644) => {
    const abs = path.join(DEB_ROOTFS, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    try {
      fs.chmodSync(abs, mode);
    } catch {
      // Windows：靠 postinst 的 chmod 兜住
    }
  };
  await writeFile('usr/bin/dieyun-headless', DEB_USR_BIN, 0o755);
  await writeFile('etc/dieyun/headless.env.example', DEB_ENV_EXAMPLE);
  await writeFile('usr/share/doc/dieyun-headless/HEADLESS.md', fs.readFileSync(path.join(ROOT, 'docs', 'HEADLESS.md'), 'utf8'));
  // systemd 单元与仓库里那份是同一个文件（不复制一份改过的）
  const unitSrc = path.join(ROOT, 'deploy', 'systemd', 'dieyun-headless.service');
  if (!fs.existsSync(unitSrc)) throw new Error('缺少 deploy/systemd/dieyun-headless.service');
  await writeFile('lib/systemd/system/dieyun-headless.service', fs.readFileSync(unitSrc, 'utf8'));

  const installedKb = Math.round(dirSizeBytes(DEB_PAYLOAD) / 1024);
  await fsp.mkdir(DEB_CONTROL, { recursive: true });
  const control = buildControlText({ version, installedKb, libcMin });
  await fsp.writeFile(path.join(DEB_CONTROL, 'control'), control, 'utf8');
  // 源地址在打包这一刻定下来：`DIEYUN_APT_BASE` > deploy.json 的 updates.primaryUrl + apt/dieyun/
  const aptBase = resolveAptBase();
  const postinstBody = buildDebPostinst(aptBase);
  console.log(
    aptBase
      ? `[headless-pack] 包内 apt 源：${aptBase}（装完即可 apt upgrade；文件已存在则不动）`
      : '[headless-pack] 包内不写 apt 源（没有 DIEYUN_APT_BASE / deploy.json updates.primaryUrl）'
  );
  for (const [name, body] of [
    ['postinst', postinstBody],
    ['prerm', DEB_PRERM],
    ['postrm', DEB_POSTRM]
  ]) {
    const p = path.join(DEB_CONTROL, name);
    await fsp.writeFile(p, body, 'utf8');
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // 同上
    }
  }

  // 两个 tar 用同一份 tar 写入器（权限位/时间戳可控），容器由本脚本拼
  const dataTar = path.join(DEB_WORK, 'data.tar.gz');
  const controlTar = path.join(DEB_WORK, 'control.tar.gz');
  writeTarGz({ root: DEB_ROOTFS, outFile: dataTar, modeFor: rootfsMode, skip: skipPackaging });
  writeTarGz({ root: DEB_CONTROL, outFile: controlTar, modeFor: controlMode });

  const debPath = path.join(DIST, `${DEB_PKG}_${version}_amd64.deb`);
  await fsp.rm(debPath, { force: true });
  writeAr(debPath, [
    { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') },
    { name: 'control.tar.gz', data: fs.readFileSync(controlTar) },
    { name: 'data.tar.gz', data: fs.readFileSync(dataTar) }
  ]);

  const check = verifyDeb(debPath);
  if (!check.ok) throw new Error(`deb 结构自检失败：\n  ${check.problems.join('\n  ')}`);
  return { debPath, installedKb, members: check.members, dpkgChecked: check.dpkgChecked, control };
}

// ---------------------------------------------------------------- 各部分

const WRAPPER = `#!/bin/sh
# dieyun-headless 启动器：优先用包内 node，其次系统 node（>= 20）
set -e
# deb 安装的机器上有 /etc/dieyun/headless.env：手工跑 CLI 也要和服务看到同一份配置
# （否则 \`dieyun-headless run …\` 会悄悄用 ~/.config/dieyunagent，报「未配置 API Key」，
#  还在另一个目录里另建一套账本 —— 真机踩过）。只补未设置的变量，显式 env 仍然优先。
if [ -r /etc/dieyun/headless.env ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in ''|\\#*) continue ;; esac
    case "$_line" in *=*) ;; *) continue ;; esac
    _k=\${_line%%=*}; _v=\${_line#*=}
    case "$_k" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    eval "_cur=\\\${$_k:-}"
    [ -n "$_cur" ] || export "$_k=$_v"
  done < /etc/dieyun/headless.env
  unset _line _k _v _cur
fi
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")
NODE_BIN="$DIR/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ]; then
  echo "dieyun-headless: 找不到 node（本包未内置，请安装 Node 20+ 或用带 bin/node 的包）" >&2
  exit 3
fi
exec "$NODE_BIN" "$ROOT/${ENTRY_REL}" "$@"
`;

/**
 * 渲染层 `index.html` 里用 `<script src="../../node_modules/...">` 引入的浏览器包
 * （mermaid / mammoth / xlsx）：只被浏览器加载、从不 `require`，因此不在 Node 依赖闭包里，
 * npm 安装完会被裁掉。按 index.html 现扒一遍带进 `web-vendor/`，不另立一份清单。
 */
function vendorWebScripts() {
  const indexHtml = path.join(ROOT, 'src', 'renderer', 'index.html');
  const html = fs.readFileSync(indexHtml, 'utf8');
  const rels = [...html.matchAll(/<script[^>]+src="\.\.\/\.\.\/(node_modules\/[^"]+)"/g)].map((m) => m[1]);
  const out = [];
  for (const rel of rels) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) throw new Error(`桌面界面需要的浏览器包缺失：${rel}（先 npm ci）`);
    const to = path.join(STAGE, 'web-vendor', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    out.push(`${rel}（${Math.round(fs.statSync(to).size / 1024)} KB）`);
  }
  return out;
}

async function stageSources({ includeMcp }) {
  // 源码每次整份重铺（代码变了必须进包）；node_modules 保留以便增量 install
  for (const rel of ['src', 'assets', 'bin', 'build', 'web-vendor']) {
    await fsp.rm(path.join(STAGE, rel), { recursive: true, force: true });
  }
  const srcFiles = copyTree(path.join(ROOT, 'src'), path.join(STAGE, 'src'));
  const assetFiles = copyTree(path.join(ROOT, 'assets'), path.join(STAGE, 'assets'));

  // dieyun-core：放到 core-bridge-path 的既有探测位置
  if (!fs.existsSync(CORE_SRC)) {
    throw new Error(
      `缺少 Linux dieyun-core：${path.relative(ROOT, CORE_SRC)}\n  先运行：npm run pack:dieyun-core:linux`
    );
  }
  const coreDest = path.join(STAGE, CORE_REL);
  await fsp.mkdir(path.dirname(coreDest), { recursive: true });
  await fsp.copyFile(CORE_SRC, coreDest);
  try {
    fs.chmodSync(coreDest, 0o755);
  } catch {
    // Windows 上 chmod 语义有限，靠安装时的 chmod / ExecStartPre 兜住
  }

  let mcpFiles = 0;
  const mcpSrc = path.join(ROOT, MCP_BUNDLE_REL);
  if (includeMcp && fs.existsSync(mcpSrc)) {
    mcpFiles = copyTree(mcpSrc, path.join(STAGE, MCP_BUNDLE_REL));
  }

  return { srcFiles, assetFiles, mcpFiles };
}

async function stagePackageJson(deps) {
  const pkg = {
    name: 'dieyun-headless',
    private: true,
    version: appPkg.version,
    description: '叠云 Agent 无界面运行包（终端 / 一次性命令 / 浏览器 Web）',
    main: ENTRY_REL,
    engines: { node: '>=20' },
    dependencies: deps
  };
  const text = `${JSON.stringify(pkg, null, 2)}\n`;
  const pkgPath = path.join(STAGE, 'package.json');
  const prev = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
  await fsp.writeFile(pkgPath, text, 'utf8');
  return prev !== text;
}

/**
 * 安装参数的唯一来源。两个关键项：
 * - `--omit=optional`：`ssh2` 的可选依赖 `cpu-features` 是原生扩展（win32 上就是 win32 二进制）；
 * - `--ignore-scripts`：`ssh2` 的安装脚本会编译原生 `sshcrypto.node`，同样不能进 Linux 包。
 * 这两条缺一个，产物里就会混进本机（构建机）的原生二进制 —— 后面的 `.node` 闸门会拦住。
 */
const INSTALL_ARGS = [
  'install',
  '--omit=dev',
  '--omit=optional',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund'
];

async function installDeps({ offline, changed }) {
  const lock = path.join(STAGE, 'node_modules', '.package-lock.json');
  const flagsPath = path.join(STAGE, 'node_modules', '.dieyun-install-flags.json');
  const flagsSig = JSON.stringify(INSTALL_ARGS);
  const prevFlags = fs.existsSync(flagsPath) ? fs.readFileSync(flagsPath, 'utf8') : '';
  if (!changed && prevFlags === flagsSig && fs.existsSync(lock)) {
    console.log('[headless-pack] 依赖清单未变，跳过 npm install');
    return;
  }
  // 清单或参数变了就整份重装：避免已剔除的依赖以「残留 node_modules」形式混进产物
  await fsp.rm(path.join(STAGE, 'node_modules'), { recursive: true, force: true });
  const args = [...INSTALL_ARGS];
  if (offline) args.push('--offline');
  console.log(`[headless-pack] npm ${args.join(' ')}`);
  execSync(`npm ${args.join(' ')}`, { cwd: STAGE, stdio: 'inherit' });
  await fsp.writeFile(flagsPath, flagsSig, 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '*/');
    console.log(lines.slice(0, end + 1).join('\n'));
    return;
  }
  if (opts.verifyOnly) {
    // 校验模式下 `--deb` 表示「校验 deb 产物」（打包模式下表示「顺便产出 deb」）
    const target = resolveVerifyTarget(path.resolve(opts.verifyOnly), opts.deb);
    if (/\.deb$/i.test(target)) {
      const res = verifyDeb(target);
      if (!res.ok) {
        console.error(`[headless-pack] deb 不完整：\n  ${res.problems.join('\n  ')}`);
        process.exit(1);
      }
      console.log(
        `[headless-pack] deb 校验通过：${target}（成员 ${res.members.join(' / ')}）` +
          (res.dpkgChecked ? '（含 dpkg-deb 交叉校验）' : '')
      );
      return;
    }
    const isTgz = /\.(tgz|tar\.gz)$/i.test(target);
    const res = isTgz ? verifyTarball(target) : verifyLayout(target);
    if (!res.ok) {
      console.error(`[headless-pack] 产物不完整，缺：\n  ${res.missing.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`[headless-pack] 校验通过：${target}${res.count ? `（${res.count} 个条目）` : ''}`);
    return;
  }

  await fsp.mkdir(STAGE, { recursive: true });
  await fsp.mkdir(DIST, { recursive: true });

  // 1) 依赖清单（从入口推）
  const { scan, deps, skipped, unknown } = resolveDependencies(path.join(ROOT, ENTRY_REL));
  console.log(
    `[headless-pack] 运行时 require 图：${scan.files.size} 个文件；依赖：${Object.keys(deps).join(', ')}`
  );
  if (skipped.length) {
    for (const name of skipped) console.log(`[headless-pack] 跳过 ${name}：${EXCLUDED_DEPS.get(name)}`);
  }
  if (unknown.length) {
    console.log(
      `[headless-pack] 注意：以下裸名既不在 dependencies 也不在允许表里（多半是可选/驼峰误报）：${unknown.join(', ')}`
    );
  }
  if (scan.dynamic.length) {
    console.log(
      `[headless-pack] 注意：${scan.dynamic.length} 个文件里有非字面量 require（静态扫不到）：` +
        scan.dynamic.slice(0, 5).join(', ')
    );
  }
  for (const must of ['ws', '@modelcontextprotocol/sdk']) {
    if (!deps[must]) throw new Error(`依赖闭包里缺少 ${must}：入口图可能被改坏了`);
  }

  // 2) 代码 / 资源 / core / MCP
  const staged = await stageSources({ includeMcp: opts.mcp });
  console.log(
    `[headless-pack] 源码 ${staged.srcFiles} 个文件、assets ${staged.assetFiles} 个、` +
      `MCP ${staged.mcpFiles || '未带'}`
  );

  // 3) node 运行时
  let nodeVersion = '';
  if (opts.node) {
    const r = await ensureBundledNodeLinux({
      outDir: STAGE,
      version: resolveNodeVersion(),
      platform: PLATFORM,
      cacheDir: CACHE_DIR,
      log: (m) => console.log(m)
    });
    nodeVersion = r.version;
  } else {
    console.log('[headless-pack] --no-node：目标机需自备 node ≥ 20');
  }

  // 4) 依赖安装 + 原生二进制闸门
  const changed = await stagePackageJson(deps);
  await installDeps({ offline: opts.offline, changed });
  const natives = findNativeBinaries(path.join(STAGE, 'node_modules'));
  if (natives.length) {
    throw new Error(
      `产物的 node_modules 里有原生二进制（说明把桌面依赖带进来了）：\n  ${natives.join(
        '\n  '
      )}\n请把对应包加进 EXCLUDED_DEPS 或改成纯 JS 依赖`
    );
  }

  // 4b) 桌面界面在浏览器里跑时，渲染层的 <script> 需要几个浏览器包（不走 require，
  //     因此不在 Node 依赖闭包里、会被 npm 裁剪掉）。这里原样带进 web-vendor/。
  const vendored = vendorWebScripts();
  if (vendored.length) console.log(`[headless-pack] 浏览器端脚本：${vendored.join('、')}`);

  // 5) 启动器 / 文档 / manifest
  const wrapperPath = path.join(STAGE, 'bin', 'dieyun-headless');
  await fsp.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fsp.writeFile(wrapperPath, WRAPPER, 'utf8');
  try {
    fs.chmodSync(wrapperPath, 0o755);
  } catch {
    // 同上：靠安装时 chmod
  }

  const docSrc = path.join(ROOT, 'docs', 'HEADLESS.md');
  if (!fs.existsSync(docSrc)) throw new Error('缺少 docs/HEADLESS.md（安装说明要随包分发）');
  await fsp.copyFile(docSrc, path.join(STAGE, 'HEADLESS.md'));

  // 6) glibc 地板：core 不能比 node 还新，否则「node 起得来、core 起不来」
  let glibcFloor = '';
  const coreCheck = glibcRequirementOf(path.join(STAGE, CORE_REL));
  const nodeCheck = opts.node ? glibcRequirementOf(path.join(STAGE, 'bin', 'node')) : { maxGlibc: '' };
  if (coreCheck.maxGlibc && nodeCheck.maxGlibc) {
    glibcFloor =
      compareNeed(coreCheck.maxGlibc, nodeCheck.maxGlibc) >= 0 ? coreCheck.maxGlibc : nodeCheck.maxGlibc;
    if (compareNeed(coreCheck.maxGlibc, nodeCheck.maxGlibc) > 0) {
      throw new Error(
        `dieyun-core 需要 GLIBC ${coreCheck.maxGlibc}，比同包 node（${nodeCheck.maxGlibc}）还新。` +
          `请用 npm run pack:dieyun-core:linux 重建（zig 目标 ${CORE_GLIBC_TARGET}）`
      );
    }
  } else {
    glibcFloor = coreCheck.maxGlibc || nodeCheck.maxGlibc || '';
  }
  console.log(
    `[headless-pack] GLIBC 地板：core ${coreCheck.maxGlibc || '—'} / node ${
      nodeCheck.maxGlibc || '—'
    } → 生效 ${glibcFloor || '未知'}`
  );

  const manifest = {
    version: appPkg.version,
    platform: PLATFORM,
    entry: ENTRY_REL,
    runtime: opts.node ? 'bin/node' : 'system-node',
    nodeVersion: nodeVersion || null,
    core: CORE_REL,
    mcpBundled: opts.mcp && staged.mcpFiles > 0,
    glibcFloor: glibcFloor || null,
    dependencies: deps,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(
    path.join(STAGE, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  // 7) 布局自检 → 冷启动闸门 → 打包 → 包内清单自检
  const layout = verifyLayout(STAGE);
  if (!layout.ok) throw new Error(`产物目录不完整，缺：${layout.missing.join(', ')}`);
  verifyColdStart();
  console.log('[headless-pack] 冷启动闸门通过（干净目录 + 仅包内依赖，入口可加载）');

  const tgz = path.join(DIST, `dieyun-headless-${appPkg.version}-${PLATFORM}.tgz`);
  await fsp.rm(tgz, { force: true });
  writeTarGz({ root: STAGE, outFile: tgz, modeFor: payloadMode, skip: skipPackaging });
  const packCheck = verifyTarball(tgz);
  if (!packCheck.ok) {
    throw new Error(`tarball 清单不完整，缺：${packCheck.missing.join(', ')}`);
  }
  const sizeMb = (fs.statSync(tgz).size / 1024 / 1024).toFixed(1);
  console.log(`[headless-pack] 完成：${path.relative(ROOT, tgz)}（${sizeMb} MB，${packCheck.count} 个条目）`);

  // 8) 可选：Debian 包（同一份 payload 的另一个外壳）
  if (opts.deb) {
    const deb = await buildDeb({ manifest });
    const debMb = (fs.statSync(deb.debPath).size / 1024 / 1024).toFixed(1);
    console.log(
      `[headless-pack] deb：${path.relative(ROOT, deb.debPath)}（${debMb} MB，Installed-Size ${deb.installedKb} KB，` +
        `成员 ${deb.members.join(' / ')}）`
    );
    console.log(
      `[headless-pack] deb 结构自检通过${deb.dpkgChecked ? '（含 dpkg-deb -I/-c 交叉校验）' : '（本机无 dpkg-deb，仅 ar/tar 自检）'}`
    );
    console.log(
      `[headless-pack] 目标机：sudo apt install ./${path.basename(deb.debPath)}` +
        ` → 编辑 /etc/dieyun/headless.env → sudo systemctl enable --now dieyun-headless`
    );
  }
  console.log('[headless-pack] 目标机安装：见包内 HEADLESS.md');
}

// 导出 control 脚本模板：包装机的 `dpkg-deb` 缺失时，单测是这些「升级/卸载语义」的唯一闸门
module.exports = { DEB_POSTINST, buildDebPostinst, resolveAptBase, DEB_PRERM, DEB_POSTRM, buildControlText };

if (require.main === module) {
  main().catch((err) => {
    console.error(`[headless-pack] 失败：${(err && err.stack) || err}`);
    process.exit(1);
  });
}
