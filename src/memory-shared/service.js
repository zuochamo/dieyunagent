'use strict';

const crypto = require('crypto');
const { createSharedMemoryStore, normalizeHost, clampPort } = require('./settings');
const { createPgAccess } = require('./pg');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');
const { isShareableKind } = require('../agent/project-memory-file');

/**
 * 共享记忆（跨机）数据层：一条 SQL 召回、幂等上传、抢占式提炼的**数据部分**。
 *
 * 边界（写死在这里，免得以后漂移）：
 * - **只同步记忆条目**，不上传对话消息。对话检索在本地已有 `messages_fts` + `session_recall`；
 *   把每条消息再往 PG 写一遍是旧「蜂群」设计最贵的部分（N 台机 × 每条消息）。
 * - **本文件不调 LLM、不写 prompt**。提炼用的模型调用与提示词在 `agent/knowledge-maintainer.js`
 *   （那里的归纳器本来就是「记忆提炼」的唯一实现），这里只提供「谁能提炼、提炼完怎么落库」。
 * - **没有 master/slave**：谁来提炼由 `pg_try_advisory_lock` 决定 —— 抢到的节点干这一次，
 *   抢不到的直接返回。旧设计为此引进了模式文件 + 授权密码 + 心跳角色表，全都删掉。
 * - **失败一律 fail-open**：调用方（system prompt 装配 / 归纳收尾）拿到 `{ok:false}` 就跳过，
 *   不重试、不入队、不阻塞对话。
 */

/** 归一化：与本地记忆的正文口径一致（空白折叠 + trim），保证同一句话在任何机器 hash 相同 */
function normalizeContent(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
}

function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeContent(text), 'utf8').digest('hex');
}

/** 向量字面量：pgvector 接受 `[0.1,0.2,...]` 文本，参数化后由 `::vector` 转型 */
function vectorLiteral(vec) {
  return `[${vec.map((n) => (Number.isFinite(n) ? n.toFixed(6) : '0')).join(',')}]`;
}

/**
 * 召回语句的唯一构造点（纯函数，可单测）。
 *
 * 「有向量就用向量、没向量就文本」**不是两条代码路径**：同一句 SQL 里一个 `COALESCE` 就够 ——
 * 查询向量为空、或该行没向量、或维度对不上（不同机器可能配了不同 embedding 模型），
 * 该行自然落到 trigram 相似度上，排序里再叠重要度 / 冷热。
 *
 * 唯一的形态差异来自**服务端能力**而不是业务分支：
 * - 没有 vector 扩展时 SQL 里不能出现 `::vector`（会直接报 `type "vector" does not exist`）；
 * - 没有 pg_trgm 时 `similarity()` 不存在。
 * 两种情况都只影响表达式，不影响「一条语句、一个排序语义」。
 *
 * `queryVec` 是给 pgvector 的**文本字面量**（`[0.1,0.2,...]`），维度必须由调用方另给
 * `queryVecDim` —— 对字面量取 `.length` 得到的是字符数，会让 `embedding_dim = $3` 永远不成立。
 */
function buildRecallQuery({ hasVector, hasTrgm, queryVec, queryVecDim, queryText, scopes, limit }) {
  const textSim = hasTrgm ? 'similarity(m.content, $2)' : '0::double precision';
  if (hasVector) {
    const vecExpr = `CASE WHEN $1::text IS NOT NULL AND m.embedding_dim = $3
                          THEN (m.embedding <=> $1::vector) END`;
    return {
      sql: `
        SELECT m.id, m.content, m.kind, m.importance, m.scope,
               ${vecExpr} AS dist,
               ${textSim} AS sim
        FROM shared_memory m
        WHERE m.status = 'active'
          AND (m.scope = 'global' OR m.scope = ANY($4::text[]))
        ORDER BY COALESCE(${vecExpr}, 1 - ${textSim}) ASC,
                 m.importance DESC,
                 m.last_used_at DESC NULLS LAST,
                 m.updated_at DESC
        LIMIT $5`,
      params: [queryVec, queryText, queryVec ? Number(queryVecDim) || null : null, scopes, limit]
    };
  }
  const simExpr = hasTrgm ? 'similarity(m.content, $1)' : '0::double precision';
  return {
    sql: `
      SELECT m.id, m.content, m.kind, m.importance, m.scope,
             NULL::double precision AS dist,
             ${simExpr} AS sim
      FROM shared_memory m
      WHERE m.status = 'active'
        AND (m.scope = 'global' OR m.scope = ANY($2::text[]))
      ORDER BY (1 - ${simExpr}) ASC,
               m.importance DESC,
               m.last_used_at DESC NULLS LAST,
               m.updated_at DESC
      LIMIT $3`,
    params: [queryText, scopes, limit]
  };
}

