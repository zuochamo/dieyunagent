'use strict';

const fs = require('fs');
const path = require('path');
const { shellQuoteSingle } = require('./remote-path');
const { endpointScopeOf, withEndpointDeployLock } = require('./deploy-lock');
const {
  REMOTE_PACK_REQUIRED_FILES,
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
 * 远程 Agent 日志**按项目 + 按实例**分开（2026-10-23 按项目，2026-10-28 加端口）。
 *
 * 原来所有 remotePath 共用 `~/.dieyun/remote-agent/current/agent.log`：同一台机器跑两个项目时
 * 两个进程 `>>` 追加同一个文件，日志交错混写，排查时根本分不清哪行属于哪个 workspace；
 * 而 `current` 是随版本切换的软链，日志还会跟着安装目录一起被替换掉。
 *
 * 现在落在 `~/.dieyun/remote-agent/logs/agent-<路径slug>-<hash8>-<port>.log`：
 * - slug 给人看（`srv_projA`），hash8 定位到项目，port 区分**同一项目的多个实例**；
 * - 只按项目哈希是不够的：多 agent 并行 / 客户端重连后旧实例未死时，两个实例会追加同一个
 *   文件，日志里端口交替出现，看起来像「单实例反复重启」——这正是 2026-10-28 那次误判的来源；
 * - 端口不做成可选参数：漏传就静默退回「按项目」= 悄悄丢隔离，比名字难看坏得多；
 * - 目录在版本目录之外，升级安装包不会丢日志。
 */
function remoteLogDir(home) {
  return `${home}/${REMOTE_HOME_DIR}/${REMOTE_LOG_DIR}`;
}

/** 每主机只有一份日志：daemon 只有一个进程，日志再分文件就是人为制造「到底看哪一份」的成本。 */
function remoteLogPathFor(home) {
  return `${remoteLogDir(home)}/agent.log`;
}

/** 展示用的 `~/...` 形式（getStatus / UI 只读这个，不再假设 current 目录）。 */
function remoteLogDisplayPath() {
  return `~/${REMOTE_HOME_DIR}/${REMOTE_LOG_DIR}/agent.log`;
}

/** 远端运行目录：socket 落在这里（目录 0700 + socket 0600 = 只有同一个 uid 能连）。 */
function remoteRunDir(home) {
  return `${home}/${REMOTE_HOME_DIR}/run`;
}

function remoteSocketPathFor(home) {
  return `${remoteRunDir(home)}/agent.sock`;
}

/**
 * 收「占库的孤儿 core」的远端脚本（`dbQ` 必须是已 shell 引用的路径）。
 *
 * 正常路径不会用到：daemon 收到 SIGTERM 会自己 dispose 每个 workspace 的 handlers。
 * 只有被 SIGKILL（来不及 dispose）时才可能留下 ppid=1 的 core 继续占着 index.sqlite，
 * 下一次 codebase.status 永远 busy —— 所以这一份兜底只服务「强杀之后」这一个场景。
 * 反过来，ppid>1 的 core 有活着的父进程在管，杀了就是互杀。
 */
function buildStaleCoreCleanupScript(dbQ) {
  return [
    `DB=${dbQ}`,
    'if test -e "$DB" && test -d /proc; then',
    '  for pid in $( (fuser "$DB" 2>/dev/null; if command -v lsof >/dev/null 2>&1; then lsof -ti "$DB" 2>/dev/null; fi) | tr -s " " "\\n"); do',
    '    if test "$pid" = "$$"; then continue; fi',
    '    cmd=$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null) || continue',
    '    case "$cmd" in *dieyun-core*) ;; *) continue ;; esac',
    '    ppid=$(sed "s/.*) //" "/proc/$pid/stat" 2>/dev/null | awk \'{print $2}\')',
    '    if test "$ppid" = "1"; then kill "$pid" 2>/dev/null || true; fi',
    '  done',
    'fi',
    'sleep 0.3'
  ].join('\n');
}

/**
 * 活体探测（socket 版）：从**已有的 SSH 连接**上开一条 direct-streamlocal 通道去连 socket。
 * 能开出来就说明「SSH 活着 + 远端 daemon 正在监听」——不再有本地端口要探，
 * 也不再需要「`active` 布尔 + 端口 + token」三件套来判断可复用性。
 * @param {any} sshManager
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 */
function probeAgentSocket(sshManager, socketPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let client = null;
    try {
      client = sshManager && typeof sshManager.getClient === 'function' ? sshManager.getClient() : null;
    } catch {
      client = null;
    }
    if (!client || typeof client.openssh_forwardOutStreamLocal !== 'function') {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok, stream) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream) {
        try {
          stream.destroy();
        } catch {
          // ignore
        }
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      client.openssh_forwardOutStreamLocal(socketPath, (err, stream) => done(!err, stream));
    } catch {
      done(false);
    }
  });
}

