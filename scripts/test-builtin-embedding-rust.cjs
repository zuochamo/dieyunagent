'use strict';

/**
 * 验证 Rust 内置 bge-base-zh-v1.5 embedding 索引与向量检索。
 */
const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { BUILTIN_EMBEDDING_ID, BUILTIN_EMBEDDING_DIMENSIONS } = require('../src/codebase/local-embedding');

async function main() {
  const bin = resolveDieyunCoreBinary();
  if (!bin) {
    console.error('未找到 dieyun-core，请先运行: npm run pack:dieyun-core');
    process.exit(1);
  }

  const workspace = path.resolve(process.argv[2] || process.cwd());
  const dataDir = path.join(require('os').tmpdir(), 'dieyun-core-builtin-test');
  const modelsDir = path.join(__dirname, '..', 'models');
  const bridge = createCoreBridge({
    binaryPath: bin,
    log: (m) => console.log('[core]', m)
  });

  await bridge.start();
  await bridge.configure({
    data_dir: dataDir,
    workspace_roots: [workspace],
    models_dirs: [modelsDir],
    embedding: {
      disabled: false,
      builtin: true,
      baseUrl: '',
      apiKey: '',
      model: BUILTIN_EMBEDDING_ID,
      dimensions: BUILTIN_EMBEDDING_DIMENSIONS
    }
  });

  const st = await bridge.invoke('codebase.index', { workspaceRoot: workspace, force: true }, 600000);
  console.log('index:', {
    vectorCount: st.vectorCount,
    embeddingModel: st.embeddingModel,
    embeddingDims: st.embeddingDims
  });

  if (!st.vectorCount || st.vectorCount <= 0) {
    throw new Error('内置 embedding 未写入向量，请确认 models/bge-base-zh-v1.5/onnx/model_quantized.onnx 存在');
  }
  if (st.embeddingModel !== `${BUILTIN_EMBEDDING_ID}@${BUILTIN_EMBEDDING_DIMENSIONS}`) {
    throw new Error(`embedding 签名异常: ${st.embeddingModel}`);
  }

  const search = await bridge.invoke('codebase.search', {
    workspaceRoot: workspace,
    query: 'AgentRunEvent 事件流',
    limit: 5,
    autoIndex: false
  });
  console.log('search:', {
    vectorSearch: search.vectorSearch,
    hits: search.results?.length || 0,
    first: search.results?.[0]?.path
  });
  if (!search.vectorSearch) {
    throw new Error('vectorSearch 应为 true');
  }

  await bridge.stop();
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
