'use strict';

/**
 * 远端（SSH）后台进程句柄表：`host_exec detached=true` 在远端拉起的进程在这里登记，
 * 与 host-control.js 的本机句柄表**同形**（list / output / kill 三件事语义一致），
 * 于是 `host_proc` 在远程工作空间下也能查、能读、能停 —— 之前只有本机能用。
 *
 * 为什么不能只回一个 PID（旧行为）：bash 对异步命令会多 fork 一层，`$!` 拿到的是启动
 * 命令的 shell，杀掉只留孤儿。这里改用 `setsid` 让命令自成会话/进程组，记 pid=pgid，
 * kill 用 `kill -TERM -<pid>` 按**进程组**结束整棵树；pid 也就是命令本身（实测 PPID=1、
 * PGID=SID=pid）。
 *
 * 安全约束同本机：只接受本模块登记过的 id/pid，模型不能拿任意远端 PID 去 kill。
 */

const { shellQuoteSingle } = require('../ssh/remote-path');
const {
  OUTPUT_BUFFER_MAX,
  OUTPUT_TAIL_DEFAULT,
  OUTPUT_WAIT_MAX_MS,
  clampNumber,
  pickOutputWindow
} = require('./host-control');

/** 远端后台输出落盘目录（/tmp 是远程允许根之一，可直接 fs_read_file）。 */
const LOG_DIR = '/tmp/dieyun-host-proc';
const HANDLE_MAX = 200;
const POLL_MS = 250;

/** @type {Map<string, { id: string, pid: number | null, command: string, cwd: string, sessionId: string,
 *   startedAt: number, logPath: string, errLogPath: string, exited: boolean }>} */
const handles = new Map();
let handleSeq = 0;

function pruneHandles() {
  while (handles.size > HANDLE_MAX) {
    const oldest = handles.keys().next().value;
    if (!oldest) break;
    handles.delete(oldest);
  }
}

function matchSession(rec, sid) {
  return !(sid && rec.sessionId && rec.sessionId !== sid);
}

function findHandle({ id, pid, sessionId }) {
  const want = id != null ? String(id).trim() : '';
  const wantPid = Number(pid);
  if (want) {
    const rec = handles.get(want);
    if (!rec) {
      return {
        error: {
          ok: false,
          errorCode: 'PROC_NOT_FOUND',
          error: `未找到远端进程句柄 ${want}`,
          hint: '先用 host_proc action=list 查看可用句柄（includeFinished=true 可看已结束的）'
        }
      };
    }
    if (!matchSession(rec, sessionId)) {
      return { error: { ok: false, errorCode: 'PROC_SESSION_MISMATCH', error: '该进程属于其它会话，拒绝操作' } };
    }
    return { rec };
  }
  if (Number.isFinite(wantPid) && wantPid > 0) {
    for (const rec of handles.values()) {
      if (rec.pid === wantPid && matchSession(rec, sessionId)) return { rec };
    }
    return {
      error: {
        ok: false,
        errorCode: 'PROC_NOT_FOUND',
        error: '该 PID 不是由 host_exec 启动，拒绝操作（只能操作本会话登记的远端进程）'
      }
    };
  }
  return { error: { ok: false, errorCode: 'PROC_ID_REQUIRED', error: '需提供 id 或 pid' } };
}

/**
 * 一批 `kill -0` 判活。组存在即算活（setsid 后 pgid=pid，组里可能还有孙进程）。
 * @param {any} ssh
 * @param {Array<{ pid: number | null }>} recs
 * @returns {Promise<Map<number, boolean>>}
 */
async function probeAlive(ssh, recs) {
  const pids = [...new Set(recs.map((r) => Number(r.pid)).filter((n) => Number.isFinite(n) && n > 0))];
  const map = new Map();
  if (!pids.length) return map;
  const script = pids
    .map(
      (p) =>
        `if kill -0 -${p} 2>/dev/null || kill -0 ${p} 2>/dev/null; then echo '${p}:1'; else echo '${p}:0'; fi`
    )
    .join('; ');
  try {
    const r = await ssh.exec(script, null, 20000);
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+):([01])$/);
      if (m) map.set(Number(m[1]), m[2] === '1');
    }
  } catch {
    // 判活失败就保持「未知」：宁可显示还在跑，也不要误报已结束
  }
  return map;
}

async function readLogTail(ssh, filePath, tailBytes = OUTPUT_BUFFER_MAX) {
  try {
    const st = await ssh.sftpStat(filePath);
    const size = Number(st && st.size) || 0;
    if (!size) return { text: '', bytes: 0 };
    const start = Math.max(0, size - tailBytes);
    const { buf } = await ssh.sftpReadFile(filePath, tailBytes, start);
    return { text: buf.toString('utf8'), bytes: size };
  } catch {
    return { text: '', bytes: 0 };
  }
}

/**
 * 远端 detached 启动：建日志目录 → setsid 生效则自成会话（可按组杀）→ 立即返回 pid。
 * @param {{ ssh: any, cwd?: string, command: string, sessionId?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ id: string, pid: number | null, logPath: string, errLogPath: string,
 *   code: number, stderr: string }>}
 */
