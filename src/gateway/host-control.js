'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);

/**
 * host_exec 长任务语义（B2）相关常量。
 * - 单条命令的硬上限：10 分钟（编译/渲染/打包常见量级）；默认仍是 90s。
 * - 输出缓冲：长任务转后台后要靠它读增量，太小会丢关键报错，太大又占内存。
 */
const SHELL_TIMEOUT_DEFAULT_MS = 90000;
const SHELL_TIMEOUT_MAX_MS = 600000;
const OUTPUT_BUFFER_MAX = 256 * 1024;
const OUTPUT_TAIL_DEFAULT = 32 * 1024;
const OUTPUT_WAIT_MAX_MS = 120000;

/** 后台进程输出落盘目录（detached 的 stdout/stderr 不再丢弃）。 */
function hostProcLogDir() {
  const dir = path.join(os.tmpdir(), 'dieyun-host-proc');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}


/** @type {((url: string) => Promise<void>) | null} */
let shellOpenExternal = null;
try {
  const { shell } = require('electron');
  if (shell && typeof shell.openExternal === 'function') {
    shellOpenExternal = (url) => shell.openExternal(url);
  }
} catch {
  // 非 Electron 主进程时可回退到 shell 命令
}

function assertHttpUrl(url) {
  const u = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    const err = new Error('无效的 URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('仅支持 http/https 链接');
    err.code = 'INVALID_URL';
    throw err;
  }
  return u;
}

async function openExternalUrl(url) {
  const u = assertHttpUrl(url);
  if (shellOpenExternal) {
    await shellOpenExternal(u);
    return { ok: true, url: u };
  }
  const quoted = u.replace(/"/g, '\\"');
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${quoted}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${quoted}"`;
  } else {
    cmd = `xdg-open "${quoted}"`;
  }
  const result = await runShell(cmd, { timeoutMs: 15000 });
  if (result.code !== 0 && result.stderr) {
    const err = new Error(result.stderr || `打开链接失败 (code ${result.code})`);
    err.code = 'OPEN_URL_FAILED';
    throw err;
  }
  return { ok: true, url: u };
}

/** @type {Set<import('child_process').ChildProcess>} */
const activeShellChildren = new Set();

/** 停止 Agent 时杀掉未 detached 的 host_exec 子进程；可按 sessionId 过滤避免并行串杀 */
function killActiveShellChildren(opts = {}) {
  const sid =
    opts && opts.sessionId != null && String(opts.sessionId).trim()
      ? String(opts.sessionId).trim()
      : null;
  for (const child of [...activeShellChildren]) {
    if (sid) {
      const childSid = child && child.__dieyunSessionId ? String(child.__dieyunSessionId) : '';
      if (childSid && childSid !== sid) continue;
      if (!childSid) continue;
    }
    try {
      child.__dieyunStopKill = true;
      // 必须按进程树杀：child.kill() 只终止 cmd.exe，孙进程会留成孤儿
      // （超时转后台的长任务被「停止 Agent」后仍在后台跑）。
      void terminateTree(child.pid, { child, detached: false }).catch(() => {});
    } catch {
      // ignore
    }
    activeShellChildren.delete(child);
  }
}

/**
 * host_exec 进程句柄表：登记 Agent 启动的后台/子进程，供事后 proc_list / proc_kill 使用。
 * 安全约束：只登记本模块真正 spawn 出来的进程；kill 只接受已登记的 id/pid，
 * 模型无法传入任意 PID 去结束系统进程。句柄归属 sessionId，避免并行会话串杀。
 * @type {Map<string, {
 *   id: string, pid: number | null, command: string, cwd: string, sessionId: string,
 *   detached: boolean, startedAt: number, child: import('child_process').ChildProcess | null,
 *   exited: boolean, exitCode: number | null
 * }>}
 */
const processHandles = new Map();
let processHandleSeq = 0;
const PROCESS_HANDLE_MAX = 200;

/** PID 是否存活（EPERM 说明进程存在但无权限查询，按存活处理）。 */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/**
 * 登记一个进程句柄。
 * @param {{ command?: string, cwd?: string, sessionId?: string, detached?: boolean, pid?: number|null,
 *   child?: import('child_process').ChildProcess|null, output?: object|null, logPath?: string }} info
 */
