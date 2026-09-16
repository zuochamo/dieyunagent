'use strict';

/**
 * 通过 SSH 在 Linux 服务器上编译 dieyun-core，并拉回 build/dieyun-core-linux/dieyun-core
 *
 * 用法：
 *   npm run pack:dieyun-core:linux:remote -- --ssh dieyunx@你的服务器
 *
 * 或配置 dieyun-linux-build.local.json（见 dieyun-linux-build.example.json）
 *
 * 环境变量：
 *   DIEYUN_LINUX_CORE_SSH   user@host
 *   DIEYUN_LINUX_CORE_PORT  22
 *   DIEYUN_LINUX_CORE_REMOTE_DIR  ~/.dieyun/remote-dieyun-core-build
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installLinuxCoreBin } = require('./pack-dieyun-core-linux-lib.cjs');

const ROOT = path.join(__dirname, '..');
const LOCAL_CONFIG = path.join(ROOT, 'dieyun-linux-build.local.json');
const DEFAULT_REMOTE_DIR = '~/.dieyun/remote-dieyun-core-build';
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const SSH_CONNECT_TIMEOUT_SEC = 60;

function sleep(ms) {
  const waitSec = Math.max(1, Math.ceil(ms / 1000));
  try {
    if (process.platform === 'win32') {
      spawnSync('ping', ['127.0.0.1', '-n', String(waitSec + 1), '-w', '1000'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      spawnSync('sleep', [String(waitSec)], { stdio: 'ignore' });
    }
  } catch {
    // ignore
  }
}

function readLocalConfig() {
  try {
    if (!fs.existsSync(LOCAL_CONFIG)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8')) || {};
  } catch (e) {
    console.warn('[dieyun-core-linux:remote] 读取本地配置失败:', e.message || e);
    return {};
  }
}

function parseArgs(argv) {
  const fileCfg = readLocalConfig();
  const opts = {
    ssh: String(process.env.DIEYUN_LINUX_CORE_SSH || fileCfg.ssh || '').trim(),
    port: Number(process.env.DIEYUN_LINUX_CORE_PORT || fileCfg.port || 22),
    remoteDir: String(
      process.env.DIEYUN_LINUX_CORE_REMOTE_DIR || fileCfg.remoteDir || DEFAULT_REMOTE_DIR
    ).trim(),
    identityFile: String(process.env.DIEYUN_LINUX_CORE_IDENTITY || fileCfg.identityFile || '').trim(),
    interactive: fileCfg.interactive === true,
    skipSync: false,
    skipBuild: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ssh' && argv[i + 1]) {
      opts.ssh = String(argv[++i]).trim();
    } else if (a === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]) || 22;
    } else if (a === '--remote-dir' && argv[i + 1]) {
      opts.remoteDir = String(argv[++i]).trim();
    } else if ((a === '--identity' || a === '-i') && argv[i + 1]) {
      opts.identityFile = String(argv[++i]).trim();
    } else if (a === '--interactive') {
      opts.interactive = true;
    } else if (a === '--skip-sync') {
      opts.skipSync = true;
    } else if (a === '--skip-build') {
      opts.skipBuild = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
用法: npm run pack:dieyun-core:linux:remote -- --ssh user@host [选项]

选项:
  --ssh <user@host>     SSH 目标（也可用 DIEYUN_LINUX_CORE_SSH）
  --port <n>            SSH 端口，默认 22
  --remote-dir <path>   远程编译目录，默认 ${DEFAULT_REMOTE_DIR}
  --identity, -i <path> 私钥路径（如 C:\\Users\\you\\.ssh\\id_ed25519）
  --interactive         允许密码登录（会多次提示密码：ssh/scp 各一次）
  --skip-sync           跳过上传源码（远程已有最新代码时）
  --skip-build          跳过编译，仅下载已有产物

也可复制 dieyun-linux-build.example.json 为 dieyun-linux-build.local.json 填写默认值。
若编译机 glibc 新于 Ubuntu 22.04（2.35），会自动用 cargo-zigbuild 链接到 DIEYUN_LINUX_GLIBC_TARGET（默认 2.35）。

认证: 推荐配置 SSH 公钥；密码登录请在配置里设 "interactive": true 或加 --interactive。
`);
}

function parseSshTarget(ssh) {
  const m = /^([^@/\s]+)@([^/\s:]+)$/.exec(String(ssh || '').trim());
  if (!m) return null;
  return { user: m[1], host: m[2] };
}

function sshTarget(opts) {
  const p = parseSshTarget(opts.ssh);
  if (!p) return null;
  return `${p.user}@${p.host}`;
}

function run(cmd, args, runOpts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: runOpts.stdio || 'inherit',
    encoding: runOpts.encoding,
    timeout: runOpts.timeoutMs,
    windowsHide: runOpts.windowsHide !== false
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const detail = r.stderr ? String(r.stderr).trim() : '';
    throw new Error(`${cmd} ${args.join(' ')} 失败 (code ${r.status})${detail ? `: ${detail}` : ''}`);
  }
  return r;
}

function isRetryableSshError(err) {
  const s = String((err && err.message) || err || '');
  return /ETIMEDOUT|timed out|Connection reset|Connection refused|No route to host|Network is unreachable/i.test(
    s
  );
}

function runWithRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableSshError(e) || i >= attempts - 1) throw e;
      console.warn(`[dieyun-core-linux:remote] ${label} 失败，${i + 2}/${attempts} 次重试…`);
      sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

function transportBaseArgs(opts, { portFlag }) {
  const args = [
    portFlag,
    String(opts.port),
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    'StrictHostKeyChecking=accept-new'
  ];
  if (!opts.interactive) {
    args.push('-o', 'BatchMode=yes');
  }
  if (opts.identityFile) {
    const id = path.resolve(opts.identityFile);
    if (!fs.existsSync(id)) {
      throw new Error(`私钥不存在: ${id}`);
    }
    args.push('-i', id, '-o', 'IdentitiesOnly=yes');
  }
  return args;
}

function sshBaseArgs(opts) {
  return transportBaseArgs(opts, { portFlag: '-p' });
}

function scpBaseArgs(opts) {
  return transportBaseArgs(opts, { portFlag: '-P' });
}

function sshRun(opts, remoteCmd, timeoutMs = BUILD_TIMEOUT_MS) {
  const target = sshTarget(opts);
  return runWithRetry('ssh', () =>
    run('ssh', [...sshBaseArgs(opts), target, remoteCmd], {
      timeoutMs,
      windowsHide: !opts.interactive
    })
  );
}

function sshRunCapture(opts, remoteCmd, timeoutMs = 120000) {
  const target = sshTarget(opts);
  return runWithRetry('ssh', () =>
    run('ssh', [...sshBaseArgs(opts), target, remoteCmd], {
      timeoutMs,
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: !opts.interactive
    })
  );
}

/** scp 不会展开远程 ~，需换成 $HOME 绝对路径 */
function expandRemoteDir(opts) {
  const dir = String(opts.remoteDir || '').trim();
  if (!dir || !dir.startsWith('~')) return dir.replace(/\\/g, '/');
  const r = sshRunCapture(opts, 'printf %s "$HOME"', 120000);
  const home = String(r.stdout || '').trim();
  if (!home) throw new Error('无法解析远程 HOME 目录');
  return dir.replace(/^~(?=\/|$)/, home).replace(/\\/g, '/');
}

