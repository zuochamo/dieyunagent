'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * 共享记忆库的连接与建表（唯一实现）。
 *
 * 这里只做三件事：拿一个连接池、跑一次幂等建表、把 SQL 错误原样往上抛。
 * 「什么算可用」「失败要不要关掉功能」都在 `service.js`；本文件不吞错、不重试、
 * 不做降级 —— 否则「PG 连不上」这件事会在两个地方各有一套判断。
 */

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** 连接超时（毫秒）：探活与召回都在每轮路径上，慢于这个数就等于不可用 */
const CONNECT_TIMEOUT_MS = 6000;

function keyOf(conn) {
  return [conn.host, conn.port, conn.database, conn.user, conn.ssl ? 'tls' : 'plain'].join('|');
}

function looksLikeSslMismatch(err) {
  const msg = String((err && err.message) || err || '');
  return /does not support SSL|SSL is not enabled|EPROTO|wrong version number|unknown protocol|ssl/i.test(msg);
}

/**
 * @param {{ log?: (msg: string) => void }} deps
 */
function createPgAccess(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** @type {import('pg').Pool | null} */
  let pool = null;
  let poolKey = '';
  /** 实际协商出的 TLS 意图：服务器不支持时第一次就降级为明文，并记住（不再每轮重试） */
  let negotiatedSsl = null;

  function buildPool(conn, useSsl) {
    return new Pool({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // PG 的自签证书在局域网里是常态：要求校验就得先给每台机装 CA，
      // 而这条链路的信任边界是「内网 + scram 口令」，不是证书。
      ssl: useSsl ? { rejectUnauthorized: false } : false
    });
  }

  async function acquirePool(conn) {
    const wantSsl = negotiatedSsl != null ? negotiatedSsl : conn.ssl !== false;
    const key = keyOf({ ...conn, ssl: wantSsl });
    if (pool && poolKey === key) return pool;
    if (pool) {
      const old = pool;
      pool = null;
      old.end().catch(() => {});
    }
    let next = buildPool(conn, wantSsl);
    try {
      await next.query('SELECT 1');
    } catch (err) {
      // 唯一的一处「协商」：服务器没开 SSL 时用明文再试一次，并把结果记住。
      // 这不是兜底层（不隐藏故障）：真连不上就是连不上，错误原样抛给调用方。
      if (wantSsl && looksLikeSslMismatch(err)) {
        log('[dieyun:shared-memory] 服务器未启用 SSL，改用明文连接');
        next = buildPool(conn, false);
        await next.query('SELECT 1');
        negotiatedSsl = false;
      } else {
        next.end().catch(() => {});
        throw err;
      }
    }
    if (negotiatedSsl == null) negotiatedSsl = wantSsl;
    pool = next;
    poolKey = key;
    return pool;
  }

  async function query(conn, sql, params) {
    const p = await acquirePool(conn);
    return p.query(sql, params);
  }

  /**
   * 借一个**独占连接**：advisory lock 是会话级的，抢锁/放锁必须落在同一条连接上，
   * 用池上的 `query()` 会随缘拿到不同连接，锁就永远放不掉。调用方必须 `client.release()`。
   */
  async function acquireClient(conn) {
    const p = await acquirePool(conn);
    return p.connect();
  }

  /** 幂等建表；顺带把「服务端到底有没有 vector、pg_trgm」探出来（没有就只走文本排名） */
  async function ensureSchema(conn) {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await query(conn, sql);
    const r = await query(
      conn,
      `SELECT
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_trgm`
    );
    const row = (r.rows && r.rows[0]) || {};
    return { hasVector: !!row.has_vector, hasTrgm: !!row.has_trgm };
  }

  async function probe(conn) {
    const r = await query(conn, 'SELECT version() AS v');
    return String((r.rows && r.rows[0] && r.rows[0].v) || '');
  }

  function dispose() {
    if (pool) {
      const p = pool;
      pool = null;
      poolKey = '';
      p.end().catch(() => {});
    }
    negotiatedSsl = null;
  }

  /** 配置变了（换服务器/换口令）就弃掉旧池，下一次调用自动重建 */
  function reset() {
    dispose();
  }

  return { query, acquireClient, ensureSchema, probe, dispose, reset, CONNECT_TIMEOUT_MS };
}

module.exports = { createPgAccess };
