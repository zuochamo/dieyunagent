#!/usr/bin/env node
'use strict';

/**
 * Health check: memory SQLite (read-only) + embedding models (builtin + configured remote).
 *
 * 手动排障工具，不接入 npm scripts / CI / smoke 链路。
 * Usage: node scripts/dev/check-memory-health.cjs [--user-data PATH]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const { createEmbeddingClient } = require('../../src/codebase/embedding-client');
const {
  hasBuiltinEmbeddingModel,
  BUILTIN_EMBEDDING_ID,
  BUILTIN_EMBEDDING_DIMENSIONS
} = require('../../src/codebase/local-embedding');
const { loadModelSettings, getEmbeddingConfig } = require('../../src/model-settings');

function guessUserData() {
  const argIdx = process.argv.indexOf('--user-data');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return path.resolve(process.argv[argIdx + 1]);
  }
  const appName = 'dieyunagent';
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', appName),
    path.join(os.homedir(), 'AppData', 'Roaming', 'pixel-office-agent'),
    path.join(os.homedir(), 'AppData', 'Roaming', '叠云 Agent'),
    path.join(os.homedir(), '.config', appName)
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

async function probeEmbedding(label, config) {
  const client = createEmbeddingClient(config || {});
  const out = {
    label,
    enabled: client.enabled(),
    model: client.model,
    dimensions: client.dimensions,
    builtin: !!config?.builtin || client.builtin,
    url: client.url || '(builtin local)',
    ok: false,
    vectorLen: 0,
    error: null
  };
  if (!out.enabled) {
    out.error = 'embedding disabled';
    return out;
  }
  try {
    const [vec] = await client.embed('叠云记忆与向量健康检查');
    out.ok = Array.isArray(vec) && vec.length > 0;
    out.vectorLen = vec?.length || 0;
    if (out.vectorLen && out.vectorLen !== out.dimensions) {
      out.warn = `returned ${out.vectorLen} dims, expected ${out.dimensions}`;
    }
  } catch (err) {
    out.error = err.message || String(err);
  }
  return out;
}

function checkMemoryDb(userData) {
  const dbPath = path.join(userData, 'diecloud-memory.sqlite');
  const result = {
    userData,
    dbPath,
    dbExists: fs.existsSync(dbPath),
    sessions: 0,
    messages: 0,
    longMemories: 0,
    vectors: 0,
    consolidationJobs: 0,
    recentLong: [],
    vectorStatus: null,
    error: null
  };
  if (!result.dbExists) {
    result.error = 'memory sqlite not found (app may not have run yet)';
    return result;
  }

  /** @type {import('better-sqlite3').Database | null} */
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    result.sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n || 0;
    result.messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n || 0;
    result.longMemories =
      db.prepare("SELECT COUNT(*) AS n FROM long_memories WHERE status IN ('active','stale')").get()?.n || 0;
    result.vectors = db.prepare('SELECT COUNT(*) AS n FROM long_memory_vectors').get()?.n || 0;
    result.consolidationJobs =
      db.prepare('SELECT COUNT(*) AS n FROM memory_consolidation_jobs').get()?.n || 0;
    result.recentLong = db
      .prepare(
        "SELECT id, kind, source, content FROM long_memories WHERE status IN ('active','stale') ORDER BY id DESC LIMIT 5"
      )
      .all()
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        source: r.source,
        preview: String(r.content || '').slice(0, 80)
      }));
    const total = result.longMemories;
    result.vectorStatus = {
      total,
      vectorCount: result.vectors,
      note: 'read via SQLite (MemoryStore is Rust-only)'
    };
  } catch (err) {
    result.error = err.message || String(err);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return result;
}

async function main() {
  const userData = guessUserData();
  const settings = loadModelSettings(userData);
  const embeddingCfg = getEmbeddingConfig(settings);

  console.log('=== 叠云 Agent · 记忆 & 向量健康检查 ===\n');
  console.log('UserData:', userData);
  console.log(
    'Settings file:',
    fs.existsSync(path.join(userData, 'model-settings.json')) ? 'found' : 'missing (using defaults)'
  );

  const builtinProbe = await probeEmbedding('builtin:bge-base-zh-v1.5', {
    model: BUILTIN_EMBEDDING_ID,
    builtin: true,
    localFallback: true
  });
  const remoteProbe = embeddingCfg.builtin
    ? null
    : await probeEmbedding(`remote:${embeddingCfg.model}`, embeddingCfg);

  console.log('\n--- 向量模型 ---');
  console.log('Builtin model files:', hasBuiltinEmbeddingModel() ? 'OK' : 'MISSING');
  console.log('Builtin embed test:', formatProbe(builtinProbe));
  if (embeddingCfg.builtin) {
    console.log('Active config: fallback to builtin (no remote baseUrl/model in settings)');
  } else {
    console.log('Active config:', `${embeddingCfg.model} @ ${embeddingCfg.baseUrl} (${embeddingCfg.dimensions}d)`);
    console.log('Remote embed test:', formatProbe(remoteProbe));
  }

  const mem = checkMemoryDb(userData);
  console.log('\n--- 记忆库 SQLite ---');
  console.log('DB:', mem.dbExists ? mem.dbPath : mem.error);
  if (mem.dbExists) {
    console.log(`Sessions: ${mem.sessions}, Messages: ${mem.messages}`);
    console.log(`Long memories (active/stale): ${mem.longMemories}, Vector rows: ${mem.vectors}`);
    console.log(`Consolidation jobs: ${mem.consolidationJobs}`);
    if (mem.recentLong.length) {
      console.log('Recent long memories:');
      for (const r of mem.recentLong) {
        console.log(`  #${r.id} [${r.kind}/${r.source}] ${r.preview}`);
      }
    } else {
      console.log('Recent long memories: (none)');
    }
    if (mem.vectorStatus) {
      const coverage =
        mem.vectorStatus.total > 0
          ? Math.round((mem.vectorStatus.vectorCount / mem.vectorStatus.total) * 100)
          : 100;
      console.log('\n--- 长期记忆向量索引 ---');
      console.log('Vector status:', JSON.stringify(mem.vectorStatus));
      console.log(`Index coverage: ${mem.vectorStatus.vectorCount}/${mem.vectorStatus.total} (${coverage}%)`);
      console.log('Recall test: skipped (use dieyun-core memory.long_recall in app)');
    }
  }

  console.log('\n--- 结论 ---');
  const issues = [];
  if (!hasBuiltinEmbeddingModel()) issues.push('内置 bge-base-zh-v1.5 模型文件缺失');
  if (!builtinProbe.ok) issues.push(`内置向量推理失败: ${builtinProbe.error}`);
  if (remoteProbe && !remoteProbe.ok) issues.push(`配置的远程向量模型不可用: ${remoteProbe.error}`);
  if (!mem.dbExists) issues.push('记忆数据库尚未创建');
  else if (mem.error) issues.push(`记忆库读取失败: ${mem.error}`);

  if (issues.length) {
    console.log('⚠ 发现问题:');
    for (const i of issues) console.log(' -', i);
    process.exitCode = 1;
  } else {
    console.log('✓ 记忆模块与向量链路基本健康');
  }
}

function formatProbe(p) {
  if (!p) return 'n/a';
  if (p.ok) return `OK (${p.vectorLen} dims${p.warn ? ', ' + p.warn : ''})`;
  return `FAIL — ${p.error}`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
