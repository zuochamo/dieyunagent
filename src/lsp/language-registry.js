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
  ['.go', 'go'],
  // C / C++ / CUDA（UE5、Blender 插件、原生扩展）：交给 clangd
  ['.c', 'c'],
  ['.h', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.c++', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
  ['.hxx', 'cpp'],
  ['.h++', 'cpp'],
  ['.ipp', 'cpp'],
  ['.inl', 'cpp'],
  ['.cu', 'cuda'],
  ['.cuh', 'cuda']
];

const SERVER_BY_LANGUAGE = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'typescript',
  javascriptreact: 'typescript',
  python: 'python',
  rust: 'rust',
  go: 'go',
  c: 'clangd',
  cpp: 'clangd',
  cuda: 'clangd'
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
  },
  /**
   * C/C++/CUDA：clangd 是原生可执行文件（LLVM 发行版自带），从 PATH 启动。
   * 未安装时 spawn 失败 → 上层返回 LSP_UNAVAILABLE，不影响其它语言。
   * UE 项目通常还需要编译数据库：项目根 .clangd 里写
   *   CompileFlags: { CompilationDatabase: Intermediate }
   * 或在 userData/lsp.json 覆盖 args（如 ["--compile-commands-dir=D:/Proj/Intermediate"]）。
   */
  clangd: {
    id: 'clangd',
    command: 'clangd',
    args: ['--background-index', '--header-insertion=never'],
    shell: false
  }
};

function lspConfigPath(userDataPath) {
  return path.join(userDataPath, 'lsp.json');
}

/** Python 类型存根目录（bpy / 引擎 SDK 等 pyi 包放这里，由 pyright stubPath 加载）。 */
function pythonStubDir(userDataPath) {
  if (!userDataPath) return '';
  return path.join(userDataPath, 'lsp-stubs');
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

/**
 * 该文件能否交给语言服务（唯一判据：语言有对应 server、且不是工程配置文件）。
 * 早先这里是「ts 系 + python」硬编码白名单，导致 rust/go/clangd 有 spec 却永远
 * 在 syncDocument 里被判死（诊断永远为空）。新增语言只改 EXT_LANGUAGE/SERVER_BY_LANGUAGE 即可。
 */
function isLanguageServable(filePath, languageId) {
  const lang = languageId || getLanguageIdForPath(filePath);
  if (!lang) return false;
  if (!getServerKeyForLanguage(lang)) return false;
  return !isTypescriptProjectConfigPath(filePath);
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

function buildInitializeOptions(serverKey, workspaceRoot, opts = {}) {
  if (serverKey === 'typescript') {
    const tsserverPath = resolveTsServerPath(workspaceRoot);
    if (!tsserverPath) return {};
    return { tsserver: { path: tsserverPath } };
  }
  /**
   * Python 类型存根（bpy 等）：pyright 的 stubPath 指向 userData/lsp-stubs，
   * 该目录不存在时保持默认（不影响普通项目）。
   * 存根通过 initializationOptions.settings 下发（vscode-pyright 同款通道），
   * 不在用户项目里写 pyrightconfig.json。
   */
  if (serverKey === 'python') {
    const stubDir = opts.userDataPath ? pythonStubDir(opts.userDataPath) : '';
    if (!stubDir) return {};
    try {
      if (!fs.statSync(stubDir).isDirectory()) return {};
    } catch {
      return {};
    }
    return {
      settings: {
        python: {
          analysis: {
            stubPath: stubDir,
            extraPaths: [stubDir]
          }
        }
      }
    };
  }
  return {};
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
  isLanguageServable,
  getServerSpec,
  buildInitializeOptions,
  resolveTsServerPath,
  isTypescriptProjectConfigPath,
  shouldOpenOnTypescriptLanguageServer,
  pythonStubDir
};
