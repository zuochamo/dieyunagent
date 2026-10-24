'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSshTunnel, closeSshTunnel } = require('./tunnel');
const { shellQuoteSingle } = require('./remote-path');
const { DEFAULT_REMOTE_PORT } = require('../remote/minimal-gateway-host');
const { endpointScopeOf, withEndpointDeployLock } = require('./deploy-lock');
const {
  REMOTE_DEPLOY_REQUIRED_FILES,
  REMOTE_PACK_OK_MARKER,
  REMOTE_PACK_MARKER_REL,
  inspectRemotePack,
  parseRemotePackMarker,
  evaluateRemotePackPreflight,
  computePackContentHash
} = require('../remote/remote-pack-layout');
const { buildPackTarGz } = require('../remote/pack-archive');

const REMOTE_HOME_DIR = '.dieyun/remote-agent';
const REMOTE_LOG_DIR = 'logs';

/**
 * 远程 Agent 日志**按项目分开**（2026-10-23）。
 *
 * 原来所有 remotePath 共用 `~/.dieyun/remote-agent/current/agent.log`：同一台机器跑两个项目时
 * 两个进程 `>>` 追加同一个文件，日志交错混写，排查时根本分不清哪行属于哪个 workspace；
 * 而 `current` 是随版本切换的软链，日志还会跟着安装目录一起被替换掉。
 *
 * 现在落在 `~/.dieyun/remote-agent/logs/agent-<路径slug>-<hash8>.log`：
 * - slug 给人看（`srv_projA`），hash8 保证唯一且与端口分配无关（换端口不换文件）；
 * - 目录在版本目录之外，升级安装包不会丢日志。
 */
function remoteLogDir(home) {
  return `${home}/${REMOTE_HOME_DIR}/${REMOTE_LOG_DIR}`;
}

function remoteLogFileName(remotePath) {
  const raw = String(remotePath || '/');
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return slug ? `agent-${slug}-${hash}.log` : `agent-path-${hash}.log`;
}

function remoteLogPathFor(home, remotePath) {
  return `${remoteLogDir(home)}/${remoteLogFileName(remotePath)}`;
}

