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
 * 统一的只读工具注册壳 —— 消除每个工具重复的 `try/catch + textResult` 样板。
 *
 * 参数默认整包透传 `args`：**zod inputSchema 就是唯一白名单**。早前每个 handler
 * 手抄一份字段映射，后端加参数时漏抄就会静默丢参数（`list_invoices` 丢掉
 * checkStatus / deductOption 等 7 个过滤参数，就是这么来的 —— 模型以为过滤了，
 * 拿到的是全量）。需要类型转换的（如 pixel.floor）用 `mapParams` 单独处理。
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} serviceId
 * @param {{ name: string, title: string, description: string, path: string,
 *           inputSchema?: Record<string, any>,
 *           mapParams?: (args: any) => Record<string, any> }} def
 */
function registerReadTool(server, serviceId, def) {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      ...(def.inputSchema ? { inputSchema: def.inputSchema } : {})
    },
    async (args) => {
      try {
        const params = def.mapParams ? def.mapParams(args) : args || {};
        return textResult(await callApi(serviceId, def.path, params));
      } catch (err) {
        return toolError(err);
      }
    }
  );
}

/** 金额类接口的税负口径说明，多个工具复用同一句，避免措辞漂移导致模型选错工具 */
const TAX_SCOPE_HINT = '查「税负率 / 应交税费 / 增值税负担」时用税负工具，不要用 list_invoices 自行核算。';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {any} z
 * @param {string} serviceId
 */
