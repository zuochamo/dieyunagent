'use strict';

/**
 * 记忆归纳（Main 侧唯一实现）smoke。
 *
 * 覆盖：
 *   - 触发门（结构信号 vs 纯文字；agent-limits 数字驱动，不再有「长度 >= 8」恒真门）
 *   - 设置读写（userData/knowledge-maintenance.json）
 *   - 一轮任务归纳：project/global 分流、job 记账、异常路径
 *   - 定时完整归纳：归档只接受语料内 id、机械维护（decay/reindex）只跑一次
 *   - 调度器队列上限
 *
 * 不触网：LLM 一律用注入替身。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const km = require('../src/agent/knowledge-maintainer');

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for async cases');
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}: ${err && (err.message || err)}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}: ${err && (err.message || err)}`);
  }
}

function tempUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-knowledge-'));
  return dir;
}

/** 假 ctx：记录所有 RPC，LLM 返回固定 JSON */
function fakeCtx({ userData, llmReply, execPrefs } = {}) {
  const calls = [];
  const ctx = {
    userData,
    sessionId: 's-test',
    workspacePath: '/ws/project',
    invokeRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'memory.consolidation_job_create') return { jobId: 'job-1' };
      if (method === 'memory.long_recent') return [];
      if (method === 'memory.sessions_with_messages') return [{ id: 's-test' }];
      if (method === 'memory.messages_recent') return [{ role: 'user', content: '整理一下项目约定' }];
      if (method === 'memory.project_scope') return { scope: 'project:/ws/project' };
      return { ok: true };
    },
    fetchChatCompletion: async () => llmReply,
    limits: () => require('../src/agent/agent-limits').getAgentLimits(userData),
    readAgentsMdPrefs: () => (execPrefs ? execPrefs() : { mode: 'off', preview: false }),
    getSettings: () => km.readKnowledgeSettings(userData),
    updateSettings: (patch) => km.writeKnowledgeSettings(userData, patch),
    isAgentBusy: () => false
  };
  return { ctx, calls };
}

