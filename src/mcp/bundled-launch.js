'use strict';

const fs = require('fs');
const path = require('path');
const { getMcpNpmPackageMeta, runtimeArgsWithoutNpxPackage } = require('./package-store');

/**
 * 预装（bundled）MCP 的启动解析 —— 一律从 app 资源里取，绝不联网。
 *
 * 两种预装形态，共用本文件：
 * 1. **纯 JS 服务**（`resources/…/src/mcp/servers/<key>/server.js`）：仓库自带代码，随 app.asar 分发。
 * 2. **离线预装的外部服务**（`<resources>/mcp/bundled/<key>/manifest.json`）：npm 包 + 平台二进制，
 *    由 `scripts/pack-mcp-bundled.cjs` 在构建期取产物、校 sha256 后打进安装包
 *    （package.json build.extraResources → mcp/bundled）。manifest 是布局的唯一声明，
 *    本文件不假设目录结构，只按 manifest 声明的 entry/binary 校验。
 *
 * 第二种形态的存在理由：这类包默认在**首次使用**时才 npm install + 从 GitHub Releases
 * 下载平台二进制；内网（以及 Node fetch 不认企业 TLS 代理的环境）两条路都不通，
 * 表现为「MCP 已启用但永远连不上」。
 */

const MANIFEST_FILE = 'manifest.json';

/** 预装 MCP 根目录候选：打包态 <resources>/mcp/bundled，开发态 <repo>/build/mcp-bundled */
function bundledRootCandidates() {
  const roots = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'mcp', 'bundled'));
    roots.push(path.join(process.resourcesPath, 'app.asar', 'mcp', 'bundled'));
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      roots.push(path.join(app.getAppPath(), 'build', 'mcp-bundled'));
    }
  } catch {
    // 非 Electron 环境
  }
  roots.push(path.join(__dirname, '..', '..', 'build', 'mcp-bundled'));
  return roots;
}

function readManifest(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** manifest 里的相对路径 → 绝对路径；越界（../）返回空串，不允许被当成合法入口 */
function resolveInside(dir, rel) {
  const text = String(rel || '').trim();
  if (!text) return '';
  const abs = path.resolve(dir, text);
  return abs.startsWith(path.resolve(dir) + path.sep) ? abs : '';
}

function bundledMissing(message) {
  const err = new Error(message);
  err.code = 'BUNDLED_MCP_MISSING';
  return err;
}

/**
 * 纯 JS 预装服务的既有位置约定（形态 1）。
 * @param {string} key
 * @returns {string[]}
 */
function legacyJsEntryCandidates(key) {
  const rel = path.join('src', 'mcp', 'servers', key, 'server.js');
  const candidates = [];
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(path.join(app.getAppPath(), rel));
      candidates.push(path.join(app.getAppPath(), 'mcp', 'servers', key, 'server.js'));
    }
  } catch {
    // 非 Electron 环境
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', rel));
    candidates.push(path.join(process.resourcesPath, rel));
    candidates.push(path.join(process.resourcesPath, 'mcp', 'bundled', key, 'server.js'));
  }
  candidates.push(path.join(__dirname, 'servers', key, 'server.js'));
  candidates.push(path.resolve(process.cwd(), rel));
  return candidates;
}

/**
 * 解析预装 MCP 入口。
 * @param {string} serverKey registry 里的 bundledServer
 * @param {string[]} [roots] 预装根目录（测试可注入；默认按打包/开发两种布局探测）
 * @returns {{ entry: string, dir: string, manifest: object|null }|null}
 */
function resolveBundledMcpEntry(serverKey, roots) {
  const key = String(serverKey || '').trim();
  if (!key) return null;

  const dirs = Array.isArray(roots) ? roots : bundledRootCandidates();
  for (const root of dirs) {
    const dir = path.join(root, key);
    const manifest = readManifest(dir);
    if (!manifest) continue;

    // 有 manifest 就按它走；此处任何缺失都**失败关闭**（不静默回退到其它候选），
    // 否则「产物过期/漏打包」会退化成运行期才发现的连接失败。
    const entry = resolveInside(dir, manifest.entry);
    if (!entry) throw bundledMissing(`预装 MCP ${key} 的 manifest.entry 非法或越界：${manifest.entry}`);
    if (!fs.existsSync(entry)) throw bundledMissing(`预装 MCP ${key} 缺少启动入口：${entry}`);
    if (manifest.binary) {
      const binary = resolveInside(dir, manifest.binary);
      if (!binary || !fs.existsSync(binary)) {
        throw bundledMissing(
          `预装 MCP ${key} 缺少平台二进制：${manifest.binary}\n` +
            `  该文件应由 npm run pack:mcp-bundled 生成并随安装包分发（${dir}）`
        );
      }
    }
    return { entry, dir, manifest };
  }

  for (const candidate of legacyJsEntryCandidates(key)) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return { entry: path.resolve(candidate), dir: path.dirname(candidate), manifest: null };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 服务自身参数 = 注册表 args 去掉 npx 专用的 `-y` 与包名规格。
 * 与「本地 npm 包启动」共用同一份剥离逻辑（package-store），勿在此另写一遍。
 * @param {object} server
 */
function bundledOwnArgs(server) {
  const args = server && Array.isArray(server.args) ? server.args : [];
  if (!args.length) return [];
  const meta = getMcpNpmPackageMeta(server) || { argIndex: -1, flagIndex: -1 };
  return runtimeArgsWithoutNpxPackage(args, meta);
}

/**
 * 将 registry 中的 bundledServer 解析为可 stdio 启动的 command/args。
 * @param {object} server
 * @param {string[]} [roots] 预装根目录（默认按打包/开发两种布局探测；测试可注入）
 * @returns {object|null} 解析后的 server；非预装则返回 null
 */
function resolveBundledMcpLaunch(server, roots) {
  const key = server && server.bundledServer ? String(server.bundledServer).trim() : '';
  if (!key) return null;
  const resolved = resolveBundledMcpEntry(key, roots);
  if (!resolved) throw bundledMissing(`预装 MCP 入口不存在：${key}`);
  return {
    ...server,
    command: process.execPath,
    // 入口必须在首位（node <entry> …），服务自身参数跟在其后。
    // 例如 mcp-postgres 的 `--stdio` 必须保留：丢掉它，服务会去开 HTTP 监听，
    // 客户端表现为「连上了但一直挂住」（见 registry 里该条目的行为契约注释）。
    args: [resolved.entry, ...bundledOwnArgs(server)],
    launchEnv: {
      ...(server.launchEnv && typeof server.launchEnv === 'object' ? server.launchEnv : {}),
      ELECTRON_RUN_AS_NODE: '1',
      ...(server.openApiService
        ? { DIEYUN_OPEN_API_SERVICE: String(server.openApiService) }
        : {})
    }
  };
}

module.exports = {
  resolveBundledMcpEntry,
  resolveBundledMcpLaunch
};
