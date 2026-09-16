'use strict';

/**
 * 叠云单系统 Open API — 内置 MCP（stdio）
 * 由 DIEYUN_OPEN_API_SERVICE=daizhang|tools|index|pixel 决定注册哪些工具。
 */

const path = require('path');
const { createRequire } = require('module');
const { callApi, SERVICES } = require('./client');

function loadSdk() {
  const candidates = [
    path.resolve(__dirname, '../../../../package.json'),
    path.resolve(process.cwd(), 'package.json')
  ];
  let lastErr = null;
  for (const pkgJson of candidates) {
    try {
      const req = createRequire(pkgJson);
      return {
        McpServer: req('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
        StdioServerTransport: req('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport,
        z: req('zod').z
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `无法加载 @modelcontextprotocol/sdk：${lastErr && lastErr.message ? lastErr.message : lastErr}`
  );
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toolError(err) {
  return {
    content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
    isError: true
  };
}

function resolveServiceId() {
  const raw = String(process.env.DIEYUN_OPEN_API_SERVICE || '').trim().toLowerCase();
  if (SERVICES[raw]) return raw;
  throw new Error(
    `DIEYUN_OPEN_API_SERVICE 无效（${raw || '空'}）。应为：${Object.keys(SERVICES).join(' / ')}`
  );
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {any} z
 * @param {string} serviceId
 */
function registerTools(server, z, serviceId) {
  const cfg = SERVICES[serviceId];

  server.registerTool(
    'ping',
    {
      title: '健康检查',
      description: `请求 ${cfg.label} /ping，检查可达性与鉴权。`
    },
    async () => {
      try {
        return textResult(await callApi(serviceId, '/ping'));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  if (serviceId === 'daizhang') {
    server.registerTool(
      'list_customers',
      {
        title: '客户列表',
        description: '查询叠云代账客户（只读）。支持 kw / status / page / pageSize。',
        inputSchema: {
          kw: z.string().optional().describe('编号/名称/全称/税号关键字'),
          status: z.enum(['pending', 'active']).optional().describe('客户状态'),
          page: z.number().int().positive().optional().describe('页码，默认 1'),
          pageSize: z.number().int().positive().max(200).optional().describe('每页条数，上限 200')
        }
      },
      async (args) => {
        try {
          return textResult(
            await callApi('daizhang', '/customers', {
              kw: args.kw,
              status: args.status,
              page: args.page,
              pageSize: args.pageSize
            })
          );
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      'list_invoices',
      {
        title: '发票列表',
        description: '查询叠云代账发票（只读）。tenantId 必填（来自 list_customers 的 id）。',
        inputSchema: {
          tenantId: z.string().min(1).describe('客户 tenantId（customers.id）'),
          type: z.enum(['output', 'input']).optional().describe('销项/进项'),
          period: z.string().optional().describe('账期 YYYY-MM'),
          periodFrom: z.string().optional(),
          periodTo: z.string().optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(200).optional()
        }
      },
      async (args) => {
        try {
          return textResult(
            await callApi('daizhang', '/invoices', {
              tenantId: args.tenantId,
              type: args.type,
              period: args.period,
              periodFrom: args.periodFrom,
              periodTo: args.periodTo,
              dateFrom: args.dateFrom,
              dateTo: args.dateTo,
              page: args.page,
              pageSize: args.pageSize
            })
          );
        } catch (err) {
          return toolError(err);
        }
      }
    );
    return;
  }

  if (serviceId === 'tools') {
    server.registerTool(
      'list_help_sections',
      {
        title: '帮助章节',
        description: '列出叠云 Tools 帮助文档章节（只读）。'
      },
      async () => {
        try {
          return textResult(await callApi('tools', '/help/sections'));
        } catch (err) {
          return toolError(err);
        }
      }
    );
    return;
  }

  if (serviceId === 'index') {
    server.registerTool(
      'list_bookmarks',
      {
        title: '导航书签',
        description: '列出叠云 Index 导航书签与分组（只读）。'
      },
      async () => {
        try {
          return textResult(await callApi('index', '/nav/bookmarks'));
        } catch (err) {
          return toolError(err);
        }
      }
    );
    server.registerTool(
      'monitor_stats',
      {
        title: '主机监控',
        description: '读取叠云 Index 主机监控统计（CPU/内存/磁盘等，只读）。'
      },
      async () => {
        try {
          return textResult(await callApi('index', '/monitor/stats'));
        } catch (err) {
          return toolError(err);
        }
      }
    );
    return;
  }

  if (serviceId === 'pixel') {
    server.registerTool(
      'office_summary',
      {
        title: '工位在线汇总',
        description: 'PixelOfficeMonitor 工位在线汇总（按房间/楼层，只读）。'
      },
      async () => {
        try {
          return textResult(await callApi('pixel', '/summary'));
        } catch (err) {
          return toolError(err);
        }
      }
    );
    server.registerTool(
      'list_computers',
      {
        title: '工位电脑列表',
        description: '列出 PixelOfficeMonitor 工位电脑（只读，不含 MAC/IP/员工姓名）。',
        inputSchema: {
          status: z.enum(['online', 'offline']).optional(),
          room: z.enum(['A', 'B']).optional(),
          floor: z.union([z.literal('0'), z.literal('1'), z.number().int()]).optional()
        }
      },
      async (args) => {
        try {
          return textResult(
            await callApi('pixel', '/computers', {
              status: args.status,
              room: args.room,
              floor: args.floor == null ? undefined : String(args.floor)
            })
          );
        } catch (err) {
          return toolError(err);
        }
      }
    );
  }
}

async function main() {
  const serviceId = resolveServiceId();
  const cfg = SERVICES[serviceId];
  const { McpServer, StdioServerTransport, z } = loadSdk();
  const server = new McpServer({
    name: `dieyun-${serviceId}`,
    version: '1.0.0'
  });
  registerTools(server, z, serviceId);
  process.stderr.write(`[dieyun-${serviceId}] ready (${cfg.label})\n`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[dieyun-open-api] ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
