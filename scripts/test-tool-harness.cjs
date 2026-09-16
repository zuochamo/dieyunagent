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
const { spillToolOutputIfLarge } = require('../src/agent/tool-output-spill');
const { resolveFsReadMaxBytes } = require('../src/agent/delegate-tool-gateway');
const { resolveHostSidecarLocalPath } = require('../src/agent/host-sidecar');
const { ToolHarnessSession, classifyFailure } = require('../src/agent/tool-harness');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const catalog = require('../src/agent/tool-catalog');
const planTools = require('../src/plans/plan-tools');
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
  assert(planTools.PLAN_HOST_TOOLS.length === 5, 'PLAN_HOST_TOOLS');
  assert(catalog.RENDERER_ONLY_TOOLS.includes('agent_clarify'), 'renderer-only clarify');
  assert(
    catalog.RENDERER_ONLY_TOOLS.length === 1 &&
      !catalog.RENDERER_ONLY_TOOLS.includes('playbook_propose') &&
      !catalog.RENDERER_ONLY_TOOLS.includes('agents_md_propose'),
    'propose tools are not renderer-only'
  );

  const v1 = validateToolArgs('host_exec', { command: '' });
  assert(!v1.ok && v1.errorCode === 'MISSING_ARG', 'host_exec empty');

  const v2 = validateToolArgs('host_exec', { command: 'rm -rf /' });
  assert(!v2.ok && v2.errorCode === 'BLOCKED', 'host_exec blocked');

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
  const vGraphLegacy = validateToolArgs('graph_callers', { name: 'bar' });
  assert(vGraphLegacy.ok, 'legacy graph_callers validates as graph');
  const vGraphBad = validateToolArgs('graph', { operation: 'nope' });
  assert(!vGraphBad.ok && vGraphBad.errorCode === 'MISSING_ARG', 'graph bad operation');

  const vPb = validateToolArgs('playbook_propose', { title: 't', goal: 'g', steps: '- a' });
  assert(vPb.ok, 'playbook_propose valid');
  const vPbBad = validateToolArgs('playbook_propose', { title: 't' });
  assert(!vPbBad.ok, 'playbook_propose missing args');
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

  const { executePlaybookProposeMain, executeAgentsMdProposeMain } = require('../src/agent/propose-tools-main');
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
      if (method === 'playbook.draft_create') {
        return {
          ok: true,
          draftPath: '.dieyun/playbooks/_drafts/x.draft.md',
          id: 'pb-1',
          title: params.title,
          domain: 'general',
          preview: 'goal'
        };
      }
      throw new Error(`unexpected ${method}`);
    }
  };

  const pbOut = await executePlaybookProposeMain(
    proposeGw,
    { title: '发版', goal: '打安装包', steps: '- 构建' },
    { workspacePath: proposeWs }
  );
  assert(pbOut.ok && pbOut.pending && pbOut.ui === 'playbook_preview' && pbOut.draftPath, 'playbook propose main');

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
