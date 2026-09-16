'use strict';

const path = require('path');

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
    getActiveCallSessionId,
    isSshConnectedForCall,
    probeHostEnvironment,
    defaultCwd,
    openExternalUrl,
    normalizeFilePathInput,
    printImage,
    assertAllowedPath,
  } = d;
  return {
    'host.exec': async ({ command, cwd, timeoutMs, detached, runId, sessionId }) => {
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
      if (detached) {
        return runShellDetached(command, { cwd: workDir });
      }
      return runShell(command, {
        cwd: workDir,
        timeoutMs,
        sessionId: sessionId || getActiveCallSessionId() || undefined,
        signal: runAbortSignal || undefined
      });
    },

    'host.environment': async () => {
      assertHostEnabled(ctx);
      const target = resolveCallWorkspaceTarget();
      const sshConnected = isSshConnectedForCall();

      let runRemoteShell = null;
      if (target && target.kind === 'ssh' && sshConnected) {
        try {
          const remote = getRemoteFs();
          const root = remote.root;
          runRemoteShell = (command, timeoutMs) =>
            requireSshForCall().exec(command, root, timeoutMs || 8000, { loginShell: false });
        } catch {
          runRemoteShell = null;
        }
      }

      return probeHostEnvironment({
        platform: process.platform,
        arch: process.arch,
        workspaceTarget: target,
        sshConnected,
        defaultCwd,
        runLocalShell: (command, timeoutMs) =>
          runShell(command, { cwd: defaultCwd || undefined, timeoutMs: timeoutMs || 8000 }),
        runRemoteShell
      });
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