/**
 * 写入语句的唯一构造点（纯函数，可单测）。
 *
 * `embedding` 列只在服务端装了 pgvector 时存在（见 schema.sql 的条件 DDL），所以这里按能力
 * 给出两版**同一语义**的语句：没有扩展就只写正文与元数据，`ON CONFLICT` 的合并口径一致。
 * 上传与提炼落库共用这一处，不要各自拼一份。
 *
 * @param {boolean} hasVector
 * @param {{ content: string, hash: string, source: string, scope: string, importance: number }} row
 * @param {{ vec?: string|null, model?: string|null, dim?: number|null, nodeId: string }} extra
 */
function buildUpsertQuery(hasVector, row, extra = {}) {
  if (!hasVector) {
    return {
      sql: `
        INSERT INTO shared_memory
          (content, content_hash, kind, source, scope, node_id, importance)
        VALUES ($1, $2, 'normal', $3, $4, $5, $6)
        ON CONFLICT (content_hash) DO UPDATE
          SET importance = GREATEST(shared_memory.importance, EXCLUDED.importance),
              updated_at = now()`,
      params: [row.content, row.hash, row.source, row.scope, String(extra.nodeId || ''), row.importance]
    };
  }
  return {
    sql: `
      INSERT INTO shared_memory
        (content, content_hash, kind, source, scope, node_id, importance,
         embedding, embedding_model, embedding_dim)
      VALUES ($1, $2, 'normal', $3, $4, $5, $6, $7::vector, $8, $9)
      ON CONFLICT (content_hash) DO UPDATE
        SET importance = GREATEST(shared_memory.importance, EXCLUDED.importance),
            updated_at = now(),
            embedding = COALESCE(EXCLUDED.embedding, shared_memory.embedding),
            embedding_model = COALESCE(EXCLUDED.embedding_model, shared_memory.embedding_model),
            embedding_dim = COALESCE(EXCLUDED.embedding_dim, shared_memory.embedding_dim)`,
    params: [
      row.content,
      row.hash,
      row.source,
      row.scope,
      String(extra.nodeId || ''),
      row.importance,
      extra.vec || null,
      extra.model || null,
      extra.dim == null ? null : Number(extra.dim)
    ]
  };
}

/**
 * @param {{
 *   userDataPath: string,
 *   safeStorage?: import('electron').SafeStorage,
 *   log?: { info?: Function, warn?: Function } | ((msg: string) => void),
 *   nodeId?: string,
 *   hostname?: string,
 *   clientVersion?: string,
 *   limits?: () => object,
 *   embedding?: () => { embed: (input: string|string[]) => Promise<number[][]>,
 *                        embedInteractive: (input: string) => Promise<number[][]>,
 *                        model: string, dimensions: number, enabled: () => boolean } | null
 *     `embed` 用于上传/提炼的**批量**向量；`embedInteractive` 用于召回时的**查询**向量
 *     （端点比交互预算慢时它不发请求，直接抛 code=EMBEDDING_TOO_SLOW → 走 trigram 文本排名）。
 * }} deps
 */
