'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMcpRuntimeManager } = require('../../src/mcp/runtime-manager');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mcp-http-server.cjs');

const CHILD_READY_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const serverLogs = (logs, id) => logs.filter((m) => String(m).includes(`「${id}」`));

/**
 * 一个只数连接、不接受内容的 TCP 服务器：模拟「宿主没开 / 连上就断」的远程 MCP。
 * 用它数连接次数，就能断言「退避期内到底有没有真的再连一次」——
 * 这比看错误文案可靠：退避复用的就是上一次的失败文案，文案看不出差别。
 */
async function startConnCounter() {
  const state = { count: 0 };
  const sock = net.createServer((conn) => {
    state.count += 1;
    conn.destroy();
  });
  await new Promise((resolve) => sock.listen(0, '127.0.0.1', resolve));
  return {
    port: sock.address().port,
    state,
    close: () => new Promise((resolve) => sock.close(() => resolve()))
  };
}

/** 起一个真实的远程 MCP 夹具进程，等它就绪（宿主后启动的场景） */
function launchHttpFixture(port) {
  const child = spawn(process.execPath, [FIXTURE, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`远程 MCP 夹具未在 ${CHILD_READY_TIMEOUT_MS}ms 内就绪`)),
      CHILD_READY_TIMEOUT_MS
    );
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      try {
        const payload = JSON.parse(line);
        if (!payload.ready) reject(new Error(`远程 MCP 夹具启动失败：${payload.error}`));
        else resolve(child);
      } catch (err) {
        reject(err);
      }
    });
    child.stderr.on('data', () => {
      // 夹具自身报错不影响断言，忽略
    });
    child.on('exit', (code) => {
      if (buffer.includes('"ready"')) return;
      clearTimeout(timer);
      reject(new Error(`远程 MCP 夹具提前退出，code=${code}`));
    });
  });
}

/**
 * 回归：一个「已启用但宿主没开」的远程 MCP（unreal 就是这种：127.0.0.1:8000/mcp）
 * 以前每过 60 秒工具目录一刷新就被重连一次、并往主日志刷一条 warn —— 实测
 * 23 分钟 9 条，日志里看不出连的是谁，也看不出这是「没开」而不是「配错了」。
 *
 * 现在的契约：
 *  1. 失败文案带上目标 URL；
 *  2. 同一错误 10 分钟内只记一条（期间静默次数在下一跳里补报）；
 *  3. 自动刷新进退避（30s 起翻倍、上限 2 分钟，保证宿主后启动也能被发现）；
 *  4. 强制/按需路径（刷新按钮、工具调用）不受退避限制 —— 宿主刚起来就该立刻连上；
 *  5. 宿主起来后连上要留下「已恢复」日志，否则日志只有断开没有恢复，是残的。
 */
describe('MCP 连接失败：退避与日志节流', () => {
  it('反复失败只记一条日志、退避期不重试、按需路径可绕过且能恢复', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-backoff-'));
    const logs = [];
    const counter = await startConnCounter();
    const url = `http://127.0.0.1:${counter.port}/mcp`;
    let child = null;

    const runtime = createMcpRuntimeManager(
      () => [
        {
          id: 'down',
          name: 'Down Remote',
          transportKind: 'remote',
          remoteUrl: url,
          remoteTransport: 'streamable-http',
          enabled: true
        }
      ],
      {
        catalogPath: path.join(tmpDir, 'mcp-tools-catalog.json'),
        getServerSecrets: () => ({ token: '', env: {} }),
        log: (msg) => logs.push(msg)
      }
    );

    try {
      // 1) 首次：目录不存在 → 引导建连 → 失败。错误里必须带 URL，否则日志看不出连的是谁
      const first = await runtime.listAgentTools({ catalogOnly: true });
      expect(first.errors).toHaveLength(1);
      expect(String(first.errors[0].error)).toContain(url);
      expect(counter.state.count).toBeGreaterThan(0);
      expect(serverLogs(logs, 'down')).toHaveLength(1);

      const attemptsAfterFirst = counter.state.count;

      // 2) 退避期内再刷新（非强制）：不再发起任何网络活动，错误文案与首次一致
      const second = await runtime.listAgentTools({ catalogOnly: true });
      expect(String(second.errors[0].error)).toContain(url);
      expect(counter.state.count).toBe(attemptsAfterFirst);
      // 节流：同一错误不重复记
      expect(serverLogs(logs, 'down')).toHaveLength(1);

      // 3) 强制刷新绕开退避：真的再连一次
      const third = await runtime.listAgentTools({ force: true });
      expect(third.errors).toHaveLength(1);
      expect(counter.state.count).toBeGreaterThan(attemptsAfterFirst);
      // 仍然只有一条日志（节流与新连接无关）
      expect(serverLogs(logs, 'down')).toHaveLength(1);

      // 4) 宿主后启动：同端口起真实的远程 MCP，强制刷新必须连上
      await counter.close();
      child = await launchHttpFixture(counter.port);
      const recovered = await runtime.listAgentTools({ force: true });
      expect(recovered.errors).toEqual([]);
      const ping = (recovered.tools || []).find((t) => t.toolName === 'ping');
      expect(ping).toBeTruthy();
      expect(logs.some((m) => String(m).includes('「down」') && String(m).includes('已恢复连接'))).toBe(
        true
      );

      // 5) 端到端：按需调用直接可用
      const called = await runtime.callAgentTool(ping.agentName, {});
      expect(called.content).toBe('pong');
    } finally {
      if (child) child.kill();
      await runtime.shutdown();
      await counter.close().catch(() => {});
      await sleep(50);
    }
  }, 60000);
});
