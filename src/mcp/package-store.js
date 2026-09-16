'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function npmCommandName() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function execFileText(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const useCmd = process.platform === 'win32' && /\.cmd$/i.test(command);
    const file = useCmd ? 'cmd.exe' : command;
    const finalArgs = useCmd ? ['/d', '/s', '/c', quoteCmdArgs([command, ...(args || [])])] : args;
    execFile(
      file,
      finalArgs,
      {
        timeout: opts.timeout || 120000,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          reject(err);
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function quoteCmdArgs(args) {
  return (args || [])
    .map((arg) => {
      const text = String(arg);
      if (!/[ \t"&|<>^]/.test(text)) return text;
      return `"${text.replace(/"/g, '\\"')}"`;
    })
    .join(' ');
}

function splitNpmPackageSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw || raw.startsWith('-')) return null;
  if (raw.startsWith('@')) {
    const slash = raw.indexOf('/');
    if (slash < 0) return null;
    const versionAt = raw.indexOf('@', slash + 1);
    return {
      name: versionAt >= 0 ? raw.slice(0, versionAt) : raw,
      version: versionAt >= 0 ? raw.slice(versionAt + 1) : ''
    };
  }
  const versionAt = raw.lastIndexOf('@');
  if (versionAt > 0) {
    return { name: raw.slice(0, versionAt), version: raw.slice(versionAt + 1) };
  }
  return { name: raw, version: '' };
}

function findNpmPackageArg(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg || arg === '-y' || arg === '--yes') continue;
    if (arg === '-p' || arg === '--package' || arg === '--package-name') {
      const next = splitNpmPackageSpec(list[i + 1]);
      if (next) return { index: i + 1, flagIndex: i, ...next };
      continue;
    }
    if (arg.startsWith('-')) continue;
    const parsed = splitNpmPackageSpec(arg);
    if (parsed) return { index: i, flagIndex: -1, ...parsed };
  }
  return null;
}

function getMcpNpmPackageMeta(server) {
  if (!server || String(server.command || '').toLowerCase() !== 'npx') return null;
  const parsed = findNpmPackageArg(server.args || []);
  const name = String(server.packageName || parsed?.name || '').trim();
  if (!name) return null;
  return {
    name,
    version: String(server.packageVersion || parsed?.version || '').trim(),
    argIndex: parsed ? parsed.index : -1,
    flagIndex: parsed ? parsed.flagIndex : -1
  };
}