function registerProcessHandle(info = {}) {
  const id = `hostproc-${++processHandleSeq}`;
  const child = info.child || null;
  const pid =
    Number.isFinite(Number(info.pid)) && Number(info.pid) > 0
      ? Number(info.pid)
      : child && Number(child.pid) > 0
        ? Number(child.pid)
        : null;
  const record = {
    id,
    pid,
    command: String(info.command || '').slice(0, 500),
    cwd: String(info.cwd || ''),
    sessionId: String(info.sessionId || ''),
    detached: !!info.detached,
    startedAt: Date.now(),
    child,
    exited: false,
    exitCode: null,
    /** runShell 转后台时共享的 { stdout, stderr } 缓冲；detached 时为 null。 */
    output: info.output || null,
    /** detached 进程的 stdout/stderr 落盘路径（活进程也能读）。 */
    logPath: info.logPath ? String(info.logPath) : '',
    errLogPath: info.errLogPath ? String(info.errLogPath) : ''
  };
  if (child && typeof child.once === 'function') {
    child.once('exit', (code) => {
      record.exited = true;
      record.exitCode = code == null ? null : code;
    });
    child.once('error', () => {
      record.exited = true;
    });
  }
  processHandles.set(id, record);
  if (processHandles.size > PROCESS_HANDLE_MAX) {
    const oldest = processHandles.keys().next().value;
    if (oldest) processHandles.delete(oldest);
  }
  return record;
}

function forgetProcessHandle(id) {
  return processHandles.delete(String(id || ''));
}

function publicProcessRecord(rec) {
  const alive = !rec.exited && (rec.child ? rec.child.exitCode == null : isPidAlive(rec.pid));
  return {
    id: rec.id,
    pid: rec.pid,
    command: rec.command,
    cwd: rec.cwd,
    sessionId: rec.sessionId || undefined,
    detached: rec.detached,
    startedAt: rec.startedAt,
    alive,
    exitCode: rec.exited ? rec.exitCode : rec.child ? rec.child.exitCode : null,
    hasOutput: !!(rec.output || rec.logPath),
    logPath: rec.logPath || undefined
  };
}

function readFileTailSafe(file, tailBytes) {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    if (!size) return { text: '', bytes: 0 };
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString('utf8'), bytes: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', bytes: 0 };
  }
}