/**
 * 读远端 `.pack-ok` 标记（版本 + 内容 hash）。
 *
 * 读不到标记只有两种正当结论：
 *   a) 标记确实不存在（脚本尾巴 `|| true`，退出码 0 且 stdout 为空）→ 首次注入；
 *   b) 传输/连接失败（超时、通道断开）→ **必须抛错**。
 * 以前把 (b) 也当成「首次注入」，于是网络抖一下就会把装好的目录 `rm -rf` 再重传整包
 * （几十 MB + 内置 Node），而且对象是一个完全健康的安装。
 *
 * @param {{ execScript: (script: string, timeoutMs?: number) => Promise<{code?: number, stdout?: string, stderr?: string}> }} sshManager
 * @param {string} remoteMarker
 * @returns {Promise<{ remoteVersion: string, remoteHash: string }>}
 */
async function readRemoteMarkerState(sshManager, remoteMarker) {
  let r;
  try {
    r = await sshManager.execScript(`cat ${shellQuoteSingle(remoteMarker)} 2>/dev/null || true`, 8000);
  } catch (e) {
    throw Object.assign(
      new Error(
        `无法读取远端 Agent 就绪标记（${(e && e.message) || e}）：为避免把已安装的目录误判成` +
          '「首次注入」而重传整包，这里直接失败。请确认 SSH 连接正常后重试。'
      ),
      { code: 'REMOTE_GATEWAY_MARKER_UNREADABLE', retryable: true, cause: e }
    );
  }
  const st = parseRemotePackMarker(String(r.stdout || ''));
  return { remoteVersion: st.version, remoteHash: st.contentHash };
}

/**
 * @param {{ log?: (msg: string) => void }} opts
 */
