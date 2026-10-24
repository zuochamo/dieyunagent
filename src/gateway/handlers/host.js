'use strict';

const path = require('path');

const { decideShellCommand } = require('../sandbox-policy');

function createHostHandlers(d) {
  const {
    assertHostEnabled,
    ctx,
    perms,
    validateShellCommand,
    resolveCallWorkspaceTarget,
    normalizeRemotePath,
    getRemoteFs,
    requireSshForCall,
    cwdForCall,
    readRootsForCall,
    runShellDetached,
    runShell,
    listProcessHandles,
    killProcessHandle,
    readProcessOutput,
    getActiveCallSessionId,
    isSshConnectedForCall,
    defaultCwd,
    openExternalUrl,
    normalizeFilePathInput,
    printImage,
    assertAllowedPath,
    sandbox,
  } = d;

  /**
   * 沙箱档位对 `host.exec` 的判定（写/联网越界 → 问一次；高危 → 恒拒）。
   * `host.exec` 唯一的策略入口：档位语义在 sandbox-policy.js，审批记忆在 sandbox-approvals.js。
   */
  async function guardShell(command, workDir, sessionId, opts = {}) {
    if (!sandbox) {
      // fail-closed：没注入沙箱说明装配错了。静默放行等于把 `host.exec` 变成无限制提权面。
      const e = new Error('沙箱未就绪，已拒绝执行（请重启应用；装配问题不该由用户承担风险）');
      e.code = 'SANDBOX_UNAVAILABLE';
      e.retryable = false;
      throw e;
    }
    const decision = decideShellCommand(command, {
      ...sandbox.context({ cwd: workDir }),
      // 远程（SSH）命令的路径是远端路径：按本地根解析只会造出假越界和假 detail
      remote: opts.remote === true
    });
    const blocked = await sandbox.guard(decision, {
      tool: 'host_exec',
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
    'host.exec': async ({ command, cwd, timeoutMs, waitMs, keepOnTimeout, detached, runId, sessionId }) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      if (!command || typeof command !== 'string') {
        const e = new Error('command 必填');
        e.code = 'INVALID_COMMAND';
        throw e;
      }
      const policy = validateShellCommand(command);
      if (!policy.ok) {
        const e = new Error(policy.message || '命令被安全策略拒绝');
        e.code = policy.code || 'SHELL_POLICY_BLOCKED';
        throw e;
      }
      let runAbortSignal = null;
      try {
        const { getRunAbortSignal } = require('../../agent/run-cancel-registry');
        runAbortSignal = runId ? getRunAbortSignal(runId) : null;
      } catch {
        runAbortSignal = null;
      }
      const remote = getRemoteFs();
      if (remote) {
        const workDir = cwd ? remote.resolve(cwd, remote.root) : remote.root;
        await guardShell(command, workDir, sessionId, { remote: true });
        if (detached) {
          const bg = `nohup ${command} >/dev/null 2>&1 & echo $!`;
          const r = await requireSshForCall().exec(bg, workDir, Math.min(30000, Number(timeoutMs) || 15000), {
            loginShell: false
          });
          const pid = parseInt(String(r.stdout || '').trim(), 10);
          const code = Number(r.code) || 0;
          return {
            code,
            stdout:
              code === 0
                ? Number.isFinite(pid)
                  ? `已后台启动 PID ${pid}`
                  : '已后台启动'
                : String(r.stdout || ''),
            stderr: r.stderr || '',
            remote: true,
            detached: true,
            pid: code === 0 && Number.isFinite(pid) ? pid : undefined
          };
        }
        const r = await requireSshForCall().exec(command, workDir, timeoutMs);
        return {
          code: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
          remote: true
        };
      }
      const workDir = (() => {
        if (!cwd) return cwdForCall() || undefined;
        const base = cwdForCall() || process.cwd();
        const resolved = path.isAbsolute(String(cwd))
          ? path.resolve(String(cwd))
          : path.resolve(base, String(cwd));
        // 并行本地任务：cwd 常为该会话工作区，必须用 readRootsForCall（含 runWorkspaceRoot），不能只用全局 roots
        return assertAllowedPath(resolved, readRootsForCall());
      })();
      const callSessionId = sessionId || getActiveCallSessionId() || undefined;
      await guardShell(command, workDir, callSessionId);
      if (detached) {
        return runShellDetached(command, { cwd: workDir, sessionId: callSessionId });
      }
      // 长任务语义：给了 waitMs 就视为「等待窗口」，到点转后台而不是杀掉重来
      const waitWindow = Number(waitMs);
      const hasWaitWindow = Number.isFinite(waitWindow) && waitWindow > 0;
      return runShell(command, {
        cwd: workDir,
        timeoutMs: hasWaitWindow ? waitWindow : timeoutMs,
        keepOnTimeout: hasWaitWindow || keepOnTimeout === true,
        sessionId: callSessionId,
        trackProcess: true,
        signal: runAbortSignal || undefined
      });
    },

    'host.proc_list': async ({ includeFinished, sessionId } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      return listProcessHandles({
        sessionId: sessionId || getActiveCallSessionId() || undefined,
        includeFinished: includeFinished === true
      });
    },

    'host.proc_output': async ({ id, pid, offset, tailBytes, waitMs, sessionId } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const result = await readProcessOutput({
        id,
        pid,
        offset,
        tailBytes,
        waitMs,
        sessionId: sessionId || getActiveCallSessionId() || undefined
      });
      if (!result.ok) {
        const e = new Error(result.error || '读取进程输出失败');
        e.code = result.errorCode || 'PROC_OUTPUT_FAILED';
        e.hint = result.hint;
        throw e;
      }
      return result;
    },

    'host.proc_kill': async ({ id, pid, sessionId } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const result = await killProcessHandle({
        id,
        pid,
        sessionId: sessionId || getActiveCallSessionId() || undefined
      });
      if (!result.ok) {
        const e = new Error(result.error || '结束进程失败');
        e.code = result.errorCode || 'PROC_KILL_FAILED';
        throw e;
      }
      return result;
    },

    'host.open_url': async ({ url }) => {
      assertHostEnabled(ctx);
      return openExternalUrl(url);
    },

    'host.print_image': async ({ filePath }) => {
      assertHostEnabled(ctx);
      const remote = getRemoteFs();
      if (remote) {
        const e = new Error('远程 SSH 工作空间暂不支持本地打印图片');
        e.code = 'REMOTE_PRINT_UNSUPPORTED';
        throw e;
      }
      const resolved = normalizeFilePathInput(filePath, cwdForCall() || defaultCwd);
      const safe = assertAllowedPath(resolved, readRootsForCall());
      return printImage(safe);
    },
  };
}

module.exports = { createHostHandlers };
