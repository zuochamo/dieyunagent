'use strict';

/**
 * 远程 Agent 部署包的「布局 + 完整性」单一来源。
 *
 * 同一条链路上有 4 个环节，过去各自维护一份清单，导致「本地打包看起来成功、
 * 远程注入却报安装包不完整」这类无法定位的故障：
 *   1. 打包         scripts/pack-remote-gateway.cjs
 *   2. 拷贝进安装包  package.json extraResources（electron-builder 会剔除根 node_modules）
 *   3. 部署包装配    src/optional-assets/service.js（lite 包 + 按需下载的 Linux Node）
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
  'src/remote/linux-elf-compat.js',
  'src/remote/workspace-index-path.js',
  'src/core-bridge.js',
  'src/core-rpc-timeouts.js',
  'src/gateway/path-policy.js',
  'src/gateway/host-control.js',
  'src/gateway/fs-read-limits.js',
  // fs_edit 结果的 added/removed 统计（LCS 口径），host 与 local 网关共用同一份
  'src/gateway/line-diff-stats.js',
  'src/gateway/fs-edit-file.js',
  'src/gateway/str-replace.js',
  'src/gateway/rg-search.js',
  // rg-search 依赖 git-target 做二进制探测，缺失会导致远程模块加载失败
  'src/git/git-target.js',
  // navigate-service 的「行内标识符纠正」复用网关侧同一套符号文本工具
  'src/gateway/symbol-text.js',
  // 远程 LSP 定位：只依赖 Node 内置模块，server 由远程环境提供
  // （rust-analyzer / gopls 走 PATH，ts/py 走远程工作区 node_modules）。
  'src/lsp/language-registry.js',
  // lsp-client 起 server 时的 cmd 命令行拼装（唯一来源）；漏打包会让远程
  // 注入 smoke 直接 `Cannot find module './spawn-args'`，整条远程 LSP 不可用。
  'src/lsp/spawn-args.js',
  'src/lsp/lsp-client.js',
  'src/lsp/navigate-service.js'
];

/** 内置 Linux Node 运行时。lite 包省略，由 optional-assets 注入前按需补全。 */
const REMOTE_PACK_NODE_REL = 'bin/node';

/** Linux dieyun-core。缺失只影响远程项目内索引，不阻塞 Agent 启动。 */
const REMOTE_PACK_CORE_REL = 'bin/dieyun-core';

/** pack 内由打包脚本生成的元数据文件。 */
const REMOTE_PACK_GENERATED_FILES = ['package.json', 'manifest.json'];

/** npm install 产出的运行时依赖（必须落在 pack 根的 node_modules/ 下）。 */
const REMOTE_PACK_RUNTIME_DEP_FILES = ['node_modules/ws/package.json'];

/** 远程 Agent 启动并加载模块所必需的全部文件（不含 bin/node）。 */
const REMOTE_PACK_REQUIRED_FILES = [
  ...REMOTE_GATEWAY_SOURCE_PATHS.map((rel) => rel.replace(/^src\//, '')),
  ...REMOTE_PACK_GENERATED_FILES,
  ...REMOTE_PACK_RUNTIME_DEP_FILES
];

/** 可直接注入远程的部署包：必需文件之外还必须有内置 Node。 */
const REMOTE_DEPLOY_REQUIRED_FILES = [...REMOTE_PACK_REQUIRED_FILES, REMOTE_PACK_NODE_REL];

/** 远程 preflight 成功标记：必须整行匹配，避免把诊断输出误判为成功。 */
const REMOTE_PACK_OK_MARKER = 'PACK_OK';

/**
 * 解析远程 `MISSING= a b c` 行。
 * 只认整行 MISSING=，缺项之间以空白分隔。
 */
function parseRemotePackMissing(stdout) {
  const m = String(stdout || '').match(/^MISSING=(.*)$/m);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * 解析远程 pack 状态脚本输出（版本 / Node 大小 / 源码 hash / 缺项）。
 * 这里刻意按行锚定：裸 `VERSION=` 之类的诊断文本不能被当成有效值。
 */
function parseRemotePackState(stdout) {
  const out = String(stdout || '');
  const pick = (re) => {
    const m = out.match(re);
    return m ? String(m[1]).trim() : '';
  };
  const size = Number(pick(/^SIZE=(\d+)$/m));
  return {
    version: pick(/^VERSION=(.*)$/m),
    size: Number.isFinite(size) ? size : 0,
    hash: pick(/^HASH=(.*)$/m),
    missing: parseRemotePackMissing(out)
  };
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
 * @param {{ deploy?: boolean, rels?: string[], fsApi?: typeof fs }} [opts]
 * @returns {{ ok: boolean, missing: string[], detail: string, required: string[] }}
 */
function inspectRemotePack(packRoot, opts = {}) {
  const required =
    Array.isArray(opts.rels) && opts.rels.length
      ? opts.rels
      : opts.deploy
        ? REMOTE_DEPLOY_REQUIRED_FILES
        : REMOTE_PACK_REQUIRED_FILES;
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
  REMOTE_PACK_REQUIRED_FILES,
  REMOTE_DEPLOY_REQUIRED_FILES,
  inspectRemotePack,
  parseRemotePackMissing,
  parseRemotePackState,
  evaluateRemotePackPreflight,
  computeRemoteGatewaySourceHash
};
