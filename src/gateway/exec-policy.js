'use strict';

const { SANDBOX_DENY_LIST, matchDangerousCommand, stripShellQuotedSegments } = require('./sandbox-policy');

/**
 * `host.exec` 的**命令合法性**检查（格式 / 长度 / 链长 / 高危词表）。
 *
 * 高危词表的单一来源是 `sandbox-policy.SANDBOX_DENY_LIST`：这些命令在任何沙箱档位都拒绝，
 * 所以「格式检查」和「沙箱判定」必须用同一份词表 —— 否则会出现「这条被 exec 拦、那条被沙箱拦」
 * 的两套答案。这里只额外负责与档位无关的长度/链长限制。
 */

/** 仅限制 && / || 组合，; 顺序执行不计入（部署脚本常用） */
const MAX_CHAIN_OPS = 8;

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
  const hit = matchDangerousCommand(cmd);
  if (hit) {
    // 必须回传**命中的那条规则**：只说「检测到高危操作」时，模型与用户都只能靠猜，
    // 于是反复改写命令再撞同一堵墙（`del /q` 被拦就是这么来回折腾的）。
    const rule = String(hit);
    return {
      ok: false,
      code: 'BLOCKED',
      rule,
      message:
        `命令被安全策略拒绝：命中高危规则 ${rule}。` +
        '这类操作在任何沙箱档位都不放行（不是权限没开）。如需清理文件，改用明确目标的删除' +
        '（不带 /s /f，或先列出再逐个删）；确需高风险操作请由用户在系统终端里手动执行。'
    };
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
  stripShellQuotedSegments,
  /** 兼容旧引用：内容即沙箱高危词表（同一份对象，不是副本） */
  BLOCKED_PATTERNS: SANDBOX_DENY_LIST
};
