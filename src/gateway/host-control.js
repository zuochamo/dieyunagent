'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { attachExecSettlement } = require('../exec-settlement');
const { EXEC_OUTPUT_MAX_CHARS, clampExecTimeoutMs } = require('../exec-limits');
const { isForeignPosixPath } = require('../workspace/target');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);

/**
 * host_exec 长任务语义（B2）相关常量。
 * - 超时上限/默认值与输出上限**不在这里定**：`src/exec-limits.js` 是唯一来源，远端
 *   （ssh/session-manager.js）必须与本机用同一份契约，否则同一条命令在本地能跑完、在远端被夹短。
 * - 下面这些是本机侧独有的缓冲窗口（长任务转后台后靠它读增量）。
 */
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
 *   child?: import('child_process').ChildProcess|null, output?: object|null, logPath?: string,
 *   awaitReport?: boolean }} info
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
    /**
     * 是否需要在「下一轮」补给模型一条「这个后台任务已经结束了」。
     *
     * 只有模型**没拿到退出码**的进程才置 true：前台 host_exec 当轮就把 exitCode/尾部
     * 返回给模型了，再补一条纯噪音；而 detached 启动、以及 waitMs 到点转后台的，
     * 模型手上只有 handle，进程何时结束它无从知晓（也没有任何事件通知）。
     */
    awaitReport: info.awaitReport === true,
    /** 已经补报过（或模型自己读过它的输出）——一次性投递，不重复刷屏。 */
    reportedAt: 0,
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
 * 取一段输出窗口（本机 host_proc 与远端 host_proc 共用同一份规则）：
 * - 给了 offset：从该字符位置往后取，用于「增量续读」；
 * - 没给：取尾部 tailBytes 字符；
 * - `more` 表示还有没取完的内容（单次读取被 tailBytes 截断）。
 * @param {string} text
 * @param {{ offset?: number | null, tailBytes: number }} opts
 * @returns {{ text: string, next: number, more: boolean }}
 */
function pickOutputWindow(text, opts = {}) {
  const s = String(text || '');
  const tailBytes = Math.max(1, Number(opts.tailBytes) || OUTPUT_TAIL_DEFAULT);
  const offset = Number.isFinite(Number(opts.offset)) && Number(opts.offset) >= 0 ? Number(opts.offset) : null;
  if (offset != null) {
    if (offset >= s.length) return { text: '', next: s.length, more: false };
    const chunk = s.slice(offset);
    if (chunk.length <= tailBytes) return { text: chunk, next: s.length, more: false };
    return { text: chunk.slice(0, tailBytes), next: offset + tailBytes, more: true };
  }
  if (s.length <= tailBytes) return { text: s, next: s.length, more: false };
  return { text: s.slice(-tailBytes), next: s.length, more: true };
}

/**
 * 一个句柄当前可读到的输出快照（唯一来源：readProcessOutput 与补报共用）。
 * - runShell 转后台：内存环形缓冲；
 * - detached：stdout/stderr 落盘，取尾部 OUTPUT_BUFFER_MAX。
 * @param {object} rec 句柄记录
 */
