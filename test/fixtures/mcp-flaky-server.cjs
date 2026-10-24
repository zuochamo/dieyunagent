'use strict';

/**
 * 测试用 MCP stdio 服务：`ping` 正常应答；`die` 应答后自行退出进程。
 *
 * 用途是复现「MCP 子进程自己退出后会话变砖」这条路径 —— 客户端侧 SDK 会清掉自己的
 * transport 并回调 onclose，如果会话对象不跟着复位，后续每次调用都会被同步拒成
 * "Not connected"，且永远不会重新 spawn。
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const fs = require('fs');

/** 应答写完到退出之间的等待：太快会截断 stdout 上的响应 */
const EXIT_DELAY_MS = 120;

/** 退出标记文件（argv[2] 传入）：测试据此确定子进程真的没了，而不是猜时间 */
const MARKER_PATH = process.argv[2] || '';
process.on('exit', () => {
  if (!MARKER_PATH) return;
  try {
    fs.writeFileSync(MARKER_PATH, String(Date.now()));
  } catch {
    // 测试辅助，写不了就算了
  }
});

const server = new Server(
  { name: 'flaky-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ping',
      description: '始终返回 pong',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'die',
      description: '应答后让本进程退出（模拟崩溃）',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'die') {
    setTimeout(() => process.exit(0), EXIT_DELAY_MS);
    return { content: [{ type: 'text', text: 'dying' }] };
  }
  return { content: [{ type: 'text', text: 'pong' }] };
});

server.connect(new StdioServerTransport()).catch(() => process.exit(1));
