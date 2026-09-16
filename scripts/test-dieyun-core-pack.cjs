'use strict';

/**
 * 验证 build/dieyun-core 产物可被 core-bridge 正常调用（无需 Electron）。
 */
const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { OUT, EXE_NAME, packLooksComplete } = require('./pack-dieyun-core.cjs');

async function main() {
  const bin = path.join(OUT, EXE_NAME);
  if (!packLooksComplete()) {
    console.error('build/dieyun-core 不完整，请先运行: npm run pack:dieyun-core');
    process.exit(1);
  }

  const bridge = createCoreBridge({
    binaryPath: bin,
    log: (m) => console.log('[core]', m)
  });

  await bridge.start();
  try {
    const ping = await bridge.invoke('core.ping', {});
    console.log('pack ping:', ping);
    if (!ping || !ping.ok) {
      throw new Error('core.ping failed');
    }
  } finally {
    await bridge.stop();
  }

  console.log('pack OK:', bin);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
