'use strict';

/** 快速 smoke：单轮 LLM，无工具 */
const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { runRustAgentLoop } = require('../src/agent/rust-loop-runner');
const { loadModelSettings } = require('../src/model-settings');

async function main() {
  const settings = loadModelSettings(process.env.DIEYUN_USER_DATA || require('os').tmpdir());
  const baseUrl = process.env.DIEYUN_TEST_LLM_BASE_URL || settings.baseUrl;
  const apiKey = process.env.DIEYUN_TEST_LLM_API_KEY || settings.apiKey;
  const model = process.env.DIEYUN_TEST_LLM_MODEL || settings.textModel;
  if (!baseUrl || !model) {
    console.log(
      'SKIP: LLM baseUrl/model 未配置；设置 DIEYUN_TEST_LLM_BASE_URL / DIEYUN_TEST_LLM_API_KEY / DIEYUN_TEST_LLM_MODEL，' +
        '或将 DIEYUN_USER_DATA 指向含 model-settings.json 的目录后可运行完整 smoke。'
    );
    return;
  }
  const bridge = createCoreBridge({ binaryPath: resolveDieyunCoreBinary() });
  await bridge.start();
  await bridge.configure({
    data_dir: path.join(require('os').tmpdir(), 'dieyun-rust-smoke'),
    workspace_roots: [process.cwd()],
    models_dirs: [path.join(__dirname, '..', 'models')],
    embedding: { disabled: true, builtin: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024 }
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl, apiKey },
    startParams: {
      model,
      maxRounds: 2,
      maxToolCalls: 0,
      tools: [],
      messages: [
        { role: 'system', content: '简洁回答' },
        { role: 'user', content: '用一句话介绍 Rust agent loop smoke test' }
      ]
    },
    onPhase: (p) => {
      if (p !== 'llm_delta') console.log('[phase]', p);
    }
  });
  console.log('OK content:', (result.content || '').slice(0, 200));
  await bridge.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
