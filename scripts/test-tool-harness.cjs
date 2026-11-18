'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');
const { validateToolArgs, validateMcpInputArgs } = require('../src/agent/tool-validate');
const {
  shouldBlockRepeatToolCall,
  recordToolCallFingerprint,
  repeatToolBlockMessage,
  normalizeAgentToolName
} = require('../src/agent/tool-guardrails');
const { spillToolOutputIfLarge, SPILL_CHAR_THRESHOLD } = require('../src/agent/tool-output-spill');
const { resolveFsReadMaxBytes } = require('../src/agent/delegate-tool-gateway');
const { resolveHostSidecarLocalPath } = require('../src/agent/host-sidecar');
const { ToolHarnessSession, classifyFailure } = require('../src/agent/tool-harness');
const { toStoreRequest } = require('../src/mcp/manage');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const catalog = require('../src/agent/tool-catalog');
const { buildMainAgentTools } = require('../src/agent/main-agent-tools');
const { createMockGateway } = require('./lib/test-gateway-mock.cjs');
const { agentSandboxPath } = require('./lib/agent-sandbox-path.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function main() {
  assert(catalog.getToolByName('fs_edit'), 'catalog fs_edit');
  assert(resolveFsReadMaxBytes({}) === AGENT_LIMITS_DEFAULTS.fsReadDefaultMaxBytes, 'fs_read default chunk');
  assert(resolveFsReadMaxBytes({ maxBytes: 4096 }) === 4096, 'fs_read explicit maxBytes');
  assert(
    catalog.toolsByNames(catalog.PLAN_RUNTIME_TOOL_NAMES).length ===
      catalog.PLAN_RUNTIME_TOOL_NAMES.length,
    'plan runtime tools in catalog'
  );
  // Main 侧（无 Renderer）一轮的工具集：静态工具 + MCP 工具，唯一构造入口。
  // 静态部分 = 计划运行时那一档 + 内网互通三件套：协调器住在 Main，计划 / 频道 / headless
  // 都是「这台机器上的 agent 在跑」，能不能看见同事的 agent 不该取决于这一轮是谁发起的。
  const mainSideTools = await buildMainAgentTools(null);
  const expectedMainNames = [...catalog.PLAN_RUNTIME_TOOL_NAMES, ...catalog.PEER_TOOLS.map((t) => t.function.name)];
  assert(
    mainSideTools.length === expectedMainNames.length,
    `main-side tools = PLAN_RUNTIME_TOOL_NAMES + PEER_TOOLS（实际 ${mainSideTools.length}，应为 ${expectedMainNames.length}）`
  );
  assert(
    expectedMainNames.every((n) => mainSideTools.some((t) => t.function && t.function.name === n)),
    'main-side tools 覆盖计划运行时与 peer 三件套'
  );
  assert(
    mainSideTools.some((t) => t.function && t.function.name === 'host_exec'),
    'main-side tools include host_exec'
  );
  assert(catalog.RENDERER_ONLY_TOOLS.includes('agent_clarify'), 'renderer-only clarify');
  assert(catalog.RENDERER_ONLY_TOOLS.includes('session_new'), 'renderer-only session_new');
  // 渲染器专属只放「只有渲染器才做得到」的动作：确认卡片、建会话/换工作空间（会话与视图状态归渲染器）。
  // propose 类、fs_*、host_* 在 Main 都有真实现，一旦被列进来就会变成两处执行。
  const RENDERER_ONLY_EXPECTED = ['agent_clarify', 'session_new', 'session_set_workspace'];
  assert(
    catalog.RENDERER_ONLY_TOOLS.every((n) => RENDERER_ONLY_EXPECTED.includes(n)) &&
      !catalog.RENDERER_ONLY_TOOLS.includes('agents_md_propose'),
    'propose tools are not renderer-only'
  );
  // 外部频道（没有 UI）的额外工具：只在频道那一轮注入，不能混进计划
  assert(
    catalog.toolsByNames(catalog.CHANNEL_RUNTIME_TOOL_NAMES).length ===
      catalog.CHANNEL_RUNTIME_TOOL_NAMES.length,
    'channel runtime tools in catalog'
  );
  assert(
    catalog.CHANNEL_RUNTIME_TOOL_NAMES.every((n) => !catalog.PLAN_RUNTIME_TOOL_NAMES.includes(n)),
    'channel-only tools stay out of plan runs'
  );
  // session_set_workspace 是唯一允许两边都出现的名字：桌面由渲染器执行（工作空间视图归渲染器），
  // 频道由 Main 执行（会话绑定归 Main）。其余工具两头都出现就等于两处执行。
  assert(
    catalog.CHANNEL_RUNTIME_TOOL_NAMES.every(
      (n) => n === 'session_set_workspace' || !catalog.RENDERER_ONLY_TOOLS.includes(n)
    ),
    'only session_set_workspace is dual-context'
  );
  assert(
    catalog.RENDERER_ONLY_TOOLS.includes('session_set_workspace'),
    'desktop path executes session_set_workspace in renderer'
  );

  const v1 = validateToolArgs('host_exec', { command: '' });
  assert(!v1.ok && v1.errorCode === 'MISSING_ARG', 'host_exec empty');

  const v2 = validateToolArgs('host_exec', { command: 'rm -rf /' });
  assert(!v2.ok && v2.errorCode === 'BLOCKED', 'host_exec blocked');

  // read_symbol 符号定位只有「按 name」与「按包含某行的最小符号」两条路，只给 filePath
  // 必返回 SYMBOL_NOT_FOUND（且已白跑 LSP + 结构索引），故在入口即拦。
  const rsPathOnly = validateToolArgs('read_symbol', { filePath: 'src/a.js' });
  assert(!rsPathOnly.ok && rsPathOnly.errorCode === 'MISSING_ARG', 'read_symbol path-only blocked（跨字段规则，A2 收进 schema 后这里会跟着变）');
  const rsAlias = normalizeAgentToolName('read_symbol', { path: 'src/a.js' });
  assert(
    !validateToolArgs(rsAlias.name, rsAlias.args).ok,
    'read_symbol path-only blocked after alias normalize'
  );
  assert(
    validateToolArgs('read_symbol', { name: 'foo' }).ok &&
      validateToolArgs('read_symbol', { filePath: 'src/a.js', line: 12 }).ok &&
      validateToolArgs('read_symbol', { filePath: 'src/a.js', name: 'foo' }).ok,
    'read_symbol valid combos keep working'
  );

  const repeatLimit = AGENT_LIMITS_DEFAULTS.repeatToolStreakLimit;
  const hist = [];
  for (let i = 0; i < repeatLimit - 2; i++) {
    recordToolCallFingerprint(hist, 'fs_list_dir', { dirPath: 'src' });
  }
  assert(!shouldBlockRepeatToolCall('fs_list_dir', { dirPath: 'src' }, hist), 'repeat not yet block');
  recordToolCallFingerprint(hist, 'fs_list_dir', { dirPath: 'src' });
  assert(shouldBlockRepeatToolCall('fs_list_dir', { dirPath: 'src' }, hist), 'repeat block');
  assert(repeatToolBlockMessage('fs_list_dir', 'src').includes('止损'), 'repeat msg');

  const grepNorm = normalizeAgentToolName('grep', { pattern: 'renderHUD' });
  assert(grepNorm.name === 'grep' && grepNorm.args.pattern === 'renderHUD', 'grep stays grep');

  const rgNorm = normalizeAgentToolName('rg', { query: 'foo' });
  assert(rgNorm.name === 'grep' && rgNorm.args.pattern === 'foo', 'rg alias');

  const vGrep = validateToolArgs('grep', { pattern: 'x' });
  assert(vGrep.ok, 'grep valid');
  const vGrepBad = validateToolArgs('grep', {});
  assert(!vGrepBad.ok && vGrepBad.errorCode === 'MISSING_ARG', 'grep missing pattern');

  const vGlob = validateToolArgs('glob', { pattern: '**/*.js' });
  assert(vGlob.ok, 'glob valid');

  const vLsp = validateToolArgs('lsp', {
    operation: 'goToDefinition',
    filePath: 'a.ts',
    line: 10,
    character: 2
  });
  assert(vLsp.ok, 'lsp valid');
  const vLspBad = validateToolArgs('lsp', { operation: 'rename', filePath: 'a.ts', line: 1 });
  assert(!vLspBad.ok, 'lsp bad operation');

  assert(catalog.getToolByName('graph'), 'catalog graph');
  assert(!catalog.getToolByName('graph_find_symbol'), 'legacy graph_* not in catalog');
  assert(catalog.GRAPH_TOOLS && catalog.GRAPH_TOOLS.length === 1, 'single graph tool');

  const graphNorm = normalizeAgentToolName('graph_find_symbol', { query: 'foo' });
  assert(
    graphNorm.name === 'graph' &&
      graphNorm.args.operation === 'find_symbol' &&
      graphNorm.args.query === 'foo',
    'graph_find_symbol alias'
  );

  const vGraph = validateToolArgs('graph', { operation: 'find_symbol', query: 'x' });
  assert(vGraph.ok, 'graph find_symbol valid');
  // 归一只在 guardrails-shared 一处（tool-gate.js#createToolCall 进关卡前调一次），
  // 校验吃的是归一后的 name/args —— 所以这里按真实链路归一后再校验。
  const graphCallersNorm = normalizeAgentToolName('graph_callers', { name: 'bar' });
  assert(
    graphCallersNorm.name === 'graph' && graphCallersNorm.args.operation === 'callers',
    'legacy graph_callers normalizes to graph.callers'
  );
  const vGraphLegacy = validateToolArgs(graphCallersNorm.name, graphCallersNorm.args);
  assert(vGraphLegacy.ok, 'normalized graph_callers validates as graph');
  const vGraphBad = validateToolArgs('graph', { operation: 'nope' });
  assert(!vGraphBad.ok && vGraphBad.errorCode === 'MISSING_ARG', 'graph bad operation');

  // 动作清单的唯一来源是 catalog 的 `action.enum`：校验的白名单由它派生
  // （`tool-validate.js#toolActionEnum`）。另抄一份数组 = 「schema 有、执行不了」或「能执行、模型不知道」。
  const sshEnum = catalog.getToolByName('ssh').function.parameters.properties.action.enum;
  const vSshBad = validateToolArgs('ssh', { action: 'nope' });
  assert(
    !vSshBad.ok && vSshBad.errorCode === 'INVALID_ARG' && vSshBad.error.includes(sshEnum.join(' / ')),
    'ssh action whitelist is derived from catalog enum'
  );
  const vWorktreeBad = validateToolArgs('worktree', { action: 'nope' });
  assert(
    !vWorktreeBad.ok && vWorktreeBad.errorCode === 'INVALID_ARG',
    'worktree action whitelist rejects unknown action'
  );

  // mcp transport：「算不算远端」只有 mcp/manage.js 一份（别名 remote / http 都归一到 remote）。
  // 这里锁住那个旧分叉 —— 别名过得了校验，却被当成 stdio 落库。
  const remoteByAlias = toStoreRequest({
    action: 'add',
    id: 'demo',
    name: 'Demo',
    transport: 'http',
    url: 'http://192.168.31.62:3011/api/open-api/mcp'
  });
  assert(remoteByAlias.payload.transportKind === 'remote', 'transport alias http resolves to remote');
  const stdioByDefault = toStoreRequest({ action: 'add', id: 'demo2', name: 'Local', command: 'npx' });
  assert(!stdioByDefault.payload.transportKind, 'no url and no transport stays stdio');

  const vAmd = validateToolArgs('agents_md_propose', { section: 'gotchas', content: '- x' });

  const mcpSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'search query' } },
    required: ['query']
  };
  const mcpEmpty = validateToolArgs('mcp_demo__search_nodes', {}, { mcpSchema });
  assert(!mcpEmpty.ok && mcpEmpty.errorCode === 'MISSING_ARG', 'mcp empty args');
  const mcpOk = validateToolArgs('mcp_demo__search_nodes', { query: 'prefs' }, { mcpSchema });
  assert(mcpOk.ok, 'mcp query ok');
  const mcpType = validateMcpInputArgs('mcp_x__search_nodes', { query: {} }, mcpSchema);
  assert(!mcpType.ok, 'mcp query must be string');
  // 未声明 required 时不得把唯一属性猜成必填（真实案例：postgres list_schemas 的 database 是可选）
  const mcpOptionalOnly = {
    type: 'object',
    properties: { database: { type: 'string', description: 'omit when only one is configured' } }
  };
  assert(
    validateMcpInputArgs('mcp_pg__list_schemas', {}, mcpOptionalOnly).ok,
    'mcp schema without required: empty args allowed'
  );
  assert(
    validateMcpInputArgs('mcp_pg__list_schemas', { database: 'dieyun_biz' }, mcpOptionalOnly).ok,
    'mcp schema without required: optional arg allowed'
  );
  const slim = catalog.slimMcpInputSchema(mcpSchema);
  assert(slim.required && slim.required[0] === 'query' && slim.properties.query.type === 'string', 'slim keeps query');
  const compacted = catalog.compactMcpToolDef({
    tool: {
      type: 'function',
      function: {
        name: 'mcp_demo__search_nodes',
        description: 'Search the knowledge graph',
        parameters: mcpSchema
      }
    }
  });
  assert(
    compacted.function.parameters.properties.query &&
      compacted.function.parameters.required.includes('query') &&
      !compacted.function.parameters.additionalProperties,
    'compact mcp keeps schema not empty object'
  );
  assert(vAmd.ok, 'agents_md_propose valid');

  const editNorm = normalizeAgentToolName('str_replace_editor', {
    path: 'a.js',
    old_string: 'foo',
    new_string: 'bar'
  });
  assert(
    editNorm.name === 'fs_edit' &&
      editNorm.args.filePath === 'a.js' &&
      editNorm.args.oldString === 'foo' &&
      editNorm.args.newString === 'bar',
    'str_replace_editor alias'
  );

  const vEdit = validateToolArgs('fs_edit', { filePath: 'a.js', oldString: 'x', newString: 'y' });
  assert(vEdit.ok, 'fs_edit valid');
  const vEditBad = validateToolArgs('fs_edit', { filePath: 'a.js', oldString: '', newString: 'y' });
  assert(!vEditBad.ok && vEditBad.errorCode === 'MISSING_OLD', 'fs_edit empty old');
  const vEditHunks = validateToolArgs('fs_edit', {
    filePath: 'a.js',
    edits: [{ oldText: 'x', newText: 'y' }]
  });
  assert(vEditHunks.ok, 'fs_edit edits[] valid');

  const { isWriteTool } = require('../src/agent/guardrails-shared');
  assert(isWriteTool('fs_edit', { filePath: 'a.js' }), 'fs_edit is write tool');

  const big = spillToolOutputIfLarge(
    'host_exec',
    { code: 0, stdout: 'x'.repeat(9000) },
    { runId: 'test', userDataPath: os.tmpdir(), spillSeq: 1 }
  );
  assert(big.outputFile && big.preview && !big.stdout, 'spill host_exec');

  /**
   * 落盘阈值与上下文截断上限是两个数、一条不变式：
   * 落盘是**无损**卸载（全文进 outputFile + 预览进上下文），截断是**有损**切掉。
   * 若落盘阈值 ≥ 截断上限，「超过上限但没到大输出」的那一段会被静默切掉、没有文件可回读。
   * 数字只允许有一个来源：`agent-limits.js:toolSpillCharThreshold`。
   */
  assert(
    SPILL_CHAR_THRESHOLD === AGENT_LIMITS_DEFAULTS.toolSpillCharThreshold,
    '落盘阈值必须从 agent-limits 读（toolSpillCharThreshold），不另写一份'
  );
  assert(
    SPILL_CHAR_THRESHOLD < AGENT_LIMITS_DEFAULTS.toolResultMaxJson,
    `落盘阈值(${SPILL_CHAR_THRESHOLD}) 必须小于截断上限(${AGENT_LIMITS_DEFAULTS.toolResultMaxJson})`
  );
  const belowThreshold = spillToolOutputIfLarge(
    'host_exec',
    { code: 0, stdout: 'z'.repeat(SPILL_CHAR_THRESHOLD - 1) },
    { runId: 'threshold', userDataPath: os.tmpdir(), spillSeq: 1 }
  );
  assert(!belowThreshold.outputFile, '恰好不到阈值不落盘（不为省一点字符制造文件）');
  const overThreshold = spillToolOutputIfLarge(
    'host_exec',
    { code: 0, stdout: 'z'.repeat(SPILL_CHAR_THRESHOLD + 1) },
    { runId: 'threshold', userDataPath: os.tmpdir(), spillSeq: 1 }
  );
  assert(overThreshold.outputFile, '越过阈值才落盘');

  const sshUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-spill-'));
  const sshSpill = spillToolOutputIfLarge(
    'host_exec',
    { code: 0, stdout: 'y'.repeat(9000) },
    {
      runId: 'ssh-run',
      workspacePath: 'ssh://user@host/run/media/dieyunx/dieyunserver/dieyundaizhang',
      userDataPath: sshUserData,
      spillSeq: 1
    }
  );
  assert(
    sshSpill.outputFile === '.dieyun/tool-output/ssh-run/host_exec-1.log',
    'ssh spill uses workspace-relative outputFile'
  );
  assert(!sshSpill.stdout, 'ssh spill strips stdout');
  const mapped = resolveHostSidecarLocalPath(sshSpill.outputFile, {
    workspacePath: 'ssh://user@host/run/media/dieyunx/dieyunserver/dieyundaizhang',
    userDataPath: sshUserData
  });
  assert(mapped && fs.existsSync(mapped), 'ssh outputFile maps to local sidecar');
  assert(
    resolveHostSidecarLocalPath('.dieyun/terminals/integrated.log', {
      workspacePath: 'ssh://user@host/tmp/proj',
      userDataPath: sshUserData
    }),
    'ssh terminals path maps to local sidecar'
  );
  assert(
    !resolveHostSidecarLocalPath('packages/frontend/src/pages/cost/CostCalculation.tsx', {
      workspacePath: 'ssh://user@host/tmp/proj',
      userDataPath: sshUserData
    }),
    'normal remote file is not a sidecar'
  );
  const vPatch = validateToolArgs('apply_patch', { patch: '--- a\n+++ b' });
  assert(!vPatch.ok && vPatch.errorCode === 'USE_FS_EDIT', 'apply_patch tool blocked');
  const vPatchExec = validateToolArgs('host_exec', {
    command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH"
  });
  assert(!vPatchExec.ok && vPatchExec.errorCode === 'USE_FS_EDIT', 'host_exec apply_patch blocked');
  fs.rmSync(sshUserData, { recursive: true, force: true });

  const surf = classifyFailure(
    'browser_observe',
    null,
    new Error('Current display surface not available for capture')
  );
  assert(surf.retryable === true && surf.errorCode === 'TRANSIENT', 'surface capture is transient');

  // 抛错同样要带契约信息：网关 invokeRpc 原样抛出 handler 的 Error（保留 code），
  // 浏览器 runner 在点击失败/被遮挡/缺 ref 时会挂 diagnostics 与 suggestedFix。
  // 一律折叠成 EXCEPTION 会让模型丢掉「失败在哪、下一步怎么改」，错误码也不再是契约。
  const thrownCoded = classifyFailure(
    'browser_click',
    null,
    Object.assign(new Error('点击失败（被 #mask 遮挡）'), {
      code: 'TARGET_OCCLUDED',
      diagnostics: { engine: 'playwright', occludedBy: { id: 'mask' } },
      suggestedFix: '先关闭/收起遮挡层，或传 force=true 强行点击'
    })
  );
  assert(thrownCoded.errorCode === 'TARGET_OCCLUDED', 'thrown failure keeps its code');
  assert(thrownCoded.retryable === false, 'thrown deterministic failure stays non-retryable');
  assert(
    thrownCoded.diagnostics &&
      thrownCoded.diagnostics.occludedBy &&
      thrownCoded.diagnostics.occludedBy.id === 'mask',
    'thrown failure keeps diagnostics for the model'
  );
  assert(thrownCoded.suggestedFix.includes('force=true'), 'thrown failure keeps suggestedFix');

  // 没有声明的抛错维持原判定口径（EXCEPTION / 消息正则判 TRANSIENT）
  const thrownPlain = classifyFailure('host_exec', null, new Error('boom'));
  assert(
    thrownPlain.errorCode === 'EXCEPTION' && thrownPlain.retryable === false,
    'plain thrown error keeps legacy classification'
  );
  const thrownTimeout = classifyFailure(
    'browser_click',
    null,
    Object.assign(new Error('Timeout 15000ms exceeded'), { code: 'CLICK_FAILED' })
  );
  assert(thrownTimeout.retryable === true, 'timeout message still retried');
  assert(thrownTimeout.errorCode === 'CLICK_FAILED', 'code describes what happened, retryable says what to do');
  // 显式声明优先于消息启发式：作者说不可重试就不再重试
  const thrownDeclared = classifyFailure(
    'browser_click',
    null,
    Object.assign(new Error('Timeout 15000ms exceeded'), { retryable: false })
  );
  assert(thrownDeclared.retryable === false, 'explicit retryable:false wins over message heuristic');

  const refFail = classifyFailure('browser_click', {
    ok: false,
    errorCode: 'REF_EXPIRED',
    error: 'ref 已失效',
    suggestedFix: '重新 browser_snapshot 取新 ref',
    diagnostics: { instanceId: 'browserview#default', refEpoch: 3, navigatedSinceSnapshot: true }
  });
  assert(refFail.errorCode === 'REF_EXPIRED', 'ref failure classified');
  assert(
    refFail.diagnostics &&
      refFail.diagnostics.instanceId === 'browserview#default' &&
      refFail.diagnostics.navigatedSinceSnapshot === true,
    'structured diagnostics survive failure classification'
  );

  const refSession = new ToolHarnessSession({ runId: 'ref-fail', userDataPath: os.tmpdir() });
  const refStep = await refSession.execute('browser_click', { ref: 'e1' }, async () => ({
    ok: false,
    errorCode: 'REF_EXPIRED',
    error: 'ref 已失效',
    retryable: false,
    suggestedFix: '重新 browser_snapshot 取新 ref',
    diagnostics: { instanceId: 'browserview#default', refEpoch: 3, navigatedSinceSnapshot: true }
  }));
  assert(!refStep.ok && refStep.errorCode === 'REF_EXPIRED', 'ref failure reaches model envelope');
  assert(
    typeof refStep.suggestedFix === 'string' && refStep.suggestedFix.includes('browser_snapshot'),
    'ref failure keeps suggestedFix for UI + model'
  );
  assert(
    refStep.diagnostics && refStep.diagnostics.refEpoch === 3 && refStep.diagnostics.navigatedSinceSnapshot === true,
    'ref failure keeps diagnostics through the failure envelope'
  );

  const trivialSession = new ToolHarnessSession({
    runId: 'tier-trivial',
    userDataPath: os.tmpdir(),
    taskTier: { taskTier: 'trivial', readyToWrite: true }
  });
  for (let i = 0; i < 24; i++) {
    const step = await trivialSession.execute(
      'codebase_search',
      { query: `tier-${i}` },
      async () => ({ ok: true, results: [] })
    );
    assert(step && step.ok && !step.errorCode, 'read-only explore is not hard-blocked');
  }

  const rereadSession = new ToolHarnessSession({
    runId: 'reread-ok',
    userDataPath: os.tmpdir()
  });
  for (let i = 0; i < 20; i++) {
    const step = await rereadSession.execute(
      'fs_read_file',
      { filePath: 'probe.txt', offset: i * 512 },
      async () => ({ ok: true, content: 'x' })
    );
    assert(!step.errorCode, `same-file paging is not REREAD_BLOCK (${i + 1})`);
  }

  let calls = 0;
  const session = new ToolHarnessSession({ runId: 't', userDataPath: os.tmpdir() });
  const r = await session.execute('web_search', { query: 'test' }, async () => {
    calls += 1;
    if (calls === 1) return { error: 'timeout', retryable: true, errorCode: 'TRANSIENT' };
    return { ok: true, results: [] };
  });
  assert(calls === 2 && r.ok, 'transient retry');

  const workspace = path.resolve(process.argv[2] || agentSandboxPath());
  const { gateway, stop } = (() => {
    const gw = createMockGateway(workspace);
    return { gateway: gw, stop: () => gw.stop() };
  })();
  const bridge = createMainToolBridge({
    gateway,
    webContents: null,
    userDataPath: os.tmpdir()
  });
  const bridgeRepeatLimit = AGENT_LIMITS_DEFAULTS.repeatToolStreakLimit;
  for (let i = 0; i < bridgeRepeatLimit - 1; i++) {
    await bridge.executeAgentTool(
      'fs_list_dir',
      { dirPath: workspace },
      { workspacePath: workspace, runId: 'bridge-test' }
    );
  }
  const blocked2 = await bridge.executeAgentTool(
    'fs_list_dir',
    { dirPath: workspace },
    { workspacePath: workspace, runId: 'bridge-test' }
  );
  assert(blocked2.errorCode === 'REPEAT_BLOCK', 'bridge repeat block');

  const { executeAgentsMdProposeMain } = require('../src/agent/propose-tools-main');
  const { writeAgentsMdPrefs } = require('../src/agent/agents-md-prefs');
  const { loadBundledTemplate } = require('../src/agents-md');
  const proposeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-propose-ud-'));
  const proposeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-propose-ws-'));
  fs.mkdirSync(path.join(proposeWs, '.dieyun'), { recursive: true });
  fs.writeFileSync(path.join(proposeWs, '.dieyun', 'AGENTS.md'), loadBundledTemplate(), 'utf8');
  writeAgentsMdPrefs(proposeUserData, { mode: 'auto', preview: false });

  const files = new Map();
  const proposeGw = {
    invokeRpc: async (method, params = {}) => {
      const rel = String(params.filePath || '').replace(/\\/g, '/');
      const abs = rel ? path.join(proposeWs, rel) : '';
      if (method === 'fs.read_file') {
        try {
          return { ok: true, data: fs.readFileSync(abs, 'utf8') };
        } catch {
          if (files.has(rel)) return { ok: true, data: files.get(rel) };
          throw new Error('not found');
        }
      }
      if (method === 'fs.write_file') {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(params.data || ''), 'utf8');
        files.set(rel, String(params.data || ''));
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    }
  };

  const amdOut = await executeAgentsMdProposeMain(
    proposeGw,
    { section: 'gotchas', content: '不要提交密钥' },
    { workspacePath: proposeWs },
    proposeUserData
  );
  assert(amdOut.ok && amdOut.applied >= 1 && !amdOut.pending, 'agents_md propose writes via gateway');
  const written = fs.readFileSync(path.join(proposeWs, '.dieyun', 'AGENTS.md'), 'utf8');
  assert(written.includes('不要提交密钥'), 'AGENTS.md updated');

  await stop();
  console.log('ok tool-harness tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
