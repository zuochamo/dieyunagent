'use strict';

/**
 * 验证 Rust agent loop（需配置 LLM + dieyun-core + 本地 workspace）。
 * 用法: node scripts/test-rust-agent-loop.cjs [workspacePath]
 * 环境: LLM 使用 model-settings 或 DIEYUN_TEST_LLM_* 变量
 */
const path = require('path');
const fs = require('fs');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { runRustAgentLoop } = require('../src/agent/rust-loop-runner');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { loadModelSettings, getEmbeddingConfig } = require('../src/model-settings');
const { createMockGateway } = require('./lib/test-gateway-mock.cjs');

async function main() {
  const bin = resolveDieyunCoreBinary();
  if (!bin) {
    console.error('未找到 dieyun-core');
    process.exit(1);
  }

  const workspace = path.resolve(process.argv[2] || process.cwd());
  const userData = path.join(require('os').tmpdir(), 'dieyun-agent-loop-test');
  const settings = loadModelSettings(userData);
  const baseUrl = process.env.DIEYUN_TEST_LLM_BASE_URL || settings.baseUrl;
  const apiKey = process.env.DIEYUN_TEST_LLM_API_KEY || settings.apiKey;
  const model = process.env.DIEYUN_TEST_LLM_MODEL || settings.textModel;
  if (!baseUrl || !apiKey || !model) {
    console.error('请配置 LLM（model-settings 或 DIEYUN_TEST_LLM_*）');
    console.error('  baseUrl:', baseUrl || '(missing)');
    console.error('  apiKey:', apiKey ? '(set)' : '(missing)');
    console.error('  model:', model || '(missing)');
    process.exit(1);
  }
  console.log('[test] LLM', { baseUrl, model });

  const bridge = createCoreBridge({ binaryPath: bin, log: (m) => console.log('[core]', m) });
  await bridge.start();

  const embedding = getEmbeddingConfig(settings);
  await bridge.configure({
    data_dir: userData,
    workspace_roots: [workspace],
    models_dirs: [path.join(__dirname, '..', 'models')],
    embedding: {
      disabled: !!embedding.disabled,
      builtin: !!embedding.builtin,
      baseUrl: embedding.baseUrl || '',
      apiKey: embedding.apiKey || '',
      model: embedding.model || '',
      dimensions: Number(embedding.dimensions) || 1024
    }
  });

  const testGw = createMockGateway(workspace);
  const toolBridge = createMainToolBridge({ gateway: testGw, webContents: null });

  const ping = await bridge.invoke('agent.ping', {});
  console.log('agent.ping:', ping);

  const nativeTools = [
    {
      type: 'function',
      function: {
        name: 'fs_read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'codebase_search',
        description: 'search codebase',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    }
  ];

  const startParams = {
    model,
    workspaceRoot: workspace,
    maxToolCalls: 8,
    maxRounds: 6,
    tools: nativeTools,
    messages: [
      {
        role: 'system',
        content: '你是代码助手。需要读文件或搜代码时使用工具，不要编造。'
      },
      {
        role: 'user',
        content: `请用 fs_read_file 读取 package.json（路径: ${path.join(workspace, 'package.json')}），一句话说出项目名。`
      }
    ]
  };

  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl, apiKey },
    startParams,
    useStream: process.env.DIEYUN_TEST_LLM_STREAM !== '0',
    onPhase: (p, d) => {
      if (p !== 'llm_delta') console.log('[phase]', p, d?.runId || '');
    },
    delegateTool: async (name, args) =>
      toolBridge.executeAgentTool(name, args, { workspacePath: workspace })
  });

  console.log('done content:', (result.content || '').slice(0, 500));
  console.log('trace rounds:', result.trace?.length || 0);
  await bridge.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
