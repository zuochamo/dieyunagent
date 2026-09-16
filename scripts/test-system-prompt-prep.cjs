'use strict';

const {
  shouldInjectCodeContext,
  formatRecentChanges,
  lightAgentsMdContent,
  extractCodebasePathsFromBlock,
  formatCodebaseBlock,
  prepSystemPrompt
} = require('../src/agent/system-prompt-prep');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(
  shouldInjectCodeContext('请看 src/foo.js', {}) === true,
  'path hint injects code context'
);
assert(shouldInjectCodeContext('你好', {}) === false, 'plain text does not inject');
assert(
  shouldInjectCodeContext('继续', {
    includeEditor: true,
    editor: { hasActiveFile: true, hasSelection: true }
  }) === true,
  'editor selection injects'
);

const changes = formatRecentChanges([{ path: 'a.ts', diff: { added: 2, removed: 1 } }]);
assert(changes.includes('a.ts'), 'recent changes path');
assert(changes.includes('+2'), 'recent changes diff');

const md = [
  '# AGENTS.md',
  '<!-- dieyun:section:overview status=stable -->',
  '## 概览',
  'hello',
  '<!-- dieyun:section:environment status=auto -->',
  '## 环境',
  'win',
  '<!-- dieyun:section:conventions status=draft -->',
  '## 约定',
  'secret-conventions'
].join('\n');
const light = lightAgentsMdContent(md);
assert(light.includes('hello'), 'keeps overview');
assert(!light.includes('win'), 'drops environment');
assert(!light.includes('secret-conventions'), 'drops heavy sections');

const envOnly = [
  '# AGENTS.md',
  '<!-- dieyun:section:environment status=auto -->',
  '## 环境',
  'win'
].join('\n');
assert(!lightAgentsMdContent(envOnly).includes('win'), 'no overview does not dump environment');

assert(
  extractCodebasePathsFromBlock('### 1. src/a.ts:1-2\nfoo').includes('src/a.ts'),
  'extract codebase path'
);
assert(formatCodebaseBlock('q', { results: [] }) === '', 'empty codebase search is silent');

async function runPrep() {
  const calls = [];
  const packed = await prepSystemPrompt(
    {
      userQuery: '请看 @Codebase src/foo.js',
      indexOk: true,
      injectCode: true,
      allowCodebase: true,
      languagePrompt: '用中文',
      userSystem: '',
      composerMode: 'agent',
      workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
      openFilePaths: ['src/foo.js', 'src/bar.js'],
      changeRows: [{ path: 'src/foo.js', diff: { added: 1, removed: 0 } }],
      turnDataChunks: ['【编辑器上下文 · 当前焦点】\nsrc/foo.js'],
      editor: { hasActiveFile: true, hasSelection: true }
    },
    {
      invokeRpc: async (method, params) => {
        calls.push(method);
        if (method === 'codebase.search') {
          return {
            results: [{ path: 'src/foo.js', startLine: 1, endLine: 3, snippet: 'export const x = 1;' }],
            totalCandidates: 1
          };
        }
        if (method === 'fs.read_file') {
          if (String(params.filePath).includes('AGENTS.md')) {
            return { data: md, encoding: 'utf8' };
          }
          return { data: 'file-body-content-here', encoding: 'utf8' };
        }
        if (method === 'workspace.git_diff') {
          return { ok: true, text: '【未提交 diff】\ndiff --git a/src/foo.js' };
        }
        if (method === 'sql.config_get') {
          return { enabled: false };
        }
        if (method === 'graph.repo_map' || method === 'graph.lsp_enrich') {
          return { indexed: false };
        }
        if (
          method === 'memory.project_recall' ||
          method === 'memory.long_recall' ||
          method === 'memory.long_recent' ||
          method === 'playbook.recall' ||
          method === 'wiki.recall'
        ) {
          return { mode: 'none', results: [] };
        }
        if (method === 'memory.compaction_recent' || method === 'agent.state_get') {
          return method === 'agent.state_get' ? null : [];
        }
        throw new Error('unexpected ' + method);
      },
      getPermissions: () => ({ hostControl: true, fsRead: true, fsWrite: true }),
      getAgentHome: () => ({ dieyunSkills: '/tmp/skills' })
    }
  );
  assert(packed.stable.includes('【Agent 准则】'), 'rules assembled on Main');
  assert(packed.stable.includes('D:/proj'), 'workspace on Main');
  assert(packed.stable.includes('读文件'), 'permissions on Main');
  assert(packed.turnRide.includes('【Codebase 检索】') || packed.turnRide.includes('src/foo.js'), 'codebase on Main');
  assert(packed.turnRide.includes('【当前关注文件'), 'open files on Main');
  assert(packed.turnRide.includes('【项目地图 · AGENTS.md】'), 'AGENTS.md on Main');
  assert(packed.turnRide.includes('hello'), 'AGENTS overview injected');
  assert(!packed.turnRide.includes('win'), 'AGENTS environment not injected');
  assert(!calls.includes('wiki.recall'), 'wiki not recalled');
  assert(packed.turnRide.includes('【本会话变更文件】'), 'changes on Main');
  assert(packed.turnRide.includes('【编辑器上下文'), 'renderer editor chunk preserved');
  assert(calls.includes('codebase.search'), 'searched codebase');
  assert(calls.includes('workspace.git_diff'), 'fetched git diff');
}