function readFileFromSafe(file, offset, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    if (!size || offset >= size) return { text: '', bytes: size };
    const len = Math.min(maxBytes, size - offset);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      return { text: buf.toString('utf8'), bytes: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', bytes: 0 };
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 读取已登记进程的输出（B2）。
 * 两类来源：
 * - runShell 转后台：内存环形缓冲（rec.output），活进程可增量读；
 * - detached：stdout/stderr 落盘（rec.logPath / rec.errLogPath），活进程也能读。
 * waitMs > 0 时轮询等待「有新输出或进程退出」，用来替代「sleep 后再查」。
 *
 * @param {{ id?: string, pid?: number, sessionId?: string, offset?: number, tailBytes?: number, waitMs?: number }} opts
 */
async function readProcessOutput(opts = {}) {
  const id = opts.id != null ? String(opts.id).trim() : '';
  const pid = Number(opts.pid);
  const sid =
    opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  let rec = null;
  if (id) rec = processHandles.get(id) || null;
  else if (Number.isFinite(pid) && pid > 0) {
    for (const item of processHandles.values()) {
      if (item.pid === pid) {
        rec = item;
        break;
      }
    }
  }
  if (!rec) {
    return {
      ok: false,
      errorCode: 'PROC_NOT_FOUND',
      error: id ? `未找到进程句柄 ${id}` : '未找到该 PID 对应的 host_exec 进程',
      hint: '先用 host_proc action=list 查看可用句柄（includeFinished=true 可看已结束的）'
    };
  }
  if (sid && rec.sessionId && rec.sessionId !== sid) {
    return { ok: false, errorCode: 'PROC_SESSION_MISMATCH', error: '该进程属于其它会话，拒绝读取' };
  }

  const tailBytes = clampNumber(opts.tailBytes, 1024, OUTPUT_BUFFER_MAX, OUTPUT_TAIL_DEFAULT);
  const waitMs = clampNumber(opts.waitMs, 0, OUTPUT_WAIT_MAX_MS, 0);
  const offset = Number.isFinite(Number(opts.offset)) && Number(opts.offset) >= 0 ? Number(opts.offset) : null;

  const alive = () =>
    !rec.exited && (rec.child ? rec.child.exitCode == null : isPidAlive(rec.pid));

  const snapshot = () => {
    if (rec.output) {
      const so = String(rec.output.stdout || '');
      const se = String(rec.output.stderr || '');
      return { stdout: so, stderr: se, bytes: so.length + se.length };
    }
    const out = readFileTailSafe(rec.logPath, OUTPUT_BUFFER_MAX);
    const err = readFileTailSafe(rec.errLogPath, OUTPUT_BUFFER_MAX);
    return { stdout: out.text, stderr: err.text, bytes: out.bytes + err.bytes };
  };

  let snap = snapshot();
  let waitedMs = 0;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    const startBytes = snap.bytes;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      waitedMs = waitMs - Math.max(0, deadline - Date.now());
      const next = snapshot();
      if (next.bytes > startBytes || !alive()) {
        snap = next;
        if (!alive()) break;
        // 有新输出时进程常常就在这次 flush 之后退出：再让一个 tick，
        // 给 'exit' 事件派发的机会。否则会把「已经跑完」报成 alive=true，
        // 调用方白多等一轮（测试里表现为 done 已到、alive 仍 true）。
        await new Promise((r) => setTimeout(r, 250));
        snap = snapshot();
        break;
      }
      snap = next;
    }
    waitedMs = Math.min(waitMs, waitedMs);
  }

  const pick = (text) => {
    if (offset != null) {
      if (offset >= text.length) return { text: '', next: text.length, more: false };
      const chunk = text.slice(offset);
      if (chunk.length <= tailBytes) return { text: chunk, next: text.length, more: false };
      return { text: chunk.slice(0, tailBytes), next: offset + tailBytes, more: true };
    }
    if (text.length <= tailBytes) return { text, next: text.length, more: false };
    return { text: text.slice(-tailBytes), next: text.length, more: true };
  };

  const so = pick(snap.stdout);
  const se = pick(snap.stderr);
  const running = alive();
  const result = {
    ok: true,
    id: rec.id,
    pid: rec.pid,
    command: rec.command,
    alive: running,
    exitCode: running ? null : rec.exited ? rec.exitCode : rec.child ? rec.child.exitCode : null,
    exited: !running && rec.exited,
    stdout: so.text.trim(),
    stderr: se.text.trim(),
    offset: { stdout: so.next, stderr: se.next },
    truncated: so.more || se.more,
    waitedMs
  };
  if (rec.exited) {
    result.hint = `进程已结束（exitCode=${rec.exitCode == null ? '未知' : rec.exitCode}）。`;
  } else if (!result.stdout && !result.stderr) {
    result.hint = '暂无输出。长任务可能还在初始化；可用 waitMs（如 30000）等待新输出。';
  } else if (running) {
    result.hint = '进程仍在运行，上面是到目前为止的输出。';
  }
  return result;
}

/**
 * 列出已登记进程。默认只返回仍存活的；includeFinished=true 时附带最近结束的。
 * @param {{ sessionId?: string, includeFinished?: boolean }} opts
 */
