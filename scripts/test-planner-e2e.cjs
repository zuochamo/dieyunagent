'use strict';

/**
 * planner 管线端到端（**不联网**）：本地假 LLM + 真 dieyun-core + 真 git worktree。
 *
 * 验的是「设置里打开多 Agent 并行执行」之后这一整条链真的能跑通：
 *   规划 →（只读勘察）→ 两路写入执行器**同时**跑 → 各自 worktree 落地 → 主工作区一动不动
 *   → 预览出两路变更 → 应用回主工作区。
 *
 * 关键断言是 `maxWorkerConcurrent`：假 LLM 服务端数「同一时刻在跑的 worker 请求数」。
 * 它必须是 2 —— 这是「并发真的发生了」而不是「代码里写了个 Promise.all」的证据。
 *
 * 需要 dieyun-core 可执行文件（target/debug 或 DIEYUN_CORE_BIN）；没有则 SKIP。
 * 需要 git 在 PATH 里。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { DEFAULTS: PERMISSION_DEFAULTS } = require('../src/gateway/permissions-store');
const { AgentRunCoordinator } = require('../src/agent/coordinator');
const worktreeService = require('../src/git/worktree-service');

const PLAN_JSON = JSON.stringify({
  planSummary: '两个互不依赖的文件各改一份',
  todos: ['拆成两路', '并行改', '验收合并'],
  subtasks: [
    {
      id: 'A1',
      worker: 'A',
      agentType: 'build',
      title: '改 alpha',
      instruction: '把 src/alpha.js 写成 A 的内容',
      expectedOutput: 'src/alpha.js 内容为 A'
    },
    {
      id: 'B1',
      worker: 'B',
      agentType: 'build',
      title: '改 beta',
      instruction: '把 src/beta.js 写成 B 的内容',
      expectedOutput: 'src/beta.js 内容为 B'
    }
  ]
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function coreBinaryPath() {
  const exe = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
  return (
    process.env.DIEYUN_CORE_BIN ||
    resolveDieyunCoreBinary() ||
    path.join(__dirname, '..', 'target', 'debug', exe)
  );
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fs_write_file',
      description: '写入文件',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' }, content: { type: 'string' } },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_read_file',
      description: '读取文件',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath']
      }
    }
  }
];

/** 从 messages 里看出这是哪一种请求（测试桩的分流依据，不参与生产逻辑）。 */
function classify(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
  // 顺序要紧：规划师（大脑）的提示词里也出现「验收」二字，先判大脑再判验收。
  if (sys.includes('规划师（大脑）')) return 'plan';
  if (sys.includes('规划师（验收）')) return 'review';
  if (sys.includes('最终汇总助手')) return 'synthesize';
  if (sys.includes('Explore 子 Agent')) return 'explore';
  const m = sys.match(/你是执行器 ([A-F])/);
  if (m) return `worker-${m[1]}`;
  return 'unknown';
}

/** 该请求是否已经拿到过工具结果（= 第二轮，该收尾了）。 */
function hasToolResult(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  return msgs.some((m) => m.role === 'tool');
}