async function runPrepKnowledge() {
  const calls = [];
  const packed = await prepSystemPrompt(
    {
      userQuery: '继续改登录',
      sessionId: 'sess-1',
      graphIndexOk: true,
      skipFastIndex: false,
      injectCode: false,
      allowCodebase: false,
      languagePrompt: '',
      userSystem: '',
      composerMode: 'agent',
      workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
      enabledSkillMap: { 'builtin:weather': true },
      compactMcpTools: true,
      hasContinueCheckpoint: true,
      hasActiveRun: false
    },
    {
      invokeRpc: async (method) => {
        calls.push(method);
        if (method === 'fs.read_file') {
          return { data: '', encoding: 'utf8' };
        }
        if (method === 'sql.config_get') return { enabled: false };
        if (method === 'graph.repo_map' || method === 'graph.lsp_enrich' || method === 'wiki.recall') {
          throw new Error(`${method} should not run in this case`);
        }
        if (method === 'memory.project_recall') {
          return { mode: 'keyword', results: [{ id: 7, kind: 'normal', score: 0.5, content: '登录用 JWT' }] };
        }
        if (method === 'memory.long_recall') {
          return { mode: 'keyword', results: [{ id: 3, kind: 'normal', score: 0.4, content: '用户偏好中文' }] };
        }
        if (method === 'playbook.recall') {
          return {
            mode: 'keyword',
            results: [{ id: 'pb1', title: '登录修复', domain: 'auth', summary: '先读登录模块', path: '.dieyun/playbook/login.md', score: 0.5 }]
          };
        }
        if (method === 'memory.compaction_recent') {
          return [{ summary_text: '此前已改过路由' }];
        }
        if (method === 'agent.state_get') {
          return { summary: '正在改登录', status: 'paused', stateSnapshot: { taskStage: 'editing' } };
        }
        throw new Error('unexpected ' + method);
      },
      getPermissions: () => ({}),
      getAgentHome: () => ({ dieyunSkills: '/tmp/skills' }),
      listMcpServers: async () => [
        {
          id: 'fs',
          name: 'Filesystem',
          enabled: true,
          command: 'npx',
          args: ['-y', 'mcp-fs'],
          description: '读本地文件'
        }
      ],
      skills: {
        scan: async () => ({
          skills: [{
            id: 'builtin:weather',
            name: '天气',
            description: '查天气',
            skillPath: '/tmp/weather/SKILL.md',
            dir: '/tmp/weather'
          }]
        }),
        recall: async () => ({
          mode: 'keyword',
          skills: [{ id: 'builtin:weather', skillPath: '/tmp/weather/SKILL.md', dir: '/tmp/weather', score: 0.9 }]
        }),
        read: async () => {
          throw new Error('should not read full SKILL.md');
        }
      }
    }
  );
  assert(!packed.turnRide.includes('尚未建立'), 'empty AGENTS.md stays out');
  assert(!packed.turnRide.includes('【项目地图 · AGENTS.md】'), 'no AGENTS stub');
  assert(packed.turnRide.includes('【项目记忆'), 'project memory on Main');
  assert(packed.turnRide.includes('【长期记忆'), 'global memory on Main');
  assert(packed.turnRide.includes('【相关 Playbook'), 'playbook on Main');
  assert(!packed.turnRide.includes('【项目 Wiki】'), 'wiki not auto-injected');
  assert(packed.turnRide.includes('此前已改过路由') || packed.turnRide.includes('压缩摘要'), 'compaction on Main');
  assert(packed.turnRide.includes('【工作记忆模板】'), 'work memory on Main');
  assert(packed.turnRide.includes('【相关技能 · 索引'), 'skills catalog on Main');
  assert(packed.turnRide.includes('查天气'), 'skill description from catalog');
  assert(!packed.turnRide.includes('用 HTTP 查天气'), 'skill body not injected');
  assert(packed.stable.includes('【MCP · 1 个服务已启用】Filesystem'), 'compact MCP on Main stable');
  assert(!calls.includes('graph.repo_map'), 'did not fetch graph');
  assert(!calls.includes('wiki.recall'), 'did not fetch wiki');
  assert(calls.includes('memory.project_recall'), 'fetched project memory');
}