function createRemoteGatewayManager(opts = {}) {
  const log = opts.log || (() => {});
  let remoteWorkspace = '';
  /** 当前生效的远端 socket 绝对路径；空字符串表示还没有可用 daemon */
  let socketPath = '';
  /** 当前槽位的远程日志（`~/...` 展示形式），每主机一份 */
  let activeLogRel = '';
  let active = false;
  /** 在途部署 Promise；null 表示空闲 */
  let deploying = null;
  /** 在途部署的「意图」标识（workspace|port|force），只用于合并同一个意图的并发调用 */
  let deployingKey = '';
  /**
   * 连接意图的世代号。每次 ensure 或 stop 都 +1。
   *
   * 部署里有十几个 await（上传、起进程、等端口、建隧道），任何一个回来时用户可能已经
   * 切换了工作区或断开连接。回来发现世代号变了就**丢弃这次结果**，并且由它自己回收
   * 已经起出来的进程/隧道 —— 这是「stop 期间照旧部署」和「旧结果覆盖新状态」两个洞的共用闸门。
   */
  let epoch = 0;
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

  /** 清空「当前生效」的全部状态（不留半真半假的 socketPath） */
  function markInactive() {
    socketPath = '';
    remoteWorkspace = '';
    runtimeSource = '';
    activeLogRel = '';
    active = false;
  }

  function supersededError() {
    return Object.assign(new Error('远端 Agent 部署已被新的连接意图取代'), {
      code: 'REMOTE_GATEWAY_SUPERSEDED'
    });
  }

  /**
   * 复用的前置条件：SSH 还连着，且**从这条 SSH 连接**能开出一条到远端 socket 的通道。
   * 这是唯一可信的活体证据 —— `active` 布尔在 daemon 被杀之后仍然是 true。
   */
  async function isAliveNow() {
    if (!active || !socketPath) return false;
    try {
      if (lastSshManager && !lastSshManager.status().connected) return false;
    } catch {
      return false;
    }
    return probeAgentSocket(lastSshManager, socketPath);
  }

  async function stop(sshManager, opts = {}) {
    const killRemote = opts.killRemote !== false;
    const sm = sshManager || lastSshManager;
    // 先作废在途部署：它们各自的 catch 会杀掉自己起的 daemon
    epoch += 1;
    const sock = socketPath;
    const ws = remoteWorkspace;
    markInactive();
    if (killRemote && sm && sock) {
      try {
        if (sm.status().connected) {
          await stopAgentDaemon(sm, sock, ws);
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * 给 `RemoteAgentClient` 的信息：不再有 url/token，改为「怎么开一条到 socket 的通道」。
   * `openChannel` 每次调用都重新取当前 SSH client —— 断线重连后 client 是新对象，
   * 闭包里若捕获旧 client，重连后所有 RPC 都会拿一个已销毁的连接。
   */
  function getInfo() {
    if (!active || !socketPath) return null;
    const activeSocket = socketPath;
    return {
      // key 必须带上 workspace：同一个 socket 上「一条连接 = 一个 workspace」，
      // 只按 socket 做缓存会把 B 的连接复用成 A 的（实测症状：B 的 cwd 被判 PATH_NOT_ALLOWED）。
      key: `${activeSocket}#${remoteWorkspace}`,
      socketPath: activeSocket,
      openChannel: () => openAgentChannel(activeSocket),
      remoteGateway: true,
      remoteAgent: true,
      workspaceRoot: remoteWorkspace,
      runtimeSource
    };
  }

  /**
   * 打开一条 direct-streamlocal 通道到远端 daemon（`direct-streamlocal@openssh.com`）。
   * 远端不需要 TCP 端口，本地也不需要隧道。
   * @param {string} activeSocket
   */
  function openAgentChannel(activeSocket) {
    return new Promise((resolve, reject) => {
      let client = null;
      try {
        client = lastSshManager && typeof lastSshManager.getClient === 'function' ? lastSshManager.getClient() : null;
      } catch {
        client = null;
      }
      if (!client || typeof client.openssh_forwardOutStreamLocal !== 'function') {
        reject(Object.assign(new Error('SSH 会话未就绪，无法连接远端 Agent'), { code: 'SSH_NOT_CONNECTED' }));
        return;
      }
      try {
        client.openssh_forwardOutStreamLocal(activeSocket, (err, stream) => {
          if (err) {
            reject(
              Object.assign(new Error(`远端 Agent 通道打不开（${activeSocket}）：${err.message || err}`), {
                code: 'REMOTE_AGENT_CHANNEL_FAILED',
                retryable: true
              })
            );
            return;
          }
          resolve(stream);
        });
      } catch (err) {
        reject(
          Object.assign(new Error(`远端 Agent 通道异常：${(err && err.message) || err}`), {
            code: 'REMOTE_AGENT_CHANNEL_FAILED',
            retryable: true
          })
        );
      }
    });
  }

  function isActive() {
    return active;
  }

  function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
  }

  /**
   * 远端 HOME：同一连接内不会变，按 sshManager 缓存一次（连上就带出）。
   * 一次 ensure 里这条路径原本要问 2~4 次，每次都是一趟 SSH 往返。
   */
  const remoteHomeCache = new WeakMap();

  async function getRemoteHome(sshManager) {
    const cached = remoteHomeCache.get(sshManager);
    if (cached) return cached;
    const pending = (async () => {
      const r = await sshManager.exec('echo $HOME', null, 5000, { loginShell: false });
      const home = String(r.stdout || '').trim();
      if (!home) throw Object.assign(new Error('无法解析远程 HOME 目录'), { code: 'REMOTE_HOME_UNKNOWN' });
      return home;
    })();
    remoteHomeCache.set(sshManager, pending);
    try {
      return await pending;
    } catch (e) {
      // 失败的结论不缓存：换一次探测（重连后）仍要能重新解析
      remoteHomeCache.delete(sshManager);
      throw e;
    }
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
   *
   * 读不到标记只有两种正当结论：
   *   a) 标记确实不存在（脚本 `|| true`，退出码 0、stdout 为空）→ 首次注入；
   *   b) 传输/连接失败（超时、通道断开）→ **必须抛错**（见模块级 remoteMarkerState）。
   *
   * @returns {Promise<{ remoteVersion: string, remoteHash: string }>}
   */
  function remoteMarkerState(sshManager, remoteMarker) {
    return readRemoteMarkerState(sshManager, remoteMarker);
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
    // 内容 hash 对「最终注入目录」现场计算（安装包里的 pack 就是最终内容），
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
      // 清目录必须成功：失败还继续上传，解压会落在残留的旧文件上，出一个「半新半旧」的安装
      const cleared = await sshManager.execScript(
        `set -e\nrm -rf ${shellQuoteSingle(remoteBase)}\nmkdir -p ${shellQuoteSingle(remoteBase)}`,
        20000
      );
      if (cleared.code !== 0) {
        throw Object.assign(new Error('远程 Agent 安装目录清理失败（~/.dieyun/remote-agent/<版本>）'), {
          code: 'REMOTE_GATEWAY_CLEANUP_FAILED',
          detail: [String(cleared.stdout || '').trim(), String(cleared.stderr || '').trim()]
            .filter(Boolean)
            .join('\n')
            .slice(0, 500)
        });
      }

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
          ...remoteMissingCheckLines('"$DIR"', REMOTE_PACK_REQUIRED_FILES),
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

        // 写就绪标记：跳过判定的唯一依据。写不进去就等于「下次还得重传整包」，
        // 必须当场失败，别让这次看起来成功、下次白传 100MB。
        const markerR = await sshManager.execScript(
          `printf 'VERSION=%s\nCONTENT_HASH=%s\n' ${shellQuoteSingle(version)} ${shellQuoteSingle(
            contentHash
          )} > ${shellQuoteSingle(remoteMarker)}`,
          8000
        );
        if (markerR.code !== 0) {
          throw Object.assign(new Error('远程 Agent 就绪标记写入失败（.pack-ok）'), {
            code: 'REMOTE_GATEWAY_MARKER_WRITE_FAILED',
            detail: [String(markerR.stdout || '').trim(), String(markerR.stderr || '').trim()]
              .filter(Boolean)
              .join('\n')
              .slice(0, 500)
          });
        }
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
    // uploaded 决定「已经在跑的 daemon 还能不能复用」：注入过新内容就必须重启，
    // 否则进程里跑的还是旧代码（新 RPC 方法/字段对不上，表现为莫名其妙的 unsupported method）。
    return { uploaded: needUpload === true };
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

  /**
   * 收掉这台主机上的 daemon。
   *
   * 只按「命令行里带 `--socket <这个 socket>`」精确匹配，不再有 pid 文件、不再 fuser/lsof 收尸：
   * daemon 收到 SIGTERM 会自己 `stop()`（逐个 dispose 每个 workspace 的 handlers，
   * 索引 core 跟着收），因此不需要外部兜「孤儿 core 占库」。等不到退出再 SIGKILL。
   */
  async function stopAgentDaemon(sshManager, activeSocket, workspaceRoot) {
    const sockQ = shellQuoteSingle(activeSocket);
    try {
      await sshManager.execScript(
        [
          `PAT=${sockQ}`,
          'if command -v pgrep >/dev/null 2>&1; then',
          '  for pid in $(pgrep -f -- "--socket $PAT" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done',
          'else',
          '  for pid in $(ps -eo pid=,args= 2>/dev/null | grep -F -- "--socket $PAT" | grep -v grep | awk \'{print $1}\'); do kill "$pid" 2>/dev/null || true; done',
          'fi',
          'for i in 1 2 3 4 5 6 7 8 9 10; do',
          '  test -e "$PAT" || break',
          '  sleep 0.2',
          'done',
          'if command -v pgrep >/dev/null 2>&1; then',
          '  for pid in $(pgrep -f -- "--socket $PAT" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done',
          'fi',
          'rm -f "$PAT" 2>/dev/null || true'
        ].join('\n'),
        12000
      );
    } catch {
      // ignore — 连接已断或安装目录不存在
    }
    const ws = String(workspaceRoot || '').trim();
    if (ws) {
      // daemon 被 SIGKILL 时它来不及 dispose，core 可能变孤儿：只在「socket 已经没了」时兜一次
      const dbQ = shellQuoteSingle(`${ws.replace(/\/+$/, '')}/.dieyun/index.sqlite`);
      try {
        await sshManager.execScript(buildStaleCoreCleanupScript(dbQ), 8000);
      } catch {
        // best effort
      }
    }
  }

  async function startAgentDaemon(sshManager, workspaceRoot, nodeRuntime) {
    const home = await getRemoteHome(sshManager);
    const currentDir = `${home}/${REMOTE_HOME_DIR}/current`;
    const wsQ = shellQuoteSingle(workspaceRoot);
    const nodeBin = nodeRuntime.nodeBin || `${currentDir}/bin/node`;
    const nodeQ = shellQuoteSingle(nodeBin);
    const dirQ = shellQuoteSingle(currentDir);
    // 每主机一份日志：daemon 只有一个进程（见 remoteLogDir 注释）
    const logDir = remoteLogDir(home);
    const logPath = remoteLogPathFor(home);
    const logQ = shellQuoteSingle(logPath);
    const runDir = remoteRunDir(home);
    const sockPath = remoteSocketPathFor(home);
    const sockQ = shellQuoteSingle(sockPath);
    const runQ = shellQuoteSingle(runDir);

    // 检查项与缺项诊断都来自 remote-pack-layout（与打包 / 部署包装配同一份清单），
    // 失败时必须报出到底缺什么，否则只剩一句「安装包不完整」无法定位。
    // 成功标记单独一行，判定走 evaluateRemotePackPreflight（脚本必然还会打印 MISSING= 行）。
    const preflight = await sshManager.execScript(
      [
        `DIR=${dirQ}`,
        `if test ! -d "$DIR" && test ! -L "$DIR"; then echo "DIR_MISSING"; exit 1; fi`,
        ...remoteMissingCheckLines('"$DIR"', REMOTE_PACK_REQUIRED_FILES),
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

    // 启动脚本必须用**绝对 node 路径**：远端非登录 bash 的 PATH 里没有 ~/.local/bin、~/.cargo/bin、
    // nvm 路径（真机实测 `command -v node` 直接 MISSING），靠 PATH 找 node 在这类机器上必然起不来。
    const startCmd = [
      `cd ${dirQ} || exit 1`,
      `mkdir -p ${runQ}`,
      `chmod 700 ${runQ}`,
      `mkdir -p ${shellQuoteSingle(logDir)}`,
      // setsid + 无 stdin：daemon 不跟着 SSH channel 一起死；输出进日志
      `setsid ${nodeQ} ${shellQuoteSingle(`${currentDir}/remote/run-cli.js`)} --socket ${sockQ} --workspace ${wsQ} >> ${logQ} 2>&1 < /dev/null &`,
      'echo STARTED'
    ].join('\n');

    const r = await sshManager.execScript(startCmd, 30000);
    const out = String(r.stdout || '').trim();
    if (!out.includes('STARTED')) {
      const logTail = await readRemoteGatewayLog(sshManager, logPath);
      throw Object.assign(new Error('远程 Agent 启动命令失败'), {
        code: 'REMOTE_GATEWAY_START_FAILED',
        detail: [out, String(r.stderr || '').trim(), logTail].filter(Boolean).join('\n---\n').slice(0, 2000)
      });
    }
    await waitAgentSocket(sshManager, sockPath);
    const pid = await readAgentPid(sshManager, sockPath);
    log(`远程 Agent 已就绪 socket=${sockPath}${pid ? ` pid=${pid}` : ''} runtime=${nodeRuntime.source || 'unknown'}`);
    activeLogRel = remoteLogDisplayPath();
    return sockPath;
  }

  /** daemon 的 pid：从「谁在用这个 socket」反查，不落 pid 文件 */
  async function readAgentPid(sshManager, activeSocket) {
    try {
      const r = await sshManager.execScript(
        `if command -v pgrep >/dev/null 2>&1; then pgrep -f -- "--socket ${shellQuoteSingle(activeSocket)}" 2>/dev/null | head -n 1; fi`,
        6000
      );
      const pid = String(r.stdout || '').trim();
      return /^\d+$/.test(pid) ? pid : '';
    } catch {
      return '';
    }
  }

  /**
   * 等 socket 可连。判据是「从这条 SSH 连接能开出 direct-streamlocal 通道」，
   * 不再轮询 `ss -ltn` 找端口。
   */
  async function waitAgentSocket(sshManager, activeSocket, attempts = 24) {
    for (let i = 0; i < attempts; i++) {
      if (await probeAgentSocket(sshManager, activeSocket, 1500)) return;
      await new Promise((res) => setTimeout(res, 250));
    }
    const logTail = await readRemoteGatewayLog(sshManager, remoteLogPathFor(await getRemoteHome(sshManager)));
    throw Object.assign(new Error('远程 Agent socket 未就绪'), {
      code: 'REMOTE_GATEWAY_SOCKET_TIMEOUT',
      detail: logTail.slice(0, 2000)
    });
  }

  async function ensureRemoteGateway(ctx) {
    const emit = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
    const workspaceRemotePath = String(ctx.workspaceRemotePath || '/').trim() || '/';
    const intent = workspaceRemotePath;

    if (deploying) {
      // 同一个意图（同一 workspace、同一端口）就共享这次部署；换了意图则等它收尾再判断
      if (deployingKey === intent) return deploying;
      try {
        await deploying;
      } catch {
        // 上一轮失败不影响本次重新判断
      }
    }

    if (active && remoteWorkspace === workspaceRemotePath) {
      // 幂等快速路径必须带活体探测：`active` 只是个布尔，daemon 被杀后它还是 true
      if (await isAliveNow()) {
        lastOkAt = Date.now();
        return getInfo();
      }
      log('远端 Agent 无响应（socket 连不上），重建…');
      emit({ phase: 'prepare', percent: 1, message: '远端无响应，重建…' });
      await stop(null, { killRemote: true });
    }

    const myEpoch = ++epoch;
    const assertFresh = () => {
      if (myEpoch !== epoch) throw supersededError();
    };

    const run = (async () => {
      const sshManager = ctx.sshManager;
      lastSshManager = sshManager;
      const packRoot = ctx.packRoot;
      const version = String(ctx.appVersion || 'dev');
      /** 我们自己起过 daemon：失败或作废时必须回收，否则它留着索引库与 workspace 状态 */
      let startedRemote = false;
      let mySocket = '';
      try {
        emit({ phase: 'prepare', percent: 1, message: '准备注入…' });
        sshManager.assertConnected();
        assertFresh();
        let deployed = await deployPack(sshManager, packRoot, version, { onProgress: emit });
        assertFresh();
        emit({ phase: 'runtime', percent: 88, message: '检测 Node…' });
        let nodeRuntime;
        try {
          nodeRuntime = await resolveNodeRuntime(sshManager, packRoot);
        } catch (firstErr) {
          if (firstErr && firstErr.code === 'REMOTE_RUNTIME_FAILED') {
            log('内置 Node 校验失败，强制重新注入…');
            emit({ phase: 'upload', percent: 10, message: '重新注入…' });
            deployed = await deployPack(sshManager, packRoot, version, { onProgress: emit, force: true });
            emit({ phase: 'runtime', percent: 88, message: '检测 Node…' });
            nodeRuntime = await resolveNodeRuntime(sshManager, packRoot);
          } else {
            throw firstErr;
          }
        }
        runtimeSource = nodeRuntime.source || '';
        assertFresh();

        emit({ phase: 'start', percent: 92, message: '连接 Agent…' });
        const home = await getRemoteHome(sshManager);
        const sockPath = remoteSocketPathFor(home);
        mySocket = sockPath;
        const alive = await probeAgentSocket(sshManager, sockPath, 2000);
        assertFresh();
        if (alive && deployed.uploaded) {
          // 刚注入了新内容：还在跑的那个进程用的是**旧代码**（拉起的代码在进程启动时就固定了）。
          // 复用它会得到一个「部署成功但行为还是老版本」的假象，必须换新的。
          log('远端 Agent 已更新内容，重启 daemon 以加载新代码');
          await stopAgentDaemon(sshManager, sockPath, workspaceRemotePath);
          assertFresh();
          emit({ phase: 'start', percent: 94, message: '重启 Agent…' });
          await startAgentDaemon(sshManager, workspaceRemotePath, nodeRuntime);
          startedRemote = true;
          assertFresh();
        } else if (alive) {
          log(`复用已在运行的远端 Agent socket=${sockPath}`);
        } else {
          // 已有 daemon 但 socket 连不上 = 陈旧文件或旧版本残留：先收干净再起。
          // 清理要带 workspace：daemon 被 SIGKILL 后 core 可能变孤儿，占着索引库，
          // 不带 workspace 就跳过这段清理（下次启动撞 busy 锁）。
          await stopAgentDaemon(sshManager, sockPath, workspaceRemotePath);
          assertFresh();
          emit({ phase: 'start', percent: 94, message: '启动 Agent…' });
          await startAgentDaemon(sshManager, workspaceRemotePath, nodeRuntime);
          startedRemote = true;
          assertFresh();
        }

        // ---- 提交点：到 active=true 之间没有 await，中途不会被打断 ----
        socketPath = sockPath;
        remoteWorkspace = workspaceRemotePath;
        active = true;
        lastError = '';
        lastErrorCode = '';
        lastErrorAt = 0;
        lastOkAt = Date.now();
        log(`远端 Agent socket=${sockPath} via SSH direct-streamlocal (${runtimeSource})`);
        emit({ phase: 'done', percent: 100, message: '完成' });
        return getInfo();
      } catch (e) {
        if (startedRemote && mySocket) {
          // 起过 daemon 就一定要收：否则失败的这一次留下一个占库的孤儿进程
          try {
            await stopAgentDaemon(sshManager, mySocket, workspaceRemotePath);
          } catch {
            // ignore
          }
        }
        throw e;
      }
    })();

    const wrapped = run
      .catch((e) => {
        if (e && e.code === 'REMOTE_GATEWAY_SUPERSEDED') {
          log('远端 Agent 部署已取消（连接意图变化）');
          throw e;
        }
        const detail = e.detail ? String(e.detail) : '';
        lastError = detail ? `${e.message}\n${detail}`.slice(0, 800) : e.message || String(e);
        lastErrorCode = e.code || 'REMOTE_GATEWAY_FAILED';
        lastErrorAt = Date.now();
        // 这里**不能**把 active 置 false：这次部署失败不代表「当前生效的部署」失效 ——
        // socketPath/remoteWorkspace 可能属于另一个工作区，或者是上一次成功部署的结果。
        // 以前盲置 active=false，就会留下「active=false 但 socketPath 还在」的半真半假状态，
        // 一边让 getInfo() 返回 null（界面显示未连接），一边让 isAliveNow() 永远为 false。
        // 需要清状态只有两条路：stop()（用户主动断/切工作区）与下面这次部署自己的失败回滚。
        log(
          `Remote Agent 注入失败 [${lastErrorCode}]: ${e.message || e}${detail ? ` | ${detail.slice(0, 200)}` : ''}`
        );
        emit({ phase: 'error', percent: 0, message: '失败', hidden: true });
        throw e;
      })
      .finally(() => {
        if (deploying === wrapped) {
          deploying = null;
          deployingKey = '';
        }
      });

    deploying = wrapped;
    deployingKey = intent;
    return wrapped;
  }

  function getStatus() {
    return {
      active,
      deploying: !!deploying,
      // IPC 与界面都读这份：必须可 structured clone（见 wireInfo）
      info: wireInfo(getInfo()),
      workspaceRoot: remoteWorkspace || '',
      socketPath: socketPath || '',
      runtimeSource,
      lastError,
      lastErrorCode,
      lastErrorAt,
      lastOkAt,
      remoteLogPath: activeLogRel || remoteLogDisplayPath()
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

/**
 * `getInfo()` 的**可跨进程投影**：去掉 `openChannel`。
 *
 * `getInfo()` 是给进程内消费者（`RemoteAgentClient`）的「怎么开通道」，带函数；
 * 只要它原样进 IPC 返回值，整条 reply 就会抛
 * `Error: An object could not be cloned`（structured clone 不支持函数）——
 * `ssh:remote-gateway-status` / `ssh:auto-reconnect` 实测就挂在这里。
 * 所以「对外可见的远端状态」一律走这个投影，别把 `getInfo()` 直接塞进 IPC。
 *
 * @param {object | null} info
 * @returns {object | null}
 */
function wireInfo(info) {
  if (!info) return null;
  const { openChannel, ...rest } = info;
  return rest;
}

module.exports = {
  createRemoteGatewayManager,
  wireInfo,
  // 路径的单一来源（IPC / 单测都走这里，别再各自拼 `current/agent.log`）
  remoteLogDir,
  remoteLogPathFor,
  remoteLogDisplayPath,
  remoteRunDir,
  remoteSocketPathFor,
  probeAgentSocket,
  readRemoteMarkerState,
  buildStaleCoreCleanupScript
};