async function startRemoteDetached(opts = {}) {
  const { ssh } = opts;
  const command = String(opts.command || '');
  const id = `sshproc-${++handleSeq}`;
  const stamp = `${Date.now()}-${handleSeq}`;
  const logPath = `${LOG_DIR}/bg-${stamp}.out.log`;
  const errLogPath = `${LOG_DIR}/bg-${stamp}.err.log`;
  const redirect = `</dev/null >${shellQuoteSingle(logPath)} 2>${shellQuoteSingle(errLogPath)}`;
  // 整体包一层 `{ … }`：exec 的前缀是 `cd <cwd> && <script>`，不包的话 cd 失败后脚本仍会
  // 因为内部的 `;` 继续跑，于是「工作目录不存在」会变成「在 HOME 里悄悄起了一份」。
  // 组内用 `& else` / `& fi`（`&` 自己就是列表分隔符，不能拼成 `&;`）。
  const script =
    `{ mkdir -p ${shellQuoteSingle(LOG_DIR)}` +
    `; if command -v setsid >/dev/null 2>&1; then setsid bash -c ${shellQuoteSingle(command)} ${redirect} & ` +
    `else bash -c ${shellQuoteSingle(command)} ${redirect} & fi` +
    '; echo $!; }';

  const r = await ssh.exec(script, opts.cwd || null, Math.min(30000, Number(opts.timeoutMs) || 15000));
  const pid = Number.parseInt(String(r.stdout || '').trim(), 10);
  const rec = {
    id,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    command: command.slice(0, 500),
    cwd: String(opts.cwd || ''),
    sessionId: String(opts.sessionId || ''),
    startedAt: Date.now(),
    logPath,
    errLogPath,
    exited: false,
    /** 远端句柄全部来自后台启动：模型手上只有 handle，结束时需要补报一次（见 takeSettledRemoteReports）。 */
    awaitReport: true,
    reportedAt: 0
  };
  // 没拿到 pid 说明这次启动没成（判活/结束都用不上），不登记，免得 host_proc 列出一个假活进程
  if (rec.pid) {
    handles.set(id, rec);
    pruneHandles();
  }
  return { id, pid: rec.pid, logPath, errLogPath, code: Number(r.code) || 0, stderr: String(r.stderr || '') };
}

/**
 * 列出远端已登记进程（默认只列仍在跑的）。
 * @param {{ ssh: any, sessionId?: string, includeFinished?: boolean }} opts
 */
