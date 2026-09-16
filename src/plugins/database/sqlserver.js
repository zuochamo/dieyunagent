'use strict';

const sql = require('mssql');
const { loadSqlConfig, saveSqlConfig, toPublicConfig } = require('./sql-config-store');

const FORBIDDEN_SQL =
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|EXEC(?:UTE)?|GRANT|REVOKE|DENY|BACKUP|RESTORE|SHUTDOWN|DBCC|KILL|RECONFIGURE|XP_|SP_|OPENROWSET|OPENDATASOURCE|BULK\s+INSERT)\b/i;

function stripSqlComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
}

function assertReadOnlySql(sqlText) {
  const cleaned = stripSqlComments(sqlText).trim();
  if (!cleaned) {
    const err = new Error('SQL 不能为空');
    err.code = 'INVALID_SQL';
    throw err;
  }
  const upper = cleaned.toUpperCase();
  if (!/^(SELECT|WITH)\b/.test(upper)) {
    const err = new Error('仅允许 SELECT / WITH 只读查询');
    err.code = 'SQL_NOT_READONLY';
    throw err;
  }
  if (FORBIDDEN_SQL.test(upper)) {
    const err = new Error('SQL 含有不允许的关键字');
    err.code = 'SQL_NOT_READONLY';
    throw err;
  }
  if (cleaned.includes(';')) {
    const parts = cleaned.split(';').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const err = new Error('不允许一次执行多条语句');
      err.code = 'SQL_NOT_READONLY';
      throw err;
    }
  }
  return cleaned;
}

function assertDatabaseName(name) {
  const n = String(name || '').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(n)) {
    const err = new Error('非法数据库名');
    err.code = 'INVALID_DATABASE';
    throw err;
  }
  return n;
}

class SqlServerService {
  /**
   * @param {string} configPath
   * @param {(msg: string) => void} [log]
   */
  constructor(configPath, log) {
    this.configPath = configPath;
    this.log = log || (() => {});
    this.config = loadSqlConfig(configPath);
    /** @type {import('mssql').ConnectionPool | null} */
    this.pool = null;
    this.poolDatabase = null;
    this.databasesCache = [];
    this.lastTestOk = false;
    this.lastError = null;
  }

  reload() {
    this.config = loadSqlConfig(this.configPath);
    return this.getPublicConfig();
  }

  getPublicConfig() {
    return toPublicConfig(this.config);
  }

  getStatus() {
    return {
      ...this.getPublicConfig(),
      lastTestOk: this.lastTestOk,
      lastError: this.lastError,
      databaseCount: this.databasesCache.length,
      databases: this.databasesCache.slice(0, 80)
    };
  }

  setConfig(patch) {
    this.config = saveSqlConfig(this.configPath, patch || {});
    this.close();
    return this.getPublicConfig();
  }

  close() {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      this.poolDatabase = null;
      p.close().catch(() => {});
    }
    this.databasesCache = [];
    this.lastTestOk = false;
  }

  _assertEnabled() {
    if (!this.config.enabled) {
      const err = new Error('SQL Server 未启用');
      err.code = 'SQL_DISABLED';
      throw err;
    }
    if (!this.config.password) {
      const err = new Error('未配置 SQL Server 密码');
      err.code = 'SQL_NO_PASSWORD';
      throw err;
    }
  }

  _buildConfig(database) {
    return {
      server: this.config.host,
      port: Number(this.config.port) || 1433,
      user: this.config.user,
      password: this.config.password,
      database: database || 'master',
      options: {
        encrypt: !!this.config.encrypt,
        trustServerCertificate: !!this.config.trustServerCertificate,
        readOnlyIntent: true
      },
      connectionTimeout: Number(this.config.connectTimeout) || 15000,
      requestTimeout: Number(this.config.requestTimeout) || 60000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
    };
  }

  async connect(database = 'master') {
    this._assertEnabled();
    const db = assertDatabaseName(database || 'master');
    if (this.pool && this.poolDatabase === db) return this.pool;
    if (this.pool) {
      try {
        await this.pool.close();
      } catch {
        // ignore
      }
      this.pool = null;
    }
    this.pool = await new sql.ConnectionPool(this._buildConfig(db)).connect();
    this.poolDatabase = db;
    return this.pool;
  }

  async testConnection() {
    this._assertEnabled();
    let pool;
    try {
      pool = await new sql.ConnectionPool(this._buildConfig('master')).connect();
      const r = await pool.request().query('SELECT @@VERSION AS version, SYSTEM_USER AS loginName');
      const row = r.recordset[0] || {};
      this.lastTestOk = true;
      this.lastError = null;
      await this.refreshDatabases(pool);
      return {
        ok: true,
        version: row.version,
        loginName: row.loginName,
        databases: this.databasesCache
      };
    } catch (e) {
      this.lastTestOk = false;
      this.lastError = e.message || String(e);
      throw e;
    } finally {
      if (pool) {
        try {
          await pool.close();
        } catch {
          // ignore
        }
      }
      this.pool = null;
      this.poolDatabase = null;
    }
  }

  async refreshDatabases(existingPool) {
    const pool = existingPool || (await this.connect('master'));
    const r = await pool.request().query(`
      SELECT d.name AS name
      FROM sys.databases d
      WHERE d.state_desc = N'ONLINE'
        AND HAS_DBACCESS(d.name) = 1
      ORDER BY d.name
    `);
    this.databasesCache = r.recordset.map((row) => row.name);
    return this.databasesCache;
  }

  async listDatabases() {
    this._assertEnabled();
    if (!this.databasesCache.length) {
      await this.testConnection();
    }
    return { databases: this.databasesCache };
  }

  async listTables({ database }) {
    this._assertEnabled();
    const db = assertDatabaseName(database);
    const pool = await this.connect(db);
    const r = await pool.request().query(`
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    return { database: db, tables: r.recordset };
  }

  async query({ database, sql: sqlText, maxRows }) {
    this._assertEnabled();
    const safeSql = assertReadOnlySql(sqlText);
    const db = database ? assertDatabaseName(database) : this.poolDatabase || 'master';
    const pool = await this.connect(db);
    const limit = Math.min(2000, Math.max(1, Number(maxRows) || Number(this.config.maxRows) || 500));
    const r = await pool.request().query(safeSql);
    const all = r.recordset || [];
    const rows = all.slice(0, limit);
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : r.recordsets && r.recordsets[0] && r.recordsets[0].columns
          ? Object.keys(r.recordsets[0].columns)
          : [];
    return {
      database: db,
      columns,
      rows,
      rowCount: rows.length,
      truncated: all.length > limit
    };
  }
}

module.exports = { SqlServerService, assertReadOnlySql };
