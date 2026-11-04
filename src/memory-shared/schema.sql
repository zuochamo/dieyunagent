-- 共享记忆（跨机）PostgreSQL 结构。
--
-- 幂等：应用启动 / 探活成功时执行一次（`src/memory-shared/pg.js#ensureSchema`）。
-- 可选项：`vector`（pgvector）与 `pg_trgm` 两个扩展**都不是必需的**。
-- 有 vector 才有向量列与语义召回，有 pg_trgm 才有文本相似度；都没有时召回退化成
-- 「活跃 + 项目可见 + 重要度/冷热排序」（`service.js#buildRecallQuery` 已经这么写了）。
-- 所以本文件用 `DO $$ … IF EXISTS (pg_extension) … $$` 按能力建列/建索引：
-- 以前无条件写 `embedding vector` 与 `gin_trgm_ops`，缺扩展时整批 DDL 回滚 →
-- 整库被判「连不上」，而那两条降级分支永远走不到。
--
-- 只有 3 张表。旧「蜂群共享记忆」（已删，见 docs/SHARED-MEMORY.md 的沿革一节）有 7 张：
-- 它把**每条对话**都上传、用角色（master/slave）+ 同步游标保证不丢，代价是 N 台机 × 每条消息。
-- 现在的边界是「只同步记忆条目」，因此会话副本、消息副本、同步游标全都不需要。

CREATE TABLE IF NOT EXISTS shared_memory (
  id             bigserial PRIMARY KEY,
  content        text NOT NULL,
  -- 归一化正文的 sha256：同一句话在任何机器、任何时间写入都只有一行
  content_hash   text NOT NULL UNIQUE,
  kind           text NOT NULL DEFAULT 'normal',
  source         text NOT NULL DEFAULT 'consolidation',
  -- 'global'（跨项目通用）或 'project:<项目 key>'；显式来源文件里没有项目级条目，先只写 global
  scope          text NOT NULL DEFAULT 'global',
  node_id        text NOT NULL DEFAULT '',
  importance     real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  -- 向量列**不声明维度**：各机配置的 embedding 模型维度可能不同（默认 1024，可改）。
  -- 比较前用 embedding_dim 过滤，维度不同的行只参与文本排名 —— 不另开一张表、不另写一套查询。
  -- 列本身在下面按「有没有 pgvector」条件添加（`embedding vector`）。
  embedding_model text,
  embedding_dim  integer,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'merged', 'archived')),
  merged_into    bigint REFERENCES shared_memory(id) ON DELETE SET NULL,
  access_count   integer NOT NULL DEFAULT 0,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 召回是「活跃 + 本项目可见」的扫描；量级预期几千条，全量扫描即可（见 docs/SHARED-MEMORY.md）
CREATE INDEX IF NOT EXISTS shared_memory_scope_status_idx
  ON shared_memory (scope, status, updated_at DESC);

-- 能力相关的列与索引：扩展不在就跳过（而不是让整份 schema 失败）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE shared_memory ADD COLUMN IF NOT EXISTS embedding vector';
    EXECUTE 'CREATE INDEX IF NOT EXISTS shared_memory_embedding_dim_idx
               ON shared_memory (embedding_dim) WHERE embedding IS NOT NULL';
  END IF;

  -- 文本兜底通道：中文没有分词器（FTS 的 simple 配置切不开中文），trigram 是唯一可用的相似度
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS shared_memory_content_trgm_idx
               ON shared_memory USING gin (content gin_trgm_ops)';
  END IF;
END
$$;

-- 参与节点：只用于「哪些机器在共用这份记忆」的可见性，没有角色字段
-- （谁来提炼由 pg_try_advisory_lock 决定，不需要 master/slave 配置）
CREATE TABLE IF NOT EXISTS memory_nodes (
  node_id        text PRIMARY KEY,
  hostname       text,
  client_version text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- 提炼台账：谁抢到锁、扫了几条、合并了几条、失败原因
CREATE TABLE IF NOT EXISTS memory_consolidations (
  id          bigserial PRIMARY KEY,
  node_id     text,
  trigger     text NOT NULL DEFAULT 'scheduled',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scanned     integer NOT NULL DEFAULT 0,
  merged      integer NOT NULL DEFAULT 0,
  created     integer NOT NULL DEFAULT 0,
  model       text,
  error       text
);
