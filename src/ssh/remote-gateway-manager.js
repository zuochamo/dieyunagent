'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createSshTunnel, closeSshTunnel } = require('./tunnel');
const { shellQuoteSingle } = require('./remote-path');
const { DEFAULT_REMOTE_PORT } = require('../remote/minimal-gateway-host');

const REMOTE_HOME_DIR = '.dieyun/remote-agent';

function remotePidBasename(remotePort, kind) {
  const p = Number(remotePort) || DEFAULT_REMOTE_PORT;
  return kind === 'gateway' ? `gateway-${p}.pid` : `agent-${p}.pid`;
}

/**
 * @param {{ log?: (msg: string) => void }} opts
 */
function createRemoteGatewayManager(opts = {}) {
  const log = opts.log || (() => {});
  /** @type {import('net').Server | null} */
  let tunnelServer = null;
  let localPort = 0;
  let token = '';
  let remoteWorkspace = '';
  let activeRemotePort = DEFAULT_REMOTE_PORT;
  let active = false;
  let deploying = null;
  /** @type {ReturnType<import('./session-manager').createSshSessionManager> | null} */
  let lastSshManager = null;
  /** @type {string} */
  let runtimeSource = '';
  /** @type {string} */
  let lastError = '';
  /** @type {string} */
  let lastErrorCode = '';
  let lastErrorAt = 0;
  let lastOkAt = 0;

  async function stopTunnel() {
    await closeSshTunnel(tunnelServer);
    tunnelServer = null;
    localPort = 0;
    token = '';
    active = false;
  }

  async function stop(sshManager, opts = {}) {
    const killRemote = opts.killRemote !== false;
    const sm = sshManager || lastSshManager;
    const ws = remoteWorkspace;
    if (killRemote && sm) {
      try {
        if (sm.status().connected) {
          await stopRemoteProcess(sm, activeRemotePort || DEFAULT_REMOTE_PORT, ws);
        }
      } catch {
        // ignore
      }
    }
    remoteWorkspace = '';
    runtimeSource = '';
    await stopTunnel();
  }

  function getInfo() {
    if (!active || !localPort || !token) return null;
    return {
      host: '127.0.0.1',
      port: localPort,
      url: `ws://127.0.0.1:${localPort}`,
      token,
      remoteGateway: true,
      remoteAgent: true,
      workspaceRoot: remoteWorkspace,
      runtimeSource
    };
  }

  function isActive() {
    return active;
  }

  async function sftpMkdirp(sftp, remoteDir) {
    const parts = String(remoteDir || '').split('/').filter(Boolean);
    let cur = remoteDir.startsWith('/') ? '' : '';
    for (const part of parts) {
      cur += `/${part}`;
      await new Promise((resolve, reject) => {
        sftp.mkdir(cur, (err) => {
          if (err && err.code !== 4) reject(err);
          else resolve();
        });
      });
    }
  }

  async function sftpUploadFile(sftp, localPath, remotePath, opts = {}) {
    await new Promise((resolve, reject) => {
      const putOpts = {};
      if (opts.mode != null) putOpts.mode = opts.mode;
      sftp.fastPut(localPath, remotePath, putOpts, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    if (opts.mode != null) {
      await new Promise((resolve, reject) => {
        sftp.chmod(remotePath, opts.mode, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  function uploadModeForRel(rel) {
    if (rel === 'bin/node' || rel === 'bin/dieyun-core' || rel === 'remote/run-cli.js') return 0o755;
    return null;
  }

  async function walkFiles(dir, base = dir) {
    const out = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name === '.tmp-node') continue;
      if (ent.isDirectory()) {
        out.push(...(await walkFiles(full, base)));
      } else {
        out.push({ local: full, rel: path.relative(base, full).replace(/\\/g, '/') });
      }
    }
    return out;
  }

  async function getRemoteHome(sshManager) {
    const r = await sshManager.exec('echo $HOME', null, 5000, { loginShell: false });
    const home = String(r.stdout || '').trim();
    if (!home) throw Object.assign(new Error('无法解析远程 HOME 目录'), { code: 'REMOTE_HOME_UNKNOWN' });
    return home;
  }

  function readLocalManifest(packRoot) {
    try {
      return JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async function remotePackState(sshManager, remoteBase, version, localNodeSize, localSourceHash) {
    const verFile = `${remoteBase}/.pack-version`;
    const nodeFile = `${remoteBase}/bin/node`;
    const runCli = `${remoteBase}/remote/run-cli.js`;
    const manifestFile = `${remoteBase}/manifest.json`;
    const bundledNode = nodeFile;
    const hashScript =
      "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log('HASH='+(m.sourceHash||''));";
    const cmd = [
      `test -f ${shellQuoteSingle(verFile)}`,
      `test -f ${shellQuoteSingle(nodeFile)}`,
      `test -f ${shellQuoteSingle(runCli)}`,
      `echo VERSION=$(tr -d '\\r\\n' < ${shellQuoteSingle(verFile)})`,
      `echo SIZE=$(stat -c%s ${shellQuoteSingle(nodeFile)} 2>/dev/null || wc -c < ${shellQuoteSingle(nodeFile)})`,
      `if test -f ${shellQuoteSingle(manifestFile)}; then ${shellQuoteSingle(bundledNode)} -e ${shellQuoteSingle(hashScript)} ${shellQuoteSingle(manifestFile)}; else echo HASH=; fi`
    ].join(' && ');
    try {
      const r = await sshManager.execScript(cmd, 12000);
      const out = String(r.stdout || '');
      const errOut = String(r.stderr || '').trim();
      if (r.code !== 0) {
        return {
          ok: false,
          remoteVer: '',
          remoteSize: 0,
          remoteHash: '',
          error: `verify exit ${r.code}${errOut ? `: ${errOut}` : ''}`
        };
      }
      const verMatch = out.match(/VERSION=(.+)/);
      const sizeMatch = out.match(/SIZE=(\d+)/);
      const hashMatch = out.match(/HASH=([^\r\n]*)/);
      const remoteVer = verMatch ? String(verMatch[1]).trim() : '';
      const remoteSize = sizeMatch ? Number(sizeMatch[1]) : 0;
      const remoteHash = hashMatch ? String(hashMatch[1]).trim() : '';
      const sizeOk = localNodeSize > 0 && Math.abs(remoteSize - localNodeSize) < 4096;
      const hashOk = !localSourceHash || (remoteHash && remoteHash === localSourceHash);
      const versionOk = remoteVer === version;
      return {
        ok: versionOk && sizeOk && hashOk,
        remoteVer,
        remoteSize,
        remoteHash,
        versionOk,
        sizeOk,
        hashOk
      };
    } catch (e) {
      return { ok: false, remoteVer: '', remoteSize: 0, remoteHash: '', error: e && e.message ? String(e.message) : 'verify exec failed' };
    }
  }

  function formatDeployVerifyFailure(verify, version, localNodeSize, localSourceHash) {
    const parts = [];
    if (verify.versionOk === false) parts.push(`版本 ${verify.remoteVer || '?'}≠${version}`);
    if (verify.sizeOk === false) {
      parts.push(`Node 大小 ${verify.remoteSize || 0}/${localNodeSize}`);
    }
    if (localSourceHash && verify.hashOk === false) {
      parts.push(`源码包 hash ${verify.remoteHash || '(空)'}≠${localSourceHash}`);
    }
    if (verify.error) parts.push(verify.error);
    return parts.length ? parts.join('，') : '未知校验失败';
  }

  async function deployPack(sshManager, packRoot, version, opts = {}) {
    const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    if (!fs.existsSync(packRoot)) {
      throw Object.assign(new Error('远程 Agent 安装包未找到，请运行 npm run pack:remote-gateway'), {
        code: 'REMOTE_GATEWAY_PACK_MISSING'
      });
    }
    const localNodePath = path.join(packRoot, 'bin', 'node');
    const manifest = readLocalManifest(packRoot);
    if (!manifest || !fs.existsSync(localNodePath)) {
      throw Object.assign(new Error('远程 Agent 包缺少内置 Node 运行时，请重新打包'), {
        code: 'REMOTE_GATEWAY_PACK_INCOMPLETE'
      });
    }
    const localNodeSize = fs.statSync(localNodePath).size;
    const localSourceHash = manifest && manifest.sourceHash ? String(manifest.sourceHash) : '';

    const home = await getRemoteHome(sshManager);
    const remoteBase = `${home}/${REMOTE_HOME_DIR}/${version}`;
    const remoteCurrent = `${home}/${REMOTE_HOME_DIR}/current`;

    let needUpload = opts.force === true;
    if (!needUpload) {
      const st = await remotePackState(sshManager, remoteBase, version, localNodeSize, localSourceHash);
      needUpload = !st.ok;
      if (!needUpload) {
        log(`远程 Agent ${version} 已存在（Node ${Math.round(localNodeSize / 1024 / 1024)}MB）`);
      } else if (st.remoteVer) {
        const hashHint =
          localSourceHash && st.remoteHash && st.remoteHash !== localSourceHash
            ? `，源码包已更新 ${st.remoteHash}→${localSourceHash}`
            : '';
        log(`远程 Agent 需重新注入（版本 ${st.remoteVer || '?'} / 大小 ${st.remoteSize || 0}${hashHint}）`);
      }
    }

    if (needUpload) {
      const sftp = sshManager.getSftp();
      emit({ phase: 'upload', percent: 3, message: '准备上传…' });
      log(`正在注入远程 Agent ${version}（含 Node ${manifest.nodeVersion || ''}，约 ${Math.round(localNodeSize / 1024 / 1024)}MB）…`);
      await sshManager.execScript(
        `rm -rf ${shellQuoteSingle(remoteBase)} && mkdir -p ${shellQuoteSingle(remoteBase)}`,
        20000
      );
      const files = await walkFiles(packRoot);
      let uploaded = 0;
      emit({ phase: 'upload', percent: 5, message: `0/${files.length}`, current: 0, total: files.length });
      for (const f of files) {
        const remotePath = `${remoteBase}/${f.rel}`;
        const mode = uploadModeForRel(f.rel);
        try {
          await sftpMkdirp(sftp, path.posix.dirname(remotePath));
          await sftpUploadFile(sftp, f.local, remotePath, { mode });
          uploaded += 1;
          const pct = 5 + Math.round((uploaded / files.length) * 76);
          emit({
            phase: 'upload',
            percent: pct,
            message: `${uploaded}/${files.length}`,
            file: f.rel,
            current: uploaded,
            total: files.length
          });
          if (f.rel === 'bin/node' || uploaded % 10 === 0 || uploaded === files.length) {
            log(`  上传进度 ${uploaded}/${files.length} (${f.rel})`);
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          throw Object.assign(new Error(`远程 Agent 上传失败 (${f.rel}): ${msg}`), {
            code: 'REMOTE_GATEWAY_UPLOAD_FAILED',
            detail: `${uploaded}/${files.length} ${f.rel}`
          });
        }
      }
      const versionFile = `${remoteBase}/.pack-version`;
      const tmp = path.join(require('os').tmpdir(), `dieyun-agent-ver-${Date.now()}.txt`);
      await fsp.writeFile(tmp, version, 'utf8');
      try {
        await sftpUploadFile(sftp, tmp, versionFile);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
      await sshManager.execScript(
        [
          `chmod +x ${shellQuoteSingle(`${remoteBase}/bin/node`)}`,
          `chmod +x ${shellQuoteSingle(`${remoteBase}/remote/run-cli.js`)}`,
          `test -f ${shellQuoteSingle(`${remoteBase}/bin/dieyun-core`)} && chmod +x ${shellQuoteSingle(`${remoteBase}/bin/dieyun-core`)} || true`
        ].join(' && '),
        8000
      );
      emit({ phase: 'verify', percent: 84, message: '校验…' });
      const verify = await remotePackState(sshManager, remoteBase, version, localNodeSize, localSourceHash);
      if (!verify.ok) {
        throw Object.assign(
          new Error(`远程 Agent 上传后校验失败（${formatDeployVerifyFailure(verify, version, localNodeSize, localSourceHash)}）`),
          { code: 'REMOTE_GATEWAY_DEPLOY_VERIFY_FAILED' }
        );
      }
      log('远程 Agent 文件上传完成');
    } else {
      emit({ phase: 'upload', percent: 82, message: '已存在，跳过上传' });
    }

    emit({ phase: 'link', percent: 86, message: '创建链接…' });
    const linkCmd = [
      `mkdir -p ${shellQuoteSingle(`${home}/${REMOTE_HOME_DIR}`)}`,
      `rm -rf ${shellQuoteSingle(remoteCurrent)}`,
      `ln -sfn ${shellQuoteSingle(remoteBase)} ${shellQuoteSingle(remoteCurrent)}`,
      `chmod +x ${shellQuoteSingle(`${remoteCurrent}/bin/node`)}`,
      `test -f ${shellQuoteSingle(`${remoteCurrent}/bin/dieyun-core`)} && chmod +x ${shellQuoteSingle(`${remoteCurrent}/bin/dieyun-core`)} || true`
    ].join(' && ');
    await sshManager.execScript(linkCmd, 15000);
  }

  async function checkSystemNode(sshManager) {
    const r = await sshManager.execScript(
      'NODE_BIN=$(command -v node 2>/dev/null); if test -n "$NODE_BIN"; then echo "$NODE_BIN"; node -v; else echo MISSING; fi',
      12000
    );
    const lines = String(r.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length || lines[0] === 'MISSING') return null;
    const nodeBin = lines[0];
    const ver = lines[1] || '';
    const major = parseInt(String(ver).replace(/^v/i, ''), 10);
    if (major > 0 && major < 18) return null;
    if (!major) return null;
    return { ver, nodeBin, source: 'system' };
  }

  async function resolveNodeRuntime(sshManager, packRoot) {
    const home = await getRemoteHome(sshManager);
    const currentDir = `${home}/${REMOTE_HOME_DIR}/current`;
    const localNodePath = path.join(packRoot, 'bin', 'node');
    const hasBundledLocal = fs.existsSync(localNodePath);

    if (hasBundledLocal) {
      const nodeFile = `${currentDir}/bin/node`;
      const diagCmd = [
        `test -L ${shellQuoteSingle(currentDir)} || test -d ${shellQuoteSingle(currentDir)}`,
        `test -f ${shellQuoteSingle(nodeFile)}`,
        `chmod +x ${shellQuoteSingle(nodeFile)} 2>/dev/null || true`,
        `${shellQuoteSingle(nodeFile)} -v`
      ].join(' && ');
      const r = await sshManager.execScript(diagCmd, 20000);
      const ver = String(r.stdout || '')
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (ver && /^v\d/i.test(ver)) {
        log(`使用注入的 Node 运行时 ${ver}`);
        return { nodeBin: `${currentDir}/bin/node`, ver, source: 'bundled' };
      }
      const diag = [String(r.stdout || '').trim(), String(r.stderr || '').trim()].filter(Boolean).join('\n');
      throw Object.assign(
        new Error(
          '内置 Node 未就绪（将自动注入到 ~/.dieyun/remote-agent/）。若仍失败，请确认服务器为 linux-x64 且磁盘空间充足。'
        ),
        {
          code: 'REMOTE_RUNTIME_FAILED',
          detail: diag.slice(0, 800)
        }
      );
    }

    const sys = await checkSystemNode(sshManager);
    if (sys) {
      log(`使用系统 Node.js ${sys.ver} (${sys.nodeBin})`);
      return sys;
    }

    throw Object.assign(new Error('远程 Agent 安装包不完整，请在本机运行 npm run pack:remote-gateway'), {
      code: 'REMOTE_GATEWAY_PACK_INCOMPLETE'
    });
  }

  async function readRemoteGatewayLog(sshManager, currentDir, lines = 40) {
    const logPath = `${currentDir}/agent.log`;
    try {
      const r = await sshManager.execScript(
        `test -f ${shellQuoteSingle(logPath)} && tail -n ${lines} ${shellQuoteSingle(logPath)} || echo "(无 agent.log)"`,
        8000
      );
      return String(r.stdout || '').trim() || '(空)';
    } catch {
      return '(无法读取 agent.log)';
    }
  }

  async function freeRemoteAgentPort(sshManager, port) {
    const p = Number(port) || DEFAULT_REMOTE_PORT;
    try {
      await sshManager.execScript(
        [
          `PORT=${p}`,
          'if command -v fuser >/dev/null 2>&1; then fuser -k ${PORT}/tcp 2>/dev/null || true; fi',
          'if command -v lsof >/dev/null 2>&1; then for pid in $(lsof -ti :${PORT} 2>/dev/null); do kill "$pid" 2>/dev/null || true; done; fi',
          'if command -v ss >/dev/null 2>&1; then for pid in $(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u); do kill "$pid" 2>/dev/null || true; done; fi',
          'sleep 0.8',
          `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${PORT} " && echo IN_USE || echo FREE`
        ].join('\n'),
        15000
      );
    } catch {
      // ignore — best effort
    }
  }

  async function stopRemoteProcess(sshManager, remotePort, workspaceRoot) {
    const home = await getRemoteHome(sshManager);
    const currentDir = `${home}/${REMOTE_HOME_DIR}/current`;
    const port = Number(remotePort) || DEFAULT_REMOTE_PORT;
    const agentPidFile = remotePidBasename(port, 'agent');
    const gatewayPidFile = remotePidBasename(port, 'gateway');
    const legacyCleanup =
      port === DEFAULT_REMOTE_PORT
        ? 'if test -f agent.pid; then kill "$(cat agent.pid)" 2>/dev/null || true; rm -f agent.pid; fi; if test -f gateway.pid; then kill "$(cat gateway.pid)" 2>/dev/null || true; rm -f gateway.pid; fi'
        : 'true';
    try {
      await sshManager.execScript(
        [
          `cd ${shellQuoteSingle(currentDir)} || exit 0`,
          `if test -f ${agentPidFile}; then kill "$(cat ${agentPidFile})" 2>/dev/null || true; rm -f ${agentPidFile}; fi`,
          `if test -f ${gatewayPidFile}; then kill "$(cat ${gatewayPidFile})" 2>/dev/null || true; rm -f ${gatewayPidFile}; fi`,
          legacyCleanup
        ].join('\n'),
        8000
      );
    } catch {
      // ignore if install dir missing
    }
    await freeRemoteAgentPort(sshManager, port);
    const ws = String(workspaceRoot || '').trim();
    if (ws) {
      const dbQ = shellQuoteSingle(`${ws.replace(/\/+$/, '')}/.dieyun/index.sqlite`);
      try {
        await sshManager.execScript(
          [
            `DB=${dbQ}`,
            'if test -e "$DB" && command -v fuser >/dev/null 2>&1; then fuser -k "$DB" 2>/dev/null || true; fi',
            'if test -e "$DB" && command -v lsof >/dev/null 2>&1; then for pid in $(lsof -ti "$DB" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done; fi',
            'sleep 0.3'
          ].join('\n'),
          8000
        );
      } catch {
        // best effort — 避免 agent 被 kill 后 dieyun-core 变孤儿占库
      }
    }
  }

  async function startRemoteProcess(sshManager, workspaceRoot, remotePort, tok, nodeRuntime) {
    const home = await getRemoteHome(sshManager);
    const currentDir = `${home}/${REMOTE_HOME_DIR}/current`;
    const wsQ = shellQuoteSingle(workspaceRoot);
    const tokQ = shellQuoteSingle(tok);
    const nodeBin = nodeRuntime.nodeBin || `${currentDir}/bin/node`;
    const nodeQ = shellQuoteSingle(nodeBin);
    const dirQ = shellQuoteSingle(currentDir);

    const preflight = await sshManager.execScript(
      [
        `test -d ${dirQ} || test -L ${dirQ}`,
        `test -f ${shellQuoteSingle(`${currentDir}/remote/run-cli.js`)}`,
        `test -d ${shellQuoteSingle(`${currentDir}/node_modules/ws`)}`,
        'echo OK'
      ].join(' && '),
      8000
    );
    if (String(preflight.stdout || '').trim() !== 'OK') {
      throw Object.assign(new Error('远程 Agent 安装包不完整'), {
        code: 'REMOTE_GATEWAY_PACK_INCOMPLETE',
        detail: String(preflight.stderr || preflight.stdout || '').trim()
      });
    }

    const smoke = await sshManager.execScript(
      [
        `cd ${dirQ}`,
        `test -f ${shellQuoteSingle(`${currentDir}/gateway/fs-read-limits.js`)}`,
        `test -f ${shellQuoteSingle(`${currentDir}/gateway/fs-edit-file.js`)}`,
        `${nodeQ} -e ${shellQuoteSingle("require('./remote/minimal-gateway-host'); console.log('SMOKE_OK')")}`
      ].join('\n'),
      20000
    );
    const smokeOut = String(smoke.stdout || '').trim();
    if (!smokeOut.includes('SMOKE_OK')) {
      const logTail = await readRemoteGatewayLog(sshManager, currentDir);
      throw Object.assign(new Error('远程 Agent 模块加载失败'), {
        code: 'REMOTE_GATEWAY_SMOKE_FAILED',
        detail: [smokeOut, String(smoke.stderr || '').trim(), logTail].filter(Boolean).join('\n').slice(0, 2000)
      });
    }

    const agentPidFile = remotePidBasename(remotePort, 'agent');
    const startCmd = [
      `cd ${dirQ}`,
      `PORT=${remotePort}`,
      'if command -v fuser >/dev/null 2>&1; then fuser -k ${PORT}/tcp 2>/dev/null || true; fi',
      'if command -v lsof >/dev/null 2>&1; then for pid in $(lsof -ti :${PORT} 2>/dev/null); do kill "$pid" 2>/dev/null || true; done; fi',
      `kill $(cat ${agentPidFile} 2>/dev/null) 2>/dev/null || true`,
      `rm -f ${agentPidFile}`,
      'sleep 0.5',
      `nohup ${nodeQ} ${shellQuoteSingle(`${currentDir}/remote/run-cli.js`)} --workspace ${wsQ} --port ${remotePort} --token ${tokQ} >> agent.log 2>&1 &`,
      `echo $! > ${agentPidFile}`,
      'sleep 2',
      `PID=$(cat ${agentPidFile} 2>/dev/null || true)`,
      'if kill -0 "$PID" 2>/dev/null; then echo "$PID"; else echo START_FAILED; tail -n 30 agent.log 2>/dev/null || true; fi'
    ].join('\n');

    const r = await sshManager.execScript(startCmd, 30000);
    const out = String(r.stdout || '').trim();
    const outLines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pidLine = outLines.find((l) => /^\d+$/.test(l));
    const pid = pidLine || outLines[0];

    if (!pid || pid === 'START_FAILED' || !/^\d+$/.test(pid)) {
      const logTail = await readRemoteGatewayLog(sshManager, currentDir);
      const detail = [out, String(r.stderr || '').trim(), logTail].filter(Boolean).join('\n---\n');
      const portBusy = /EADDRINUSE|address already in use/i.test(detail);
      throw Object.assign(
        new Error(portBusy ? `远程 Agent 端口 :${remotePort} 被占用，已尝试清理仍无法启动` : '远程 Agent 进程启动失败'),
        {
          code: portBusy ? 'REMOTE_GATEWAY_PORT_IN_USE' : 'REMOTE_GATEWAY_START_FAILED',
          detail: detail.slice(0, 2000)
        }
      );
    }
    log(`远程 Agent 已启动 pid=${pid} port=${remotePort} runtime=${nodeRuntime.source || 'unknown'}`);
  }

  async function waitRemotePort(sshManager, remotePort, attempts = 12) {
    for (let i = 0; i < attempts; i++) {
      const r = await sshManager.execScript(
        `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${remotePort} " && echo OK || echo WAIT`,
        6000
      );
      if (String(r.stdout || '').trim() === 'OK') return;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw Object.assign(new Error('远程 Agent 端口未就绪'), { code: 'REMOTE_GATEWAY_PORT_TIMEOUT' });
  }

  async function pickFreeLocalPort() {
    const net = require('net');
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => resolve(port));
      });
      s.on('error', reject);
    });
  }

  async function ensureRemoteGateway(ctx) {
    if (deploying) return deploying;
    const emit = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
    const workspaceRemotePath = String(ctx.workspaceRemotePath || '/').trim() || '/';
    const requestedPort = Number(ctx.remotePort) || DEFAULT_REMOTE_PORT;
    if (
      active &&
      remoteWorkspace === workspaceRemotePath &&
      requestedPort === activeRemotePort &&
      ctx.force !== true
    ) {
      return getInfo();
    }
    deploying = (async () => {
      const sshManager = ctx.sshManager;
      lastSshManager = sshManager;
      const packRoot = ctx.packRoot;
      const version = String(ctx.appVersion || 'dev');

      emit({ phase: 'prepare', percent: 1, message: '准备注入…' });
      sshManager.assertConnected();
      await deployPack(sshManager, packRoot, version, {
        onProgress: emit,
        force: ctx.force === true
      });
      emit({ phase: 'runtime', percent: 88, message: '检测 Node…' });
      let nodeRuntime;
      try {
        nodeRuntime = await resolveNodeRuntime(sshManager, packRoot);
      } catch (firstErr) {
        if (firstErr && firstErr.code === 'REMOTE_RUNTIME_FAILED') {
          log('内置 Node 校验失败，强制重新注入…');
          emit({ phase: 'upload', percent: 10, message: '重新注入…' });
          await deployPack(sshManager, packRoot, version, { onProgress: emit, force: true });
          emit({ phase: 'runtime', percent: 88, message: '检测 Node…' });
          nodeRuntime = await resolveNodeRuntime(sshManager, packRoot);
        } else {
          throw firstErr;
        }
      }
      runtimeSource = nodeRuntime.source || '';

      const remotePort = requestedPort;
      const newToken = crypto.randomBytes(24).toString('hex');
      emit({ phase: 'start', percent: 92, message: '启动 Agent…' });
      await stopRemoteProcess(sshManager, remotePort, workspaceRemotePath);
      await startRemoteProcess(sshManager, workspaceRemotePath, remotePort, newToken, nodeRuntime);
      emit({ phase: 'port', percent: 96, message: '等待端口…' });
      await waitRemotePort(sshManager, remotePort);

      const nextLocalPort = await pickFreeLocalPort();
      await stopTunnel();
      lastSshManager = sshManager;
      const client = sshManager.getClient();
      emit({ phase: 'tunnel', percent: 98, message: '建立隧道…' });
      tunnelServer = await createSshTunnel(client, {
        localHost: '127.0.0.1',
        localPort: nextLocalPort,
        remoteHost: '127.0.0.1',
        remotePort,
        isConnected: () => sshManager.status().connected,
        onDisconnect: () => {
          active = false;
          localPort = 0;
          token = '';
        }
      });

      localPort = nextLocalPort;
      token = newToken;
      remoteWorkspace = workspaceRemotePath;
      activeRemotePort = remotePort;
      active = true;
      lastError = '';
      lastErrorCode = '';
      lastErrorAt = 0;
      lastOkAt = Date.now();
      log(`SSH 隧道 ws://127.0.0.1:${localPort} → 127.0.0.1:${remotePort} (${runtimeSource})`);
      emit({ phase: 'done', percent: 100, message: '完成' });

      return getInfo();
    })().catch((e) => {
      const detail = e.detail ? String(e.detail) : '';
      lastError = detail ? `${e.message}\n${detail}`.slice(0, 800) : e.message || String(e);
      lastErrorCode = e.code || 'REMOTE_GATEWAY_FAILED';
      lastErrorAt = Date.now();
      active = false;
      log(`Remote Agent 注入失败 [${lastErrorCode}]: ${e.message || e}${detail ? ` | ${detail.slice(0, 200)}` : ''}`);
      emit({ phase: 'error', percent: 0, message: '失败', hidden: true });
      throw e;
    }).finally(() => {
      deploying = null;
    });
    return deploying;
  }

  function getStatus() {
    return {
      active,
      deploying: !!deploying,
      info: getInfo(),
      workspaceRoot: remoteWorkspace || '',
      localPort: localPort || 0,
      remotePort: activeRemotePort || DEFAULT_REMOTE_PORT,
      runtimeSource,
      lastError,
      lastErrorCode,
      lastErrorAt,
      lastOkAt,
      remoteLogPath: `~/${REMOTE_HOME_DIR}/current/agent.log`
    };
  }

  return {
    ensureRemoteGateway,
    stop,
    getInfo,
    getStatus,
    isActive
  };
}

module.exports = { createRemoteGatewayManager };
