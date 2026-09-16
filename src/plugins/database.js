'use strict';

const path = require('path');
const { SqlServerService } = require('./database/sqlserver');

const SQL_TOOL_DEFS = [
  {
    name: 'sql_list_databases',
    description:
      '列出可访问的在线数据库。若系统提示中已有库列表则不要调用，直接 sql_query 或 sql_list_tables。',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'sql_list_tables',
    description: '列出指定库中的表。已知表名时跳过，直接 sql_query；同一库只列一次。',
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string', description: '数据库名' }
      },
      required: ['database']
    }
  },
  {
    name: 'sql_query',
    description:
      '执行只读 SELECT。优先用 [库].[dbo].[表] 三段式一次查清；可用 INFORMATION_SCHEMA 查元数据，减少 list_tables 次数。',
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string', description: '数据库名，不填则用 master' },
        sql: { type: 'string', description: 'SELECT 语句' }
      },
      required: ['sql']
    }
  }
];

function createDatabasePlugin() {
  let service = null;
  return {
    id: 'builtin.database',
    name: '数据库连接',
    description: 'SQL Server 只读连接、数据库列表、表结构与 SELECT 查询能力。',
    version: '1.0.0',
    category: 'data',
    provides: ['sql'],
    tools: SQL_TOOL_DEFS.slice(),
    defaultEnabled: true,
    builtin: true,
    source: 'builtin',
    init({ userDataPath, log }) {
      const configPath = path.join(userDataPath, 'sqlserver.json');
      service = new SqlServerService(configPath, log);
      return { services: { sql: service } };
    },
    getTools() {
      if (!service) return [];
      const st = service.getStatus();
      if (!st.enabled || st.hasPassword === false) return [];
      return SQL_TOOL_DEFS;
    },
    handleTool(name, args) {
      if (!service) {
        const err = new Error('SQL Server 服务未初始化');
        err.code = 'SQL_UNAVAILABLE';
        throw err;
      }
      const st = service.getStatus();
      if (!st.enabled) {
        const err = new Error('SQL Server 未启用');
        err.code = 'SQL_DISABLED';
        throw err;
      }
      switch (name) {
        case 'sql_list_databases':
          return service.listDatabases();
        case 'sql_list_tables':
          return service.listTables(args || {});
        case 'sql_query':
          return service.query(args || {});
        default:
          throw new Error(`未知 SQL 工具: ${name}`);
      }
    },
    dispose() {
      if (service) service.close();
      service = null;
    }
  };
}

module.exports = { createDatabasePlugin, SQL_TOOL_DEFS };