function createSharedMemoryService(deps) {
  const rawLog = deps.log;
  const log =
    typeof rawLog === 'function'
      ? rawLog
      : (msg) => {
          try {
            if (rawLog && typeof rawLog.info === 'function') rawLog.info(msg);
          } catch {
            // 日志失败不影响任何逻辑
          }
        };
  const warn = (msg) => {
    try {
      if (rawLog && typeof rawLog.warn === 'function') rawLog.warn(msg);
      else log(msg);
    } catch {
      // ignore
    }
  };

  const store = createSharedMemoryStore({
    userDataPath: deps.userDataPath,
    safeStorage: deps.safeStorage,
    log
  });
  const pg = createPgAccess({ log });
  const nodeId = String(deps.nodeId || deps.hostname || 'unknown');
  const hostname = String(deps.hostname || deps.nodeId || '');
  const clientVersion = String(deps.clientVersion || '');

  const state = {
    available: false,
    probing: null,
    lastError: '',
    lastProbeAt: 0,
    lastSyncAt: 0,
    serverVersion: '',
    hasVector: false,
    hasTrgm: false
  };

  /**
   * 预算取值的唯一入口：**默认值来自 `agent-limits`**（数字只在那里改），
   * 依赖注入的 `limits()` 只负责覆盖。以前各处写 `|| 5` / `|| 600` / `|| 40`，
   * 改了 agent-limits 也不生效 —— 「缺省」变成了第二份真相。
   */
  const limitsOf = () => {
    let injected = {};
    try {
      injected = (typeof deps.limits === 'function' ? deps.limits() : null) || {};
    } catch {
      injected = {};
    }
    return { ...AGENT_LIMITS_DEFAULTS, ...injected };
  };

  function embeddingFor() {
    try {
      const client = typeof deps.embedding === 'function' ? deps.embedding() : null;
      if (!client || typeof client.embed !== 'function') return null;
      if (typeof client.enabled === 'function' && !client.enabled()) return null;
      return client;
    } catch {
      return null;
    }
  }

  /** 配置 + 可达性：**两个条件都成立才算「开着」**（检查不到数据库 = 关闭，用户要的语义） */
  function getStatus() {
    const settings = store.getSettings();
    const enabled = settings.enabled;
    const configured = settings.configured;
    const available = !!state.available;
    let reason = '';
    if (!enabled) reason = 'disabled';
    else if (!configured) reason = settings.hasPassword ? 'unconfigured' : 'no-password';
    else if (!available) reason = state.lastError ? 'unreachable' : 'unprobed';
    return {
      enabled,
      configured,
      available,
      active: enabled && configured && available,
      reason,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      ssl: settings.ssl,
      hasPassword: settings.hasPassword,
      canEncrypt: settings.canEncrypt,
      serverVersion: state.serverVersion,
      hasVector: state.hasVector,
      hasTrgm: state.hasTrgm,
      lastError: state.lastError,
      lastProbeAt: state.lastProbeAt,
      lastSyncAt: state.lastSyncAt,
      nodeId,
      limits: {
        recallLimit: Number(limitsOf().sharedMemoryRecallLimit),
        minScoreSemantic: Number(limitsOf().sharedMemoryMinScoreSemantic),
        minScoreKeyword: Number(limitsOf().sharedMemoryMinScoreKeyword)
      }
    };
  }

  function active() {
    const s = store.getSettings();
    return !!s.enabled && s.configured && !!state.available;
  }

  /**
   * 探活 + 首次建表。失败只记状态（`available:false`），抛给调用方的是结果而不是异常：
   * 设置页要显示原因，装配侧要静默跳过。
   */
  async function probe() {
    const settings = store.getSettings();
    if (!settings.enabled) {
      state.available = false;
      return { ok: false, reason: 'disabled' };
    }
    if (!settings.configured) {
      state.available = false;
      state.lastProbeAt = Date.now();
      return { ok: false, reason: 'unconfigured' };
    }
    if (state.probing) return state.probing;
    state.probing = (async () => {
      const conn = store.getConnection();
      try {
        const version = await pg.probe(conn);
        const caps = await pg.ensureSchema(conn);
        state.serverVersion = version;
        state.hasVector = !!caps.hasVector;
        state.hasTrgm = !!caps.hasTrgm;
        state.available = true;
        state.lastError = '';
        state.lastProbeAt = Date.now();
        if (!state.hasVector) {
          warn('[dieyun:shared-memory] 库里没有 vector 扩展：向量通道关闭，召回只走文本排名');
        }
        await heartbeat().catch(() => {});
        return { ok: true, serverVersion: version, ...caps };
      } catch (err) {
        const msg = (err && err.message) || String(err);
        state.available = false;
        state.lastError = msg;
        state.lastProbeAt = Date.now();
        warn(`[dieyun:shared-memory] 不可用（本轮及以后按关闭处理）：${msg}`);
        return { ok: false, reason: 'unreachable', error: msg };
      } finally {
        state.probing = null;
      }
    })();
    return state.probing;
  }

  /** 节点心跳：只用于「哪些机器在共用这份记忆」的可见性 */
  async function heartbeat() {
    if (!active()) return { ok: false };
    const conn = store.getConnection();
    await pg.query(
      conn,
      `INSERT INTO memory_nodes (node_id, hostname, client_version, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (node_id) DO UPDATE
         SET hostname = EXCLUDED.hostname,
             client_version = EXCLUDED.client_version,
             last_seen_at = now()`,
      [nodeId, hostname, clientVersion]
    );
    return { ok: true };
  }

  /**
   * 批量取向量（上传与提炼共用）：没有 embedding 端点 / 调用失败 → `vecs:null`，
   * 条目按「无向量」入库，召回时自然按文本排名 —— 失败退回不是第二套语义。
   */
  async function embedContents(contents) {
    const embedder = state.hasVector ? embeddingFor() : null;
    if (!embedder || !contents.length) return { vecs: null, embedder: null };
    try {
      const out = await embedder.embed(contents);
      if (Array.isArray(out) && out.length === contents.length) return { vecs: out, embedder };
    } catch (err) {
      warn(`[dieyun:shared-memory] 取向量失败（按无向量入库）：${(err && err.message) || err}`);
    }
    return { vecs: null, embedder };
  }

  /**
   * 上传一批记忆条目（归纳器写完本地库后调用）。
   *
   * `kind` 过滤不在这里另写一份：调用方传入的条目已过
   * `agent/project-memory-file.js#isShareableKind`（secret / private 永不出本机）。
   * 这里只兜底一次（防御性，不是第二套规则）。
   */
  async function mirrorItems(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { ok: true, uploaded: 0, skipped: 0 };
    if (!active()) return { ok: false, reason: getStatus().reason, uploaded: 0, skipped: list.length };
    const maxChars = Number(limitsOf().sharedMemoryEntryMaxChars);
    const rows = [];
    let skipped = 0;
    for (const item of list) {
      const content = normalizeContent(item && item.content).slice(0, maxChars);
      if (!content || content.length < 8) {
        skipped += 1;
        continue;
      }
      // secret / private 的判定只有一处：`project-memory-file#isShareableKind`
      // （与写 `.dieyun/memory.md` 共用）。这里不再自己写一份字符串比较。
      const kind = String((item && item.kind) || 'normal').toLowerCase();
      if (!isShareableKind(kind)) {
        skipped += 1;
        continue;
      }
      rows.push({
        content,
        hash: contentHash(content),
        source: String((item && item.source) || 'auto_consolidation'),
        scope: String((opts.scope || (item && item.scope) || 'global')).trim() || 'global',
        importance: Math.min(1, Math.max(0, Number(item && item.importance) / 5 || 0.5))
      });
    }
    if (!rows.length) return { ok: true, uploaded: 0, skipped };

    // 向量：有 embedding 端点就带上，没有就保持 NULL（召回时按文本排名，见 recall）
    const { vecs: vectors, embedder } = await embedContents(rows.map((r) => r.content));

    const conn = store.getConnection();
    let uploaded = 0;
    try {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const q = buildUpsertQuery(!!state.hasVector, row, {
          vec: vectors ? vectorLiteral(vectors[i]) : null,
          model: vectors ? embedder.model : null,
          dim: vectors ? embedder.dimensions : null,
          nodeId
        });
        await pg.query(conn, q.sql, q.params);
        uploaded += 1;
      }
      state.lastSyncAt = Date.now();
      return { ok: true, uploaded, skipped };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      state.available = false;
      state.lastError = msg;
      warn(`[dieyun:shared-memory] 上传失败：${msg}`);
      return { ok: false, uploaded, skipped, error: msg };
    }
  }

  /**
   * 召回：**一条 SQL，一个函数**。
   *
   * 「有向量就用向量、没向量就文本」不是两条代码路径，而是同一句 `ORDER BY` 里的条件表达式：
   * 查询向量为空、或某行没有向量、或维度对不上（不同机器可能配了不同模型），该行自然落到
   * `pg_trgm` 的相似度上。中文没有分词器，trigram 是这里唯一可用的文本相似度
   * （FTS 的 simple 配置切不开中文，见 docs/SHARED-MEMORY.md）。
   */
  async function recall(query, opts = {}) {
    const q = normalizeContent(query);
    if (!q) return { ok: true, mode: 'none', results: [] };
    if (!active()) return { ok: false, mode: 'none', results: [], reason: getStatus().reason };
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || limitsOf().sharedMemoryRecallLimit));
    const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ['global'];
    const conn = store.getConnection();

    let vec = null;
    const embedder = state.hasVector ? embeddingFor() : null;
    if (embedder) {
      try {
        // 查询向量走交互闸门：端点比交互预算慢时不发请求，直接落到下面的 trigram 文本排名。
        // 慢的那次由 embedding 客户端自己记一行日志，这里不重复刷屏。
        const out = await embedder.embedInteractive(q);
        if (Array.isArray(out) && out[0] && out[0].length) vec = out[0];
      } catch (err) {
        if (!err || err.code !== 'EMBEDDING_TOO_SLOW') {
          warn(`[dieyun:shared-memory] 查询向量失败（改走文本排名）：${(err && err.message) || err}`);
        }
      }
    }

    const { sql, params } = buildRecallQuery({
      hasVector: !!state.hasVector,
      hasTrgm: !!state.hasTrgm,
      queryVec: vec ? vectorLiteral(vec) : null,
      queryVecDim: vec ? vec.length : null,
      queryText: q,
      scopes,
      limit
    });
    try {
      const r = await pg.query(conn, sql, params);
      const rows = (r.rows || []).map((row) => {
        const dist = row.dist == null ? null : Number(row.dist);
        const sim = row.sim == null ? null : Number(row.sim);
        const score = dist != null ? 1 - dist : sim || 0;
        return {
          id: Number(row.id),
          content: String(row.content || ''),
          kind: String(row.kind || 'normal'),
          importance: Number(row.importance) || 0,
          scope: String(row.scope || 'global'),
          score: Number.isFinite(score) ? score : 0,
          mode: dist != null ? 'semantic' : 'keyword'
        };
      });
      const mode = rows.some((r) => r.mode === 'semantic') ? 'semantic' : rows.length ? 'keyword' : 'none';
      // 命中即记账：这一列是衰减与提炼优先级的唯一信号
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        await pg
          .query(
            conn,
            `UPDATE shared_memory
             SET access_count = access_count + 1, last_used_at = now()
             WHERE id = ANY($1::bigint[])`,
            [ids]
          )
          .catch(() => {});
      }
      return { ok: true, mode, results: rows };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      state.available = false;
      state.lastError = msg;
      warn(`[dieyun:shared-memory] 召回失败：${msg}`);
      return { ok: false, mode: 'none', results: [], error: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // 提炼（数据部分）：抢锁 → 取候选 → 交回调用方算完 → 落库 → 放锁
  // ---------------------------------------------------------------------------

  const CONSOLIDATE_LOCK_KEY = 0x64696579; // 'diey'

  /**
   * 抢这次提炼的独占权。抢不到（别的机器正在提炼）返回 null —— 这是**唯一的调度器**：
   * 不需要「谁是 Master」的配置，也不会出现两台机同时烧 LLM。
   *
   * 冷却期也在这里判：读的是 `memory_consolidations` 里上次成功的时间戳，
   * 所以是**跨机口径**（本机内存里那份计数换台机器就失效，等于没有）。
   */
  async function claimConsolidation(trigger, opts = {}) {
    if (!active()) return null;
    const conn = store.getConnection();
    const minIntervalMs = Number(opts.minIntervalMs) || 0;
    try {
      if (minIntervalMs > 0) {
        const last = await pg.query(
          conn,
          `SELECT extract(epoch FROM (now() - finished_at)) * 1000 AS age_ms
           FROM memory_consolidations
           WHERE finished_at IS NOT NULL
           ORDER BY finished_at DESC
           LIMIT 1`
        );
        const age = last.rows && last.rows[0] ? Number(last.rows[0].age_ms) : null;
        if (age != null && Number.isFinite(age) && age < minIntervalMs) return null;
      }
    } catch {
      // 读台账失败不拦提炼：锁仍然是唯一硬约束
    }
    // 借连接也在 try 里：`acquireClient` 会在 `SELECT 1` 探活失败时抛（DB 在探活之后掉线），
    // 逃出去就变成 reject，与「失败一律 fail-open 返回 null」的契约相反（调用方是 fire-and-forget）。
    let client = null;
    try {
      client = await pg.acquireClient(conn);
      const locked = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CONSOLIDATE_LOCK_KEY]);
      if (!locked.rows[0] || locked.rows[0].ok !== true) {
        client.release();
        return null;
      }
      const run = await client.query(
        `INSERT INTO memory_consolidations (node_id, trigger) VALUES ($1, $2) RETURNING id`,
        [nodeId, String(trigger || 'scheduled')]
      );
      return { runId: Number(run.rows[0].id), client };
    } catch (err) {
      // 抢到锁之后的任何异常都要先 unlock 再还连接：advisory lock 是**会话级**的，
      // 直接 release 会让它继续被池里那条连接持有（锁是跨机全局的 ⇒ 全集群再也提炼不了）。
      if (client) {
        await client.query('SELECT pg_advisory_unlock($1)', [CONSOLIDATE_LOCK_KEY]).catch(() => {});
        client.release();
      }
      const msg = (err && err.message) || String(err);
      state.lastError = msg;
      warn(`[dieyun:shared-memory] 抢提炼锁失败：${msg}`);
      return null;
    }
  }

  /** 候选：活跃条目里「从没被召回 / 久未使用」的一段，按体量取批 */
  async function listConsolidationCandidates(claim) {
    if (!claim) return [];
    const batch = Math.max(2, Number(limitsOf().sharedMemoryConsolidateBatch));
    const r = await claim.client.query(
      `SELECT id, content, importance, access_count, last_used_at
       FROM shared_memory
       WHERE status = 'active'
       ORDER BY (access_count = 0) DESC, last_used_at ASC NULLS FIRST, importance ASC, id ASC
       LIMIT $1`,
      [batch]
    );
    return (r.rows || []).map((row) => ({
      id: Number(row.id),
      content: String(row.content || ''),
      importance: Number(row.importance) || 0,
      accessCount: Number(row.access_count) || 0
    }));
  }

  /**
   * 落库提炼结果：
   * - `mergedIds` 标记 `status='merged'`（软归档，不物理删 —— 「忘掉」可回滚）
   * - `created` 写入合并后的新条目（与正常上传同一条 upsert，content_hash 保证幂等）
   */
  async function applyConsolidation(claim, result = {}) {
    if (!claim) return { ok: false };
    const mergedIds = (result.mergedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const created = Array.isArray(result.created) ? result.created : [];
    let marked = 0;
    let inserted = 0;
    try {
      if (mergedIds.length) {
        const r = await claim.client.query(
          `UPDATE shared_memory SET status = 'merged', updated_at = now()
           WHERE id = ANY($1::bigint[]) AND status = 'active'`,
          [mergedIds]
        );
        marked = r.rowCount || 0;
      }
      const maxChars = Number(limitsOf().sharedMemoryEntryMaxChars);
      const newRows = created
        .map((entry) => {
          const content = normalizeContent(entry && entry.content).slice(0, maxChars);
          if (!content) return null;
          return {
            content,
            // hash 必须按**入库的**正文算：拿未截断的原文算，同一句话在截断后又会变成另一行
            hash: contentHash(content),
            source: String((entry && entry.source) || 'shared_consolidation'),
            scope: String((entry && entry.scope) || 'global'),
            importance: Math.min(1, Math.max(0, Number(entry && entry.importance) / 5 || 0.5))
          };
        })
        .filter(Boolean);
      // 提炼产出的条目也要有向量：否则「越提炼越搜不到」（只剩 trigram 排名）
      const { vecs: vectors, embedder } = await embedContents(newRows.map((r) => r.content));
      for (let i = 0; i < newRows.length; i += 1) {
        const row = newRows[i];
        const q = buildUpsertQuery(!!state.hasVector, row, {
          vec: vectors ? vectorLiteral(vectors[i]) : null,
          model: vectors ? embedder.model : null,
          dim: vectors ? embedder.dimensions : null,
          nodeId
        });
        await claim.client.query(q.sql, q.params);
        inserted += 1;
      }
      return { ok: true, marked, inserted };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      warn(`[dieyun:shared-memory] 提炼落库失败：${msg}`);
      return { ok: false, error: msg, marked, inserted };
    }
  }

  /** 结账 + 放锁（一定释放 client，否则连接池会被慢慢耗干） */
  async function releaseConsolidation(claim, info = {}) {
    if (!claim) return;
    const { client, runId } = claim;
    try {
      await client.query(
        `UPDATE memory_consolidations
         SET finished_at = now(), scanned = $2, merged = $3, created = $4, model = $5, error = $6
         WHERE id = $1`,
        [
          runId,
          Number(info.scanned) || 0,
          Number(info.merged) || 0,
          Number(info.created) || 0,
          String(info.model || ''),
          info.error ? String(info.error) : null
        ]
      );
    } catch {
      // 台账写不进去不影响提炼结果
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [CONSOLIDATE_LOCK_KEY]);
    } catch {
      // 连接被服务端断掉时锁会随会话消失
    }
    client.release();
  }

  /** 设置页「测试连接」：用**候选配置**试连，不动运行时已生效的连接 */
  async function testConnection(patch = {}) {
    const current = store.getConnection();
    // 归一与「保存并连接」**同源**：`normalizeHost` 认 `postgresql://…` / `host:port/db` 形态，
    // `clampPort` 认非法端口。自己在这里 trim/Number 会出现「测试连接失败、保存却能连上」。
    const candidate = {
      host: patch.host !== undefined ? normalizeHost(patch.host) || current.host : current.host,
      port: patch.port !== undefined ? clampPort(patch.port) : current.port,
      database: patch.database !== undefined ? String(patch.database || '').trim() : current.database,
      user: patch.user !== undefined ? String(patch.user || '').trim() : current.user,
      ssl: patch.ssl !== undefined ? !!patch.ssl : current.ssl,
      password: patch.password !== undefined ? String(patch.password || '') : current.password
    };
    if (!candidate.host || !candidate.database || !candidate.user || !candidate.password) {
      return { ok: false, reason: 'unconfigured', error: '主机 / 库名 / 账号 / 口令都需要填写' };
    }
    const probe = createPgAccess({ log: () => {} });
    try {
      const version = await probe.probe(candidate);
      const caps = await probe.ensureSchema(candidate);
      return { ok: true, serverVersion: version, ...caps };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      probe.dispose();
    }
  }

  return {
    filePath: store.filePath,
    getSettings: store.getSettings,
    saveSettings(patch) {
      const saved = store.saveSettings(patch);
      // 配置一变，连接与可达性全部作废，下次调用重新协商
      pg.reset();
      state.available = false;
      state.lastError = '';
      state.serverVersion = '';
      state.lastProbeAt = 0;
      return saved;
    },
    getStatus,
    active,
    probe,
    heartbeat,
    mirrorItems,
    recall,
    claimConsolidation,
    listConsolidationCandidates,
    applyConsolidation,
    releaseConsolidation,
    testConnection,
    dispose: () => pg.dispose()
  };
}

module.exports = {
  createSharedMemoryService,
  buildRecallQuery,
  buildUpsertQuery,
  contentHash,
  normalizeContent,
  vectorLiteral
};
