'use strict';

const fs = require('fs');
const path = require('path');
const { getDeployConfig } = require('../../deploy-config');

function buildSqlDefaults() {
  const sql = getDeployConfig().sqlServer;
  return {
    enabled: true,
    host: sql.host || '',
    port: Number(sql.port) || 1433,
    user: sql.user || '',
    password: sql.password != null ? String(sql.password) : '',
    encrypt: true,
    trustServerCertificate: true,
    connectTimeout: 15000,
    requestTimeout: 60000,
    maxRows: 500
  };
}

function loadSqlConfig(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...buildSqlDefaults(), ...raw };
    }
  } catch {
    // ignore
  }
  const cfg = buildSqlDefaults();
  if (!cfg.password && process.env.SQLSERVER_PASSWORD) {
    cfg.password = process.env.SQLSERVER_PASSWORD;
  }
  return cfg;
}

function saveSqlConfig(filePath, cfg) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const prev = loadSqlConfig(filePath);
  const next = { ...buildSqlDefaults(), ...prev, ...cfg };
  if (cfg.password === '' || cfg.password == null) {
    next.password = prev.password || buildSqlDefaults().password;
  }
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function toPublicConfig(cfg) {
  return {
    enabled: !!cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    hasPassword: !!(cfg.password && String(cfg.password).length),
    encrypt: cfg.encrypt !== false,
    trustServerCertificate: cfg.trustServerCertificate !== false,
    connectTimeout: cfg.connectTimeout,
    requestTimeout: cfg.requestTimeout,
    maxRows: cfg.maxRows
  };
}

module.exports = {
  loadSqlConfig,
  saveSqlConfig,
  toPublicConfig
};
