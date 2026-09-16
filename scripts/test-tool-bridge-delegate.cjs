'use strict';

const path = require('path');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { createMockGateway } = require('./lib/test-gateway-mock.cjs');

async function main() {
  const workspace = path.resolve(process.argv[2] || process.cwd());
  const { gateway, stop } = (() => {
    const gw = createMockGateway(workspace);
    return { gateway: gw, stop: () => gw.stop() };
  })();
  const bridge = createMainToolBridge({ gateway, webContents: null });

  const pkgPath = path.join(workspace, 'package.json');
  const read = await bridge.executeAgentTool(
    'fs_read_file',
    { filePath: pkgPath, encoding: 'utf8', maxBytes: 4096 },
    { workspacePath: workspace }
  );
  if (read.error) throw new Error(read.error);
  const pkg = JSON.parse(read.data || '{}');
  console.log('fs_read_file ok, name:', pkg.name);

  const list = await bridge.executeAgentTool(
    'fs_list_dir',
    { dirPath: workspace },
    { workspacePath: workspace }
  );
  if (list.error) throw new Error(list.error);
  console.log('fs_list_dir entries:', (list.entries || []).length);

  await stop();
  console.log('tool-bridge delegate OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
