'use strict';

/**
 * 快速验证 core-bridge ↔ dieyun-core 联通（无需启动 Electron）
 * 用法: node scripts/test-core-bridge.cjs [workspacePath]
 */

const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');

async function main() {
  const bin = resolveDieyunCoreBinary();
  if (!bin) {
    console.error('未找到 dieyun-core，请先运行: npm run cargo:build');
    process.exit(1);
  }
  const workspace = path.resolve(process.argv[2] || process.cwd());
  const dataDir = path.join(require('os').tmpdir(), 'dieyun-core-test');
  const bridge = createCoreBridge({
    binaryPath: bin,
    log: (m) => console.log('[core]', m)
  });

  await bridge.start();
  await bridge.configure({
    data_dir: dataDir,
    workspace_roots: [workspace],
    models_dirs: [path.join(__dirname, '..', 'models')]
  });

  const ping = await bridge.invoke('core.ping', {});
  console.log('ping:', ping);

  const st = await bridge.invoke('codebase.index', { workspaceRoot: workspace, force: true });
  console.log('index:', st);

  const search = await bridge.invoke('codebase.search', {
    workspaceRoot: workspace,
    query: 'AgentRunEvent',
    limit: 3,
    autoIndex: false
  });
  console.log('search hits:', search.results?.length || 0);
  if (search.results?.[0]) console.log('first:', search.results[0].path);

  await bridge.stop();
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
