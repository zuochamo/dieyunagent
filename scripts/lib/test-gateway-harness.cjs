'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { LocalGateway } = require('../../src/gateway/server');

/**
 * 测试脚本用轻量 LocalGateway（工具 delegate E2E）
 * @param {string} workspaceRoot
 */
function createTestLocalGateway(workspaceRoot) {
  const userData = path.join(os.tmpdir(), `dieyun-gw-test-${Date.now()}`);
  fs.mkdirSync(userData, { recursive: true });
  const gw = new LocalGateway({
    userDataPath: userData,
    readableDir: userData,
    extraReadRoots: [workspaceRoot],
    log: () => {}
  });
  gw.start();
  gw.setWorkspace(workspaceRoot);
  return {
    gateway: gw,
    userData,
    async stop() {
      try {
        gw.stop();
      } catch {
        // ignore
      }
    }
  };
}

module.exports = { createTestLocalGateway };