function readRecordSnapshot(rec) {
  if (!rec) return { stdout: '', stderr: '', bytes: 0 };
  if (rec.output) {
    const so = String(rec.output.stdout || '');
    const se = String(rec.output.stderr || '');
    return { stdout: so, stderr: se, bytes: so.length + se.length };
  }
  const out = readFileTailSafe(rec.logPath, OUTPUT_BUFFER_MAX);
  const err = readFileTailSafe(rec.errLogPath, OUTPUT_BUFFER_MAX);
  return { stdout: out.text, stderr: err.text, bytes: out.bytes + err.bytes };
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

  const snapshot = () => readRecordSnapshot(rec);

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

  const so = pickOutputWindow(snap.stdout, { offset, tailBytes });
  const se = pickOutputWindow(snap.stderr, { offset, tailBytes });
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
  // 模型自己把已结束的后台任务读过了：下一轮不必再补报一遍。
  if (rec.awaitReport && !running && !rec.reportedAt) rec.reportedAt = Date.now();
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
 * 取「后台任务已经结束、但模型还不知道」的那些，**并当场标记为已投递**。
 *
 * 这是「静默补报」的唯一来源：不唤醒任何一轮，只在下一次组 prompt 时被取走一次
 * （`agent/system-prompt-prep.js#fetchSettledJobsBlock`）。因此不需要唤醒预算、
 * 不碰循环语义（`AGENTS.md` 原则 5 的「禁止假用户续跑」）。
 *
 * 只报 `awaitReport` 的句柄：前台命令当轮就把退出码给了模型，再报一次是噪音。
 *
 * @param {{ sessionId?: string, tailBytes?: number, limit?: number }} [opts]
 * @returns {{ ok: true, count: number, jobs: Array<{ id: string, command: string, detached: boolean,
 *   exitCode: number|null, startedAt: number, alive: false, stdout: string, stderr: string }> }}
 */
function takeSettledReports(opts = {}) {
  const sid =
    opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  const tailBytes = clampNumber(opts.tailBytes, 256, OUTPUT_BUFFER_MAX, 1200);
  const limit = clampNumber(opts.limit, 1, 8, 4);
  const settled = [];
  for (const rec of processHandles.values()) {
    if (!rec.awaitReport || rec.reportedAt) continue;
    // 严格按会话归属：推给用户的上下文不像 list/output 那样是「你问了我才给」，
    // 一旦错了就是别人会话的输出尾巴跑进这轮对话，撤不回来。没有归属的句柄宁可不报。
    if (sid && rec.sessionId !== sid) continue;
    // 既没有 pid 也没有 child：当初就没真起来（Start-Process 没解析出 pid 等），
    // isPidAlive(null) 恒为 false，不拦就会误报一条「已结束」。
    if (!rec.pid && !rec.child) continue;
    if (publicProcessRecord(rec).alive) continue;
    settled.push({ rec, at: rec.startedAt });
  }
  // 先结束的先报；超出上限的留到下一轮（不丢，只是排队）
  settled.sort((a, b) => a.at - b.at);
  const jobs = [];
  for (const item of settled.slice(0, limit)) {
    const { rec } = item;
    const snap = readRecordSnapshot(rec);
    const out = pickOutputWindow(snap.stdout, { tailBytes });
    const err = pickOutputWindow(snap.stderr, { tailBytes });
    rec.reportedAt = Date.now();
    jobs.push({
      id: rec.id,
      command: rec.command,
      detached: rec.detached,
      exitCode: publicProcessRecord(rec).exitCode,
      startedAt: rec.startedAt,
      alive: false,
      stdout: out.text.trim(),
      stderr: err.text.trim()
    });
  }
  return { ok: true, count: jobs.length, jobs };
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
 * 本机 spawn 的 cwd 唯一解析点（`runShell` / `spawnDetachedProcess` 共用）。
 *
 * 必须在这里校验目录**存在**：libuv 遇到不存在的 cwd 返回的是
 * `spawn C:\WINDOWS\system32\cmd.exe ENOENT` —— 报的是 ComSpec 找不到（其实它好好的），
 * 完全看不出真因。线上实测模型据此在 2–6ms 内盲试 4 次（tool-telemetry errorCode=ENOENT）。
 * 把远端路径 / 已删除的 worktree 当本机 cwd 时尤其容易踩到，所以错误必须点名到路径。
 *
 * @param {string} [rawCwd]
 * @returns {string} 可直接交给 spawn 的目录
 */
function resolveSpawnCwd(rawCwd) {
  const cwd = rawCwd && String(rawCwd).trim() ? String(rawCwd) : os.homedir();
  let stat = null;
  try {
    stat = fs.statSync(cwd);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    const err = new Error(`cwd 不是本机存在的目录：${cwd}`);
    // 声明式失败契约：不声明 code 就会塌成 EXCEPTION，模型分不清「目录不对」和「命令崩了」
    err.code = 'CWD_NOT_FOUND';
    err.retryable = false;
    err.cwd = cwd;
    err.suggestedFix =
      'SSH 会话的远端路径不能当本机 cwd。用 host_exec 的 cwd 指到本机真实存在的目录（工作区根即可），' +
      '不要在同一个不存在的路径上重复重试。';
    throw err;
  }
  return cwd;
}

/**
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number, signal?: AbortSignal, sessionId?: string,
 *   trackProcess?: boolean, keepOnTimeout?: boolean }} opts
 *   keepOnTimeout=true：到点不杀进程，转入后台并把已输出内容返回（配合 host_proc action=output 续读）。
 */
function runShell(command, opts = {}) {
  const timeoutMs = clampExecTimeoutMs(opts.timeoutMs);
  const maxBuffer = Math.min(
    2 * 1024 * 1024,
    Math.max(4096, Number(opts.maxBuffer) || EXEC_OUTPUT_MAX_CHARS)
  );
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

    // cwd 取唯一解析点（含存在性校验），不在这里自己拼
    let cwd;
    try {
      cwd = resolveSpawnCwd(opts.cwd);
    } catch (err) {
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
        // 模型从这里起就拿不到退出码了 → 结束时要靠「静默补报」告知它一次。
        handleRec.awaitReport = true;
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

    /**
     * 命令结束的唯一判定来自 exec-settlement：`close` 优先，后台进程握着输出管道时
     * 按 exit-status + 静默窗口收尾（否则 `sh -c 'daemon &'` 这种写法要等到超时才返回，
     * 而那时进程其实早就跑起来了 —— 与 SSH 侧同一个坑）。
     */
    const finishFromSettlement = (code, settledBy) => {
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
        droppedChars: outputState.dropped || undefined,
        // close 之外收尾 = 命令主体已退出，但输出管道仍被它拉起的后台进程占着
        behindStillHoldingStdio: settledBy === 'exit' || undefined
      });
    };

    // 收尾判定只是「补足 exit-status 之后的尾部输出」，失败不是第二种失败：
    // spawn 失败（ENOENT/EACCES）等情况 child.on('error') 上面已经 settleReject 过外层 Promise，
    // 而 attachExecSettlement 会因同一个 error 再 reject 一次 —— 不接住就冒成
    // main.log 的 `Unhandled rejection: Error: spawn ... ENOENT`，掩盖真正的错误来源。
    attachExecSettlement({ out: child.stdout, err: child.stderr, life: child })
      .then((r) => finishFromSettlement(r.code, r.settledBy))
      .catch(() => {});
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
      // 拿得到 child 时带上：精确的 exit 事件/退出码（拿不到就退化为 PID 判活）
      child: (result && result.child) || null,
      awaitReport: true,
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
  // cwd 取唯一解析点（含存在性校验），不在这里自己拼
  let cwd;
  try {
    cwd = resolveSpawnCwd(opts.cwd);
  } catch (err) {
    return Promise.reject(err);
  }
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
          pid: child.pid,
          // 带着 child 回上层登记：能收到精确的 exit/退出码，不必只靠 PID 判活
          child
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
        pid: child.pid,
        child
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
 * Windows 上以 `/` 开头的输入有三种可能的意图，按**结构证据**依次判定（不猜关键词）：
 *
 * 1. `/c:/Users/…` —— 被 URI 化过的盘符路径（LSP `file:///c%3A/…` 解码后的常见形态）；
 * 2. 工作区相对路径（模型常写 `/src/x.js`）—— 判据是「首段在工作区里真的存在」，
 *    这样 `/src/new/deep/x.js`（要新建的深层文件）也能按工作区相对解释；
 * 3. daemon 侧的绝对路径（远端会话自己的 worktree）—— 本机没有对应目录。
 *
 * 以前一律按「盘符根」解释（`path.resolve('/run/media/…')` → `E:\run\media\…`），于是第 3 种
 * 被静默改写成**不存在**的本地路径，后续索引、检索、读文件都照着这个幻觉路径答
 * （症状是 INVALID_WORKSPACE / ENOENT / 0 命中）。现在：前两种按各自意图解析，
 * 第三种在「连父目录都不存在」时报错 —— 报错比返回一个幻觉路径诚实（SSH-MODULE-REVIEW S14）。
 */
function resolveForeignPosixInput(rawInput, input, defaultCwd) {
  const rel = input.replace(/^[/\\]+/, '');
  // ① 「/c:/Users/…」= 盘符路径被 URI 化：还原成盘符路径
  if (/^[A-Za-z]:[\\/]/.test(rel)) return path.resolve(rel);
  // ② 工作区相对：首段在工作区里存在就说明这个读法说得通（含「要新建的深层文件」）
  if (defaultCwd && rel) {
    const root = path.resolve(defaultCwd);
    const candidate = path.resolve(root, rel);
    const relFromRoot = path.relative(root, candidate);
    if (relFromRoot && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)) {
      const firstSegment = relFromRoot.split(path.sep)[0];
      if (firstSegment && fs.existsSync(path.join(root, firstSegment))) return candidate;
    }
  }
  // ③ 整个输入就是一串斜杠（'/'）：那是「盘符根」，本身没有远端路径歧义
  const naive = path.resolve(input);
  if (!rel) return naive;
  // ④ 三种读法都说不通：不返回幻觉路径。
  //    刻意**不**用「盘符根下恰好存在同名目录」来放行 —— 那正是事故原形：
  //    开发机上 `E:\run` 或 `E:\srv` 一旦存在，/run/media/… 又会变回幻觉路径。**
  const err = new Error(
    `无法把「${rawInput}」解析成本机路径：Windows 上以 / 开头的路径不是本地绝对路径。` +
      `按工作区相对拼是「${path.resolve(defaultCwd || '.', rel || '.')}」、按盘符拼是「${naive}」，` +
      '但这两处连目录都不存在。它更像远端会话里的路径 —— 那种路径必须带该会话的工作区（ssh://user@host/…）才有人认。'
  );
  err.code = 'REMOTE_PATH_AS_LOCAL';
  err.retryable = false;
  err.suggestedFix =
    '别原样重试：若这是工作区里的文件，去掉开头的 / 再试一次（如 src/x.js）；' +
    '若确实是远端会话里的路径，先切到该会话的 ssh:// 工作区再操作。';
  err.requestedPath = String(rawInput);
  err.resolvedPath = naive;
  throw err;
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
  // 外来 POSIX 写法要按「解释得到底说不说得通」解析，不能直接丢给 path.resolve
  // （win32 上 isAbsolute('/x') 为 true、resolve 会沿用 cwd 盘符，见 resolveForeignPosixInput）
  if (isForeignPosixPath(p)) return resolveForeignPosixInput(String(filePath || '').trim(), p, defaultCwd);
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
  listProcessHandles,
  takeSettledReports,
  killProcessHandle,
  readProcessOutput,
  openExternalUrl,
  normalizeFilePathInput,
  printImage,
  // 可打印的图片扩展名（printImage 的判定口径）：远端取回打印时先按同一份校验
  IMAGE_EXTENSIONS,
  // 输出窗口/上限与远端（SSH）侧共用同一份，避免本地与远程读到不同的截断规则
  OUTPUT_BUFFER_MAX,
  OUTPUT_TAIL_DEFAULT,
  OUTPUT_WAIT_MAX_MS,
  clampNumber,
  pickOutputWindow
};
