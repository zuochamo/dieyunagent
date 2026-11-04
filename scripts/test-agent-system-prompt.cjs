'use strict';

const {
  buildCoreAgentRules,
  formatSystemTimeChunk,
  assembleSystemPrompt
} = require('../src/agent/agent-system-prompt');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// 规则不再有模式分支：plan/explore 两段随模式选择器一起删除，
// 只剩「主循环准则」+ subagent + peer 三块（plan/explore 相关断言一并删除）。
const rules = buildCoreAgentRules();
assert(rules.includes('【Agent 准则】'), 'core rules header');
assert(rules.includes('无 tool_calls 的文字回复即本轮结束'), 'loop end rule');
assert(!rules.includes('【编排】'), 'no plan-mode orchestration rule');
assert(!rules.includes('【探索】'), 'no explore-mode rule');
assert(rules.includes('【只读并发调研】'), 'subagent rules always present');

const agentRules = rules;
assert(agentRules.includes('若给出新需求则只做该需求'), 'new task still wins when it replaces the goal');
assert(agentRules.includes('未改目标时根据压缩摘要'), 'same-session work continues from fold');
assert(agentRules.includes('不要因历史已折叠而提问'), 'folded history is not a clarify trigger');
assert(agentRules.includes('勿仅因折叠就重读同一文件'), 'fold must not trigger recovery thrash');
assert(!agentRules.includes('概览已注入'), 'AGENTS overview is not claimed injected');
assert(agentRules.includes('概览若已出现'), 'AGENTS overview is conditional');
assert(!agentRules.includes('运行环境'), 'environment not in core rules');

const now = new Date('2026-09-09T01:00:00.000Z');
const timeChunk = formatSystemTimeChunk(now);
assert(timeChunk.includes('ISO 2026-09-09'), 'frozen system time');

const packed = assembleSystemPrompt({
  languagePrompt: '用中文回答。',
  userSystem: '用户补充规则',
  taskTier: { taskTier: 'trivial', reason: '单文件', suggestedFiles: ['a.ts'] },
  agentHome: { dieyunSkills: '/home/u/.dieyun/skills', dieyunWorkspace: '/home/u/.dieyun' },
  workspaceInfo: { workspacePath: 'D:/proj', kind: 'local' },
  permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true },
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

// 上限唯一来源是 src/agent/agent-limits.js：探针与边界都按它推导。
// 抄死字面量的话，改护栏数字就会让本用例假红（或假绿）。
const userSystemCap = AGENT_LIMITS_DEFAULTS.userSystemMaxChars;
const stableSystemCap = AGENT_LIMITS_DEFAULTS.systemStableMaxChars;

const longSys = assembleSystemPrompt({
  userSystem: 'S'.repeat(userSystemCap * 3),
  now
});
assert(longSys.stable.includes('用户系统提示已截断'), 'user system is capped');
assert(!longSys.stable.includes('S'.repeat(userSystemCap + 1)), 'oversized user system is not kept whole');

const longStable = assembleSystemPrompt({
  stableDataChunks: ['M'.repeat(stableSystemCap * 3)],
  now
});
assert(longStable.stable.includes('稳定系统提示已截断'), 'stable system total is capped');
// 截断标记（…（稳定系统提示已截断））追加在 cap 之后，故留固定余量。
assert(
  longStable.stable.length <= stableSystemCap + 64,
  'stable system stays bounded by systemStableMaxChars'
);

console.log('test-agent-system-prompt.cjs ok');
