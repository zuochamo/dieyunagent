'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpRuntimeManager } = require('../../src/mcp/runtime-manager');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mcp-flaky-server.cjs');

const EXIT_MARKER_TIMEOUT_MS = 10000;
const RECONNECT_TIMEOUT_MS = 10000;
const POLL_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExitMarker(file) {
  const deadline = Date.now() + EXIT_MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await sleep(50);
  }
  throw new Error(`测试夹具子进程未在 ${EXIT_MARKER_TIMEOUT_MS}ms 内退出`);
}

/**
 * 子进程退出后反复重试调用：退出瞬间 SDK 的 onclose 可能还没落地，
 * 单次调用会打到垂死的 transport 上。只有「会话复位 + 重新 spawn」都成立才可能拿到成功，
 * 所以重试不会掩盖缺陷 —— 修不好就永远拿不到。
 */
async function waitForToolOk(runtime, agentName) {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await runtime.callAgentTool(agentName, {});
      if (result && result.ok) return result;
      lastError = new Error(result && result.error ? result.error : '工具返回失败');
    } catch (err) {
      lastError = err;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `子进程退出后 ${RECONNECT_TIMEOUT_MS}ms 内未能重新连接（会话未复位）：${lastError && lastError.message}`
  );
}

/**
 * 回归：MCP 子进程自己退出（崩溃 / EOF）后，会话必须复位并重新连接。
 *
 * 修复前 `McpSession.client` 只在 disconnect() 里被清空，子进程退出后它仍是旧对象，
 * `connect()` 永久短路在 `if (this.client) return`，之后每次调用都被 SDK 同步拒成
 * "Not connected"（在 tool-harness 里归为不可重试的 EXCEPTION），该服务静默变砖到重启。
 */
describe('McpSession 子进程退出后自动重连', () => {
  it('会话断开后下一次调用重新 spawn，而不是永久 Not connected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-session-'));
    const exitMarker = path.join(tmpDir, 'child-exited');
    const logs = [];

    const runtime = createMcpRuntimeManager(
      () => [
        { id: 'flaky', command: process.execPath, args: [FIXTURE, exitMarker], enabled: true }
      ],
      {
        catalogPath: path.join(tmpDir, 'mcp-tools-catalog.json'),
        getServerSecrets: () => ({ token: '', env: {} }),
        log: (msg) => logs.push(msg)
      }
    );

    const first = await runtime.listAgentTools({ force: true });
    expect(first.errors).toEqual([]);
    expect(first.tools.map((t) => t.toolName).sort()).toEqual(['die', 'ping']);

    const before = await runtime.callAgentTool('mcp_flaky__ping', {});
    expect(before.content).toBe('pong');

    // 让子进程自杀：transport 关闭 → SDK 清掉自己的 transport 并回调 onclose
    await runtime.callAgentTool('mcp_flaky__die', {});
    await waitForExitMarker(exitMarker);

    // 回归点：修复前这里永远抛 Not connected（client 没复位、不再 spawn）
    const after = await waitForToolOk(runtime, 'mcp_flaky__ping');
    expect(after.content).toBe('pong');

    // 可观测性：会话断开必须留下主日志线索，否则「静默变砖」下次还是查不出来
    expect(logs.some((m) => /flaky/.test(m) && /断开/.test(m))).toBe(true);

    await runtime.shutdown();
  }, 40000);
});
