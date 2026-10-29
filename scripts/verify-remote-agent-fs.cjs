'use strict';
/**
 * 「远端文件读写走 RPC」（P4）的真机验收器。
 *
 * 验的是这条链路真的通了、而且语义对：
 *   desktop → getRemoteAgentClient(socket 通道) → 远端 `fs.write_file/read_file/list_dir/stat/mkdir`
 *  → 远端真实文件系统 + 远端增量索引调度。
 *
 * 用法与 `verify-remote-agent-socket.cjs` 同环境变量：
 *   set DY_SSH_HOST=192.168.31.62
 *   set DY_SSH_USER=dieyunx
 *   set DY_SSH_PW_FILE=%TEMP%\dy_ssh_pw
 *   set DY_WS_BASE=/run/media/<user>/Data/ceshi
 *   npm run verify:remote-agent-fs
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 环境不全或连接失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSshSessionManager } = require('../src/ssh/session-manager');
const { resolveConnectPayload } = require('../src/ssh/connect-payload');
const { createRemoteGatewayManager } = require('../src/ssh/remote-gateway-manager');
const { createRemoteAgentFsAdapter } = require('../src/gateway/remote-agent-fs');
const { remoteAllowedRoots } = require('../src/gateway/path-policy');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const HOST = env('DY_SSH_HOST', '');
const USER = env('DY_SSH_USER', 'dieyunx');
const PW_FILE = env('DY_SSH_PW_FILE', path.join(os.tmpdir(), 'dy_ssh_pw'));
const WS_BASE = env('DY_WS_BASE', '');
const PACK = env('DY_REMOTE_PACK', path.join(__dirname, '..', 'build', 'remote-gateway-pack'));

if (!HOST || !WS_BASE) {
  console.error('需要 DY_SSH_HOST 与 DY_WS_BASE');
  process.exit(2);
}
if (!fs.existsSync(PW_FILE)) {
  console.error(`找不到密码文件 ${PW_FILE}`);
  process.exit(2);
}

const PW = fs.readFileSync(PW_FILE, 'utf8').trim();
const WS = path.posix.join(WS_BASE, 'verify-fs');

const results = [];
function check(label, pass, detail) {
  results.push([pass ? 'PASS' : 'FAIL', label]);
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}${detail == null ? '' : ` | ${String(detail).slice(0, 200)}`}`);
}

const ssh = createSshSessionManager({
  userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'dy-vfs-')),
  log: () => {}
});

async function sh(cmd, ms) {
  return ssh.execScript(cmd, ms || 15000);
}

(async () => {
  await ssh.connect(
    resolveConnectPayload(
      { host: HOST, username: USER, password: PW, authType: 'password', acceptNewHostKey: true },
      { sshConfigBlocks: [], agentSocket: '' }
    )
  );
  console.log(`ssh ${USER}@${HOST} connected`);

  await sh(`rm -rf ${WS}; mkdir -p ${WS}/sub; echo original > ${WS}/a.txt`);

  const mgr = createRemoteGatewayManager({ log: (m) => console.log(`[agent] ${m}`) });
  const info = await mgr.ensureRemoteGateway({
    sshManager: ssh,
    packRoot: PACK,
    appVersion: 'verify-fs',
    workspaceRemotePath: WS,
    onProgress: () => {}
  });

  const home = String((await sh('printf %s "$HOME"')).stdout || '').trim();
  const adapter = createRemoteAgentFsAdapter(
    info,
    { kind: 'ssh', remotePath: WS },
    { roots: remoteAllowedRoots(WS, home) }
  );
  check('适配器是 RPC 传输', adapter.transport === 'rpc', adapter.transport);

  // ---- 1. 读 ----
  const read1 = await adapter.readFile('a.txt', 'utf8');
  check('readFile 经 RPC 读回内容', read1.data.trim() === 'original' && read1.remote === true, JSON.stringify(read1.data));

  // ---- 2. 写（diff 必须来自远端）----
  const write = await adapter.writeFile('a.txt', 'original\nsecond line\n', 'utf8');
  check('writeFile 成功并带 diff', write.ok === true && write.diff && write.diff.added >= 1, JSON.stringify(write.diff));
  const onDisk = String((await sh(`cat ${WS}/a.txt`)).stdout || '');
  check('远端磁盘内容已变（不是被本地写覆盖到别处）', onDisk.includes('second line'), JSON.stringify(onDisk));

  const read2 = await adapter.readFile('a.txt', 'utf8');
  check('写后读回一致', read2.data === 'original\nsecond line\n', JSON.stringify(read2.data));

  // ---- 3. 基线外的新文件 + 子目录 ----
  const mk = await adapter.mkdir('sub/deep');
  check('mkdir 递归创建', mk.ok === true, mk.path);
  const existed = String((await sh(`test -d ${WS}/sub/deep && echo YES || echo NO`)).stdout || '').trim();
  check('目录真的建在远端', existed === 'YES', existed);

  const created = await adapter.writeFile('sub/deep/new.txt', 'nested\n', 'utf8');
  check('新文件写入（diff 对不存在的旧内容也不炸）', created.ok === true, JSON.stringify(created.diff));

  // ---- 4. stat / listDir ----
  const st = await adapter.stat('sub/deep/new.txt');
  check('stat 给出 isFile + size', st.isFile === true && st.size === 7, JSON.stringify(st));
  const rows = await adapter.listDir('sub');
  check(
    'listDir 列出子目录',
    rows.some((r) => r.name === 'deep' && r.isDirectory === true),
    rows.map((r) => r.name).join(',')
  );

  // ---- 5. 增量索引：远端 fs.write_file 自己调度（桌面端不再补通知）----
  // 前提：这个工作区得先有一份索引。对**没建过索引**的工作区写文件只会「无事可做」——
  // 远端调度器查 codebase.status 看到 indexed=false 就安静返回（设计如此），
  // 拿它断言「有没有触发」等于在断言启动时序，测不出写路径对不对。
  const { getRemoteAgentClient } = require('../src/gateway/remote-agent-client');
  const client = getRemoteAgentClient(info);
  const built = await client.call('codebase.index.start', { workspaceRoot: WS, force: true }, 180000);
  check('远端建起索引（增量调度的前提）', !!built, JSON.stringify(built).slice(0, 120));
  await adapter.writeFile('inc.js', 'export const touched = 1;\n', 'utf8');
  await new Promise((r) => setTimeout(r, 3000));
  const logTail = async () =>
    String((await sh(`tail -n 200 ${home}/.dieyun/remote-agent/logs/agent.log 2>/dev/null`)).stdout || '');
  const tail = await logTail();
  check(
    '这次写入触发了远端增量索引（写路径合一的实际收益）',
    /remote codebase incremental started/.test(tail),
    tail.split('\n').filter((l) => /incremental/i.test(l)).slice(-2).join(' / ') || '(日志里没有 incremental 行)'
  );

  // ---- 6. 单一份 grep / glob（删掉自拼 GNU grep 之后，剩下的那条真的能跑）----
  const token = `NEEDLE_${Date.now()}`;
  await adapter.writeFile('grep-target.js', `export const x = '${token}';\n`, 'utf8');
  const gp = await client.call('fs.grep', { pattern: token, regex: false, maxResults: 10 }, 60000);
  const gm = (gp && gp.matches) || [];
  check(
    'fs.grep 在远端命中刚写的 token（这台机器没有 rg，走的是 rg-search 内部退 grep）',
    gm.some((m) => String(m.path || '').endsWith('grep-target.js')),
    JSON.stringify(gm.slice(0, 2))
  );
  const gl = await client.call('fs.glob', { pattern: '**/grep-target.js', maxResults: 10 }, 60000);
  const glFiles = (gl && (gl.files || gl.matches)) || [];
  check('fs.glob 找到同一文件', glFiles.some((f) => String(f.path || f).includes('grep-target.js')), JSON.stringify(glFiles.slice(0, 2)));

  // ---- 7. 白名单：工作空间外仍可写 HOME 兜底目录（与 SFTP 时代同一边界）----
  const homeShot = `${home}/.dieyun/workspace/verify-fs-probe.txt`;
  const w2 = await adapter.writeFile(homeShot, 'probe\n', 'utf8');
  check('HOME 兜底目录可写（两传输口径一致）', w2.ok === true, w2.path);
  await sh(`rm -f ${homeShot}`);

  const outside = await adapter
    .readFile('/etc/passwd', 'utf8')
    .then(() => null)
    .catch((e) => e);
  check('白名单外被拒（PATH_NOT_ALLOWED）', !!outside && outside.code === 'PATH_NOT_ALLOWED', outside && outside.code);

  // ---- 8. 清理 ----
  await mgr.stop(ssh, { killRemote: true });
  await sh(`rm -rf ${WS}`);
  check('测试工作区已清理', String((await sh(`ls -d ${WS} 2>/dev/null | wc -l`)).stdout || '').trim() === '0');

  ssh.disconnect();
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL ${e && e.code ? `${e.code} ` : ''}${e && e.message}`);
  if (e && e.detail) console.log(String(e.detail).slice(0, 1500));
  process.exit(2);
});