function compareSemver(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = String(b || '').split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function fetchNpmLatestVersion(packageName) {
  const out = await execFileText(npmCommandName(), ['view', packageName, 'version', '--json'], {
    timeout: 25000
  });
  try {
    const parsed = JSON.parse(out);
    return String(parsed || '').trim();
  } catch {
    return out.replace(/^"|"$/g, '').trim();
  }
}

function safePackageDirName(serverId, packageName) {
  const base = String(serverId || packageName || 'mcp')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
  return base || 'mcp';
}

function packageRoot(userDataPath, serverId, packageName) {
  return path.join(userDataPath, 'mcp-packages', safePackageDirName(serverId, packageName));
}

function packageJsonPath(root, packageName) {
  return path.join(root, 'node_modules', ...String(packageName).split('/'), 'package.json');
}

function readInstalledPackage(root, packageName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath(root, packageName), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

function resolveBinName(pkg, packageName) {
  if (pkg && typeof pkg.bin === 'string') {
    return path.basename(String(packageName).split('/').pop() || String(packageName));
  }
  if (pkg && pkg.bin && typeof pkg.bin === 'object') {
    const keys = Object.keys(pkg.bin).filter(Boolean);
    if (keys.length) return keys[0];
  }
  return path.basename(String(packageName).split('/').pop() || String(packageName));
}

function resolveBinPath(root, binName) {
  const binDir = path.join(root, 'node_modules', '.bin');
  const candidates =
    process.platform === 'win32'
      ? [path.join(binDir, `${binName}.cmd`), path.join(binDir, `${binName}.ps1`), path.join(binDir, binName)]
      : [path.join(binDir, binName)];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function runtimeArgsWithoutNpxPackage(args, meta) {
  // 文本与索引分开存：早前用同一个 Set 里存两种含义，参数值恰好等于索引字符串时会被误删
  const removeText = new Set(['-y', '--yes']);
  const removeIndex = new Set();
  if (meta.argIndex >= 0) removeIndex.add(meta.argIndex);
  if (meta.flagIndex >= 0) removeIndex.add(meta.flagIndex);
  return (Array.isArray(args) ? args : [])
    .map((arg, index) => ({ arg: String(arg), index }))
    .filter((item) => !removeIndex.has(item.index) && !removeText.has(item.arg))
    .map((item) => item.arg);
}

async function installMcpNpmPackage({ userDataPath, serverId, packageName, version }) {
  const root = packageRoot(userDataPath, serverId, packageName);
  fs.mkdirSync(root, { recursive: true });
  const spec = version ? `${packageName}@${version}` : packageName;
  try {
    await execFileText(npmCommandName(), ['install', '--prefix', root, '--no-audit', '--no-fund', spec], {
      timeout: 300000
    });
  } catch (err) {
    throw decorateMcpInstallError(err);
  }
  const pkg = readInstalledPackage(root, packageName);
  if (!pkg) throw new Error(`MCP 包安装后未找到 package.json：${packageName}`);
  return { root, packageJson: pkg };
}

function decorateMcpInstallError(err) {
  const diagnostic = classifyMcpInstallError(err);
  if (!diagnostic.repairKind) return err;
  const wrapped = new Error(diagnostic.message);
  wrapped.code = 'MCP_ENV_REPAIR_REQUIRED';
  wrapped.repairKind = diagnostic.repairKind;
  wrapped.diagnostic = diagnostic.detail;
  wrapped.stderr = err && err.stderr;
  wrapped.stdout = err && err.stdout;
  wrapped.cause = err;
  return wrapped;
}

function classifyMcpInstallError(err) {
  const text = `${err?.message || ''}\n${err?.stderr || ''}\n${err?.stdout || ''}`;
  if (
    process.platform === 'win32' &&
    /node-gyp|gyp ERR!|Desktop development with C\+\+|Visual Studio|VCINSTALLDIR|msvs_version/i.test(text)
  ) {
    return {
      repairKind: 'windows-vctools',
      message:
        '缺少 Windows C++ 编译环境，无法编译该 MCP 的原生依赖。请点击“修复环境”安装 Visual Studio Build Tools 后重试。',
      detail: compactErrorText(text)
    };
  }
  if (/EBUSY|EPERM|resource busy or locked|operation not permitted/i.test(text)) {
    return {
      repairKind: 'npm-cache-busy',
      message: 'npm 安装目录被占用或无权限，请关闭相关 Node/MCP 进程后重试。',
      detail: compactErrorText(text)
    };
  }
  return {
    repairKind: '',
    message: err?.message || 'MCP 包安装失败',
    detail: compactErrorText(text)
  };
}

function compactErrorText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .join('\n')
    .slice(0, 4000);
}

async function ensureMcpNpmPackage({ userDataPath, server }) {
  const meta = getMcpNpmPackageMeta(server);
  if (!meta) return { server, installed: false, supported: false };
  const root = packageRoot(userDataPath, server.id, meta.name);
  let pkg = readInstalledPackage(root, meta.name);
  const wantVersion = String(meta.version || '').trim();
  if (!pkg || (wantVersion && String(pkg.version || '') !== wantVersion)) {
    const installed = await installMcpNpmPackage({
      userDataPath,
      serverId: server.id,
      packageName: meta.name,
      version: wantVersion
    });
    pkg = installed.packageJson;
  }
  const binName = resolveBinName(pkg, meta.name);
  const command = resolveBinPath(root, binName);
  return {
    installed: true,
    supported: true,
    packageName: meta.name,
    packageVersion: String(pkg.version || meta.version || ''),
    installRoot: root,
    command,
    args: runtimeArgsWithoutNpxPackage(server.args || [], meta),
    server: {
      ...server,
      command,
      args: runtimeArgsWithoutNpxPackage(server.args || [], meta),
      localPackageRoot: root,
      localPackageVersion: String(pkg.version || meta.version || '')
    }
  };
}

function getMcpPackageStatus(userDataPath, server) {
  const meta = getMcpNpmPackageMeta(server);
  if (!meta) return { supported: false, installed: false };
  const root = packageRoot(userDataPath, server.id, meta.name);
  const pkg = readInstalledPackage(root, meta.name);
  return {
    supported: true,
    installed: !!pkg,
    installRoot: root,
    packageName: meta.name,
    configuredVersion: meta.version || '',
    installedVersion: pkg ? String(pkg.version || '') : ''
  };
}

module.exports = {
  compareSemver,
  ensureMcpNpmPackage,
  execFileText,
  fetchNpmLatestVersion,
  getMcpNpmPackageMeta,
  getMcpPackageStatus,
  installMcpNpmPackage,
  classifyMcpInstallError,
  runtimeArgsWithoutNpxPackage,
  replaceNpmPackageVersion(args, meta, targetVersion) {
    const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
    if (meta.argIndex >= 0 && meta.argIndex < list.length) {
      list[meta.argIndex] = meta.name;
      return list;
    }
    return ['-y', meta.name, ...list.filter((arg) => arg !== '-y' && arg !== '--yes')];
  }
};
