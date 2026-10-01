'use strict';

/**
 * dev / start 前置：确保 build/mcp-bundled 里有预装 MCP 产物（对标 scripts/ensure-dieyun-core.cjs）。
 *
 * 与 dieyun-core 的关键区别：预装 MCP 是**可选能力**（registry 里 defaultEnabled: false），
 * 取不到产物时不能阻断开发 —— 否则内网/断网机器连 npm run dev 都起不来。
 * 这里只打印一条可执行的提示并放行；真正启用该 MCP 时，同一条原因会出现在 MCP 错误列表里。
 */

const { execSync } = require('child_process');
const path = require('path');
const { OUT, BUNDLED_MCP_IDS, packLooksComplete } = require('./pack-mcp-bundled.cjs');
const { getBuiltinMcpById } = require('../src/mcp/registry');
const { getMcpNpmPackageMeta } = require('../src/mcp/package-store');

const ROOT = path.join(__dirname, '..');

function pendingIds() {
  const pending = [];
  for (const id of BUNDLED_MCP_IDS) {
    const server = getBuiltinMcpById(id);
    if (!server || !server.bundledServer) {
      pending.push(id);
      continue;
    }
    const meta = getMcpNpmPackageMeta(server);
    if (!meta || !meta.version) {
      pending.push(id);
      continue;
    }
    if (!packLooksComplete(path.join(OUT, server.bundledServer), meta)) pending.push(id);
  }
  return pending;
}

const pending = pendingIds();
if (!pending.length) {
  console.log(`[mcp-bundled] 预装产物 OK: ${OUT}`);
  process.exit(0);
}

console.log(`[mcp-bundled] 缺少预装产物（${pending.join(', ')}），尝试 npm run pack:mcp-bundled …`);
try {
  execSync('npm run pack:mcp-bundled', { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  console.warn(`[mcp-bundled] 预装失败：${err.message || err}`);
}
if (pendingIds().length) {
  console.warn('[mcp-bundled] 预装产物不完整：该 MCP 在开发态不可用（可选能力，不阻断启动）。');
  console.warn('[mcp-bundled] 修法：联网重跑 npm run pack:mcp-bundled；或把 Release 产物放进 build/.cache/ 后重跑。');
  process.exit(0);
}
console.log(`[mcp-bundled] 预装产物 OK: ${OUT}`);
