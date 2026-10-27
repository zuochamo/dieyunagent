'use strict';

const { decideOsControlAction } = require('../sandbox-policy');

/**
 * computer 工具的 gateway handler：开关断言 → 沙箱判定/审批 → 调 service。
 * 判定单一来源在 sandbox-policy.js（decideOsControlAction），这里不做任何白名单判断。
 */
function createComputerHandlers(d) {
  const { computer, assertOsControlEnabled, sandbox, getActiveCallSessionId, getRemoteFs } = d;

  /**
   * 沙箱档位对 computer 动作的判定（输入动作 → 问一次；截屏 → 开关即同意）。
   * @param {string} action
   * @param {string} sessionId
   */
  async function guardComputer(action, sessionId) {
    if (!sandbox) {
      // fail-closed：与 host.exec 同一立场——装配错误不能静默放行成无限制提权面。
      const e = new Error('沙箱未就绪，已拒绝执行（请重启应用；装配问题不该由用户承担风险）');
      e.code = 'SANDBOX_UNAVAILABLE';
      e.retryable = false;
      throw e;
    }
    const decision = decideOsControlAction(action, { mode: sandbox.context().mode });
    const blocked = await sandbox.guard(decision, {
      tool: 'computer',
      sessionId: sessionId || getActiveCallSessionId()
    });
    if (blocked) {
      const e = new Error(blocked.error);
      e.code = blocked.errorCode;
      e.sandboxMode = blocked.sandboxMode;
      e.retryable = false;
      throw e;
    }
  }

  return {
    'computer.action': async (params = {}) => {
      assertOsControlEnabled();
      const remote = typeof getRemoteFs === 'function' ? getRemoteFs() : null;
      if (remote) {
        // computer 控制的是叠云所在机器的屏幕；SSH 工作区下执行体仍在本机，
        // 语义上会把「远程任务」和「本机桌面操作」混在一起，明确不支持（参照 host.print_image）。
        const e = new Error('SSH 远程工作区暂不支持电脑控制（该工具只作用于叠云所在机器的屏幕）');
        e.code = 'REMOTE_OS_CONTROL_UNSUPPORTED';
        e.retryable = false;
        throw e;
      }
      const { sessionId, ...rest } = params;
      await guardComputer(String(rest.action || ''), sessionId);
      return computer.action({ ...rest, sessionId });
    }
  };
}

module.exports = { createComputerHandlers };
