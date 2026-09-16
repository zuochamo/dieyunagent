'use strict';

const path = require('path');
const http = require('http');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { createMockGateway } = require('./lib/test-gateway-mock.cjs');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { runRustPlannerPipeline } = require('../src/agent/rust-planner-runner');
const { loadModelSettings } = require('../src/model-settings');
const { AgentRunCoordinator } = require('../src/agent/coordinator');
const worktreeService = require('../src/git/worktree-service');
const subagentStore = require('../src/agent/subagent-store');

function coreBinaryPath() {
  const exe = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
  return (
    process.env.DIEYUN_CORE_BIN ||
    resolveDieyunCoreBinary() ||
    path.join(__dirname, '..', 'target', 'debug', exe)
  );
}

function startMockLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let reply = 'OK';
        try {
          const j = JSON.parse(body);
          const sys = j.messages?.[0]?.content || '';
          const user = j.messages?.[j.messages.length - 1]?.content || '';
          if (sys.includes('规划师（大脑）') || (sys.includes('规划师') && sys.includes('JSON'))) {
            reply = JSON.stringify({
              planSummary: 'smoke test',
              todos: ['执行', '验证'],
              subtasks: [
                {
                  id: 'A1',
                  worker: 'A',
                  agentType: 'shell',
                  title: '读 package.json',
                  instruction: `用 fs_read_file 读取 ${path.join(process.cwd(), 'package.json')} 并返回 name 字段`,
                  expectedOutput: '项目名'
                }
              ]
            });
          } else if (sys.includes('Explore') || sys.includes('只读勘察')) {
            reply = '## 勘察\n- package.json 存在\n- 建议读取 name 字段';
          } else if (sys.includes('验收')) {
            reply = JSON.stringify({ accepted: true, retry: [], notes: '通过' });
          } else {
            reply = '## 任务总结\n\nSmoke planner E2E 已完成。';
          }
          if (user.includes('package.json')) {
            reply = 'dieyunagent';
          }
        } catch {
          // ignore
        }
        const payload = JSON.stringify({
          choices: [{ message: { content: reply } }]
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

async function main() {
  const bin = coreBinaryPath();
  if (!bin) {
    console.error('未找到 dieyun-core');
    process.exit(1);
  }
  const workspace = path.resolve(process.cwd());
  const userData = path.join(require('os').tmpdir(), 'dieyun-planner-smoke');
  const mockLlm = await startMockLlm();
  const settings = loadModelSettings(userData);
  settings.baseUrl = mockLlm.baseUrl;
  settings.apiKey = 'test';
  settings.textModel = 'mock-model';

  const bridge = createCoreBridge({ binaryPath: bin });
  await bridge.start();
  await bridge.configure({
    data_dir: userData,
    workspace_roots: [workspace],
    models_dirs: [path.join(__dirname, '..', 'models')],
    embedding: { disabled: true, builtin: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024 }
  });

  const testGw = createMockGateway(workspace);
  const coordinator = new AgentRunCoordinator();
  const dieyunHome = () => path.join(userData, 'dieyun-home');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'fs_read_file',
        description: 'read',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        }
      }
    }
  ];

  const result = await runRustPlannerPipeline(
    {
      coreBridge: bridge,
      coordinator,
      worktreeService,
      subagentStore,
      dieyunHome,
      workspaceRootPath: () => workspace,
      localGateway: { getWorkspace: () => ({ kind: 'local', workspacePath: workspace }) },
      userData,
      createToolBridge: () => createMainToolBridge({ gateway: testGw, webContents: null })
    },
    {
      userText: '读取 package.json 项目名',
      sysContent: '你是叠云测试 Agent',
      chatHistoryBlock: '',
      tools,
      apiConfig: { baseUrl: mockLlm.baseUrl, apiKey: 'test' },
      model: 'mock-model'
    },
    {
      onProgress: (trace) => {
        if (trace && trace.length) {
          console.log('[trace]', trace[trace.length - 1].phase);
        }
      }
    }
  );

  console.log('OK planner smoke content:', (result.content || '').slice(0, 200));
  console.log('OK phases:', (result.trace || []).map((t) => t.phase).join(' → '));
  await bridge.stop();
  await mockLlm.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
