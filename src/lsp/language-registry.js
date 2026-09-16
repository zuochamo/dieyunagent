'use strict';

const fs = require('fs');
const path = require('path');

const EXT_LANGUAGE = [
  ['.tsx', 'typescriptreact'],
  ['.jsx', 'javascriptreact'],
  ['.ts', 'typescript'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go']
];

const SERVER_BY_LANGUAGE = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'typescript',
  javascriptreact: 'typescript',
  python: 'python',
  rust: 'rust',
  go: 'go'
};

function resolvePyrightLangserverPath(workspaceRoot) {
  let dir = path.resolve(String(workspaceRoot || process.cwd()));
  for (let i = 0; i < 12; i++) {
    try {
      return require.resolve('pyright/langserver.index.js', { paths: [dir] });
    } catch {
      // walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const APP_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_SERVER_SPECS = {
  typescript: {
    id: 'typescript-language-server',
    command: 'npx',
    // typescript is a peer of typescript-language-server; install both so initialize
    // works in JS-only workspaces that do not have a local typescript package.
    args: ['-y', '-p', 'typescript-language-server', '-p', 'typescript', 'typescript-language-server', '--stdio'],
    shell: process.platform === 'win32'
  },
  python: {
    id: 'pyright-langserver',
    command: 'npx',
    // pyright-langserver is a binary inside the `pyright` npm package, not its own package.
    args: ['-y', '-p', 'pyright', 'pyright-langserver', '--stdio'],
    shell: process.platform === 'win32'
  },
  // rust-analyzer / gopls 是原生可执行文件，从 PATH 启动；
  // 未安装时 spawn 失败 → 上层返回 LSP_UNAVAILABLE，不影响其他能力。
  // 可用 userData 下的 lsp.json 覆盖 command/args 指定绝对路径。
  rust: {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    shell: false
  },
  go: {
    id: 'gopls',
    command: 'gopls',
    args: [],
    shell: false
  }
};

function lspConfigPath(userDataPath) {
  return path.join(userDataPath, 'lsp.json');
}

function loadLspServerOverrides(userDataPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(lspConfigPath(userDataPath), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function getLanguageIdForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  for (const [suffix, lang] of EXT_LANGUAGE) {
    if (ext === suffix) return lang;
  }
  return null;
}

/** tsserver 把 tsconfig/package.json 当工程配置，didOpen 会 Unexpected resource */
function isTypescriptProjectConfigPath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (base === 'package.json' || base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    return true;
  }
  if (base === 'jsconfig.json' || (base.startsWith('jsconfig.') && base.endsWith('.json'))) return true;
  if (base === 'tsconfig.json' || (base.startsWith('tsconfig.') && base.endsWith('.json'))) return true;
  return false;
}

function shouldOpenOnTypescriptLanguageServer(filePath, languageId) {
  if (isTypescriptProjectConfigPath(filePath)) return false;
  const lang = languageId || getLanguageIdForPath(filePath);
  return (
    lang === 'typescript' ||
    lang === 'typescriptreact' ||
    lang === 'javascript' ||
    lang === 'javascriptreact'
  );
}

function getServerKeyForLanguage(languageId) {
  return SERVER_BY_LANGUAGE[languageId] || null;
}

function resolveTsServerFromDir(startDir) {
  let dir = path.resolve(String(startDir || ''));
  for (let i = 0; i < 12; i++) {
    try {
      return require.resolve('typescript/lib/tsserver.js', { paths: [dir] });
    } catch {
      // walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveTsServerPath(workspaceRoot) {
  const fromWorkspace = resolveTsServerFromDir(workspaceRoot || process.cwd());
  if (fromWorkspace) return fromWorkspace;
  const fromApp = resolveTsServerFromDir(APP_ROOT);
  if (fromApp) return fromApp;
  try {
    return require.resolve('typescript/lib/tsserver.js');
  } catch {
    return null;
  }
}

function buildInitializeOptions(serverKey, workspaceRoot) {
  if (serverKey !== 'typescript') return {};
  const tsserverPath = resolveTsServerPath(workspaceRoot);
  if (!tsserverPath) return {};
  return { tsserver: { path: tsserverPath } };
}

function getServerSpec(serverKey, userDataPath, workspaceRoot) {
  const overrides = loadLspServerOverrides(userDataPath);
  const custom = overrides[serverKey];
  if (custom && custom.command) {
    return {
      id: String(custom.id || serverKey),
      command: String(custom.command),
      args: Array.isArray(custom.args) ? custom.args.map(String) : [],
      shell: custom.shell !== false,
      cwd: custom.cwd ? String(custom.cwd) : undefined
    };
  }
  if (serverKey === 'python' && workspaceRoot) {
    const langserverPath = resolvePyrightLangserverPath(workspaceRoot);
    if (langserverPath) {
      return {
        id: 'pyright-langserver',
        command: process.execPath,
        args: [langserverPath, '--stdio'],
        shell: false
      };
    }
  }
  const base = DEFAULT_SERVER_SPECS[serverKey];
  if (!base) return null;
  return { ...base, args: [...base.args] };
}

module.exports = {
  getLanguageIdForPath,
  getServerKeyForLanguage,
  getServerSpec,
  buildInitializeOptions,
  resolveTsServerPath,
  resolvePyrightLangserverPath,
  isTypescriptProjectConfigPath,
  shouldOpenOnTypescriptLanguageServer,
  lspConfigPath
};