function listProcessHandles(opts = {}) {
  const sid =
    opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  const includeFinished = opts.includeFinished === true;
  const rows = [];
  for (const rec of processHandles.values()) {
    if (sid && rec.sessionId && rec.sessionId !== sid) continue;
    const pub = publicProcessRecord(rec);
    if (!includeFinished && !pub.alive) continue;
    rows.push(pub);
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return { ok: true, count: rows.length, processes: rows };
}

/**
 * 结束一整棵进程树，**唯一实现**（`host_proc kill`、超时终止、停止 Agent 三处共用）。
 *
 * 为什么必须是「树」而不是 `child.kill()`：Windows 上 `runShell` spawn 的是
 * `cmd.exe /c <命令>`，`child.kill()` 只 TerminateProcess 掉 cmd.exe，真正的
 * node/python/编译器孙进程会变成孤儿继续烧 CPU。600s 长任务被「停止 Agent」后
 * 尤其明显（界面显示已停止，进程还在跑）。
 *
 * @param {number} pid
 * @param {{ child?: import('child_process').ChildProcess|null, detached?: boolean }} [opts]
 * @returns {Promise<{ killed: boolean, alive: boolean, reason?: string }>}
 */
function terminateTree(pid, opts = {}) {
  return new Promise((resolve) => {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) {
      resolve({ killed: false, alive: false, reason: '无有效 PID' });
      return;
    }
    if (!isPidAlive(n)) {
      resolve({ killed: false, alive: false, reason: '进程已结束' });
      return;
    }
    const settle = () => {
      const alive = isPidAlive(n);
      resolve({ killed: true, alive, reason: alive ? '发送结束信号后仍在运行' : undefined });
    };
    if (process.platform === 'win32') {
      try {
        const tk = spawn('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true });
        tk.on('error', () => {
          try {
            if (opts.child) opts.child.kill();
          } catch {
            /* ignore */
          }
          setTimeout(settle, 200);
        });
        tk.on('close', () => setTimeout(settle, 200));
      } catch {
        try {
          if (opts.child) opts.child.kill();
        } catch {
          /* ignore */
        }
        setTimeout(settle, 200);
      }
      return;
    }
    try {
      process.kill(opts.detached ? -n : n, 'SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (isPidAlive(n)) {
        try {
          process.kill(opts.detached ? -n : n, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
      setTimeout(settle, 150);
    }, 400);
  });
}

/** 结束已登记进程的便捷封装（同步标记句柄状态）。 */
function killProcessTree(rec) {
  return terminateTree(rec.pid, { child: rec.child, detached: rec.detached }).then((res) => {
    if (!res.alive) rec.exited = true;
    return res;
  });
}

/**
 * 结束已登记的进程。只接受已登记 id/pid，拒绝任意 PID。
 * @param {{ id?: string, pid?: number, sessionId?: string }} opts
 */
async function killProcessHandle(opts = {}) {
  const id = opts.id != null ? String(opts.id).trim() : '';
  const pid = Number(opts.pid);
  const sid =
    opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  const targets = [];
  if (id) {
    const rec = processHandles.get(id);
    if (!rec) {
      return { ok: false, errorCode: 'PROC_NOT_FOUND', error: `未找到进程句柄 ${id}` };
    }
    if (sid && rec.sessionId && rec.sessionId !== sid) {
      return { ok: false, errorCode: 'PROC_SESSION_MISMATCH', error: '该进程属于其它会话，拒绝结束' };
    }
    targets.push(rec);
  } else if (Number.isFinite(pid) && pid > 0) {
    for (const rec of processHandles.values()) {
      if (rec.pid !== pid) continue;
      if (sid && rec.sessionId && rec.sessionId !== sid) continue;
      targets.push(rec);
    }
    if (!targets.length) {
      return {
        ok: false,
        errorCode: 'PROC_NOT_FOUND',
        error: '该 PID 不是由 host_exec 启动，拒绝结束（只能结束本会话登记的进程）'
      };
    }
  } else {
    return { ok: false, errorCode: 'PROC_ID_REQUIRED', error: '需提供 id 或 pid' };
  }
  const results = [];
  for (const rec of targets) {
    const r = await killProcessTree(rec);
    results.push({ id: rec.id, pid: rec.pid, ...r });
    processHandles.delete(rec.id);
  }
  return { ok: true, killed: results };
}

/**
 * 截取尾部（把省略号放前面，避免模型误认为输出从截断处开始）。
 * @param {string} text
 * @param {number} max
 */
function tailOf(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `…(前 ${s.length - max} 字符已省略)\n${s.slice(-max)}`;
}

/**
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number, signal?: AbortSignal, sessionId?: string,
 *   trackProcess?: boolean, keepOnTimeout?: boolean }} opts
 *   keepOnTimeout=true：到点不杀进程，转入后台并把已输出内容返回（配合 host_proc action=output 续读）。
 */
function runShell(command, opts = {}) {
  const timeoutMs = Math.min(
    SHELL_TIMEOUT_MAX_MS,
    Math.max(1000, Number(opts.timeoutMs) || SHELL_TIMEOUT_DEFAULT_MS)
  );
  const maxBuffer = Math.min(2 * 1024 * 1024, Math.max(4096, Number(opts.maxBuffer) || 512 * 1024));
  const cwd = opts.cwd && String(opts.cwd).trim() ? opts.cwd : os.homedir();
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const signal = opts.signal || null;
  const keepOnTimeout = opts.keepOnTimeout === true;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    // Windows 上的引号：Node 默认按 MSVCRT 规则给参数加转义（`"` → `\"`），而 cmd.exe 不认这套转义，
    // 于是 `echo "a b"` 实际收到的是 `\"a b\"`、`"C:\Program Files\node.exe" x.js` 直接报
    // 「'C:\Program' 不是内部或外部命令」。这里改用 Node 自己 spawn(shell:true) 的同款做法：
    // 关掉 Node 的转义（windowsVerbatimArguments），自己按 cmd 的规矩 /d /s /c "命令" 传一整串。
    const commandText = String(command);
    const child =
      process.platform === 'win32'
        ? spawn(shell, ['/d', '/s', shellFlag, `"${commandText}"`], {
            cwd,
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: process.env
          })
        : spawn(shell, [shellFlag, commandText], {
            cwd,
            windowsHide: true,
            env: process.env
          });
    if (opts.sessionId != null && String(opts.sessionId).trim()) {
      child.__dieyunSessionId = String(opts.sessionId).trim();
    }
    activeShellChildren.add(child);

    /**
     * 输出缓冲：转后台后要被 host_proc 读，所以必须在 spawn 之前创建并与句柄共享。
     * 超过 maxBuffer 保留尾部（长任务的报错/进度都在尾部），并记录丢弃量。
     */
    const outputState = { stdout: '', stderr: '', total: 0, dropped: 0 };
    const appendOutput = (key, chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      outputState.total += text.length;
      let next = outputState[key] + text;
      if (next.length > maxBuffer) {
        outputState.dropped += next.length - maxBuffer;
        next = next.slice(-maxBuffer);
      }
      outputState[key] = next;
    };

    let handleRec = null;
    if (opts.trackProcess === true) {
      handleRec = registerProcessHandle({
        command,
        cwd,
        sessionId: child.__dieyunSessionId || opts.sessionId,
        detached: false,
        pid: child.pid,
        child,
        output: outputState
      });
    }

    let settled = false;
    let killed = false;
    let abortReason = false;

    const cleanupSignal = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      activeShellChildren.delete(child);
      reject(err);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      activeShellChildren.delete(child);
      resolve(value);
    };

    const killChild = () => {
      killed = true;
      // 按进程树终止（Windows 上 child.kill() 只杀 cmd.exe，孙进程会残留）。
      // terminateTree 内部先判 PID 存活，避免 PID 复用误杀无关进程。
      void terminateTree(child.pid, { child, detached: false }).catch(() => {});
    };

    const onAbort = () => {
      abortReason = true;
      killChild();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      if (abortReason) {
        killChild();
        const e = new Error('已停止');
        e.name = 'AbortError';
        e.code = 'SHELL_ABORTED';
        e.retryable = false;
        e.suggestedFix = '这是用户主动停止，不是命令本身失败；不要原样重跑，先确认是否还需要执行。';
        settleReject(e);
        return;
      }
      if (keepOnTimeout && handleRec) {
        // 长任务语义：到点不杀，转后台继续跑，句柄已登记，可用 host_proc 续读/结束
        settleResolve({
          code: null,
          stdout: tailOf(outputState.stdout, OUTPUT_TAIL_DEFAULT).trim(),
          stderr: tailOf(outputState.stderr, 8000).trim(),
          cwd,
          timedOut: true,
          stillRunning: true,
          pid: child.pid,
          handle: handleRec.id,
          waitedMs: timeoutMs,
          hint:
            `命令超过 ${timeoutMs}ms 仍未结束，已转入后台继续运行（未终止）。` +
            `用 host_proc action=output id=${handleRec.id} 读后续输出，action=kill id=${handleRec.id} 结束。`
        });
        // 转后台后仍受「停止 Agent」管辖
        activeShellChildren.add(child);
        child.once('close', () => activeShellChildren.delete(child));
        return;
      }
      killChild();
      const tail = tailOf(outputState.stdout, 8000).trim();
      const errTail = tailOf(outputState.stderr, 4000).trim();
      const err = new Error(
        `命令超时（${timeoutMs}ms，进程已终止）` +
          (tail || errTail
            ? `\n--- 终止前输出（尾部）---\n${[tail, errTail].filter(Boolean).join('\n')}`
            : '')
      );
      // 声明式失败契约：不声明 code 就会塌成 EXCEPTION，模型分不清「超时」和「程序崩了」。
      // 超时**不自动重试**：重跑同一条长命令大概率再超时一次，浪费 2×timeoutMs。
      err.code = 'SHELL_TIMEOUT';
      err.retryable = false;
      err.suggestedFix =
        '命令超过等待窗口已被终止。长任务请给 waitMs（到点转后台不杀进程）或 detached=true，' +
        '再用 host_proc action=output 续读；也可缩小命令范围（加 head -n / 限制 -m 条数）。';
      err.timedOut = true;
      err.stdoutTail = tail;
      err.stderrTail = errTail;
      err.timeoutMs = timeoutMs;
      settleReject(err);
    }, timeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      appendOutput('stderr', chunk);
    });

    child.on('error', (err) => {
      if (abortReason) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        e.code = 'SHELL_ABORTED';
        e.retryable = false;
        e.suggestedFix = '这是用户主动停止，不是命令本身失败；不要原样重跑，先确认是否还需要执行。';
        settleReject(e);
        return;
      }
      if (!killed) settleReject(err);
      else {
        // 外部 kill（停止 Agent）未走 signal 时，按停止处理
        const e = new Error('已停止');
        e.name = 'AbortError';
        e.code = 'SHELL_ABORTED';
        e.retryable = false;
        e.suggestedFix = '这是用户主动停止，不是命令本身失败；不要原样重跑，先确认是否还需要执行。';
        settleReject(e);
      }
    });

    child.on('close', (code) => {
      if (abortReason || child.__dieyunStopKill || (killed && !settled)) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        e.code = 'SHELL_ABORTED';
        e.retryable = false;
        e.suggestedFix = '这是用户主动停止，不是命令本身失败；不要原样重跑，先确认是否还需要执行。';
        settleReject(e);
        return;
      }
      if (killed) return;
      settleResolve({
        code: code == null ? -1 : code,
        stdout: outputState.stdout.trim(),
        stderr: outputState.stderr.trim(),
        cwd,
        truncated: outputState.dropped > 0,
        droppedChars: outputState.dropped || undefined
      });
    });
  });
}

