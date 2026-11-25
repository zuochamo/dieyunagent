'use strict';

const path = require('path');
const http = require('http');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { createMockGateway } = require('./lib/test-gateway-mock.cjs');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { runRustPlannerPipeline } = require('../src/agent/rust-planner-runner');
const { createMainCompactionAgent } = require('../src/agent/compaction-main');
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
  /** 汇总轮的模式：`content` = 正常回正文；`reasoning-only` = 只回思考（复现 2026-11-19 空气泡） */
  const state = { synthesize: 'content', exploreDispatchesSubagent: 0, requests: [], twoTasksOneWorker: false };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let reply = 'OK';
        let reasoning = null;
        let toolCalls = null;
        try {
          const j = JSON.parse(body);
          state.requests.push(j);
          const sys = j.messages?.[0]?.content || '';
          const user = j.messages?.[j.messages.length - 1]?.content || '';
          const isPlan =
            sys.includes('规划师（大脑）') || (sys.includes('规划师') && sys.includes('JSON'));
          const isExplore = sys.includes('Explore') || sys.includes('只读勘察');
          // 按**各自 prompt 的身份句**路由，不要用「验收」这种会出现在别的提示词里的词：
          // 汇总人格里也写着「见【验收结论】」，用它判会把汇总请求当成验收（回 JSON）。
          const isReview = sys.includes('规划师（验收）');
          const isResearchChild = sys.includes('只读调研子 Agent');
          if (isPlan) {
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
          } else if (isResearchChild) {
            // 研究子 Agent 自己的一轮：给一句结论即可
            reply = 'package.json 的 name 字段是 dieyunagent（子 Agent 已核实）';
          } else if (isExplore && state.exploreDispatchesSubagent > 0) {
            // 回归（2026-11-19）：explore 作为**协调者**派一个只读研究子 Agent。
            // 以前这里必然回 SUBAGENT_DEPTH_EXCEEDED（调用方手写了 subagentDepth: 1）。
            state.exploreDispatchesSubagent -= 1;
            reply = '';
            toolCalls = [
              {
                id: 'call_sub_1',
                type: 'function',
                function: {
                  name: 'subagent',
                  arguments: JSON.stringify({
                    task: '确认 package.json 的 name 字段',
                    label: '核实项目名'
                  })
                }
              }
            ];
          } else if (isExplore) {
            reply = '## 勘察\n- package.json 存在\n- 建议读取 name 字段';
          } else if (isReview) {
            reply = JSON.stringify({ accepted: true, retry: [], notes: '通过' });
          } else if (state.synthesize === 'reasoning-only') {
            // 上游只回思考通道：正文空。以前这条路径会交付成「(模型未生成文字答复。)」
            reply = '';
            reasoning = '思考：package.json 的 name 是 dieyunagent';
          } else if (state.synthesize === 'markup-leak') {
            // 中转把「工具调用」当正文吐回来（2026-11-19 三例实锤的形态）
            reply =
              '<| |DSML| | tool_calls>\n' +
              '<| |DSML| | invoke name="fs_read_file">\n' +
              '<| |DSML| | parameter name="filePath">package.json</| |DSML| | parameter>\n' +
              '</| |DSML| | invoke>\n' +
              '</| |DSML| | tool_calls>';
          } else {
            reply = '## 任务总结\n\nSmoke planner E2E 已完成。';
          }
          // 子 Agent / 执行器：任务里带 package.json 就直接给项目名（规划师/勘察/验收/汇总不受此影响）
          const isWorker = sys.includes('执行器');
          if (isWorker && !reasoning && user.includes('package.json')) {
            reply = 'dieyunagent';
          }
        } catch {
          // ignore
        }
        // 回归（2026-11-19）：同一执行器两个子任务 —— 把计划复制成两条，用来钉「共用一段对话」
        if (state.twoTasksOneWorker && reply && reply.startsWith('{')) {
          try {
            const p = JSON.parse(reply);
            if (Array.isArray(p.subtasks) && p.subtasks.length === 1) {
              p.subtasks.push({ ...p.subtasks[0], id: 'A2' });
              reply = JSON.stringify(p);
            }
          } catch {
            // ignore
          }
        }
        const message = { content: reply };
        if (reasoning != null) message.reasoning_content = reasoning;
        if (toolCalls) message.tool_calls = toolCalls;
        const payload = JSON.stringify({ choices: [{ message }] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

/** 汇总请求数：汇总轮的 system 里带「最终汇总助手」（`build_synthesize_llm_body` 的唯一标志）。 */
function countSummaryRequests(requests) {
  return (requests || []).filter((r) =>
    String((r.messages && r.messages[0] && r.messages[0].content) || '').includes('最终汇总助手')
  ).length;
}

/** 汇总步的 trace 必须如实写「未成文」：写「已完成」就意味着把不可用的东西当成了正文。 */
function assertSummaryUnwritten(trace) {
  const entry = (trace || []).filter((t) => String(t.phase || '') === '汇总').pop();
  if (!entry) throw new Error('trace 里没有「汇总」这一步');
  const thought = String(entry.thought || entry.fullThought || '');
  if (!thought.includes('未成文')) {
    throw new Error(`汇总步必须如实标「未成文」，实际：${JSON.stringify(thought)}`);
  }
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

  const plannerDeps = {
    coreBridge: bridge,
    coordinator,
    worktreeService,
    subagentStore,
    dieyunHome,
    workspaceRootPath: () => workspace,
    localGateway: { getWorkspace: () => ({ kind: 'local', workspacePath: workspace }) },
    // 生产环境由 main-entry 的单例提供；planner 不再自建，故此处显式注入同一契约
    getCompactionAgent: () => createMainCompactionAgent(userData, bridge),
    userData,
    createToolBridge: () => createMainToolBridge({ gateway: testGw, webContents: null })
  };
  const runOnce = (userText, extra = {}) =>
    runRustPlannerPipeline(
      plannerDeps,
      {
        userText,
        sysContent: '你是叠云测试 Agent',
        chatHistoryBlock: '',
        tools,
        apiConfig: { baseUrl: mockLlm.baseUrl, apiKey: 'test' },
        model: 'mock-model',
        ...extra
      },
      {
        onProgress: (trace) => {
          if (trace && trace.length) {
            console.log('[trace]', trace[trace.length - 1].phase);
          }
        }
      }
    ).then(async (res) => {
      // 自洁：真实运行由 Renderer 在「应用/放弃」后清理 worktree，冒烟没有那一步 ——
      // 不清理的话每跑一次就在仓库里留一套 `.dieyun/worktrees/<runId>/A` 与分支（实测已攒十几套）。
      if (res && res.runId && worktreeService && worktreeService.cleanupRunWorktrees) {
        await worktreeService
          .cleanupRunWorktrees(workspace, String(res.runId))
          .catch(() => {});
      }
      return res;
    });

  const result = await runOnce('读取 package.json 项目名');
  console.log('OK planner smoke content:', (result.content || '').slice(0, 200));
  console.log('OK phases:', (result.trace || []).map((t) => t.phase).join(' → '));
  if (!String(result.content || '').includes('Smoke planner E2E 已完成')) {
    throw new Error(`汇总轮正常回正文时应交付原文，实际：${JSON.stringify(result.content)}`);
  }

  // 回归（2026-11-19）：汇总轮**只回思考、正文为空**时，planner 不许把思考当正文交出去
  // （思考永不顶正文），只交空串让 core 重问一次（`synth_retry`）；仍空就如实标「未成文」，
  // 展示侧的带标签思考引用由交付层（`normalizeAssistantReplyForStorage`）出，不在这里伪造。
  mockLlm.state.synthesize = 'reasoning-only';
  mockLlm.state.requests = [];
  const reasoningOnly = await runOnce('再读一次 package.json 项目名');
  const reasoningOnlyText = String(reasoningOnly.content || '');
  if (reasoningOnlyText.includes('package.json 的 name 是 dieyunagent')) {
    throw new Error(`思考不许进交付正文，实际：${JSON.stringify(reasoningOnlyText)}`);
  }
  if (reasoningOnlyText !== '(空响应)') {
    throw new Error(`汇总轮无可用正文时应交空正文哨兵，实际：${JSON.stringify(reasoningOnlyText)}`);
  }
  const summaryRequests = countSummaryRequests(mockLlm.state.requests);
  if (summaryRequests < 2) {
    throw new Error(
      `空正文必须触发 core 的「再要一次最终答复」，实际汇总请求 ${summaryRequests} 次`
    );
  }
  assertSummaryUnwritten(reasoningOnly.trace);
  console.log('OK 汇总轮空正文 → 交空正文 + core 重问一次 → 如实标「未成文」');

  // 回归（2026-11-19 三例实锤）：中转把工具调用当正文吐回来时，`stripToolCallMarkup` 会从标记处
  // 删到**全文末尾** —— 以前这段残渣被当「已完成」往下交，账本里只剩「（模型未生成文字答复。）」，
  // 用户看到的就是「活干完了但任务断了」。现在含标记一律按空正文处理：不冒充成功、标记不进交付。
  mockLlm.state.synthesize = 'markup-leak';
  mockLlm.state.requests = [];
  const leaked = await runOnce('再读一次 package.json 项目名');
  const leakedText = String(leaked.content || '');
  if (/DSML|tool_calls|invoke name=/.test(leakedText)) {
    throw new Error(`工具调用标记不许进交付正文，实际：${JSON.stringify(leakedText)}`);
  }
  assertSummaryUnwritten(leaked.trace);
  console.log('OK 汇总轮正文是工具调用标记 → 不冒充成功，按「未成文」交付');

  // 回归（2026-11-19/20）：开关只代表「允许」，真正拍板的是侧模型（`planner-router`）——
  // 判定（结论 + 理由 + 判定模型思考）必须进思考区**第一张卡**，否则用户看到 3 路执行器时
  // 无法判断是不是判定器判的，也无从复盘误判。
  mockLlm.state.synthesize = 'content';
  const routed = await runOnce('读取 package.json 项目名', {
    plannerRouteReason: '三处独立产物，可并行',
    plannerRouteThinking: '三个文件互不依赖，改完各自能自检'
  });
  const first = (routed.trace || [])[0];
  if (!first || String(first.phase || '') !== '调度 · 侧模型判定') {
    throw new Error(
      `判定卡必须是思考区第一张，实际首张：${JSON.stringify(first && first.phase)}`
    );
  }
  if (!String(first.thought || '').includes('三处独立产物，可并行')) {
    throw new Error(`判定理由要原样写出来，实际：${JSON.stringify(first.thought)}`);
  }
  if (!String(first.fullThought || '').includes('三个文件互不依赖')) {
    throw new Error(`判定模型的思考必须能展开看到，实际：${JSON.stringify(first.fullThought)}`);
  }
  console.log('OK 侧模型判定（结论 + 思考）进思考区第一张卡');

  // 回归（2026-11-20）：**中途改道**（模型跑到一半调 `fan_out`）用的是另一个 phase ——
  // 「开跑前判定器判的」和「跑到一半模型自己要求的」责任方不同，必须能分开看。
  const handedOff = await runOnce('读取 package.json 项目名', {
    plannerRoutePhase: '调度 · 中途改道',
    plannerRouteReason: '模型执行途中要求改道：三处文件互不依赖'
  });
  const handoffFirst = (handedOff.trace || [])[0];
  if (!handoffFirst || String(handoffFirst.phase || '') !== '调度 · 中途改道') {
    throw new Error(
      `中途改道的卡片要有自己的 phase，实际首张：${JSON.stringify(handoffFirst && handoffFirst.phase)}`
    );
  }
  console.log('OK 中途改道的卡片与开跑前判定分开');

  // 回归（2026-11-19）：explore 作为**协调者**必须能派只读研究子 Agent。
  // 以前 planner 自己传 `subagentDepth: 1`，与默认 `subagentMaxDepth: 1` 相撞 →
  // plan 的并发只读调研 100% 被拒（SUBAGENT_DEPTH_EXCEEDED），只读勘察永远串行。
  mockLlm.state.synthesize = 'content';
  mockLlm.state.exploreDispatchesSubagent = 1;
  const withSubagent = await runOnce('读取 package.json 项目名，并让子 Agent 核实一次');
  const phases = (withSubagent.trace || []).map((t) => t.phase || '');
  if (!phases.some((p) => p.includes('调研子 Agent'))) {
    throw new Error(
      `explore 必须能派研究子 Agent（卡片缺失）—— 实际阶段：${phases.join(' → ')}`
    );
  }
  console.log('OK explore 协调者派发研究子 Agent');

  // 回归（2026-11-19 P0-4）：续跑必须**复用被中断那一轮的 runId**。
  // worktree 目录（.dieyun/worktrees/<runId>/<role>）、分支名、变更面板的预演/应用都按 runId 定位；
  // 换一个新 runId 续跑 = 给同一件活新建一套空副本，半成品既看不见也应用不回来。
  const resumeRunId = 'run-smoke-resume-1';
  if (!result.plan) throw new Error('首轮没拿到 plan，无法构造续跑断点');
  subagentStore.saveCheckpoint(dieyunHome(), resumeRunId, {
    status: 'running',
    resumable: true,
    sessionId: null,
    // 直接用第一轮真实产出的 plan（core 的计划形状只有一处生产者，别在测试里手抄）
    plan: result.plan,
    planSummary: String(result.plan.planSummary || ''),
    completedOutputs: [],
    exploreNotes: ''
  });
  const resumed = await runOnce('读取 package.json 项目名', { resumeFromRunId: resumeRunId });
  if (String(resumed.runId) !== resumeRunId) {
    throw new Error(
      `续跑必须复用被中断那一轮的 runId（worktree/预演都按它定位），实际 ${resumed.runId}`
    );
  }
  if (!plannerDeps.coordinator.runs.has(resumeRunId)) {
    throw new Error('续跑必须在同一个 coordinator run 身份下记账');
  }
  console.log('OK 续跑复用原 runId');

  // 回归（2026-11-19）：同一执行器（worker）的多个子任务**共用一段对话** ——
  // 以前每个子任务各起一次 loop run：system / 已读文件全部重建，第二刀会把第一刀查过的东西重查一遍。
  mockLlm.state.twoTasksOneWorker = true;
  mockLlm.state.requests = [];
  await runOnce('读取 package.json 项目名（同一执行器两个子任务）');
  const workerReqs = (mockLlm.state.requests || []).filter((r) =>
    String((r.messages && r.messages[0] && r.messages[0].content) || '').includes('你是执行器')
  );
  if (workerReqs.length < 2) {
    throw new Error(`同一执行器应有 2 段 worker 请求，实际 ${workerReqs.length}`);
  }
  const secondWorkerReq = workerReqs[1];
  if (!Array.isArray(secondWorkerReq.messages) || secondWorkerReq.messages.length < 4) {
    throw new Error(`第二段 worker 请求必须带上第一段历史（消息数 ${secondWorkerReq.messages && secondWorkerReq.messages.length}）`);
  }
  const carriesPrior = secondWorkerReq.messages.some(
    (m) => m.role === 'assistant' && String(m.content || '').includes('dieyunagent')
  );
  if (!carriesPrior) {
    throw new Error('第二段 worker 请求没带上第一段的结果 → 上下文被重建了');
  }
  mockLlm.state.twoTasksOneWorker = false;
  console.log('OK 同一执行器的两个子任务共用一段对话');
  await bridge.stop();
  await mockLlm.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
