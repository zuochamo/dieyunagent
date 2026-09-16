'use strict';

/**
 * @param {{
 *   sqlSvc: object | null,
 *   assertHostEnabled: (ctx: object) => void,
 *   assertSqlEnabled: () => void,
 *   ctx: object
 * }} deps
 */
function createSqlHandlers({ sqlSvc, assertHostEnabled, assertSqlEnabled, ctx }) {
  return {
    'sql.config_get': () => {
      if (!sqlSvc) return { enabled: false };
      return sqlSvc.getStatus();
    },

    'sql.config_set': (params) => {
      assertHostEnabled(ctx);
      if (!sqlSvc) {
        const e = new Error('SQL Server 服务未初始化');
        e.code = 'SQL_UNAVAILABLE';
        throw e;
      }
      return sqlSvc.setConfig(params || {});
    },

    'sql.test': async () => {
      assertSqlEnabled();
      return sqlSvc.testConnection();
    },

    'sql.list_databases': async () => {
      assertSqlEnabled();
      return sqlSvc.listDatabases();
    },

    'sql.list_tables': async (params) => {
      assertSqlEnabled();
      return sqlSvc.listTables(params || {});
    },

    'sql.query': async (params) => {
      assertSqlEnabled();
      return sqlSvc.query(params || {});
    }
  };
}

module.exports = { createSqlHandlers };
