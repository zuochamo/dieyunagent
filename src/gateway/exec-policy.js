'use strict';

/** 明确拒绝的高危 shell 片段（子串/正则） */
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\s/,
  /\brm\s+-rf\s+\/\s*$/,
  /\bdel\s+\/[sfq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\./i,
  />\s*\/dev\/sd[a-z]/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\s+\/s/i,
  /\breboot\b/i,
  /powershell\s+.*-enc(odedcommand)?/i
];

/** 仅限制 && / || 组合，; 顺序执行不计入（部署脚本常用） */
const MAX_CHAIN_OPS = 8;

function stripShellQuotedSegments(cmd) {
  return String(cmd || '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function countChainOperators(cmd) {
  const s = stripShellQuotedSegments(cmd);
  return (s.match(/&&|\|\|/g) || []).length;
}

function validateShellCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return { ok: false, code: 'EMPTY', message: 'command 为空' };
  }
  if (cmd.length > 12000) {
    return { ok: false, code: 'TOO_LONG', message: '命令过长，请拆分执行' };
  }
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(cmd)) {
      return {
        ok: false,
        code: 'BLOCKED',
        message: '命令被安全策略拒绝：检测到高危操作'
      };
    }
  }
  const chainOps = countChainOperators(cmd);
  if (chainOps > MAX_CHAIN_OPS) {
    return {
      ok: false,
      code: 'CHAIN_LIMIT',
      message: `命令 &&/|| 链过长（>${MAX_CHAIN_OPS} 段），请拆分逐步执行`
    };
  }
  return { ok: true };
}

module.exports = {
  validateShellCommand,
  countChainOperators,
  stripShellQuotedSegments,
  BLOCKED_PATTERNS,
  MAX_CHAIN_OPS
};
