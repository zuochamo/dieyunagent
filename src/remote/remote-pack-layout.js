'use strict';

/**
 * 远程 Agent 部署包的「布局 + 完整性」单一来源。
 *
 * 同一条链路上有 4 个环节，过去各自维护一份清单，导致「本地打包看起来成功、
 * 远程注入却报安装包不完整」这类无法定位的故障：
 *   1. 打包         scripts/pack-remote-gateway.cjs
 *   2. 拷贝进安装包  package.json extraResources（electron-builder 会剔除根 node_modules）
 *   3. 装配闸门    assertRemotePackReady（本文件）—— 安装包里的 pack 就是最终内容
 *   4. 远程注入校验  src/ssh/remote-gateway-manager.js
 * 清单与校验函数集中在本文件，任一环节的不完整都能报出具体缺项。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 打包进远程包的源码（相对仓库根）。pack 内相对路径 = 去掉 `src/` 前缀。 */
const REMOTE_GATEWAY_SOURCE_PATHS = [
  'src/remote/run-cli.js',
  'src/remote/minimal-gateway-host.js',
  'src/remote/remote-index-core.js',
  'src/remote/workspace-index-path.js',
  // 远端索引根的单一解析处：漏打包 = daemon 侧 `require('./index-root')` 直接崩，
  // 索引 RPC 全不可用（且 hash 不含它时还会判定「已存在、跳过上传」，修也修不掉）。
  'src/remote/index-root.js',
  // index-root 用它解析 ssh URI / 归一 POSIX 根（远端只认这一份口径）
  'src/workspace/target.js',
  // 等待超时的唯一实现：host-control / lsp-client / navigate-service 都在打包闭包里，
  // 漏了它远端会在加载期 `Cannot find module '../timeout'`（同 2026-10-18 spawn-args 事故形态）。
  'src/timeout.js',
  'src/core-bridge.js',
  'src/core-rpc-timeouts.js',
  'src/gateway/path-policy.js',
  // host-control（runShell）依赖它判定「命令何时算结束」，漏打包会让远程 Agent 起不来
  'src/exec-settlement.js',
  // exec 的超时上限 / 输出上限唯一来源：本机 runShell 与远端 exec 共用同一份契约
  'src/exec-limits.js',
  'src/gateway/host-control.js',
  'src/gateway/fs-read-limits.js',
  // artifact.list_files 的目录遍历与排除表（远程 Agent 与本地/SFTP 网关共用同一份）
  'src/gateway/artifact-scan.js',
  // fs_edit 结果的 added/removed 统计（LCS 口径），host 与 local 网关共用同一份
  'src/gateway/line-diff-stats.js',
  'src/gateway/fs-edit-file.js',
  'src/gateway/str-replace.js',
  'src/gateway/rg-search.js',
  // rg-search 依赖 git-target 做二进制探测，缺失会导致远程模块加载失败
  'src/git/git-target.js',
  // navigate-service 的「行内标识符纠正」复用网关侧同一套符号文本工具
  'src/gateway/symbol-text.js',
  // 远程宿主判断「哪些文件要触发结构索引增量」：与本地调度器共用同一份口径
  'src/index/source-files.js',
  // 远程 LSP 定位：只依赖 Node 内置模块，server 由远程环境提供
  // （rust-analyzer / gopls 走 PATH，ts/py 走远程工作区 node_modules）。
  'src/lsp/language-registry.js',
  // lsp-client 起 server 时的 cmd 命令行拼装（唯一来源）；漏打包会让远程
  // 注入 smoke 直接 `Cannot find module './spawn-args'`，整条远程 LSP 不可用。
  'src/lsp/spawn-args.js',
  'src/lsp/lsp-client.js',
  'src/lsp/navigate-service.js',
  // 跨语言常量：model-runtime-by-tier → shared-constants → assets/agent-shared.json。
  // 漏掉任何一个，远端 daemon 加载期就 `Cannot find module`（同 2026-10-18 spawn-args 事故形态），
  // 而且 hash 是按这份清单算的 —— 漏了它反而会被判「已存在、跳过上传」，修也修不掉。
  'src/agent/shared-constants.js',
  'assets/agent-shared.json'
];

/** 内置 Linux Node 运行时：随安装包一起预装，远程不需要目标机装 Node。 */
const REMOTE_PACK_NODE_REL = 'bin/node';

/** Linux dieyun-core。缺失只影响远程项目内索引，不阻塞 Agent 启动。 */
const REMOTE_PACK_CORE_REL = 'bin/dieyun-core';

/** pack 内由打包脚本生成的元数据文件。 */
const REMOTE_PACK_GENERATED_FILES = ['package.json', 'manifest.json'];

/** npm install 产出的运行时依赖（必须落在 pack 根的 node_modules/ 下）。 */
const REMOTE_PACK_RUNTIME_DEP_FILES = ['node_modules/ws/package.json'];

