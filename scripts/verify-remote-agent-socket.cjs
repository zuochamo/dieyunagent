'use strict';
/**
 * 远端 Agent socket 模型（P2）的真机验收器。
 *
 * 这是「每主机一个 daemon + Unix socket」这条设计**唯一真正的证据**：
 * 离线单测只能证明脚本拼得对，证明不了「两个工作区共用一个进程、零监听端口、退出零残留」。
 *
 * 用法（密码只从文件读，不进命令行 / 不进仓库）：
 *   set DY_SSH_HOST=192.168.31.62
 *   set DY_SSH_USER=dieyunx
 *   set DY_SSH_PW_FILE=%TEMP%\dy_ssh_pw
 *   set DY_WS_BASE=/run/media/<user>/Data/ceshi        # 两个临时子目录建在这里，跑完删掉
 *   npm run verify:remote-agent-socket
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 连接或部署直接失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSshSessionManager } = require('../src/ssh/session-manager');
const { resolveConnectPayload } = require('../src/ssh/connect-payload');
const { createRemoteGatewayManager } = require('../src/ssh/remote-gateway-manager');
const { getRemoteAgentClient, invalidateRemoteAgentClient } = require('../src/gateway/remote-agent-client');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const HOST = env('DY_SSH_HOST', '');
const USER = env('DY_SSH_USER', 'dieyunx');
const PW_FILE = env('DY_SSH_PW_FILE', path.join(os.tmpdir(), 'dy_ssh_pw'));
const WS_BASE = env('DY_WS_BASE', '');
const PACK = env('DY_REMOTE_PACK', path.join(__dirname, '..', 'build', 'remote-gateway-pack'));
const VERSION = 'verify-socket';

if (!HOST || !WS_BASE) {
  console.error('需要 DY_SSH_HOST 与 DY_WS_BASE（远端可写目录，验收器会在其下建两个临时工作区）');
  process.exit(2);
}
if (!fs.existsSync(PW_FILE)) {
  console.error(`找不到密码文件 ${PW_FILE}；把密码写进该文件（或设置 DY_SSH_PW_FILE）再跑`);
  process.exit(2);
}

const PW = fs.readFileSync(PW_FILE, 'utf8').trim();
const WS_A = path.posix.join(WS_BASE, 'verify-socket-a');
const WS_B = path.posix.join(WS_BASE, 'verify-socket-b');

const results = [];
function check(label, pass, detail) {
  results.push([pass ? 'PASS' : 'FAIL', label]);
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}${detail == null ? '' : ` | ${String(detail).slice(0, 200)}`}`);
}

const ssh = createSshSessionManager({
  userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'dy-verify-')),
  log: () => {}
});

async function sh(cmd, ms) {
  return ssh.execScript(cmd, ms || 15000);
}

/** 该 socket 对应的 daemon 进程（pgrep 按启动参数匹配，不靠 pid 文件） */
async function daemonPids(sockPath) {
  const r = await sh(`pgrep -f -- "--socket ${sockPath}" 2>/dev/null | tr "\\n" " "`, 8000);
  return String(r.stdout || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

(async () => {
  await ssh.connect(
    resolveConnectPayload(
      { host: HOST, username: USER, password: PW, authType: 'password', acceptNewHostKey: true },
      { sshConfigBlocks: [], agentSocket: '' }
    )
  );
  console.log(`ssh ${USER}@${HOST} connected`);

  // 冷启动：清掉上一次留下的 daemon 与陈旧 socket
  const home = String((await sh('printf %s "$HOME"', 8000)).stdout || '').trim();
  const sockPath = `${home}/.dieyun/remote-agent/run/agent.sock`;
  await sh(`pkill -9 -f -- "--socket ${sockPath}" 2>/dev/null; rm -f ${sockPath}; sleep 0.4`);
  await sh(
    `rm -rf ${WS_A} ${WS_B}; mkdir -p ${WS_A} ${WS_B}; echo a > ${WS_A}/a.txt; echo b > ${WS_B}/b.txt`
  );

  // 1. 首次 ensure：部署 + 拉起 daemon
  const mgrA = createRemoteGatewayManager({ log: (m) => console.log(`[A] ${m}`) });
  const t0 = Date.now();
  const infoA = await mgrA.ensureRemoteGateway({
    sshManager: ssh,
    packRoot: PACK,
    appVersion: VERSION,
    workspaceRemotePath: WS_A,
    onProgress: () => {}
  });
  check('ensure A 返回 socketPath', infoA && infoA.socketPath === sockPath, infoA && infoA.socketPath);
  check(
    'info 不再是 url/token，而是 openChannel',
    !!infoA && !infoA.url && !infoA.token && typeof infoA.openChannel === 'function',
    Object.keys(infoA || {}).join(',')
  );
  const pidsA = await daemonPids(sockPath);
  check('daemon 正好一个进程', pidsA.length === 1, `pids=${pidsA.join(',')} (${Date.now() - t0}ms)`);

  // 2. 经 SSH 通道跑真实 RPC
  const clientA = getRemoteAgentClient(infoA);
  const rA = await clientA.call('host.exec', { command: 'pwd; cat a.txt', cwd: WS_A }, 30000);
  check(
    'RPC over direct-streamlocal 落在 A 的根下',
    rA && rA.code === 0 && String(rA.stdout).includes(WS_A),
    String(rA && rA.stdout).replace(/\n/g, ' ')
  );

  // 3. 第二个工作区：同一个 daemon
  const mgrB = createRemoteGatewayManager({ log: (m) => console.log(`[B] ${m}`) });
  const infoB = await mgrB.ensureRemoteGateway({
    sshManager: ssh,
    packRoot: PACK,
    appVersion: VERSION,
    workspaceRemotePath: WS_B,
    onProgress: () => {}
  });
  check('两个工作区同一个 socket', infoA.socketPath === infoB.socketPath, infoB.socketPath);
  const pidsB = await daemonPids(sockPath);
  check('两个工作区同一个 daemon 进程', pidsB.length === 1 && pidsB[0] === pidsA[0], pidsB.join(','));
  check(
    '客户端缓存键带 workspace（否则 B 会复用 A 的连接）',
    infoB.key !== infoA.key,
    `${infoA.key} vs ${infoB.key}`
  );

  const clientB = getRemoteAgentClient(infoB);
  const rB = await clientB.call('host.exec', { command: 'pwd; cat b.txt', cwd: WS_B }, 30000);
  check(
    'B 的 RPC 落在 B 的根下',
    rB && rB.code === 0 && String(rB.stdout).includes(WS_B),
    String(rB && rB.stdout).replace(/\n/g, ' ')
  );

  // 4. 零监听端口 + 权限
  const listen = await sh(`ss -lntpH 2>/dev/null | grep -cF 'pid=${pidsA[0]},' || true`);
  check('daemon 监听 TCP 端口数 = 0', String(listen.stdout || '').trim() === '0', `匹配 ${String(listen.stdout || '').trim()}`);
  const perm = await sh(`stat -c '%a' ${sockPath}; stat -c '%a' $(dirname ${sockPath})`);
  const [sockMode, dirMode] = String(perm.stdout || '').trim().split('\n');
  check('socket 0600 / 目录 0700', sockMode === '600' && dirMode === '700', `sock=${sockMode} dir=${dirMode}`);

  // 5. daemon 被强杀 → 下次 ensure 自动重建
  await sh(`kill -9 ${pidsA[0]} 2>/dev/null; sleep 0.5`);
  check('强杀后进程消失（socket 文件变陈旧）', (await daemonPids(sockPath)).length === 0);
  invalidateRemoteAgentClient(infoA);
  const infoA2 = await mgrA.ensureRemoteGateway({
    sshManager: ssh,
    packRoot: PACK,
    appVersion: VERSION,
    workspaceRemotePath: WS_A,
    onProgress: () => {}
  });
  const pidsA2 = await daemonPids(sockPath);
  check('自动重建出新进程', pidsA2.length === 1 && pidsA2[0] !== pidsA[0], `旧 ${pidsA[0]} → 新 ${pidsA2.join(',')}`);
  const rA2 = await getRemoteAgentClient(infoA2).call('host.exec', { command: 'echo revived', cwd: WS_A }, 30000);
  check('重建后 RPC 正常', !!(rA2 && String(rA2.stdout).includes('revived')), String(rA2 && rA2.stdout).trim());

  // 6. 退出零残留
  invalidateRemoteAgentClient(infoA2);
  invalidateRemoteAgentClient(infoB);
  await mgrA.stop(ssh, { killRemote: true });
  await mgrB.stop(ssh, { killRemote: true });
  await new Promise((r) => setTimeout(r, 800));
  check('stop 后没有 daemon 进程', (await daemonPids(sockPath)).length === 0);
  const sockLeft = String((await sh(`test -e ${sockPath} && echo EXISTS || echo GONE`)).stdout || '').trim();
  check('stop 后 socket 文件消失', sockLeft === 'GONE', sockLeft);

  // 7. 清理
  await sh(`rm -rf ${WS_A} ${WS_B}`);
  check('测试工作区已清理', String((await sh(`ls -d ${WS_A} ${WS_B} 2>/dev/null | wc -l`)).stdout || '').trim() === '0');

  ssh.disconnect();
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL ${e && e.code ? `${e.code} ` : ''}${e && e.message}`);
  if (e && e.detail) console.log(String(e.detail).slice(0, 1500));
  process.exit(2);
});