const SHELL_METACHAR_RE = /[|&;<>^`%\r\n]/;

/** 解析简单「可执行文件 + 参数」命令（无 shell 元字符） */
function parseSimpleCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || SHELL_METACHAR_RE.test(trimmed)) return null;
  const m = trimmed.match(/^("([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/);
  if (!m) return null;
  const exe = m[2] || m[3] || m[4];
  const rest = (m[5] || '').trim();
  const args = [];
  if (rest) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let hit;
    while ((hit = re.exec(rest))) {
      args.push(hit[1] ?? hit[2] ?? hit[3]);
    }
  }
  return { exe, args };
}

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

let detachedLogSeq = 0;

/**
 * 后台启动进程（GUI / 长期运行），不阻塞 host_exec。
 * 结果里带 handle（已登记进程句柄），可用 host_proc 结束/读输出。
 * detached 的 stdout/stderr 不再丢弃：落盘到临时目录，活进程也能用
 * host_proc action=output 读（这是「长任务」能被观测的前提）。
 * @param {string} command
 * @param {{ cwd?: string, sessionId?: string }} opts
 */
async function runShellDetached(command, opts = {}) {
  const stamp = `${Date.now()}-${++detachedLogSeq}`;
  const logDir = hostProcLogDir();
  const logPath = path.join(logDir, `bg-${stamp}.out.log`);
  const errLogPath = path.join(logDir, `bg-${stamp}.err.log`);
  const result = await spawnDetachedProcess(command, { ...opts, logPath, errLogPath });
  try {
    const rec = registerProcessHandle({
      command,
      cwd: (result && result.cwd) || (opts && opts.cwd),
      sessionId: opts && opts.sessionId,
      detached: true,
      pid: result && result.pid,
      logPath,
      errLogPath
    });
    if (result && typeof result === 'object') {
      if (rec.pid) result.pid = rec.pid;
      result.handle = rec.id;
      result.logPath = logPath;
      result.stdout = rec.pid
        ? `已后台启动 PID ${rec.pid}（句柄 ${rec.id}；输出写入 ${logPath}）`
        : `已后台启动（句柄 ${rec.id}；输出写入 ${logPath}）`;
      result.hint = `用 host_proc action=output id=${rec.id} 读取输出（可加 waitMs），action=kill id=${rec.id} 结束。`;
    }
  } catch {
    // 登记失败不影响启动结果
  }
  return result;
}

/** 打开追加写日志 fd（失败降级为 ignore，不能让日志问题阻断启动）。 */
function openAppendFd(file) {
  try {
    return fs.openSync(file, 'a');
  } catch {
    return 'ignore';
  }
}

function closeQuiet(fd) {
  if (typeof fd === 'number') {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} command
 * @param {{ cwd?: string, sessionId?: string, logPath?: string, errLogPath?: string }} opts
 */
function spawnDetachedProcess(command, opts = {}) {
  const cwd = opts.cwd && String(opts.cwd).trim() ? opts.cwd : os.homedir();
  const cmd = String(command || '').trim();
  if (!cmd) {
    return Promise.reject(new Error('command 为空'));
  }
  const logPath = opts.logPath ? String(opts.logPath) : '';
  const errLogPath = opts.errLogPath ? String(opts.errLogPath) : '';

  if (process.platform === 'win32') {
    const simple = parseSimpleCommand(cmd);
    if (simple) {
      return new Promise((resolve, reject) => {
        const outFd = logPath ? openAppendFd(logPath) : 'ignore';
        const errFd = errLogPath ? openAppendFd(errLogPath) : 'ignore';
        const child = spawn(simple.exe, simple.args, {
          cwd,
          detached: true,
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
          shell: false
        });
        closeQuiet(outFd);
        closeQuiet(errFd);
        child.on('error', reject);
        child.unref();
        resolve({
          code: 0,
          stdout: `已后台启动 PID ${child.pid}`,
          stderr: '',
          cwd,
          detached: true,
          pid: child.pid
        });
      });
    }
    // 复杂命令（含管道/重定向）走 Start-Process；输出改写到日志文件，不再丢弃
    for (const f of [logPath, errLogPath]) {
      if (!f) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
    const redirects = [];
    if (logPath) redirects.push(`-RedirectStandardOutput ${psSingleQuote(logPath)}`);
    if (errLogPath) redirects.push(`-RedirectStandardError ${psSingleQuote(errLogPath)}`);
    const ps = [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',${psSingleQuote(cmd)} -WorkingDirectory ${psSingleQuote(cwd)} -WindowStyle Hidden ${redirects.join(' ')} -PassThru; if ($p) { $p.Id }`
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(ps[0], ps.slice(1), { cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const pid = parseInt(String(stdout).trim(), 10);
        if (code !== 0 && !Number.isFinite(pid)) {
          reject(new Error(stderr.trim() || `detached 启动失败 (code ${code})`));
          return;
        }
        resolve({
          code: 0,
          stdout: Number.isFinite(pid) ? `已后台启动 PID ${pid}` : '已后台启动',
          stderr: stderr.trim(),
          cwd,
          detached: true,
          pid: Number.isFinite(pid) ? pid : undefined
        });
      });
    });
  }

  const simple = parseSimpleCommand(cmd);
  if (simple) {
    return new Promise((resolve, reject) => {
      const outFd = logPath ? openAppendFd(logPath) : 'ignore';
      const errFd = errLogPath ? openAppendFd(errLogPath) : 'ignore';
      const child = spawn(simple.exe, simple.args, {
        cwd,
        detached: true,
        stdio: ['ignore', outFd, errFd],
        shell: false
      });
      closeQuiet(outFd);
      closeQuiet(errFd);
      child.on('error', reject);
      child.unref();
      resolve({
        code: 0,
        stdout: `已后台启动 PID ${child.pid}`,
        stderr: '',
        cwd,
        detached: true,
        pid: child.pid
      });
    });
  }

  const redirect = logPath ? ` > ${JSON.stringify(logPath)} 2> ${JSON.stringify(errLogPath || logPath)}` : ' >/dev/null 2>&1';
  return runShell(`nohup ${cmd}${redirect} & echo $!`, { cwd, timeoutMs: 15000 }).then((r) => {
    const pid = parseInt(String(r.stdout || '').trim(), 10);
    return {
      code: 0,
      stdout: Number.isFinite(pid) ? `已后台启动 PID ${pid}` : '已后台启动',
      stderr: r.stderr || '',
      cwd,
      detached: true,
      pid: Number.isFinite(pid) ? pid : undefined
    };
  });
}

