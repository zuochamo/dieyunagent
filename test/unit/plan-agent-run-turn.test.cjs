'use strict';

/**
 * 「计划这一轮到底喂了什么」—— 计划执行器的编排夹具。
 *
 * 为什么需要它：`plan-agent-runner` 与 `main-turn-runner` 是两条「跑一轮」的路，历史上靠注释维系一致
 * （同一句「逐字段重建会丢 headers」抄了四份）。2026-11-21 把历史装配 / helpers / 轮次上限 /
 * 空交付文案 / 模型解析都收成了单一来源，**但没有夹具就不知道合并有没有改变计划轮的行为**。
 *
 * 这里用 `ctx.runRustAgentLoop`（测试缝，生产不传）把整条编排跑起来，钉住四件事：
 * 1. 系统提示里必须同时有：身份段、`【定时计划 Agent】`、`计划名称：`、`【本次任务】`；
 * 2. `startParams`：模型名、轮次上限（= agent-limits 的 clamp 值）、工具上限、workspaceRoot；
 * 3. `trigger === 'goal'` 的计划多两个目标工具；普通计划没有；
 * 4. 派发到工具桥的工具调用会被计数（收尾事实 `mutatingToolCalls` 的来源）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPlanAgentLoop } = require('../../src/plans/plan-agent-runner');
const { AGENT_LIMITS_DEFAULTS, resolveAgentMaxRounds } = require('../../src/agent/agent-limits');
const { clampModelRuntimeValue } = require('../../src/agent/model-runtime-schema');

function tmpUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-run-'));
  fs.writeFileSync(
    path.join(dir, 'model-settings.json'),
    JSON.stringify({
      apiKey: 'k-test',
      baseUrl: 'https://llm.example/v1',
      textModel: 'mimo-v2.5-pro'
    }),
    'utf8'
  );
  return dir;
}

/**
 * @param {{ trigger?: string, skillIds?: string[], onLoop?: Function }} [opts]
 */
function makeCtx(userData, opts = {}) {
  const seen = { rpc: [], startParams: null, loopArgs: null, sysContent: '' };
  const plan = {
    id: 'plan-1',
    name: '每日巡检',
    prompt: '检查服务健康',
    trigger: opts.trigger || 'schedule',
    skillIds: opts.skillIds
  };
  const ctx = {
    userData,
    workspacePath: '/w/app',
    sessionId: 's-plan-1',
    planUserPrompt: '检查服务健康',
    gateway: {
      invokeRpc: async (method, args) => {
        seen.rpc.push([method, args]);
        if (method === 'memory.messages_recent') {
          return [
            { role: 'user', content: '上一轮的要求', createdAt: 1700000000000 },
            { role: 'assistant', content: '上一轮的结论', created_at: 1700000001000 },
            { role: 'system', content: '应被过滤掉' }
          ];
        }
        return { ok: true };
      }
    },
    coreBridge: { isReady: () => true },
    mcpRuntime: null,
    createToolBridge: () => ({
      executeAgentTool: async () => ({ ok: true })
    }),
    onPlanPhase: () => {},
    runRustAgentLoop: async (args) => {
      seen.loopArgs = args;
      seen.startParams = args.startParams;
      const sys = (args.startParams.messages || []).find((m) => m.role === 'system');
      seen.sysContent = String((sys && sys.content) || '');
      // 让本轮「有正文」，避免走空交付失败分支
      return { content: '巡检完成：一切正常', trace: [] };
    }
  };
  return { ctx, plan, seen };
}

