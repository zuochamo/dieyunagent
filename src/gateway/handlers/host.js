'use strict';

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const { decideShellCommand } = require('../sandbox-policy');
// 可打印图片扩展名：printImage 的判定口径，远端取回打印前按同一份校验（直接取模块，别再穿一层依赖）
const { IMAGE_EXTENSIONS } = require('../host-control');
// 远端读回上来的图片要按同一份字节上限读，否则默认 64KB 会把图截断成坏文件
const { ABSOLUTE_READ_MAX_BYTES } = require('../fs-read-limits');
// 「本机」（跑叠云这台机器）的显式标记：cwd 的 `local:` 前缀 / host_exec 的 local:true /
// 后台进程句柄前缀。语义唯一来源见 host-local.js，这里不另写判定。
const { splitHostLocalRef, isLocalFlag, procHandleScope, annotateLocalPathMiss } = require('../host-local');
// 本机 Windows 上写 POSIX 风格路径要报「方言不对」，而不是让 path.resolve 造出 `E:\srv\app`
const { isForeignPosixPath } = require('../../workspace/target');
const {
  startRemoteDetached,
  listRemoteProcesses,
  takeSettledRemoteReports,
  readRemoteOutput,
  killRemoteProcess
} = require('../remote-processes');

function createHostHandlers(d) {
  const {
    assertHostEnabled,
    ctx,
    perms,
    validateShellCommand,
    resolveCallWorkspaceTarget,
    normalizeRemotePath,
    getRemoteFs,
    resolveFsTarget,
    requireSshForCall,
    cwdForCall,
    readRootsForCall,
    // 远端沙箱作用域（工作区根 + 传输允许根）：远端命令的档位判定用它，别在 handler 里自己拼
    remoteSandboxScope,
    runShellDetached,
    runShell,
    listProcessHandles,
    takeSettledReports,
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
   *
   * `opts.remote` = 命令跑在**远端主机**上：同一套档位语义，换 POSIX 方言与远端根
   * （`remoteSandboxScope()` 给出远端工作区 + 传输允许根）。曾经远端命令一律「问一次」，
   * 因为本机看不到远端路径 —— 现在按远端工作区精确判：工作区内的写直接放行、区外才问。
   */
  async function guardShell(command, workDir, sessionId, opts = {}) {
    if (!sandbox) {
      // fail-closed：没注入沙箱说明装配错了。静默放行等于把 `host.exec` 变成无限制提权面。
      const e = new Error('沙箱未就绪，已拒绝执行（请重启应用；装配问题不该由用户承担风险）');
      e.code = 'SANDBOX_UNAVAILABLE';
      e.retryable = false;
      throw e;
    }
    const scope =
      opts.remote === true && typeof remoteSandboxScope === 'function' ? remoteSandboxScope() : null;
    const decision = decideShellCommand(command, {
      ...sandbox.context(scope ? { remote: scope, cwd: workDir } : { cwd: workDir }),
      // 远端命令的路径是远端路径：按 POSIX 解析、大小写敏感（方言跟着机器走）
      remote: opts.remote === true
    });
    const blocked = await sandbox.guard(decision, {
      tool: 'host_exec',
      sessionId: sessionId || getActiveCallSessionId(),
      // 批准记忆的粒度是「会话 × 类别 × 目录」，目录只能来自判定结果。
      // 不传 path 会让 `ask()` 拿到 `scopeOf(undefined)='-'`，退化成类别级 ——
      // 即「批准过 D:\a 就等于批准过 D:\b」，一次批准打穿整个档位。
      path: (decision && decision.path) || '',
      // 远端目录的授权只对远端生效（不进本机写白名单，见 sandbox-approvals#rememberPath）
      remote: opts.remote === true
    });
    if (blocked) {
      const e = new Error(blocked.error);
      e.code = blocked.errorCode;
      e.sandboxMode = blocked.sandboxMode;
      e.retryable = false;
      throw e;
    }
  }
  /**
   * 后台进程去哪张表：`local:true` 优先，其次看句柄前缀（`hostproc-` 本机 / `sshproc-` 远端），
   * 两者都没有（例如 list 不带句柄）就跟随会话工作空间。
   * @returns {'local'|'remote'}
   */
  function procScope({ local, id } = {}) {
    if (isLocalFlag(local)) return 'local';
    const byHandle = procHandleScope(id);
    if (byHandle) return byHandle;
    return getRemoteFs() ? 'remote' : 'local';
  }
  return {
    'host.exec': async ({ command, cwd, local, timeoutMs, waitMs, keepOnTimeout, detached, runId, sessionId }) => {
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
      // 去哪台机器：`cwd` 带 `local:` 前缀或 `local:true` = 在**本机**（跑叠云这台机器）跑，
      // 与工作空间无关 —— SSH 会话里也能在本机执行（判定仍走本机沙箱档位与白名单）。
      // 缺省跟随会话工作空间（SSH 会话即远端主机）。
      const cwdRef = splitHostLocalRef(cwd);
      const sessionRemote = getRemoteFs();
      const wantLocal = cwdRef.local || isLocalFlag(local);
      const remote = wantLocal ? null : sessionRemote;
      if (remote) {
        const workDir = cwdRef.path ? remote.resolve(cwdRef.path, remote.root) : remote.root;
        await guardShell(command, workDir, sessionId, { remote: true });
        if (detached) {
          // 远程也要有本机那套「能查、能读、能停」：setsid 起独立进程组 + 输出落盘 + 登记句柄
          const res = await startRemoteDetached({
            ssh: requireSshForCall(),
            cwd: workDir,
            command,
            sessionId: sessionId || getActiveCallSessionId() || undefined,
            timeoutMs
          });
          // 没拿到 pid = 这次启动没成（cd 失败 / bash -c 立刻退出），别回一个用不了的句柄
          if (res.code !== 0 || !res.pid) {
            return {
              code: res.code || 1,
              stdout: String(res.stderr || ''),
              stderr: res.stderr || '',
              remote: true,
              detached: true,
              hint: `后台启动失败：先确认 cwd「${workDir}」在远端存在、命令本身能跑；启动日志在 ${res.logPath}。`
            };
          }
          return {
            code: 0,
            stdout: `已后台启动 PID ${res.pid}（句柄 ${res.id}；输出写入 ${res.logPath}）`,
            stderr: res.stderr || '',
            remote: true,
            detached: true,
            pid: res.pid,
            handle: res.id,
            logPath: res.logPath,
            hint: `用 host_proc action=output id=${res.id} 读输出（可加 waitMs），action=kill id=${res.id} 结束。`
          };
        }
        const r = await requireSshForCall().exec(command, workDir, timeoutMs);
        return {
          code: r.code,
          stdout: r.stdout,
          stderr: r.stderr,
          remote: true,
          // 输出超上限时只保留尾部：必须告诉模型，否则它会把半截输出当成全部
          truncated: r.truncated === true,
          droppedChars: r.droppedChars,
          ...(r.truncated === true
            ? { hint: '输出超过上限，只保留了尾部；要更多请缩小范围（head / tail / grep）。' }
            : {})
        };
      }
      const workDir = (() => {
        const rawCwd = cwdRef.path;
        // 显式本机时基准必须是本机目录：SSH 会话里 cwdForCall() 是远端路径，
        // 拿它当基准 resolve 出来的位置在另一台机器上，等于静默跑错地方。
        const base = wantLocal && sessionRemote ? defaultCwd : cwdForCall();
        if (!rawCwd) return base || undefined;
        if (wantLocal && isForeignPosixPath(String(rawCwd))) {
          // 模型常把远端 cwd 照抄过来；在 Windows 上 `path.isAbsolute('/srv/app')` 为真、
          // resolve 会变成 `E:\srv\app`，最后报一句和病因无关的 PATH_NOT_ALLOWED。
          const e = new Error(
            `本机是 Windows，local 执行时不能给 POSIX 路径「${rawCwd}」`
          );
          e.code = 'LOCAL_PATH_WRONG_DIALECT';
          e.retryable = false;
          e.suggestedFix =
            '本机路径写成 Windows 形式（例 local:C:\\Users\\me\\work），或干脆不带 local / 不传 cwd 走远端。';
          throw e;
        }
        const anchor = base || process.cwd();
        const resolved = path.isAbsolute(String(rawCwd))
          ? path.resolve(String(rawCwd))
          : path.resolve(anchor, String(rawCwd));
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

    'host.proc_list': async ({ includeFinished, sessionId, local } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const callSessionId = sessionId || getActiveCallSessionId() || undefined;
      // 句柄在哪台机器就在哪张表里（同一套 list/output/kill 语义）：
      // SSH 会话里起过本机后台进程（host_exec local:true）时，用 local:true 看本机那张表。
      if (procScope({ local }) === 'remote') {
        return listRemoteProcesses({
          ssh: requireSshForCall(),
          sessionId: callSessionId,
          includeFinished: includeFinished === true
        });
      }
      return listProcessHandles({
        sessionId: callSessionId,
        includeFinished: includeFinished === true
      });
    },

    /**
     * 「后台任务已结束、但模型还不知道」的一次性投递口：不唤醒任何一轮（静默补报），
     * 只在下一次组 prompt 时被取走一次。唯一消费者是
     * `agent/system-prompt-prep.js#fetchSettledJobsBlock`；取走即标记已投递，
     * 同一条不会报第二次（模型自己用 host_proc 读过也一样算已投递）。
     */
    'host.proc_settled': async ({ sessionId, tailBytes, limit } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const callSessionId = sessionId || getActiveCallSessionId() || undefined;
      if (getRemoteFs()) {
        // SSH 会话里也可能起过**本机**后台进程（host_exec local:true）：两张表都要报，
        // 只报远端那张，那条「已结束」就永远送不到模型面前。
        const local = takeSettledReports({ sessionId: callSessionId, tailBytes, limit });
        // 远端取报告要 SSH 往返，连不上时**不能**把本机那份也一起丢掉（那几条已经被标记投递了）
        let remote = null;
        try {
          remote = await takeSettledRemoteReports({
            ssh: requireSshForCall(),
            sessionId: callSessionId,
            tailBytes,
            limit
          });
        } catch {
          remote = null;
        }
        if (!remote || !remote.count) return local;
        if (!local.count) return remote;
        // 两个 take* 各自已经标了「已投递」：这里不能再按 limit 截断，否则被截掉的永远不报
        return {
          ok: true,
          count: local.count + remote.count,
          jobs: [...local.jobs, ...remote.jobs]
        };
      }
      return takeSettledReports({ sessionId: callSessionId, tailBytes, limit });
    },

    'host.proc_output': async ({ id, pid, offset, tailBytes, waitMs, sessionId, local } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const callSessionId = sessionId || getActiveCallSessionId() || undefined;
      const result =
        procScope({ local, id }) === 'remote'
          ? await readRemoteOutput({
              ssh: requireSshForCall(),
              id,
              pid,
              offset,
              tailBytes,
              waitMs,
              sessionId: callSessionId
            })
          : await readProcessOutput({ id, pid, offset, tailBytes, waitMs, sessionId: callSessionId });
      if (!result.ok) {
        const e = new Error(result.error || '读取进程输出失败');
        e.code = result.errorCode || 'PROC_OUTPUT_FAILED';
        e.hint = result.hint;
        throw e;
      }
      return result;
    },

    'host.proc_kill': async ({ id, pid, sessionId, local } = {}) => {
      assertHostEnabled(ctx);
      if (!perms.shellExec) {
        const e = new Error('Shell 执行未授权');
        e.code = 'SHELL_DISABLED';
        throw e;
      }
      const callSessionId = sessionId || getActiveCallSessionId() || undefined;
      const result =
        procScope({ local, id }) === 'remote'
          ? await killRemoteProcess({ ssh: requireSshForCall(), id, pid, sessionId: callSessionId })
          : await killProcessHandle({ id, pid, sessionId: callSessionId });
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
      // 打印只可能发生在叠云这台机器上：路径指远端时把文件取回一份临时副本再打印。
      const target = resolveFsTarget(filePath);
      if (target.remote) {
        const remotePath = target.path;
        const ext = path.extname(String(remotePath)).toLowerCase();
        if (!IMAGE_EXTENSIONS || !IMAGE_EXTENSIONS.has(ext)) {
          const e = new Error(
            `不支持的图片格式「${ext || '(无扩展名)'}」，支持 jpg/png/gif/bmp/webp/tif`
          );
          e.code = 'UNSUPPORTED_FORMAT';
          e.retryable = false;
          throw e;
        }
        let got;
        try {
          got = await target.remote.readFile(remotePath, 'base64', {
            maxBytes: ABSOLUTE_READ_MAX_BYTES
          });
        } catch (err) {
          throw annotateLocalPathMiss(err, remotePath);
        }
        const buf = Buffer.from(String((got && got.data) || ''), 'base64');
        if (!buf.length) {
          const e = new Error(`远端文件为空或读不到: ${remotePath}`);
          e.code = 'FILE_NOT_FOUND';
          throw e;
        }
        if (got && got.truncated === true) {
          const e = new Error(
            `远端图片超过 ${ABSOLUTE_READ_MAX_BYTES} 字节上限，读回来的副本不完整，不能打印`
          );
          e.code = 'FILE_TOO_LARGE';
          e.retryable = false;
          e.suggestedFix = '先在远端把图缩小（如 convert 缩放）再打印；不要原样重试。';
          throw e;
        }
        // 固定目录 + 固定文件名（按扩展名）：反复打印不会在 %TEMP% 里堆整图副本。
        // 不立刻删除：mspaint 是异步打开的，提前 unlink 会让它读不到内容。
        const dir = path.join(os.tmpdir(), 'dieyun-print');
        await fsp.mkdir(dir, { recursive: true });
        const localCopy = path.join(dir, `remote${ext}`);
        await fsp.writeFile(localCopy, buf);
        const out = await printImage(localCopy);
        // 临时副本故意不删：mspaint 是异步打开的，提前 unlink 会让它读不到内容
        return { ...out, source: 'remote', remotePath, localCopy, bytes: buf.length };
      }
      const resolved = normalizeFilePathInput(target.path, target.base || defaultCwd);
      const safe = assertAllowedPath(resolved, readRootsForCall());
      return printImage(safe);
    },
  };
}

module.exports = { createHostHandlers };