/**
 * 规范化模型传入的路径，避免 dir + "绝对路径" 拼接错误。
 * @param {string} filePath
 * @param {string | null | undefined} defaultCwd
 */
function normalizeFilePathInput(filePath, defaultCwd) {
  let p = String(filePath || '').trim();
  if (!p) {
    const err = new Error('filePath 必填');
    err.code = 'INVALID_PATH';
    throw err;
  }
  // 若误传了拼接路径，提取最后一个像 Windows 绝对路径的片段
  const absMatches = p.match(/[A-Za-z]:[\\/][^"']+/g);
  if (absMatches && absMatches.length > 1) {
    p = absMatches[absMatches.length - 1].trim();
  }
  p = p.replace(/^["']+|["']+$/g, '').trim();
  if (!path.isAbsolute(p) && defaultCwd) {
    p = path.join(defaultCwd, p);
  }
  return path.resolve(p);
}

function printImageWindows(absPath) {
  const mspaint = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mspaint.exe');
  if (fs.existsSync(mspaint)) {
    return new Promise((resolve, reject) => {
      const child = spawn(mspaint, ['/p', absPath], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', reject);
      child.unref();
      setTimeout(() => resolve({ ok: true, path: absPath, method: 'mspaint' }), 600);
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -LiteralPath ${JSON.stringify(absPath)} -Verb Print`],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve({ ok: true, path: absPath, method: 'powershell-print' });
        return;
      }
      const err = new Error(stderr.trim() || `打印失败 (code ${code})`);
      err.code = 'PRINT_FAILED';
      reject(err);
    });
  });
}

/**
 * @param {string} absPath 已校验的绝对路径
 */
async function printImage(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    const err = new Error(`不支持的图片格式「${ext || '(无扩展名)'}」，支持 jpg/png/gif/bmp/webp/tif`);
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }
  if (!fs.existsSync(absPath)) {
    const err = new Error(`文件不存在: ${absPath}`);
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  if (process.platform === 'win32') {
    return printImageWindows(absPath);
  }
  if (process.platform === 'darwin') {
    return runShell(`lpr ${JSON.stringify(absPath)}`, { timeoutMs: 30000 });
  }
  return runShell(`lp ${JSON.stringify(absPath)}`, { timeoutMs: 30000 });
}

module.exports = {
  runShell,
  runShellDetached,
  killActiveShellChildren,
  registerProcessHandle,
  forgetProcessHandle,
  listProcessHandles,
  killProcessHandle,
  readProcessOutput,
  openExternalUrl,
  normalizeFilePathInput,
  printImage
};