function scpFromRemote(opts, remotePath, localPath) {
  const target = sshTarget(opts);
  run('scp', [...scpBaseArgs(opts), `${target}:${remotePath}`, localPath], {
    timeoutMs: 5 * 60 * 1000,
    windowsHide: !opts.interactive
  });
}

function scpToRemote(opts, localPath, remotePath) {
  const target = sshTarget(opts);
  run('scp', [...scpBaseArgs(opts), localPath, `${target}:${remotePath}`], {
    timeoutMs: 10 * 60 * 1000,
    windowsHide: !opts.interactive
  });
}

function ensureOpenSsh() {
  for (const cmd of ['ssh', 'scp']) {
    const r = spawnSync(cmd, ['-V'], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status === 127) {
      throw new Error(`未找到 ${cmd}，请安装 OpenSSH 客户端（Windows 可选功能或 Git for Windows）`);
    }
  }
}

async function uploadSources(opts) {
  const tarItems = ['Cargo.toml', 'crates'];
  if (fs.existsSync(path.join(ROOT, 'Cargo.lock'))) tarItems.push('Cargo.lock');

  const tmpTar = path.join(os.tmpdir(), `dieyun-core-src-${Date.now()}.tgz`);
  console.log('[dieyun-core-linux:remote] 打包源码…');
  run('tar', ['-czf', tmpTar, ...tarItems], { cwd: ROOT });

  const remoteTar = `${opts.remoteDir}/src.tgz`;
  console.log('[dieyun-core-linux:remote] 上传源码到', remoteTar);
  sshRun(opts, `mkdir -p ${shellQuote(opts.remoteDir)}`, 60000);
  scpToRemote(opts, tmpTar, remoteTar);
  sshRun(
    opts,
    `cd ${shellQuote(opts.remoteDir)} && tar -xzf src.tgz && rm -f src.tgz`,
    120000
  );

  try {
    fs.unlinkSync(tmpTar);
  } catch {
    // ignore
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function glibcTarget() {
  const v = String(process.env.DIEYUN_LINUX_GLIBC_TARGET || '2.35').trim();
  return /^\d+\.\d+$/.test(v) ? v : '2.35';
}

function remoteBuild(opts) {
  const dir = shellQuote(opts.remoteDir);
  const glibc = glibcTarget();
  const script = [
    'set -e',
    `cd ${dir}`,
    'export PATH="$HOME/.cargo/bin:$HOME/.dieyun/zig:$PATH"',
    'if ! command -v cargo >/dev/null 2>&1; then',
    '  echo "[remote] 安装 Rust toolchain…"',
    '  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable',
    'fi',
    '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"',
    `GLIBC_TARGET=${glibc}`,
    'host_glibc=$(ldd --version 2>&1 | sed -n "s/.*GLIBC \\([0-9.][0-9.]*\\).*/\\1/p;s/.* \\([0-9]\\+\\.[0-9]\\+\\) *$/\\1/p" | head -1)',
    'echo "[remote] host GLIBC=${host_glibc:-unknown} target=${GLIBC_TARGET}"',
    'need_old_glibc=0',
    'if [ -n "$host_glibc" ]; then',
    '  host_maj=${host_glibc%%.*}; host_min=${host_glibc#*.}; host_min=${host_min%%.*}',
    '  tgt_maj=${GLIBC_TARGET%%.*}; tgt_min=${GLIBC_TARGET#*.}; tgt_min=${tgt_min%%.*}',
    '  if [ "$host_maj" -gt "$tgt_maj" ] || { [ "$host_maj" -eq "$tgt_maj" ] && [ "$host_min" -gt "$tgt_min" ]; }; then',
    '    need_old_glibc=1',
    '  fi',
    'fi',
    'BIN=""',
    'if [ "$need_old_glibc" = 1 ]; then',
    '  echo "[remote] 编译机 glibc 新于目标，改用 cargo-zigbuild → gnu.$GLIBC_TARGET"',
    '  if ! command -v zig >/dev/null 2>&1; then',
    '    mkdir -p "$HOME/.dieyun/zig"',
    '    ZIG_VER=0.14.1',
    '    ok=0',
    '    for ZIG_URL in "https://ziglang.org/download/${ZIG_VER}/zig-x86_64-linux-${ZIG_VER}.tar.xz" "https://ziglang.org/download/${ZIG_VER}/zig-linux-x86_64-${ZIG_VER}.tar.xz"; do',
    '      echo "[remote] 下载 $ZIG_URL"',
    '      if curl -fsSL "$ZIG_URL" -o /tmp/zig-dieyun.tar.xz; then ok=1; break; fi',
    '    done',
    '    test "$ok" = 1',
    '    tar -xJf /tmp/zig-dieyun.tar.xz -C "$HOME/.dieyun"',
    '    ZIG_DIR=$(find "$HOME/.dieyun" -maxdepth 1 -type d -name "zig-*" | head -1)',
    '    test -n "$ZIG_DIR" && test -x "$ZIG_DIR/zig"',
    '    ln -sfn "$ZIG_DIR/zig" "$HOME/.dieyun/zig/zig"',
    '    rm -f /tmp/zig-dieyun.tar.xz',
    '  fi',
    '  zig version',
    '  if ! command -v cargo-zigbuild >/dev/null 2>&1; then',
    '    echo "[remote] 安装 cargo-zigbuild…"',
    '    cargo install cargo-zigbuild',
    '  fi',
    '  rustup target add x86_64-unknown-linux-gnu >/dev/null',
    '  cargo zigbuild -p dieyun-core --release --no-default-features --target "x86_64-unknown-linux-gnu.${GLIBC_TARGET}"',
    '  BIN=target/x86_64-unknown-linux-gnu/release/dieyun-core',
    'else',
    '  cargo build -p dieyun-core --release',
    '  BIN=target/release/dieyun-core',
    'fi',
    'test -s "$BIN"',
    'cp -f "$BIN" dieyun-core',
    'chmod +x dieyun-core',
    'max_glibc=$(strings -a dieyun-core | grep -oE "GLIBC_[0-9]+\\.[0-9]+" | sed "s/GLIBC_//" | sort -t. -k1,1n -k2,2n | tail -1 || true)',
    'echo "[remote] artifact $(pwd)/dieyun-core max GLIBC=${max_glibc:-unknown}"',
    'ls -la dieyun-core'
  ].join('\n');
  console.log('[dieyun-core-linux:remote] 远程编译中（首次可能较久）…');
  sshRun(opts, script, BUILD_TIMEOUT_MS);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.ssh) {
    printHelp();
    throw new Error('缺少 --ssh user@host 或 DIEYUN_LINUX_CORE_SSH / dieyun-linux-build.local.json');
  }
  if (!parseSshTarget(opts.ssh)) {
    throw new Error(`SSH 目标格式无效: ${opts.ssh}（应为 user@host）`);
  }

  ensureOpenSsh();
  console.log('[dieyun-core-linux:remote] 目标:', sshTarget(opts), 'port', opts.port);
  opts.remoteDir = expandRemoteDir(opts);
  console.log('[dieyun-core-linux:remote] 远程目录:', opts.remoteDir);
  if (opts.interactive) {
    console.log('[dieyun-core-linux:remote] 交互模式：将提示输入 SSH 密码（可能多次）');
  } else if (opts.identityFile) {
    console.log('[dieyun-core-linux:remote] 私钥:', path.resolve(opts.identityFile));
  }

  if (!(opts.skipSync && opts.skipBuild)) {
    sshRun(opts, 'uname -a && command -v cargo >/dev/null 2>&1 && cargo -V || echo cargo-not-installed', 120000);
  }

  if (!opts.skipSync) {
    await uploadSources(opts);
  } else {
    console.log('[dieyun-core-linux:remote] 跳过源码同步 (--skip-sync)');
  }

  if (!opts.skipBuild) {
    remoteBuild(opts);
  } else {
    console.log('[dieyun-core-linux:remote] 跳过编译 (--skip-build)');
  }

  const remoteBin = `${opts.remoteDir}/dieyun-core`;
  const tmpBin = path.join(os.tmpdir(), `dieyun-core-linux-${Date.now()}`);
  console.log('[dieyun-core-linux:remote] 下载', remoteBin);
  scpFromRemote(opts, remoteBin, tmpBin);

  try {
    await installLinuxCoreBin(tmpBin);
  } finally {
    try {
      fs.unlinkSync(tmpBin);
    } catch {
      // ignore
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[dieyun-core-linux:remote] failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = { main };