/** 假模型配置：归纳只校验 baseUrl + model 存在，不真发请求（LLM 走 fetchChatCompletion 替身） */
const FAKE_LLM = { model: 'test-model', apiConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' } };

const TASK_PAYLOAD = {
  sessionId: 's-test',
  workspacePath: '/ws/project',
  source: 'task-completed',
  userText: '把 camera 模块的导出改成 runtime 配置',
  assistantText: '已改完 camera/export.ts 并跑了 npm run check',
  ...FAKE_LLM,
  trace: [
    { tools: [{ name: 'fs_edit', argsBrief: 'camera/export.ts', summary: '写入成功' }] },
    { tools: [{ name: 'host_exec', argsBrief: 'npm run check', summary: '0 errors' }] }
  ],
  changes: [{ relativePath: 'camera/export.ts', source: 'agent' }]
};

async function main() {
  check('gate: 纯短文本不触发', () => {
    const limits = require('../src/agent/agent-limits').AGENT_LIMITS_DEFAULTS;
    assert.strictEqual(
      km.shouldRunKnowledgeMaintenance({
        signals: km.collectKnowledgeSignals({ userText: '你好', assistantText: '你好' }, limits),
        limits
      }),
      false
    );
  });

  check('gate: 有工具轨迹就触发', () => {
    const limits = require('../src/agent/agent-limits').AGENT_LIMITS_DEFAULTS;
    assert.strictEqual(
      km.shouldRunKnowledgeMaintenance({
        signals: km.collectKnowledgeSignals({ trace: TASK_PAYLOAD.trace }, limits),
        limits
      }),
      true
    );
  });

  check('gate: 长文本轮次触发', () => {
    const limits = require('../src/agent/agent-limits').AGENT_LIMITS_DEFAULTS;
    const signals = km.collectKnowledgeSignals(
      { userText: 'x'.repeat(60), assistantText: 'y'.repeat(30) },
      limits
    );
    assert.strictEqual(km.shouldRunKnowledgeMaintenance({ signals, limits }), true);
  });

  check('parse: 宽松 JSON / kind 白名单 / 上限', () => {
    const items = [];
    for (let i = 0; i < 12; i++) items.push({ content: `memory item number ${i}`, kind: i === 0 ? 'SECRET' : 'weird' });
    const parsed = km.parseKnowledgeJson('```json\n' + JSON.stringify({ memories: items }) + '\n```');
    assert.strictEqual(parsed.memories.length, 8, 'should clamp to 8 items');
    assert.strictEqual(parsed.memories[0].kind, 'secret');
    assert.strictEqual(parsed.memories[1].kind, undefined);
  });

  check('parse: scope 只留 project / global（自由文本归一）', () => {
    const parsed = km.parseKnowledgeJson(
      JSON.stringify({
        memories: [
          { content: '项目约定：提交前跑 npm test', scope: '本项目' },
          { content: '用户偏好中文回复，少用客套话', scope: '长期' },
          { content: 'camera 模块导出统一走 runtime 配置', scope: 'Workspace' },
          { content: '不要提交 dist 目录', scope: 'GLOBAL' }
        ]
      })
    );
    assert.deepStrictEqual(
      parsed.memories.map((m) => m.scope),
      ['project', 'global', 'project', 'global']
    );
  });

  check('changes: 未上报变更时按 trace 里的写文件工具推导', () => {
    const limits = require('../src/agent/agent-limits').AGENT_LIMITS_DEFAULTS;
    const signals = km.collectKnowledgeSignals(
      {
        trace: [
          { tools: [{ name: 'fs_edit', toolArgs: { filePath: 'camera/export.ts' }, summary: '写入成功' }] },
          { tools: [{ name: 'fs_write_file', toolArgs: { filePath: 'docs/x.md' }, summary: '写入成功' }] },
          { tools: [{ name: 'host_exec', argsBrief: 'npm test', summary: '0 errors' }] }
        ]
      },
      limits
    );
    assert.ok(signals.changes.includes('camera/export.ts'), signals.changes);
    assert.ok(signals.changes.includes('docs/x.md'), signals.changes);
    assert.strictEqual(signals.writeCount, 2);
    assert.ok(!signals.changes.includes('npm test'), '命令不算文件变更');
  });

  check('prompt: 未启用 AGENTS 时要求 agents_updates 为空', () => {
    const disabled = km.buildKnowledgeSystemPrompt({ agentsEnabled: false });
    assert.ok(disabled.includes('agents_updates 必须为空数组'));
    const full = km.buildKnowledgeSystemPrompt({ fullPeriodic: true, agentsEnabled: true });
    assert.ok(full.includes('archive_memory_ids'));
  });

  check('settings: 默认值 + 读写 + 非法值被忽略', () => {
    const userData = tempUserData();
    const def = km.readKnowledgeSettings(userData);
    assert.strictEqual(def.mode, 'on');
    assert.strictEqual(def.intervalHours, 6);
    const saved = km.writeKnowledgeSettings(userData, { mode: 'idle', intervalHours: 12, scopes: { agents: false } });
    assert.strictEqual(saved.mode, 'idle');
    assert.strictEqual(saved.intervalHours, 12);
    assert.strictEqual(saved.scopes.agents, false);
    const raw = JSON.parse(fs.readFileSync(path.join(userData, km.KNOWLEDGE_SETTINGS_FILE), 'utf8'));
    assert.strictEqual(raw.mode, 'idle');
    const bad = km.writeKnowledgeSettings(userData, { mode: 'bogus', intervalHours: 7 });
    assert.strictEqual(bad.mode, 'idle');
    assert.strictEqual(bad.intervalHours, 12);
  });

  await checkAsync('run: 结构信号轮次写全局记忆进库、项目记忆进文件', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [
        { content: 'camera 模块导出统一走 runtime 配置', kind: 'normal', importance: 4, scope: 'project' },
        { content: '用户偏好中文回复', kind: 'normal', importance: 3, scope: 'global' }
      ],
      archive_memory_ids: [],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    const files = new Map();
    const inner = ctx.invokeRpc;
    ctx.invokeRpc = async (method, params) => {
      if (method === 'fs.read_file') return { data: files.get(String(params.filePath)) || '', encoding: 'utf8' };
      if (method === 'fs.write_file') {
        files.set(String(params.filePath), String(params.data));
        calls.push({ method, params });
        return { ok: true };
      }
      return inner(method, params);
    };
    const res = await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.memorySaved, 2);
    assert.strictEqual(calls.filter((c) => c.method === 'memory.project_add').length, 0, '项目记忆不再写库');
    assert.ok(String(files.get('.dieyun/memory.md')).includes('runtime 配置'), '项目记忆写进文件');
    const longAdd = calls.filter((c) => c.method === 'memory.long_add');
    assert.strictEqual(longAdd.length, 1);
    // 溯源：写入必须带上"哪个会话沉淀的"，否则「本会话沉淀了什么/忘掉」无法回答
    const expectedSession = String(TASK_PAYLOAD.sessionId || '');
    assert.ok(expectedSession, '任务语料自带 sessionId');
    assert.strictEqual(longAdd[0].params.sessionId, expectedSession);
    assert.ok(calls.some((c) => c.method === 'memory.consolidation_job_finish' && c.params.status === 'completed'));
  });

  await checkAsync('run: 按写入侧事实计数（合并 / 弃用不算新增）', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [
        { content: 'camera 模块导出统一走 runtime 配置', kind: 'normal', importance: 4, scope: 'project' },
        { content: '用户偏好中文回复', kind: 'normal', importance: 3, scope: 'global' }
      ],
      archive_memory_ids: [],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    // 文件里已经有同一条项目记忆 → 本轮应记为「合并」而不是「新增」
    const files = new Map([['.dieyun/memory.md', '# 项目记忆\n\n- camera 模块导出统一走 runtime 配置\n']]);
    const inner = ctx.invokeRpc;
    ctx.invokeRpc = async (method, params) => {
      if (method === 'fs.read_file') return { data: files.get(String(params.filePath)) || '', encoding: 'utf8' };
      if (method === 'fs.write_file') {
        files.set(String(params.filePath), String(params.data));
        calls.push({ method, params });
        return { ok: true };
      }
      const res = await inner(method, params);
      // 全局条目的写入侧策略在 Rust（低价值闸）；项目条目由文件去重判定
      if (method === 'memory.long_add') return { ...res, skipped: 'low_importance' };
      return res;
    };
    const res = await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.memorySaved, 0, '合并/弃用都不算新增');
    assert.strictEqual(res.memoryMerged, 1, '文件去重命中记为合并');
    assert.strictEqual(res.memorySkipped, 1, 'Rust 闸门挡掉记为弃用');
  });

  await checkAsync('run: 门未过时不发 LLM 不写库', async () => {
    const userData = tempUserData();
    const { ctx, calls } = fakeCtx({ userData, llmReply: '{}' });
    let llmCalled = false;
    ctx.fetchChatCompletion = async () => {
      llmCalled = true;
      return '{}';
    };
    const res = await km.runTaskMaintenance(ctx, { sessionId: 's-test', userText: 'hi', assistantText: 'ok' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'skip');
    assert.strictEqual(llmCalled, false);
    assert.deepStrictEqual(calls, []);
  });

  await checkAsync('run: LLM 失败要记 failed job', async () => {
    const userData = tempUserData();
    const { ctx, calls } = fakeCtx({ userData, llmReply: '{}' });
    ctx.fetchChatCompletion = async () => {
      throw new Error('boom');
    };
    const res = await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(res.reason, 'llm_failed');
    assert.ok(calls.some((c) => c.method === 'memory.consolidation_job_finish' && c.params.status === 'failed'));
  });

  await checkAsync('run: 项目记忆写进 .dieyun/memory.md（不再写库）', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [
        { content: 'camera 模块导出统一走 runtime 配置', kind: 'normal', importance: 4, scope: 'project' },
        { content: '数据库口令是 hunter2', kind: 'secret', importance: 5, scope: 'project' }
      ],
      archive_memory_ids: [],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    const files = new Map();
    const inner = ctx.invokeRpc;
    ctx.invokeRpc = async (method, params) => {
      if (method === 'fs.read_file') {
        return { data: files.get(String(params.filePath)) || '', encoding: 'utf8' };
      }
      if (method === 'fs.write_file') {
        files.set(String(params.filePath), String(params.data));
        calls.push({ method, params });
        return { ok: true };
      }
      return inner(method, params);
    };
    const res = await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(res.ok, true);
    // 项目记忆的唯一真相是文件：库里不应该再有项目行
    assert.strictEqual(calls.filter((c) => c.method === 'memory.project_add').length, 0);
    const text = files.get('.dieyun/memory.md') || '';
    assert.ok(text.includes('runtime 配置'), '项目条目写进 memory.md');
    assert.ok(!text.includes('hunter2'), 'secret 条目绝不进文件（会进版本库）');
    assert.strictEqual(res.memorySaved, 1);
    assert.strictEqual(res.memorySkipped, 1);

    // 再归纳一次同一条：文件幂等（不产生第二条）
    const before = files.get('.dieyun/memory.md');
    await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(files.get('.dieyun/memory.md'), before, '重复条目不再写文件');
  });

  await checkAsync('run: scope=global 的 secret 不被 importance 抢进文件（落库、绝不进 memory.md）', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [
        { content: '数据库口令是 hunter2', kind: 'secret', importance: 5, scope: 'global' },
        { content: 'camera 模块导出统一走 runtime 配置', kind: 'normal', importance: 5, scope: 'global' }
      ],
      archive_memory_ids: [],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    const files = new Map();
    const inner = ctx.invokeRpc;
    ctx.invokeRpc = async (method, params) => {
      if (method === 'fs.read_file') return { data: files.get(String(params.filePath)) || '', encoding: 'utf8' };
      if (method === 'fs.write_file') {
        files.set(String(params.filePath), String(params.data));
        calls.push({ method, params });
        return { ok: true };
      }
      return inner(method, params);
    };
    const res = await km.runTaskMaintenance(ctx, TASK_PAYLOAD);
    assert.strictEqual(res.ok, true);
    const longAdd = calls.filter((c) => c.method === 'memory.long_add');
    assert.strictEqual(longAdd.length, 2, 'scope=global 一律落库，importance 不改变落点');
    assert.ok(
      longAdd.some((c) => String(c.params.content).includes('hunter2')),
      'secret 条目必须落库（否则模型看不到、用户也不知道它丢了）'
    );
    const text = files.get('.dieyun/memory.md') || '';
    assert.ok(!text.includes('hunter2'), 'secret 条目绝不进文件（会进版本库）');
    assert.ok(!text.includes('runtime 配置'), 'importance=5 的 global 条目也不该改道进文件');
    assert.strictEqual(res.memorySaved, 2);
    assert.strictEqual(res.memorySkipped, 0);
  });

  await checkAsync('run: 项目记忆落项目根（worktree 会话不写进临时 worktree）', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [{ content: 'camera 导出统一走 runtime 配置', kind: 'normal', importance: 4, scope: 'project' }],
      archive_memory_ids: [],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    const roots = [];
    const inner = ctx.invokeRpc;
    ctx.invokeRpc = async (method, params) => {
      if (method === 'fs.read_file' || method === 'fs.write_file') {
        roots.push(String(params.runWorkspaceRoot || ''));
        calls.push({ method, params });
        return method === 'fs.read_file' ? { data: '', encoding: 'utf8' } : { ok: true };
      }
      return inner(method, params);
    };
    // 计划 worktree 里跑的任务：payload.workspacePath 带 worktree 尾巴
    await km.runTaskMaintenance(ctx, {
      ...TASK_PAYLOAD,
      workspacePath: '/ws/project/.dieyun/worktrees/task-42'
    });
    assert.ok(roots.length >= 2, '文件读写都要发生');
    for (const r of roots) {
      assert.strictEqual(r, '/ws/project', 'memory.md 必须落在项目根，而不是会被删除的 worktree 里');
    }
  });

  await checkAsync('periodic: 归档只接受语料内 id，机械维护只跑一次', async () => {
    const userData = tempUserData();
    const reply = JSON.stringify({
      memories: [{ content: '项目约定：提交前跑 npm test', kind: 'normal', importance: 3, scope: 'project' }],
      archive_memory_ids: ['7', '999'],
      agents_updates: []
    });
    const { ctx, calls } = fakeCtx({ userData, llmReply: reply });
    ctx.invokeRpc = async (method, params) => {
      calls.push({ method, params });
      if (method === 'memory.consolidation_job_create') return { jobId: 'job-2' };
      if (method === 'memory.sessions_with_messages') return [{ id: 's-test' }];
      if (method === 'memory.messages_recent') return [{ role: 'user', content: '提交前要跑测试' }];
      if (method === 'memory.long_recent') {
        // 已知 id 来自 global 语料；项目记忆现在是文件，不再产出 id
        return params && params.scope === 'global' ? [{ id: 7, content: '旧约定' }] : [];
      }
      if (method === 'memory.project_scope') return { scope: 'project:/ws/project' };
      return { ok: true };
    };
    const res = await km.runPeriodicMaintenance(ctx, { reason: 'periodic', ...FAKE_LLM });
    assert.strictEqual(res.ok, true);
    const archived = calls.filter((c) => c.method === 'memory.long_status_set');
    assert.deepStrictEqual(archived.map((c) => c.params.memoryId), [7], 'unknown id must be dropped');
    assert.strictEqual(calls.filter((c) => c.method === 'memory.long_decay').length, 1);
    assert.strictEqual(calls.filter((c) => c.method === 'memory.long_reindex').length, 1);
  });

  check('scheduler: 队列上限与设置热更新', () => {
    const userData = tempUserData();
    const limits = require('../src/agent/agent-limits').getAgentLimits(userData);
    const maintainer = km.createKnowledgeMaintainer({
      getGateway: () => null,
      getUserDataPath: () => userData,
      getAgentBusy: () => false,
      notify: () => {}
    });
    try {
      const cap = Number(limits.knowledgeMaintenanceQueueMax) || 8;
      const results = [];
      for (let i = 0; i < cap + 1; i++) {
        results.push(maintainer.schedule({ sessionId: `s-${i}`, delayMs: 60 * 60 * 1000 }));
      }
      assert.strictEqual(results[cap].ok, false);
      assert.strictEqual(results[cap].reason, 'queue_full');
      const updated = maintainer.updateSettings({ mode: 'off' });
      assert.strictEqual(updated.mode, 'off');
    } finally {
      maintainer.stopSchedule();
    }
  });

  await checkAsync('scheduler: 定时运行注入当前工作空间（否则项目记忆永远不整理）', async () => {
    const userData = tempUserData();
    const calls = [];
    const maintainer = km.createKnowledgeMaintainer({
      getGateway: () => ({
        invokeRpc: async (method, params) => {
          calls.push({ method, params });
          if (method === 'memory.sessions_with_messages') return [];
          if (method === 'memory.project_scope') return { scope: 'project:/ws/active' };
          if (method === 'memory.long_recent') return [];
          if (method === 'fs.read_file') return { data: '', encoding: 'utf8' };
          return { ok: true };
        }
      }),
      getUserDataPath: () => userData,
      getAgentBusy: () => false,
      getWorkspacePath: () => '/ws/active',
      notify: () => {}
    });
    try {
      // 没有可用模型 → 会在语料组装之后返回 no_model，但 scope 解析必须已经带上工作空间
      await maintainer.runPeriodic({ reason: 'periodic' });
      // 项目记忆的读写都要落在当前工作空间根上（否则材料化会写错仓库）
      const scopeCall = calls.find((c) => c.method === 'memory.project_scope');
      assert.ok(scopeCall, 'periodic must resolve project scope from current workspace');
      assert.strictEqual(scopeCall.params.workspacePath, '/ws/active');
      const fileCall = calls.find((c) => c.method === 'fs.read_file');
      assert.ok(fileCall, 'periodic must read the project memory file');
      assert.strictEqual(fileCall.params.runWorkspaceRoot, '/ws/active');
    } finally {
      maintainer.stopSchedule();
    }
  });

  await checkAsync('scheduler: afterRun 分流（入队 / 计划暂存 / 关闭不跑）', async () => {
    const userData = tempUserData();
    // 先不当成「定时已过期」，免得 afterRun 顺手触发一次定时归纳
    km.writeKnowledgeSettings(userData, { mode: 'on', lastRunAt: Date.now() });
    const maintainer = km.createKnowledgeMaintainer({
      getGateway: () => null,
      getUserDataPath: () => userData,
      getAgentBusy: () => false,
      notify: () => {}
    });
    const run = (over = {}) => ({
      result: {
        content: '已改完 camera/export.ts',
        trace: [{ tools: [{ name: 'fs_edit', toolArgs: { filePath: 'camera/export.ts' }, summary: '写入成功' }] }],
        runId: 'r-1',
        ...(over.result || {})
      },
      opts: { sessionId: 's-after', workspacePath: '/ws/project', userText: '改导出方式', ...(over.opts || {}) }
    });
    try {
      const queued = maintainer.afterRun(run());
      assert.strictEqual(queued.ok, true, JSON.stringify(queued));
      assert.ok(queued.queued >= 1, '普通轮次直接入队');

      const notAccepted = maintainer.afterRun(
        run({ result: { plan: { subtasks: [{ title: '改导出' }] }, review: { accepted: false } } })
      );
      assert.deepStrictEqual(notAccepted, { ok: false, reason: 'plan_not_accepted' });

      // 计划已采纳、worktree 还没应用：暂存在 Main，等应用结果
      const deferred = maintainer.afterRun(
        run({
          result: {
            plan: { subtasks: [{ title: '改导出' }] },
            review: { accepted: true },
            deferWorktreeCleanup: true
          }
        })
      );
      assert.deepStrictEqual(deferred, { ok: true, deferred: true });
      const applied = maintainer.resolvePending('s-after', 'applied', { appliedPaths: ['camera/export.ts'] });
      assert.strictEqual(applied.ok, true, JSON.stringify(applied));
      assert.deepStrictEqual(maintainer.resolvePending('s-after', 'applied'), { ok: false, reason: 'none' });

      // 关掉：一条都不入队（off 是「全部关」，不是只关定时）
      maintainer.updateSettings({ mode: 'off' });
      assert.deepStrictEqual(maintainer.afterRun(run()), { ok: false, reason: 'disabled' });
    } finally {
      maintainer.stopSchedule();
    }
  });

  if (failures) {
    console.error(`\n${failures} case(s) failed`);
    process.exit(1);
  }
  console.log('\ntest-knowledge-maintainer.cjs ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
