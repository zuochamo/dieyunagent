'use strict';

/**
 * 最小可用的「远程 MCP」夹具（streamable-http，无状态）。
 *
 * 用途：验证「宿主稍后才启动」的服务发现路径 —— 先让它缺席（连接失败、进退避），
 * 再在同一端口把它拉起来，强制/按需刷新必须能连上并打出恢复日志。
 * 独立进程运行，避免测试进程里挂着 HTTP server 不放。
 *
 * 用法：node mcp-http-server.cjs <port> [readyFile]
 * 就绪后向 stdout 打一行 JSON（含实际端口）；监听失败也会打一行 JSON 后退出。
 */

const http = require('http');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const port = Number(process.argv[2] || 0);
const readyFile = process.argv[3] || '';

function buildServer() {
  const server = new Server(
    { name: 'fixture-http', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ping',
        description: '返回 pong',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'pong' }]
  }));
  return server;
}

/** 无状态模式：每个请求一条新传输，不校验 session id */
function makeTransport() {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}

const httpServer = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/mcp')) {
    res.writeHead(404).end('not found');
    return;
  }
  const transport = makeTransport();
  const server = buildServer();
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  server
    .connect(transport)
    .then(() => transport.handleRequest(req, res))
    .catch(() => {
      if (!res.headersSent) res.writeHead(500).end('fixture error');
    });
});

httpServer.on('error', (err) => {
  const payload = { ready: false, error: err.message };
  if (readyFile) {
    try {
      fs.writeFileSync(readyFile, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
});

httpServer.listen(port, '127.0.0.1', () => {
  const actual = httpServer.address().port;
  const payload = { ready: true, port: actual };
  if (readyFile) {
    try {
      fs.writeFileSync(readyFile, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
});