async function runPrepGraph() {
  const calls = [];
  const packed = await prepSystemPrompt(
    {
      userQuery: '请看 src/login.js',
      graphIndexOk: true,
      skipFastIndex: false,
      injectCode: true,
      allowCodebase: false,
      workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
      openFilePaths: []
    },
    {
      invokeRpc: async (method) => {
        calls.push(method);
        if (method === 'fs.read_file') return { data: md, encoding: 'utf8' };
        if (method === 'sql.config_get') return { enabled: false };
        if (method === 'graph.repo_map') {
          return { indexed: true, markdown: '【仓库结构】\n- src/login.js' };
        }
        if (method === 'graph.lsp_enrich') return { ok: true };
        if (method === 'workspace.git_diff') return { ok: false };
        if (
          method === 'memory.project_recall' ||
          method === 'memory.long_recall' ||
          method === 'playbook.recall'
        ) {
          return { mode: 'none', results: [] };
        }
        if (method === 'memory.compaction_recent' || method === 'agent.state_get') {
          return method === 'agent.state_get' ? null : [];
        }
        throw new Error('unexpected ' + method);
      },
      getPermissions: () => ({}),
      getAgentHome: () => ({})
    }
  );
  assert(packed.turnRide.includes('【仓库结构】') || packed.turnRide.includes('src/login.js'), 'graph on injectCode');
  assert(calls.includes('graph.repo_map'), 'fetched graph with injectCode');
}

async function runPrepSkipAutoGraph() {
  const calls = [];
  await prepSystemPrompt(
    {
      userQuery: '请看 src/login.js',
      graphIndexOk: true,
      injectCode: true,
      allowCodebase: false,
      workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
      taskTier: {
        taskTier: 'trivial',
        readyToWrite: true,
        suggestedFiles: ['src/login.js']
      }
    },
    {
      invokeRpc: async (method) => {
        calls.push(method);
        if (method === 'fs.read_file') return { data: md, encoding: 'utf8' };
        if (method === 'sql.config_get') return { enabled: false };
        if (method === 'graph.repo_map' || method === 'graph.lsp_enrich') {
          throw new Error('graph should skip when skipAuto');
        }
        if (method === 'workspace.git_diff') return { ok: false };
        if (
          method === 'memory.project_recall' ||
          method === 'memory.long_recall' ||
          method === 'playbook.recall'
        ) {
          return { mode: 'none', results: [] };
        }
        throw new Error('unexpected ' + method);
      },
      getPermissions: () => ({}),
      getAgentHome: () => ({})
    }
  );
  assert(!calls.includes('graph.repo_map'), 'trivial scoped task skips repo_map');
  assert(!calls.includes('graph.lsp_enrich'), 'trivial scoped task skips lsp_enrich');
}

async function runPrepMcpFull() {
  const packed = await prepSystemPrompt(
    {
      userQuery: 'hi',
      compactMcpTools: false,
      injectCode: false,
      allowCodebase: false,
      workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' }
    },
    {
      invokeRpc: async (method) => {
        if (method === 'fs.read_file') return { data: '', encoding: 'utf8' };
        if (method === 'sql.config_get') return { enabled: false };
        if (
          method === 'memory.project_recall' ||
          method === 'memory.long_recall' ||
          method === 'playbook.recall'
        ) {
          return { mode: 'none', results: [] };
        }
        throw new Error('unexpected ' + method);
      },
      getPermissions: () => ({}),
      getAgentHome: () => ({}),
      listMcpServers: async () => [
        {
          id: 'fs',
          name: 'Filesystem',
          enabled: true,
          command: 'npx',
          args: ['-y', 'mcp-fs'],
          description: '读本地文件',
          envHint: 'FOO'
        }
      ]
    }
  );
  assert(packed.stable.includes('【已启用 MCP 服务】'), 'full MCP listing on stable');
  assert(packed.stable.includes('启动命令：npx -y mcp-fs'), 'MCP command on Main');
  assert(packed.stable.includes('环境变量：FOO'), 'MCP env hint');
}

runPrep()
  .then(() => runPrepKnowledge())
  .then(() => runPrepGraph())
  .then(() => runPrepSkipAutoGraph())
  .then(() => runPrepMcpFull())
  .then(() => {
    console.log('test-system-prompt-prep.cjs ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
