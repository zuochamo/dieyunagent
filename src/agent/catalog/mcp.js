'use strict';

/**
 * MCP 工具：mcp_tool_schema（查远端工具的参数）/ mcp_manage（增删改服务）。
 * 动作清单与 transport 判定的唯一来源都在 `src/mcp/manage.js`。
 */
const { MCP_MANAGE_ACTIONS, MCP_TRANSPORT_KINDS } = require('../../mcp/manage');

const MCP_TOOL_SCHEMA_TOOL = {
  type: 'function',
  function: {
    name: 'mcp_tool_schema',
    description:
      '查 MCP 工具。两种用法：① agentName=已知工具名，返回完整 JSON Schema（嵌套字段被折叠时用）；' +
      '② query=你现在要做的事，在全部已启用 MCP 服务里检索工具，返回命中工具的 schema —— ' +
      '返回的 agentName 可直接当工具名调用，不必等它出现在工具列表里。' +
      '本轮工具列表只是召回来的子集，缺工具先用 query 找。',
    parameters: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'MCP agent 工具名，如 mcp_server_tool' },
        query: {
          type: 'string',
          description: '要完成的事情（自然语言或关键词），如「查上个月开票收入」「看某表结构」'
        }
      }
    }
  }
};

/**
 * 管理 MCP **服务本身**（不是调用它们的工具）：装、改、启停、删。
 *
 * 与 `mcp_tool_schema` 的分工：那个查「工具叫什么、参数什么」，这个管「服务在不在、连不连得上」。
 * 之前装服务只有设置页一条路（`mcp:add` 只收 stdio），远端 HTTP 服务连正规入口都没有 ——
 * 于是「让 Agent 自己把某台 Open API 接进来」是不可能的。执行端走 mcp/manage.js 的
 * `applyToolRequest`，与 IPC 共用同一份 store 与同一次运行时重挂。
 */
const MCP_MANAGE_TOOL = {
  type: 'function',
  function: {
    name: 'mcp_manage',
    description:
      '管理 MCP 服务本身（装/改/启停/删），不是调用它们的工具。' +
      'action=list 看现有服务与启停状态；add 新增；update 改 URL/命令/Token/环境变量；' +
      'enable 启停；remove 删除自定义服务；restore 恢复被移除的预装服务；' +
      'request_credential 让界面上弹出该服务的凭据输入框（由用户亲手填，你永远拿不到明文）；' +
      'check_update 查该 npx 包的最新版本；install_package 把它装到本地后离线可用；upgrade_package 升到指定/最新版本；repair_env 打开环境修复（缺 VS Build Tools 等）。' +
      '远端服务：transport=streamable-http + url，鉴权头不是 Authorization 时给 authHeaderName（如 X-API-Key）并把密钥放 token；' +
      '本地服务：command + args。改动会立即重建 MCP 会话，下一轮工具表里即出现（或消失）该服务的工具；' +
      '具体工具名用 mcp_tool_schema 查。**不知道密钥时不要向用户索要明文**，用 request_credential。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          // 枚举只有一份：mcp/manage.js 的 MCP_MANAGE_ACTIONS（apply() 按它分派）。
          // 在这里抄一份就会漂移 —— 加了动作忘了改 schema，模型永远调不到。
          enum: [...MCP_MANAGE_ACTIONS],
          description: '要做的操作'
        },
        id: {
          type: 'string',
          description: '服务 id（字母开头，仅字母/数字/_/-），用短名即可，如 daizhang、pg-prod'
        },
        name: { type: 'string', description: 'add 时的显示名（必填）' },
        description: { type: 'string', description: '可选说明，会显示在设置页' },
        transport: {
          type: 'string',
          // 取值唯一来源是 `mcp/manage.js`（`MCP_TRANSPORT_KINDS` = stdio + 远端协议），
          // 校验器由这份 schema 生成，所以**别名必须写进 enum 才认**：`remote` / `http` 只留给
          // 落库层做兼容（见 `isRemoteTransport`），模型照 schema 写 `sse` / `streamable-http` 即可。
          enum: [...MCP_TRANSPORT_KINDS],
          description: 'add/update 时选传输方式：本地命令用 stdio；远端用 streamable-http（多数）或 sse（老服务）；省略时按是否给 url 判断'
        },
        url: { type: 'string', description: '远端服务端点，如 http://192.168.31.62:3011/api/open-api/mcp' },
        authHeaderName: {
          type: 'string',
          description: '鉴权请求头名，默认 Authorization；叠云 Open API 系列用 X-API-Key'
        },
        token: { type: 'string', description: '鉴权值：加密存进凭据库（mcp-secrets.json），不写进 mcp.json' },
        command: { type: 'string', description: 'stdio 服务的启动命令，如 npx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio 服务的启动参数' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'update 时覆盖环境变量；只允许服务自己声明过的键（如 mcp-postgres 的 DATABASE_URL）'
        },
        enabled: { type: 'boolean', description: 'enable 时用：true 启用（默认）/ false 停用' },
        reason: {
          type: 'string',
          description: 'request_credential 时用：一句话说明为什么要这个凭据，会显示在输入框上方'
        },
        version: { type: 'string', description: 'upgrade_package 时用：目标版本号；省略则升到 npm latest' },
        repairKind: {
          type: 'string',
          enum: ['windows-vctools', 'npm-cache-busy'],
          description: 'repair_env 时用：要修的问题类型（来自安装失败的诊断）'
        }
      },
      required: ['action']
    }
  }
};

module.exports = {
  MCP_TOOL_SCHEMA_TOOL,
  MCP_MANAGE_TOOL
};