function registerTools(server, z, serviceId) {
  const cfg = SERVICES[serviceId];

  registerReadTool(server, serviceId, {
    name: 'ping',
    title: '健康检查',
    description: `请求 ${cfg.label} /ping，检查可达性与鉴权。`,
    path: '/ping'
  });

  if (serviceId === 'daizhang') {
    registerReadTool(server, serviceId, {
      name: 'list_customers',
      title: '客户列表',
      description: '查询叠云代账客户（只读）。支持 kw / status / page / pageSize。',
      path: '/customers',
      inputSchema: {
        kw: z.string().optional().describe('编号/名称/全称/税号关键字'),
        status: z.enum(['pending', 'active']).optional().describe('客户状态'),
        page: z.number().int().positive().optional().describe('页码，默认 1'),
        pageSize: z.number().int().positive().max(200).optional().describe('每页条数，上限 200')
      }
    });

    registerReadTool(server, serviceId, {
      name: 'list_invoices',
      title: '发票列表',
      description:
        '查询叠云代账发票明细（只读）。tenantId 必填（来自 list_customers 的 id）。' +
        '只看金额汇总时优先用 invoices_summary，不要拉全量明细。',
      path: '/invoices',
      inputSchema: {
        tenantId: z.string().min(1).describe('客户 tenantId（customers.id）'),
        type: z.enum(['output', 'input']).optional().describe('output=销项 / input=进项'),
        period: z.string().optional().describe('账期 YYYY-MM（单月）'),
        periodFrom: z.string().optional().describe('账期起 YYYY-MM'),
        periodTo: z.string().optional().describe('账期止 YYYY-MM'),
        dateFrom: z.string().optional().describe('开票日期起 YYYY-MM-DD'),
        dateTo: z.string().optional().describe('开票日期止 YYYY-MM-DD'),
        taxPeriod: z.string().optional().describe('税款所属期 YYYY-MM（单月，与账期 period 不是一回事）'),
        taxPeriodFrom: z.string().optional().describe('税款所属期起 YYYY-MM'),
        taxPeriodTo: z.string().optional().describe('税款所属期止 YYYY-MM'),
        checkStatus: z
          .enum(['已勾选', '未勾选', '无需勾选'])
          .optional()
          .describe('勾选状态（进项票）。税负口径只计「已勾选」'),
        deductOption: z
          .enum(['抵扣', '不可抵扣', '不抵扣'])
          .optional()
          .describe('抵扣选项。「不抵扣」不计入税负进项'),
        invoiceStatus: z
          .enum(['正常', '已红冲-全额', '已作废'])
          .optional()
          .describe('发票状态'),
        isRed: z.boolean().optional().describe('是否红字发票'),
        page: z.number().int().positive().optional().describe('页码，默认 1'),
        pageSize: z.number().int().positive().max(500).optional().describe('每页条数，上限 500')
      }
    });

    registerReadTool(server, serviceId, {
      name: 'invoices_summary',
      title: '发票按期汇总',
      description:
        '按税款所属期分组的发票金额汇总（销项/进项，只读）。只需要各期销售额或进项税额时用本工具，' +
        '不要 list_invoices 拉全量明细后自己加总。',
      path: '/invoices/summary',
      inputSchema: {
        tenantId: z.string().min(1).describe('客户 tenantId（customers.id）'),
        type: z.enum(['output', 'input']).optional().describe('output=销项 / input=进项'),
        periodFrom: z.string().optional().describe('起始期 YYYY-MM'),
        periodTo: z.string().optional().describe('结束期 YYYY-MM'),
        groupBy: z.enum(['period']).optional().describe('分组维度，目前仅 period')
      }
    });

    registerReadTool(server, serviceId, {
      name: 'tax_burden',
      title: '税负汇总',
      description:
        '查询客户增值税税负汇总（销售额、销项税额、可抵扣进项税额、应纳增值税、税负率），' +
        '含固定资产累计税负指标。periodFrom/periodTo 格式 YYYY-MM。' +
        TAX_SCOPE_HINT +
        '返回已带 caliberNote（口径说明原文），可直接转述给会计。',
      path: '/tax/burden',
      inputSchema: {
        tenantId: z.string().min(1).describe('客户 tenantId，来自 list_customers 的 id'),
        periodFrom: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .describe('起始税款所属期 YYYY-MM'),
        periodTo: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .describe('结束税款所属期 YYYY-MM'),
        granularity: z
          .enum(['month', 'year', 'total'])
          .optional()
          .default('total')
          .describe('month=逐月明细 / year=按年 / total=期间合计（默认，最省 token）'),
        caliber: z
          .enum(['client'])
          .optional()
          .default('client')
          .describe('统计口径，目前仅 client（系统客户口径）'),
        includeUnsettled: z
          .boolean()
          .optional()
          .default(false)
          .describe('是否包含未申报完结的当期，默认 false')
      }
    });

    registerReadTool(server, serviceId, {
      name: 'tax_declaration',
      title: '申报口径明细',
      description:
        '查询某客户某税款所属期的申报口径数据（销项、进项、进项转出、期初/期末留抵、应纳、已缴）。' +
        '未申报时 declared=false 且金额为 null，属正常返回，不是错误。' +
        TAX_SCOPE_HINT,
      path: '/tax/declaration',
      inputSchema: {
        tenantId: z.string().min(1).describe('客户 tenantId，来自 list_customers 的 id'),
        period: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .describe('税款所属期 YYYY-MM')
      }
    });
    return;
  }

  if (serviceId === 'tools') {
    registerReadTool(server, serviceId, {
      name: 'list_help_sections',
      title: '帮助章节',
      description: '列出叠云 Tools 帮助文档章节（只读）。',
      path: '/help/sections'
    });
    return;
  }

  if (serviceId === 'index') {
    registerReadTool(server, serviceId, {
      name: 'list_bookmarks',
      title: '导航书签',
      description: '列出叠云 Index 导航书签与分组（只读）。',
      path: '/nav/bookmarks'
    });
    registerReadTool(server, serviceId, {
      name: 'monitor_stats',
      title: '主机监控',
      description: '读取叠云 Index 主机监控统计（CPU/内存/磁盘等，只读）。',
      path: '/monitor/stats'
    });
    return;
  }

  if (serviceId === 'pixel') {
    registerReadTool(server, serviceId, {
      name: 'office_summary',
      title: '工位在线汇总',
      description: 'PixelOfficeMonitor 工位在线汇总（按房间/楼层，只读）。',
      path: '/summary'
    });
    registerReadTool(server, serviceId, {
      name: 'list_computers',
      title: '工位电脑列表',
      description: '列出 PixelOfficeMonitor 工位电脑（只读，不含 MAC/IP/员工姓名）。',
      path: '/computers',
      inputSchema: {
        status: z.enum(['online', 'offline']).optional(),
        room: z.enum(['A', 'B']).optional(),
        floor: z.union([z.literal('0'), z.literal('1'), z.number().int()]).optional()
      },
      // floor 只接受字符串，数字 0/1 直接塞进 query 也能过，但显式 stringify 避免后端类型判定歧义
      mapParams: (args) => ({
        ...args,
        floor: args.floor == null ? undefined : String(args.floor)
      })
    });
  }
}

async function main() {
  const serviceId = resolveServiceId();
  const cfg = SERVICES[serviceId];
  const { McpServer, StdioServerTransport, z } = loadSdk();
  const server = new McpServer({
    name: `dieyun-${serviceId}`,
    version: '1.1.0'
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