/** 远程 Agent 启动并加载模块所必需的全部文件（含内置 Node）。 */
const REMOTE_PACK_REQUIRED_FILES = [
  REMOTE_PACK_NODE_REL,
  ...REMOTE_GATEWAY_SOURCE_PATHS.map((rel) => rel.replace(/^src\//, '')),
  ...REMOTE_PACK_GENERATED_FILES,
  ...REMOTE_PACK_RUNTIME_DEP_FILES
];

/** 远程 preflight 成功标记：必须整行匹配，避免把诊断输出误判为成功。 */
const REMOTE_PACK_OK_MARKER = 'PACK_OK';

/**
 * 注入成功标记（远端 `~/.dieyun/remote-agent/<version>/.pack-ok`）。
 * 内容为 `VERSION=…` / `CONTENT_HASH=…` 两行：跳过重传的判定只认这份标记，
 * 取代旧的 `.pack-version` + 文件大小 + manifest hash 三口径拼合。
 */
const REMOTE_PACK_MARKER_REL = '.pack-ok';

/**
 * 解析远程 `MISSING= a b c` 行。
 * 只认整行 MISSING=，缺项之间以空白分隔。
 */
function parseRemotePackMissing(stdout) {
  const m = String(stdout || '').match(/^MISSING=(.*)$/m);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * 解析远端 `.pack-ok` 标记内容（版本 / 内容 hash）。
 * 与其它解析器一样按行锚定，裸文本不能被当成有效值。
 */
function parseRemotePackMarker(stdout) {
  const out = String(stdout || '');
  const ver = out.match(/^VERSION=(.*)$/m);
  const hash = out.match(/^CONTENT_HASH=([0-9a-f]{64})$/m);
  return {
    version: ver ? ver[1].trim() : '',
    contentHash: hash ? hash[1] : ''
  };
}

/** tar 归档内的执行位白名单。 */
const REMOTE_PACK_EXEC_RELS = new Set(['bin/node', 'bin/dieyun-core', 'remote/run-cli.js']);

/**
 * tar 头里的文件 mode：白名单 0755，其余 0644。
 * Windows 侧文件系统不带执行位，注入到 Linux 的执行权限只能在这里声明。
 */
function remotePackTarMode(rel) {
  return REMOTE_PACK_EXEC_RELS.has(rel) ? 0o755 : 0o644;
}

/**
 * 遍历 pack 目录的全部文件（相对路径按字典序稳定排序）。
 * 打 tar（pack-archive）与内容 hash（computePackContentHash）共用这一份遍历，
 * 保证「hash 算过什么」与「tar 里装了什么」永远一致。
 */
async function walkPackFiles(packRoot) {
  const fsp = require('fs/promises');
  const root = String(packRoot || '');
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.tmp-node') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else {
        out.push({ abs: full, rel: path.relative(root, full).replace(/\\/g, '/') });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 内容 hash 的进程内缓存。
 *
 * pack 由打包脚本产出、注入期只读；94MB 逐文件 sha256 要几百毫秒，而每次 ensure
 * （每个会话激活）都要问一次「远端是不是这一份」。命中判据是「文件清单 + 大小 + mtime」
 * 的指纹——只做 50 次 lstat，内容有任何变化指纹必变，不必整包重读。
 */
let packContentHashCache = null;

/** 文件清单的 lstat 指纹：rel + size + mtime，与内容一一对应。 */
async function packStatFingerprint(files) {
  const fsp = require('fs/promises');
  const rows = [];
  for (const f of files) {
    const st = await fsp.stat(f.abs);
    rows.push(`${f.rel}\0${st.size}\0${st.mtimeMs}`);
  }
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

/**
 * 部署包内容 hash：对最终注入目录的全部文件逐个 sha256 后再汇总。
 * 在注入期对最终 pack 目录现场计算（lite 包直用 / 缓存装配目录都统一覆盖），
 * 不落 manifest —— manifest 只在打包期生成，装配进缓存目录的 Node 不经过它。
 */
async function computePackContentHash(packRoot) {
  const files = await walkPackFiles(packRoot);
  const cacheKey = `${String(packRoot)}\0${await packStatFingerprint(files)}`;
  if (packContentHashCache && packContentHashCache.key === cacheKey) return packContentHashCache.hash;
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const fileHash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(f.abs);
      stream.on('data', (c) => fileHash.update(c));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    hash.update(f.rel);
    hash.update('\0');
    hash.update(fileHash.digest('hex'));
    hash.update('\n');
  }
  const hex = hash.digest('hex');
  packContentHashCache = { key: cacheKey, hash: hex };
  return hex;
}

/**
 * 远程 preflight（必需文件是否存在）输出 → 结论。
 * 成功必须同时满足：打印了 PACK_OK 标记，且没有缺项。
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ ok: boolean, missing: string[], detail: string }}
 */
function evaluateRemotePackPreflight(stdout, exitCode) {
  const raw = String(stdout || '');
  const missing = parseRemotePackMissing(raw);
  const signaled = raw.split(/\r?\n/).some((line) => line.trim() === REMOTE_PACK_OK_MARKER);
  const ok = signaled && missing.length === 0;
  if (ok) return { ok: true, missing: [], detail: '' };
  const code = Number(exitCode);
  const detail = [`exit=${Number.isFinite(code) ? code : '?'}`, raw.trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
  return { ok: false, missing, detail };
}

function isFile(fsApi, abs) {
  try {
    const st = fsApi.statSync(abs);
    return typeof st.isFile === 'function' ? st.isFile() : true;
  } catch {
    return false;
  }
}

/**
 * @param {string} packRoot
 * @param {{ rels?: string[], fsApi?: typeof fs }} [opts]
 * @returns {{ ok: boolean, missing: string[], detail: string, required: string[] }}
 */
function inspectRemotePack(packRoot, opts = {}) {
  const required =
    Array.isArray(opts.rels) && opts.rels.length ? opts.rels : REMOTE_PACK_REQUIRED_FILES;
  const fsApi = opts.fsApi || fs;
  const root = String(packRoot || '');
  const missing = root ? required.filter((rel) => !isFile(fsApi, path.join(root, rel))) : required.slice();
  return {
    ok: missing.length === 0,
    missing,
    required,
    detail: missing.length ? `缺少 ${missing.join(', ')}` : '完整'
  };
}

/**
 * 注入前的最后一道本地闸门：部署包必须满足本文件的清单，否则宁可在这里失败，
 * 也不要上传几百 MB 后在远程报「安装包不完整」。
 */
function assertRemotePackReady(packRoot) {
  const check = inspectRemotePack(packRoot);
  if (check.ok) return packRoot;
  // 整个包还没打过（dev 首次启动）：按「未打包」报，让上层走 SFTP 兜底 + 给出打包命令。
  const manifestMissing = check.missing.includes('manifest.json');
  if (manifestMissing) {
    throw Object.assign(
      new Error('远程 Agent 部署包缺失：请先执行 npm run pack:remote-gateway（npm run dev 会自动打包）'),
      { code: 'REMOTE_GATEWAY_PACK_MISSING' }
    );
  }
  const onlyNodeMissing = check.missing.length === 1 && check.missing[0] === REMOTE_PACK_NODE_REL;
  if (onlyNodeMissing) {
    throw Object.assign(
      new Error('远程 Agent 内置 Node 缺失：请重新执行 npm run pack:remote-gateway'),
      { code: 'REMOTE_GATEWAY_PACK_MISSING' }
    );
  }
  throw Object.assign(
    new Error(
      `远程 Agent 部署包不完整：${check.detail}。请重新执行 npm run pack:remote-gateway（安装包用 npm run build 重新打包）`
    ),
    { code: 'REMOTE_GATEWAY_PACK_INCOMPLETE', missing: check.missing }
  );
}

/**
 * 部署包内容 hash：源码清单 + Linux dieyun-core。
 * 远程包内容不止源码清单：Linux dieyun-core 有无/换版都要反映到 hash，
 * 否则补打包核心后注入端会因 hash 不变而跳过重传。
 */
function computeRemoteGatewaySourceHash(rootDir) {
  const root = path.resolve(rootDir || path.join(__dirname, '..', '..'));
  const hash = crypto.createHash('sha256');
  for (const rel of REMOTE_GATEWAY_SOURCE_PATHS) {
    const abs = path.join(root, rel);
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(abs));
    } catch {
      hash.update('__missing__');
    }
    hash.update('\0');
  }
  const linuxCore = path.join(root, 'build', 'dieyun-core-linux', 'dieyun-core');
  hash.update('linux-core\0');
  try {
    const bin = fs.readFileSync(linuxCore);
    hash.update(String(bin.length));
    hash.update('\0');
    hash.update(bin);
  } catch {
    hash.update('missing');
  }
  hash.update('\0');
  return hash.digest('hex').slice(0, 16);
}

module.exports = {
  REMOTE_GATEWAY_SOURCE_PATHS,
  REMOTE_PACK_NODE_REL,
  REMOTE_PACK_CORE_REL,
  REMOTE_PACK_OK_MARKER,
  REMOTE_PACK_MARKER_REL,
  REMOTE_PACK_REQUIRED_FILES,
  inspectRemotePack,
  assertRemotePackReady,
  parseRemotePackMissing,
  parseRemotePackMarker,
  evaluateRemotePackPreflight,
  remotePackTarMode,
  walkPackFiles,
  computePackContentHash,
  computeRemoteGatewaySourceHash
};