function sseWrite(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function streamText(res, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  const parts = String(text).match(/[\s\S]{1,40}/g) || [''];
  for (const part of parts) {
    sseWrite(res, { choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
  }
  sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamToolCall(res, name, args) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  sseWrite(res, {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: `call_${name}_1`, type: 'function', function: { name, arguments: '' } }
          ]
        },
        finish_reason: null
      }
    ]
  });
  sseWrite(res, {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
        finish_reason: null
      }
    ]
  });
  sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function jsonBody(res, content) {
  const payload = {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  };
  const text = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 假 LLM：按 system prompt 分流；worker 第一轮发工具调用、第二轮收尾。
 * 同时统计「同时在跑的 worker 请求数」，作为并发证据。
 */
function startFakeLlm(state) {
  const WORKER_DELAY_MS = 150; // 让「同时在跑」可被观测（响应瞬时完成的话并发度恒为 1）
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      const kind = classify(body);
      state.kinds.push(kind);
      if (kind === 'unknown') {
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
        state.unmatched.push(sys.slice(0, 200));
      }
      const isWorker = kind.startsWith('worker-');
      if (isWorker) {
        state.workerRequests += 1;
        state.workerInFlight += 1;
        state.maxWorkerConcurrent = Math.max(state.maxWorkerConcurrent, state.workerInFlight);
        await new Promise((r) => setTimeout(r, WORKER_DELAY_MS));
        state.workerInFlight -= 1;
      }
      try {
        if (kind === 'plan') return jsonBody(res, PLAN_JSON);
        if (kind === 'review') return jsonBody(res, '{"accepted":true,"retry":[],"notes":"ok"}');
        if (kind === 'synthesize') return jsonBody(res, '两路都已改好。');
        if (kind === 'explore') return streamText(res, '勘察：两个文件互不依赖。');
        if (isWorker) {
          const worker = kind.slice('worker-'.length);
          if (hasToolResult(body)) return streamText(res, `${worker} 已完成`);
          const file = worker === 'A' ? 'src/alpha.js' : 'src/beta.js';
          return streamToolCall(res, 'fs_write_file', { filePath: file, content: `${worker}\n` });
        }
        return jsonBody(res, 'ok');
      } catch (e) {
        try {
          res.destroy(e);
        } catch {
          /* ignore */
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/**
 * 跑一次完整 planner 管线。
 * @param {{ bin: string, gitRepo: boolean }} opts
 */
async function runPipelineCase(opts) {
  const { bin, gitRepo } = opts;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-planner-e2e-'));
  const repo = path.join(root, 'repo');
  const userData = path.join(root, 'userData');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.dieyun/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'src', 'keep.js'), 'keep\n');
  if (gitRepo) {
    git(repo, 'init');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=test@dieyun.local', '-c', 'user.name=dieyun-test', 'commit', '-m', 'init');
  }

  const state = { workerRequests: 0, workerInFlight: 0, maxWorkerConcurrent: 0, kinds: [], unmatched: [] };
  const fake = await startFakeLlm(state);

  const bridge = createCoreBridge({ binaryPath: bin });
  await bridge.start();
  await bridge.configure({
    data_dir: path.join(root, 'core-data'),
    workspace_roots: [repo],
    embedding: { disabled: true, builtin: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024 }
  });

  const gateway = {
    getPermissions: () => ({ ...PERMISSION_DEFAULTS }),
    invokeRpc: async (method, params) => {
      // 只有 fs 写走真磁盘（模拟 Gateway 的落盘），其余给空成功
      if (method === 'fs.write_file') {
        const target = String(params.filePath || '');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(params.data == null ? '' : params.data));
        return { ok: true, path: target };
      }
      if (method === 'fs.read_file') {
        try {
          return { ok: true, data: fs.readFileSync(String(params.filePath || ''), 'utf8') };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      return { ok: true };
    }
  };

  const deps = {
    coreBridge: bridge,
    userData,
    dieyunHome: () => home,
    coordinator: new AgentRunCoordinator(),
    worktreeService,
    subagentStore: require('../src/agent/subagent-store'),
    workspaceRootPath: () => repo,
    resolveAgentRunWorkspacePath: async () => repo,
    localGateway: { getWorkspace: () => ({ kind: 'local', workspacePath: repo }) },
    getCompactionAgent: () => ({ maybeCompactMessages: async (messages) => ({ messages }) }),
    createToolBridge: () => createMainToolBridge({ gateway, userDataPath: userData, webContents: null })
  };

  const { runRustPlannerPipeline } = require('../src/agent/rust-planner-runner');
  const phases = [];
  let result = null;
  try {
    result = await runRustPlannerPipeline(
      deps,
      {
        model: 'fake-model',
        sysContent: '你是叠云 Agent。',
        userText: '把 alpha 和 beta 两个文件各自改好',
        chatHistoryBlock: '',
        hasImages: false,
        tools: TOOLS,
        sessionId: 'e2e-session',
        contextTierId: 'default',
        workspacePath: repo,
        apiConfig: { baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-model' }
      },
      { webContents: null, onPhase: (name) => phases.push(name), onProgress: () => {} }
    );
  } finally {
    await fake.server.close();
    await bridge.stop().catch(() => {});
  }

  assert(result, 'planner 应返回结果');
  assert(result.content && result.content.length > 0, `最终正文不应为空: ${JSON.stringify(result)}`);
  console.log('   request kinds:', state.kinds.join(' | '));
  if (state.unmatched.length) console.log('   unmatched system heads:', JSON.stringify(state.unmatched, null, 1));
  console.log(`   phases: ${[...new Set(phases)].join(' → ')}`);
  assert(
    ['need_plan_llm', 'need_workers', 'need_review_llm', 'need_synthesize_llm'].every((p) => phases.includes(p)),
    `管线应走到「拆解 → 执行 → 验收 → 汇总」，实际 ${[...new Set(phases)].join(',')}`
  );
  assert.strictEqual(state.workerRequests, 4, `两路各两轮请求，共 4 次，实际 ${state.workerRequests}`);

  const runId = result.runId;
  assert(runId, 'planner 应返回 coordinator runId');

  if (gitRepo) {
    // ① 两路 worker 真的同时跑（假 LLM 侧统计的并发数）
    assert.strictEqual(
      state.maxWorkerConcurrent,
      2,
      `两路写入执行器的 LLM 请求应同时在跑（实际最大并发 ${state.maxWorkerConcurrent}）`
    );

    // ② 隔离：执行器各自写了 worktree，主工作区此刻还没变
    assert(!fs.existsSync(path.join(repo, 'src', 'alpha.js')), '执行器产出不得直接落在主工作区');
    assert(!fs.existsSync(path.join(repo, 'src', 'beta.js')), '执行器产出不得直接落在主工作区');

    const preview = await worktreeService.previewRunWorktreeChanges(repo, runId);
    assert(preview && preview.ok, `预览失败: ${JSON.stringify(preview)}`);
    const alpha = preview.changes.find((c) => c.repoPath === 'src/alpha.js');
    const beta = preview.changes.find((c) => c.repoPath === 'src/beta.js');
    assert(alpha && alpha.roleId === 'A', `alpha 应来自执行器 A，实际 ${JSON.stringify(preview.changes)}`);
    assert(beta && beta.roleId === 'B', `beta 应来自执行器 B，实际 ${JSON.stringify(preview.changes)}`);
    assert(alpha.conflict !== true && beta.conflict !== true, '两路改的是不同文件，不应有冲突');

    // ③ 合并：应用后主工作区才有这两份产出
    const applied = await worktreeService.applyRunWorktreeChanges(repo, runId, {
      paths: ['src/alpha.js', 'src/beta.js']
    });
    assert.strictEqual(applied.ok, true, `应用失败: ${JSON.stringify(applied)}`);
    assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'alpha.js'), 'utf8'), 'A\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'beta.js'), 'utf8'), 'B\n');

    await worktreeService.cleanupRunWorktrees(repo, runId).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    console.log('ok planner 端到端（git）：两路执行器并发跑 + 各自 worktree 隔离 + 变更合并');
    return;
  }

  // 非 git 工作区：没有隔离能力 → 必须**退成串行**（绝不允许两路同时写主工作区）
  assert.strictEqual(
    state.maxWorkerConcurrent,
    1,
    `非 git 工作区必须退成串行（实际最大并发 ${state.maxWorkerConcurrent}）`
  );
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'alpha.js'), 'utf8'), 'A\n');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'beta.js'), 'utf8'), 'B\n');
  const preview = await worktreeService.previewRunWorktreeChanges(repo, runId);
  assert.strictEqual(preview.ok, false, '非 git 工作区预览应明确失败（界面据此提示「改动已直接写入」）');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok planner 端到端（非 git）：自动退成串行 + 改动直接落主工作区');
}

async function main() {
  const bin = coreBinaryPath();
  if (!fs.existsSync(bin)) {
    console.log('SKIP planner-e2e（没有 dieyun-core 可执行文件；先 npm run pack:dieyun-core）');
    return;
  }
  await runPipelineCase({ bin, gitRepo: true });
  await runPipelineCase({ bin, gitRepo: false });
  console.log('test-planner-e2e.cjs ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
