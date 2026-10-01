'use strict';

/**
 * 打包后校验：安装包内必须带预装的离线 MCP（<resources>/mcp/bundled/<id>），
 * 且二进制与 manifest 的 sha256 一致、版本与 registry 的锁定版本一致。
 *
 * 这一环专门拦两类静默事故（都在打包配置里，跑测试看不出来）：
 * - package.json build.extraResources 漏了 build/mcp-bundled → 客户端上该 MCP 必然连不上；
 * - build/mcp-bundled 是旧版本（没重新 pack）→ 版本/校验和与 registry 脱钩。
 * 对标 scripts/verify-remote-gateway-pack.cjs。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getBuildDistRoot } = require('./build-dist-root.cjs');
const { BUNDLED_MCP_IDS } = require('./pack-mcp-bundled.cjs');
const { getBuiltinMcpById } = require('../src/mcp/registry');
const { getMcpNpmPackageMeta } = require('../src/mcp/package-store');

const BUNDLED_ROOT = path.join(getBuildDistRoot(), 'win-unpacked', 'resources', 'mcp', 'bundled');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fail(message, hint) {
  console.error('[verify-mcp-bundled]', message);
  if (hint) console.error('  ' + hint);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(BUNDLED_ROOT)) {
    fail(
      `安装包内缺少预装 MCP 目录: ${BUNDLED_ROOT}`,
      '先执行 npm run pack:mcp-bundled，并确认 package.json build.extraResources 含 build/mcp-bundled → mcp/bundled'
    );
  }

  for (const id of BUNDLED_MCP_IDS) {
    const server = getBuiltinMcpById(id);
    if (!server || !server.bundledServer) fail(`registry 里 ${id} 未声明 bundledServer`);
    const meta = getMcpNpmPackageMeta(server);
    if (!meta || !meta.version) fail(`registry 里 ${id} 的启动规格未锁定版本`);

    const dir = path.join(BUNDLED_ROOT, server.bundledServer);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) fail(`缺少 manifest: ${manifestPath}`);

    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      fail(`manifest 解析失败: ${manifestPath}`, e.message || String(e));
    }
    if (manifest.packageName !== meta.name || manifest.version !== meta.version) {
      fail(
        `安装包内的 ${id} 与 registry 锁定版本不一致：包内 ${manifest.packageName}@${manifest.version}，registry ${meta.name}@${meta.version}`,
        '重新执行 npm run pack:mcp-bundled 后再打包'
      );
    }

    const entry = path.join(dir, manifest.entry || '');
    const binary = path.join(dir, manifest.binary || '');
    if (!manifest.entry || !fs.existsSync(entry)) {
      fail(`缺少启动入口: ${manifest.entry || '(manifest 未声明)'}`, `目录: ${dir}`);
    }
    if (!manifest.binary || !fs.existsSync(binary)) {
      fail(`缺少平台二进制: ${manifest.binary || '(manifest 未声明)'}`, `目录: ${dir}`);
    }

    const got = sha256File(binary);
    if (got !== manifest.binarySha256) {
      fail(
        `二进制校验和不符: ${manifest.binary}`,
        `expected ${manifest.binarySha256}\n  got      ${got}\n  重新执行 npm run pack:mcp-bundled 后再打包`
      );
    }

    const size = fs.statSync(binary).size;
    console.log(
      `[verify-mcp-bundled] OK ${id}: ${meta.name}@${meta.version} ` +
        `(${Math.round((size / 1024 / 1024) * 10) / 10} MB, sha256 ${got.slice(0, 12)}…)`
    );
  }
}

main();