describe('计划执行器：这一轮喂给核心的东西', () => {
  let userData;
  beforeEach(() => {
    userData = tmpUserData();
  });
  afterEach(() => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响判定 */
    }
  });

  it('系统提示含计划身份段与本次任务；历史里只留 user/assistant 且补上时间', async () => {
    const { ctx, plan, seen } = makeCtx(userData);
    const res = await runPlanAgentLoop(ctx, plan);
    assert.equal(res.ok, true);

    assert.match(seen.sysContent, /【定时计划 Agent】/);
    assert.match(seen.sysContent, /计划名称：每日巡检/);
    assert.match(seen.sysContent, /【本次任务】/);
    assert.match(seen.sysContent, /检查服务健康/);
    // 工作空间要写进上下文（否则模型只能猜根目录）
    assert.match(seen.sysContent, /\/w\/app/);

    const history = seen.startParams.messages.filter((m) => m.role !== 'system');
    assert.equal(history.length, 2, '历史只留 user / assistant 两条');
    assert.ok(String(history[0].content).includes('上一轮的要求'), 'user 那轮进消息');
    assert.ok(String(history[1].content).includes('上一轮的结论'), 'assistant 那轮进消息');
  });

  it('历史读取只留 user/assistant，且 createdAt / created_at 两种字段都归一', async () => {
    const { loadRecentTurnMessages } = require('../../src/agent/session-context');
    const rows = await loadRecentTurnMessages(
      {
        invokeRpc: async () => [
          { role: 'user', content: 'a', createdAt: 1700000000000 },
          { role: 'assistant', content: 'b', created_at: 1700000001000 },
          { role: 'system', content: 'c' },
          { role: 'tool', content: 'd' }
        ]
      },
      's-1',
      120
    );
    assert.equal(rows.length, 2, 'system / tool 不进历史');
    assert.equal(rows[0].created_at, 1700000000000, 'createdAt 归一成 created_at');
    assert.equal(rows[1].created_at, 1700000001000, 'created_at 原样保留');
  });

  it('startParams：模型、轮次上限、工具上限、工作区根都对得上单一来源', async () => {
    const { ctx, plan, seen } = makeCtx(userData);
    await runPlanAgentLoop(ctx, plan);
    const sp = seen.startParams;
    assert.equal(sp.model, 'mimo-v2.5-pro');
    assert.equal(sp.maxRounds, clampModelRuntimeValue('agentMaxRounds', AGENT_LIMITS_DEFAULTS.agentMaxRounds));
    assert.equal(sp.maxRounds, resolveAgentMaxRounds({ agentMaxRounds: AGENT_LIMITS_DEFAULTS.agentMaxRounds }));
    assert.ok(Number(sp.maxToolCalls) > 0);
    assert.equal(sp.workspaceRoot, '/w/app');
    // 请求快照来源标 plan
    assert.equal(seen.loopArgs.runSource, 'plan');
    assert.equal(seen.loopArgs.sessionId, 's-plan-1');
  });

  it('只有 trigger==="goal" 的计划才拿到目标工具（goal_check / goal_finish）', async () => {
    const normal = makeCtx(userData);
    await runPlanAgentLoop(normal.ctx, normal.plan);
    const normalNames = normal.seen.startParams.tools.map((t) => (t.function || {}).name);

    const goal = makeCtx(userData, { trigger: 'goal' });
    await runPlanAgentLoop(goal.ctx, goal.plan);
    const goalNames = goal.seen.startParams.tools.map((t) => (t.function || {}).name);

    assert.ok(!normalNames.includes('goal_finish'), '普通计划不该有 goal_finish');
    assert.ok(goalNames.includes('goal_finish'), '目标型计划要有 goal_finish');
    assert.ok(goalNames.includes('goal_check'), '目标型计划要有 goal_check');
  });

  it('空正文如实失败（不冒充成功），文案与主循环同一份', async () => {
    const { ctx, plan } = makeCtx(userData);
    ctx.runRustAgentLoop = async () => ({ content: '', trace: [{ tools: [{ name: 'host_exec' }] }] });
    await assert.rejects(
      () => runPlanAgentLoop(ctx, plan),
      (err) => {
        assert.match(err.message, /次工具调用但未生成任何正文/);
        assert.match(err.message, /请查看日志后重试/);
        return true;
      }
    );
  });
});
