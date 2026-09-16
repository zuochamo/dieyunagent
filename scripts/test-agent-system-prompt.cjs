'use strict';

const {
  buildCoreAgentRules,
  formatSystemTimeChunk,
  assembleSystemPrompt
} = require('../src/agent/agent-system-prompt');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const planRules = buildCoreAgentRules({ composerMode: 'plan' });
assert(planRules.includes('【Agent 准则】'), 'core rules header');
assert(planRules.includes('无 tool_calls 的文字回复即本轮结束'), 'loop end rule');
assert(planRules.includes('规划师产出 TODO'), 'plan mode orchestration');

const agentRules = buildCoreAgentRules({ composerMode: 'agent' });
assert(agentRules.includes('若给出新需求则只做该需求'), 'new task still wins when it replaces the goal');
assert(agentRules.includes('未改目标时根据压缩摘要'), 'same-session work continues from fold');
assert(agentRules.includes('不要因历史已折叠而提问'), 'folded history is not a clarify trigger');
assert(agentRules.includes('勿仅因折叠就重读同一文件'), 'fold must not trigger recovery thrash');
assert(agentRules.includes('不要假设已注入'), 'wiki is on-demand');
assert(!agentRules.includes('概览已注入'), 'AGENTS overview is not claimed injected');
assert(agentRules.includes('概览若已出现'), 'AGENTS overview is conditional');
assert(!agentRules.includes('运行环境'), 'environment not in core rules');

const now = new Date('2026-09-09T01:00:00.000Z');
const timeChunk = formatSystemTimeChunk(now);
assert(timeChunk.includes('ISO 2026-09-09'), 'frozen system time');

const packed = assembleSystemPrompt({
  languagePrompt: '用中文回答。',
  userSystem: '用户补充规则',
  composerMode: 'agent',
  taskTier: { taskTier: 'trivial', reason: '单文件', suggestedFiles: ['a.ts'] },
  agentHome: { dieyunSkills: '/home/u/.dieyun/skills', dieyunWorkspace: '/home/u/.dieyun' },
  workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
  permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true, sqlRead: true },
  sqlConfig: {
    enabled: true,
    host: '127.0.0.1',
    port: 1433,
    user: 'sa',
    databases: ['AppDb']
  },
  stableDataChunks: ['【MCP】demo'],
  turnDataChunks: ['【相关代码】foo.ts'],
  now
});

assert(packed.stable.includes('用中文回答。'), 'language in stable');
assert(packed.stable.includes('用户补充规则'), 'user system in stable');
assert(packed.stable.includes('【Agent 准则】'), 'rules in stable');
assert(packed.stable.includes('技能根目录：/home/u/.dieyun/skills'), 'home in stable');
assert(packed.stable.includes('D:/proj'), 'workspace in stable');
assert(!packed.stable.includes('已预注入'), 'workspace does not claim preloaded maps');
assert(packed.stable.includes('读文件'), 'permissions in stable');
assert(packed.stable.includes('cmd'), 'windows host_exec hint stays short');
assert(!packed.stable.includes('browser_navigate'), 'permissions omit tool tutorial');
assert(packed.stable.includes('AppDb'), 'sql in stable');
assert(packed.stable.includes('【MCP】demo'), 'stable recall after rules');
assert(!packed.stable.includes('foo.ts'), 'turn recall stays out of stable');
assert(packed.turnRide.includes('ISO 2026-09-09'), 'time in turn ride');
assert(!packed.turnRide.includes('【任务分级'), 'task tier stays out of prompt');
assert(packed.turnRide.includes('foo.ts'), 'recall in turn ride');

const fallbackHome = assembleSystemPrompt({
  agentHome: { dieyunWorkspace: '/tmp/default-ws' },
  now
});
assert(fallbackHome.stable.includes('【默认工作目录】'), 'default workspace when none bound');
assert(fallbackHome.stable.includes('/tmp/default-ws'), 'default workspace path');

const longSys = assembleSystemPrompt({
  userSystem: 'S'.repeat(20000),
  now
});
assert(longSys.stable.includes('用户系统提示已截断'), 'user system is capped');
assert(!longSys.stable.includes('S'.repeat(9000)), 'oversized user system is not kept whole');

const longStable = assembleSystemPrompt({
  stableDataChunks: ['M'.repeat(40000)],
  now
});
assert(longStable.stable.includes('稳定系统提示已截断'), 'stable system total is capped');
assert(longStable.stable.length < 20000, 'stable system stays bounded');

console.log('test-agent-system-prompt.cjs ok');