/** 展示用的 `~/...` 形式（getStatus / UI 只读这个，不再假设 current 目录）。 */
function remoteLogDisplayPath(remotePath) {
  return `~/${REMOTE_HOME_DIR}/${REMOTE_LOG_DIR}/${remoteLogFileName(remotePath)}`;
}

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
  /** 当前槽位的远程日志（`~/...` 展示形式）；每个 workspace 一份，不随版本目录变化 */
  let activeLogRel = '';
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
    activeLogRel = '';
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

  function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
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

  /**
   * 远程存在性检查脚本片段：必需清单来自 remote-pack-layout（单一来源）。
   * @param {string} dirExpr 远程 shell 表达式，如 '"$DIR"' 或已引用的绝对路径
   * @param {string[]} rels
   */
  function remoteMissingCheckLines(dirExpr, rels) {
    const list = rels.map((rel) => shellQuoteSingle(rel)).join(' ');
    return [
      "MISSING=''",
      `for f in ${list}; do test -f ${dirExpr}/"$f" || MISSING="$MISSING $f"; done`,
      'echo "MISSING=$MISSING"'
    ];
  }

  /**
   * 远端已就绪判定：只认 `.pack-ok` 标记（版本 + 内容 hash 两个口径）。
   * @returns {Promise<{ remoteVersion: string, remoteHash: string }>}
   */
  async function remoteMarkerState(sshManager, remoteMarker) {
    try {
      const r = await sshManager.execScript(`cat ${shellQuoteSingle(remoteMarker)} 2>/dev/null || true`, 8000);
      const st = parseRemotePackMarker(String(r.stdout || ''));
      return { remoteVersion: st.version, remoteHash: st.contentHash };
    } catch {
      return { remoteVersion: '', remoteHash: '' };
    }
  }

  /** 远端工具 preflight：解压与校验各依赖一个工具，缺了必须在上传前报出来。 */
  async function assertRemoteDeployTools(sshManager) {
    const r = await sshManager.execScript(
      [
        'command -v tar >/dev/null 2>&1 && echo TAR=tar || echo TAR=missing',
        'command -v sha256sum >/dev/null 2>&1 && echo SHA=sha256sum || echo SHA=missing'
      ].join('\n'),
      8000
    );
    const out = String(r.stdout || '');
    const missing = [];
    if (!/^TAR=tar$/m.test(out)) missing.push('tar');
    if (!/^SHA=sha256sum$/m.test(out)) missing.push('sha256sum');
    if (missing.length) {
      throw Object.assign(new Error(`远程服务器缺少 ${missing.join('、')}，无法注入远程 Agent`), {
        code: 'REMOTE_GATEWAY_TOOLS_MISSING',
        detail: missing.join(', ')
      });
    }
  }

  /**
   * 注入远程安装包。同端点串行（见模块级 deployLocks）：`rm -rf remoteBase` 与
   * `current` 软链是跨 manager 共享资源，必须整段排队。
   *
   * 传输与完整性模型：整包打成单个 tar.gz 一次上传（取代散文件逐个 SFTP 的
   * 上百次往返），sha256 远端比对校验传输，解压 + 缺项检查后写 `.pack-ok`
   * 标记；下次注入只对标记（版本 + 内容 hash）决定是否跳过上传。
   */
  async function deployPack(sshManager, packRoot, version, opts = {}) {
    const scope = `deploy:${endpointScopeOf(sshManager)}`;
    return withEndpointDeployLock(scope, () => deployPackUnlocked(sshManager, packRoot, version, opts));
  }

  async function deployPackUnlocked(sshManager, packRoot, version, opts = {}) {
    const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    if (!fs.existsSync(packRoot)) {
      throw Object.assign(new Error('远程 Agent 安装包未找到，请运行 npm run pack:remote-gateway'), {
        code: 'REMOTE_GATEWAY_PACK_MISSING'
      });
    }
    const manifest = readLocalManifest(packRoot);
    if (!manifest || !fs.existsSync(path.join(packRoot, 'bin', 'node'))) {
      throw Object.assign(new Error('远程 Agent 包缺少内置 Node 运行时，请重新打包'), {
        code: 'REMOTE_GATEWAY_PACK_INCOMPLETE'
      });
    }
    // 清单来自 remote-pack-layout：本地缺项就在这里失败，不要上传几十 MB 后再报错
    const localCheck = inspectRemotePack(packRoot);
    if (!localCheck.ok) {
      throw Object.assign(new Error(`远程 Agent 包内容不完整（${localCheck.detail}），请重新打包`), {
        code: 'REMOTE_GATEWAY_PACK_INCOMPLETE',
        detail: localCheck.missing.join(', ')
      });
    }
    // 内容 hash 对「最终注入目录」现场计算（lite 直用 / 缓存装配统一覆盖），
    // 跳过判定与写标记共用这一份，保证两处口径一致
    const contentHash = await computePackContentHash(packRoot);

    const home = await getRemoteHome(sshManager);
    const remoteBase = `${home}/${REMOTE_HOME_DIR}/${version}`;
    const remoteCurrent = `${home}/${REMOTE_HOME_DIR}/current`;
    const remoteMarker = `${remoteBase}/${REMOTE_PACK_MARKER_REL}`;
    const remoteArchive = `${remoteBase}/pack.tar.gz`;

    let needUpload = opts.force === true;
    if (!needUpload) {
      const st = await remoteMarkerState(sshManager, remoteMarker);
      needUpload = !(st.remoteVersion === version && st.remoteHash === contentHash);
      if (!needUpload) {
        log(`远程 Agent ${version} 已就绪（内容 ${contentHash.slice(0, 8)}）`);
      } else {
        const hint = st.remoteVersion
          ? st.remoteHash !== contentHash
            ? `内容已变化 ${st.remoteHash.slice(0, 8) || '(空)'}→${contentHash.slice(0, 8)}`
            : `版本 ${st.remoteVersion}≠${version}`
          : '首次注入';
        log(`远程 Agent 需重新注入（${hint}，整包约含 Node ${manifest.nodeVersion || '?'}）`);
      }
    }

    if (needUpload) {
      await assertRemoteDeployTools(sshManager);
      await sshManager.execScript(
        `rm -rf ${shellQuoteSingle(remoteBase)} && mkdir -p ${shellQuoteSingle(remoteBase)}`,
        20000
      );

      // 本地打包：单归档，进度口径为已送入压缩的未压缩字节
      emit({ phase: 'prepare', percent: 2, message: '正在打包…' });
      const tmpArchive = path.join(require('os').tmpdir(), `dieyun-agent-pack-${Date.now()}.tar.gz`);
      let built;
      try {
        built = await buildPackTarGz(packRoot, tmpArchive, {
          onBytes: (fed, total) =>
            emit({
              phase: 'prepare',
              percent: 2 + Math.min(2, Math.round((fed / Math.max(1, total)) * 2)),
              message: `正在打包 ${mb(fed)}/${mb(total)} MB`
            })
        });

        // 上传：一次 fastPut，字节级进度（ssh2 step 回调）
        emit({
          phase: 'upload',
          percent: 5,
          message: `0/${mb(built.sizeBytes)} MB`,
          file: 'pack.tar.gz',
          current: 0,
          total: built.sizeBytes
        });
        const sftp = sshManager.getSftp();
        log(`正在注入远程 Agent ${version}（含 Node ${manifest.nodeVersion || ''}，压缩后 ${mb(built.sizeBytes)}MB）…`);
        await new Promise((resolve, reject) => {
          sftp.fastPut(
            tmpArchive,
            remoteArchive,
            {
              step: (transferred, _chunk, total) => {
                emit({
                  phase: 'upload',
                  percent: 5 + Math.round((transferred / Math.max(1, total)) * 75),
                  message: `${mb(transferred)}/${mb(total)} MB`,
                  file: 'pack.tar.gz',
                  current: transferred,
                  total
                });
              }
            },
            (err) => (err ? reject(err) : resolve())
          );
        }).catch((e) => {
          throw Object.assign(new Error(`远程 Agent 上传失败 (pack.tar.gz): ${e && e.message ? e.message : e}`), {
            code: 'REMOTE_GATEWAY_UPLOAD_FAILED'
          });
        });

        // 传输校验：远端 sha256sum 与本地构建摘要比对
        emit({ phase: 'verify', percent: 82, message: '校验 sha256…' });
        const hashR = await sshManager.execScript(
          `A=$(sha256sum ${shellQuoteSingle(remoteArchive)} 2>/dev/null | cut -d' ' -f1); echo "HASH=$A"`,
          20000
        );
        const remoteSha = (String(hashR.stdout || '').match(/^HASH=([0-9a-f]{64})$/m) || [])[1] || '';
        if (remoteSha !== built.sha256) {
          throw Object.assign(
            new Error(`远程 Agent 上传后校验失败（sha256 ${remoteSha || '(空)'}≠${built.sha256}）`),
            { code: 'REMOTE_GATEWAY_DEPLOY_VERIFY_FAILED' }
          );
        }

        // 解压（-p 保留执行位）+ 清理归档 + 必需文件缺项检查（清单单一来源）
        emit({ phase: 'extract', percent: 84, message: '解压…' });
        const dirQ = shellQuoteSingle(remoteBase);
        const extractCmd = [
          'set -e',
          `DIR=${dirQ}`,
          `tar -xzpf ${shellQuoteSingle(remoteArchive)} -C "$DIR"`,
          `rm -f ${shellQuoteSingle(remoteArchive)}`,
          ...remoteMissingCheckLines('"$DIR"', REMOTE_DEPLOY_REQUIRED_FILES),
          'if test -n "$MISSING"; then exit 1; fi',
          `echo ${REMOTE_PACK_OK_MARKER}`
        ].join('\n');
        const extractR = await sshManager.execScript(extractCmd, 120000);
        const extractCheck = evaluateRemotePackPreflight(extractR.stdout, extractR.code);
        if (!extractCheck.ok) {
          throw Object.assign(
            new Error(
              `远程 Agent 解压后缺项${extractCheck.missing.length ? `：${extractCheck.missing.join(', ')}` : ''}`
            ),
            {
              code: 'REMOTE_GATEWAY_PACK_INCOMPLETE',
              detail: [String(extractR.stdout || ''), String(extractR.stderr || '')]
                .filter(Boolean)
                .join('\n')
                .slice(0, 800)
            }
          );
        }

        // 写就绪标记：跳过判定的唯一依据
        await sshManager.execScript(
          `printf 'VERSION=%s\nCONTENT_HASH=%s\n' ${shellQuoteSingle(version)} ${shellQuoteSingle(
            contentHash
          )} > ${shellQuoteSingle(remoteMarker)}`,
          8000
        );
        log('远程 Agent 整包上传并解压完成');
      } finally {
        try {
          fs.unlinkSync(tmpArchive);
        } catch {
          // ignore
        }
      }
    } else {
      emit({ phase: 'upload', percent: 82, message: '已存在，跳过上传' });
    }

    emit({ phase: 'link', percent: 86, message: '创建链接…' });
    // set -e：任意一步失败即退出，退出码才能被下面检测到
    // （原来整条 && 链结尾的 `|| true` 会把 mkdir/ln 的失败一起吞掉）。
    // chmod 不再需要：tar 头里的 mode 白名单（remotePackTarMode）+ tar -p 已保留执行位。
    const linkCmd = [
      'set -e',
      `mkdir -p ${shellQuoteSingle(`${home}/${REMOTE_HOME_DIR}`)}`,
      `rm -rf ${shellQuoteSingle(remoteCurrent)}`,
      `ln -sfn ${shellQuoteSingle(remoteBase)} ${shellQuoteSingle(remoteCurrent)}`
    ].join('\n');
    // current 链接是后续 preflight / 启动的前置条件，失败必须显式报错
    const linked = await sshManager.execScript(linkCmd, 15000);
    if (linked.code !== 0) {
      throw Object.assign(new Error('远程 Agent 安装目录链接失败（~/.dieyun/remote-agent/current）'), {
        code: 'REMOTE_GATEWAY_LINK_FAILED',
        detail: [String(linked.stdout || '').trim(), String(linked.stderr || '').trim()]
          .filter(Boolean)
          .join('\n')
          .slice(0, 500)
      });
    }
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

  async function readRemoteGatewayLog(sshManager, logPath, lines = 40) {
    if (!logPath) return '(无 agent.log)';
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
    // 每个项目一份日志：避免同机器两个 workspace 混写同一个文件（见 remoteLogDir 注释）
    const logDir = remoteLogDir(home);
    const logPath = remoteLogPathFor(home, workspaceRoot);
    const logQ = shellQuoteSingle(logPath);

    // 检查项与缺项诊断都来自 remote-pack-layout（与打包 / 部署包装配同一份清单），
    // 失败时必须报出到底缺什么，否则只剩一句「安装包不完整」无法定位。
    // 成功标记单独一行，判定走 evaluateRemotePackPreflight（脚本必然还会打印 MISSING= 行）。
    const preflight = await sshManager.execScript(
      [
        `DIR=${dirQ}`,
        `if test ! -d "$DIR" && test ! -L "$DIR"; then echo "DIR_MISSING"; exit 1; fi`,
        ...remoteMissingCheckLines('"$DIR"', REMOTE_DEPLOY_REQUIRED_FILES),
        'if test -n "$MISSING"; then ls -la "$DIR" 2>&1 | head -n 40; exit 1; fi',
        `echo ${REMOTE_PACK_OK_MARKER}`
      ].join('\n'),
      8000
    );
    const preflightResult = evaluateRemotePackPreflight(preflight.stdout, preflight.code);
    if (!preflightResult.ok) {
      const hint = preflightResult.missing.length ? `，缺少 ${preflightResult.missing.join(', ')}` : '';
      const detail = [preflightResult.detail, String(preflight.stderr || '').trim()]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1200);
      throw Object.assign(new Error(`远程 Agent 安装包不完整${hint}`), {
        code: 'REMOTE_GATEWAY_PACK_INCOMPLETE',
        detail
      });
    }

    const smoke = await sshManager.execScript(
      [
        `cd ${dirQ}`,
        `${nodeQ} -e ${shellQuoteSingle("require('./remote/minimal-gateway-host'); console.log('SMOKE_OK')")}`
      ].join('\n'),
      20000
    );
    const smokeOut = String(smoke.stdout || '').trim();
    if (!smokeOut.includes('SMOKE_OK')) {
      const logTail = await readRemoteGatewayLog(sshManager, logPath);
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
      `mkdir -p ${shellQuoteSingle(logDir)}`,
      'sleep 0.5',
      // token 走 env：argv 里的 --token 会被同机其他用户从 ps 里读到
      `DIEYUN_REMOTE_TOKEN=${tokQ} nohup ${nodeQ} ${shellQuoteSingle(`${currentDir}/remote/run-cli.js`)} --workspace ${wsQ} --port ${remotePort} >> ${logQ} 2>&1 &`,
      `echo $! > ${agentPidFile}`,
      'sleep 2',
      `PID=$(cat ${agentPidFile} 2>/dev/null || true)`,
      `if kill -0 "$PID" 2>/dev/null; then echo "$PID"; else echo START_FAILED; tail -n 30 ${logQ} 2>/dev/null || true; fi`
    ].join('\n');

    const r = await sshManager.execScript(startCmd, 30000);
    const out = String(r.stdout || '').trim();
    const outLines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pidLine = outLines.find((l) => /^\d+$/.test(l));
    const pid = pidLine || outLines[0];

    if (!pid || pid === 'START_FAILED' || !/^\d+$/.test(pid)) {
      const logTail = await readRemoteGatewayLog(sshManager, logPath);
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
    activeLogRel = remoteLogDisplayPath(workspaceRoot);
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
      remoteLogPath: activeLogRel || remoteLogDisplayPath(remoteWorkspace || '/')
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

module.exports = {
  createRemoteGatewayManager,
  // 日志路径的单一来源（IPC / 单测都走这里，别再各自拼 `current/agent.log`）
  remoteLogDir,
  remoteLogFileName,
  remoteLogPathFor,
  remoteLogDisplayPath
};