async function listRemoteProcesses(opts = {}) {
  const sid = opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  const includeFinished = opts.includeFinished === true;
  const recs = [...handles.values()].filter((r) => matchSession(r, sid));
  const aliveMap = await probeAlive(
    opts.ssh,
    recs.filter((r) => !r.exited)
  );
  const rows = [];
  for (const rec of recs) {
    const alive = rec.exited || !rec.pid ? false : (aliveMap.get(Number(rec.pid)) ?? true);
    if (!alive) rec.exited = true;
    if (!includeFinished && !alive) continue;
    rows.push({
      id: rec.id,
      pid: rec.pid,
      command: rec.command,
      cwd: rec.cwd,
      sessionId: rec.sessionId || undefined,
      detached: true,
      startedAt: rec.startedAt,
      alive,
      exitCode: null,
      hasOutput: true,
      logPath: rec.logPath,
      remote: true
    });
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return { ok: true, count: rows.length, processes: rows, remote: true };
}

/**
 * 取「远端后台任务已结束、但模型还不知道」的那些，并当场标记已投递。
 *
 * 与本地 `host-control#takeSettledReports` 同一语义（静默补报，不唤醒任何一轮），
 * 只是判活走一批 `kill -0`、输出走 sftp 读日志尾部。
 *
 * @param {{ ssh: any, sessionId?: string, tailBytes?: number, limit?: number }} opts
 */
async function takeSettledRemoteReports(opts = {}) {
  const sid = opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null;
  const tailBytes = clampNumber(opts.tailBytes, 256, OUTPUT_BUFFER_MAX, 1200);
  const limit = clampNumber(opts.limit, 1, 8, 4);
  const recs = [...handles.values()].filter(
    (r) => r.awaitReport && !r.reportedAt && r.pid && (!sid || r.sessionId === sid)
  );
  if (!recs.length) return { ok: true, count: 0, jobs: [], remote: true };
  const aliveMap = await probeAlive(
    opts.ssh,
    recs.filter((r) => !r.exited && r.pid)
  );
  // 判活没拿到结果的（脚本失败）按「还活着」处理：宁可晚一轮报，也不要误报已结束
  const settled = recs.filter((r) => {
    if (r.exited || !r.pid) return true;
    return aliveMap.get(Number(r.pid)) === false;
  });
  settled.sort((a, b) => a.startedAt - b.startedAt);
  const jobs = [];
  for (const rec of settled.slice(0, limit)) {
    const out = await readLogTail(opts.ssh, rec.logPath, tailBytes);
    const err = await readLogTail(opts.ssh, rec.errLogPath, tailBytes);
    rec.exited = true;
    rec.reportedAt = Date.now();
    jobs.push({
      id: rec.id,
      command: rec.command,
      detached: true,
      exitCode: null,
      startedAt: rec.startedAt,
      alive: false,
      stdout: String(out.text || '').trim(),
      stderr: String(err.text || '').trim(),
      remote: true
    });
  }
  return { ok: true, count: jobs.length, jobs, remote: true };
}

/**
 * 读远端进程输出（落盘日志）。waitMs > 0 时轮询等待「有新输出或进程退出」。
 * @param {{ ssh: any, id?: string, pid?: number, sessionId?: string, offset?: number,
 *   tailBytes?: number, waitMs?: number }} opts
 */
async function readRemoteOutput(opts = {}) {
  const found = findHandle(opts);
  if (found.error) return found.error;
  const rec = found.rec;

  const tailBytes = clampNumber(opts.tailBytes, 1024, OUTPUT_BUFFER_MAX, OUTPUT_TAIL_DEFAULT);
  const waitMs = clampNumber(opts.waitMs, 0, OUTPUT_WAIT_MAX_MS, 0);
  const offset = Number.isFinite(Number(opts.offset)) && Number(opts.offset) >= 0 ? Number(opts.offset) : null;

  const snapshot = async () => {
    const out = await readLogTail(opts.ssh, rec.logPath);
    const err = await readLogTail(opts.ssh, rec.errLogPath);
    return { stdout: out.text, stderr: err.text, bytes: out.bytes + err.bytes };
  };

  const alive = async () => {
    if (rec.exited || !rec.pid) return false;
    const map = await probeAlive(opts.ssh, [rec]);
    const isAlive = map.get(Number(rec.pid)) ?? true;
    if (!isAlive) rec.exited = true;
    return isAlive;
  };

  let snap = await snapshot();
  let waitedMs = 0;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    const startBytes = snap.bytes;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const next = await snapshot();
      snap = next;
      waitedMs = Math.min(waitMs, waitMs - Math.max(0, deadline - Date.now()));
      if (next.bytes > startBytes || !(await alive())) break;
    }
  }

  const so = pickOutputWindow(snap.stdout, { offset, tailBytes });
  const se = pickOutputWindow(snap.stderr, { offset, tailBytes });
  const running = await alive();
  const result = {
    ok: true,
    id: rec.id,
    pid: rec.pid,
    command: rec.command,
    alive: running,
    exitCode: null,
    exited: !running,
    stdout: so.text.trim(),
    stderr: se.text.trim(),
    offset: { stdout: so.next, stderr: se.next },
    truncated: so.more || se.more,
    waitedMs,
    logPath: rec.logPath,
    remote: true
  };
  if (!running) {
    result.hint = `远端进程已结束；完整日志在 ${rec.logPath}（可 fs_read_file）。`;
    // 模型自己读过了：下一轮不必再补报一遍
    if (!rec.reportedAt) rec.reportedAt = Date.now();
  } else if (!result.stdout && !result.stderr) {
    result.hint = '暂无输出。长任务可能还在初始化；可用 waitMs（如 30000）等待新输出。';
  } else {
    result.hint = '进程仍在运行，上面是到目前为止的输出。';
  }
  return result;
}

/**
 * 结束远端已登记进程（整棵进程树：setsid 后按进程组杀）。
 * @param {{ ssh: any, id?: string, pid?: number, sessionId?: string }} opts
 */
async function killRemoteProcess(opts = {}) {
  const found = findHandle(opts);
  if (found.error) return found.error;
  const rec = found.rec;
  if (!rec.pid) {
    return { ok: false, errorCode: 'PROC_KILL_FAILED', error: '该远端进程没有可用的 PID（启动时未取到）' };
  }
  const p = Number(rec.pid);
  const script =
    `kill -TERM -${p} 2>/dev/null || kill -TERM ${p} 2>/dev/null; sleep 0.4; ` +
    `kill -KILL -${p} 2>/dev/null || kill -KILL ${p} 2>/dev/null; sleep 0.2; ` +
    `if kill -0 -${p} 2>/dev/null || kill -0 ${p} 2>/dev/null; then echo ALIVE; else echo DEAD; fi`;
  let alive = true;
  let detail = '';
  try {
    const r = await opts.ssh.exec(script, null, 20000);
    detail = String(r.stdout || '').trim();
    alive = detail !== 'DEAD';
  } catch (e) {
    return { ok: false, errorCode: 'PROC_KILL_FAILED', error: `结束远端进程失败：${e && e.message}` };
  }
  if (!alive) rec.exited = true;
  return {
    ok: true,
    remote: true,
    killed: [{ id: rec.id, pid: rec.pid, killed: true, alive, reason: alive ? '发送结束信号后仍在运行' : undefined }]
  };
}

/** 仅测试用：清空句柄表。 */
function resetRemoteHandlesForTest() {
  handles.clear();
  handleSeq = 0;
}

module.exports = {
  LOG_DIR,
  startRemoteDetached,
  listRemoteProcesses,
  takeSettledRemoteReports,
  readRemoteOutput,
  killRemoteProcess,
  resetRemoteHandlesForTest
};
