'use strict';

/**
 * LSP 定位/诊断链路回归（默认不联网、不启动真实 Language Server）。
 *
 * 覆盖：
 *  - 纯函数：hover 归一化、位置归一化、行内标识符列纠正（resolveCharacter0）
 *  - server spec / tsserver 解析 / CLI 降级命令（原 test-lsp-navigate 口径）
 *  - queryLspPosition：注入 fake client 校验实际发出的落点列
 *  - 远程网关 lsp.query 只有一份实现（重复键回归）
 *  - LspClient 在 server 不可用时快速失败，而不是等 initialize 超时
 *
 * 可选端到端（需网络 + npx，原 test-lsp-diagnostics 口径）：
 *  DIEYUN_LSP_E2E=1 node scripts/test-lsp.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  hoverToText,
  normalizeLocations,
  resolveCharacter0,
  queryLspPosition,
  MAX_SERVERS_PER_SYMBOL_QUERY
} = require('../src/lsp/navigate-service');
const {
  getServerSpec,
  resolveTsServerPath,
  getLanguageIdForPath,
  isTypescriptProjectConfigPath,
  shouldOpenOnTypescriptLanguageServer
} = require('../src/lsp/language-registry');
const { resolveTscCommand, childEnvForCommand } = require('../src/lsp/cli-fallback');
const { LspClient } = require('../src/lsp/lsp-client');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-test-'));
const sampleTs = path.join(tmpRoot, 'sample.ts');
fs.writeFileSync(
  sampleTs,
  ['export function prepSystemPrompt(input) {', '  const total = computeValue(input);', '  return total;', '}'].join(
    '\n'
  ) + '\n'
);

function fakeClient(bucket) {
  const record = (req) => {
    bucket.req = req;
    return [];
  };
  return {
    getDefinition: async (req) => record(req),
    getReferences: async (req) => record(req),
    getImplementation: async (req) => record(req),
    getTypeDefinition: async (req) => record(req),
    getDocumentSymbols: async (req) => record(req),
    getWorkspaceSymbols: async (req) => record(req),
    getHover: async (req) => {
      bucket.req = req;
      return { contents: 'hover' };
    }
  };
}

function assertHoverNormalization() {
  assert(hoverToText({ contents: 'hello' }) === 'hello', 'string hover');
  assert(hoverToText({ contents: { kind: 'markdown', value: '**x**' } }) === '**x**', 'markup hover');
  assert(
    hoverToText({ contents: [{ language: 'ts', value: 'n: number' }, 'note'] }).includes('n: number'),
    'array hover'
  );
  assert(hoverToText(null) == null, 'empty hover');
}

function assertLocationNormalization() {
  const fileUri = pathToFileURL(sampleTs).href;
  const locs = normalizeLocations(
    [
      { uri: fileUri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } } },
      {
        targetUri: fileUri,
        targetSelectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }
      },
      { uri: fileUri, range: { start: { line: 0, character: 0 } } }
    ],
    tmpRoot
  );
  assert(locs.length === 2, 'dedupe location + locationLink');
  assert(locs[0].line === 3 && locs[0].character === 5, '1-based line/character');
  assert(String(locs[0].path).replace(/\\/g, '/').endsWith('sample.ts'), 'rel path');
}

function assertCharacterCorrection() {
  assert(resolveCharacter0('  const total = 1;', null) === 8, 'auto column skips indent/keyword');
  assert(resolveCharacter0('  const total = 1;', 1) === 8, 'character=1 on whitespace is corrected');
  assert(resolveCharacter0('  const total = 1;', 9) === 8, 'explicit identifier column preserved');
  assert(resolveCharacter0('  const total = 1;', 11) === 8, 'explicit cursor inside identifier preserved');
  assert(resolveCharacter0('  const total = 1;', 3) === 8, 'cursor on keyword falls back to identifier');
  assert(resolveCharacter0('', null) === 0, 'empty line falls back to column 0');
  assert(resolveCharacter0('}', null) === 0, 'line without identifier falls back');
}

function assertServerSpecs() {
  const spec = getServerSpec('typescript', path.join(tmpRoot, 'no-override'), tmpRoot);
  assert(spec, 'typescript server spec');
  assert(spec.args.includes('typescript'), 'npx must install typescript peer');
  assert(spec.args.includes('typescript-language-server'), 'npx must run typescript-language-server');

  assert(childEnvForCommand(process.execPath).ELECTRON_RUN_AS_NODE === '1', 'electron child must run as node');
  assert(childEnvForCommand('npx').ELECTRON_RUN_AS_NODE == null, 'npx child keeps default env');

  const fakeLib = path.join(tmpRoot, 'node_modules', 'typescript', 'lib');
  fs.mkdirSync(fakeLib, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'node_modules', 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: '5.0.0', main: 'lib/typescript.js' })
  );
  const fakeTsServer = path.join(fakeLib, 'tsserver.js');
  fs.writeFileSync(fakeTsServer, 'module.exports = {};\n');
  fs.writeFileSync(path.join(fakeLib, 'tsc.js'), 'module.exports = {};\n');

  const resolved = resolveTsServerPath(tmpRoot);
  assert(resolved, 'resolve tsserver from workspace node_modules');
  assert(
    path.normalize(resolved).toLowerCase() === path.normalize(fakeTsServer).toLowerCase(),
    'resolved tsserver path'
  );

  const tscCmd = resolveTscCommand(tmpRoot);
  assert(tscCmd.command === process.execPath, 'tsc via current node/electron');
  assert(String(tscCmd.args[0]).replace(/\\/g, '/').endsWith('lib/tsc.js'), 'tsc entry must be lib/tsc.js');

  assert(getLanguageIdForPath('src/a.ts') === 'typescript', 'ts language');
  assert(getLanguageIdForPath('pkg/package.json') == null, 'package.json is not a tsserver document');
  assert(isTypescriptProjectConfigPath('tsconfig.json'), 'tsconfig is a project config');
  assert(shouldOpenOnTypescriptLanguageServer('src/a.ts', 'typescript') === true, 'open ts');
  assert(shouldOpenOnTypescriptLanguageServer('website/package.json', 'json') === false, 'skip package.json');
  assert(shouldOpenOnTypescriptLanguageServer('apps/web/tsconfig.json', 'json') === false, 'skip nested tsconfig');
  assert(MAX_SERVERS_PER_SYMBOL_QUERY >= 2, 'workspaceSymbol queries more than one server');
}

async function assertQueryPosition() {
  const bucket = {};
  const client = fakeClient(bucket);
  const deps = { getClient: async () => client, listClients: () => [] };

  const auto = await queryLspPosition({
    operation: 'goToDefinition',
    workspaceRoot: tmpRoot,
    absPath: sampleTs,
    line: 2,
    ...deps
  });
  assert(auto.ok, 'goToDefinition ok');
  assert(bucket.req.character === 8, `auto column should hit identifier (got ${bucket.req.character})`);

  const forced = await queryLspPosition({
    operation: 'findReferences',
    workspaceRoot: tmpRoot,
    absPath: sampleTs,
    line: 1,
    character: 1,
    ...deps
  });
  assert(forced.ok, 'findReferences ok');
  assert(
    bucket.req.character === 16,
    `character=1 must be corrected to the identifier column (got ${bucket.req.character})`
  );

  const unsupported = await queryLspPosition({
    operation: 'goToDefinition',
    workspaceRoot: tmpRoot,
    absPath: path.join(tmpRoot, 'notes.md'),
    line: 1
  });
  assert(unsupported.ok === false && unsupported.errorCode === 'LSP_UNSUPPORTED', 'unsupported file type');

  const noQuery = await queryLspPosition({ operation: 'workspaceSymbol', workspaceRoot: tmpRoot, query: '' });
  assert(noQuery.ok === false && noQuery.errorCode === 'LSP_MISSING_QUERY', 'workspaceSymbol needs query');

  const badOp = await queryLspPosition({ operation: 'rename', workspaceRoot: tmpRoot, absPath: sampleTs, line: 1 });
  assert(badOp.ok === false && badOp.errorCode === 'LSP_BAD_OPERATION', 'operation whitelist');
}

/** 远程网关里 lsp.query 曾被同对象的后置存根键覆盖成「永远不可用」，这里锁死该回归。 */
async function assertRemoteGatewayLspHandler() {
  const { MinimalRemoteGatewayHost } = require('../src/remote/minimal-gateway-host');
  const host = new MinimalRemoteGatewayHost({ workspaceRoot: tmpRoot, log: () => {} });
  try {
    const handler = host.handlers['lsp.query'];
    assert(typeof handler === 'function', 'remote lsp.query registered');
    const res = await handler({ operation: 'goToDefinition', filePath: 'notes.md', line: 1 });
    assert(res && res.ok === false, 'unsupported file should fail');
    assert(
      res.errorCode === 'LSP_UNSUPPORTED',
      `remote lsp.query must run the real handler (got ${res.errorCode})`
    );
    assert(
      !String(res.error || '').includes('远程 Agent 没有 Language Server'),
      'stub handler must not shadow the real one'
    );

    // 缺 filePath 在 PC 侧 handler 已拦截；这里只要求远程不抛异常、返回结构化失败
    const noPath = await handler({ operation: 'goToDefinition' });
    assert(
      noPath && noPath.ok === false && typeof noPath.errorCode === 'string',
      'missing filePath returns structured error'
    );
  } finally {
    await host.handlers.__disposeRemoteIndex();
  }
}

/** PC 侧 lsp.query：缺 filePath 要返回结构化失败，不能抛异常（错误语义统一）。 */
async function assertLocalHandlerMissingPath() {
  const { createLspWorkspaceHandlers } = require('../src/gateway/handlers/lsp-workspace');
  const handlers = createLspWorkspaceHandlers({
    perms: { hostControl: true, fsRead: true },
    ctx: { getWorkspaceTarget: () => null },
    lspDiagnostics: { queryPosition: async () => ({ ok: true, kind: 'locations', locations: [] }) },
    cwdForCall: () => tmpRoot,
    defaultCwd: tmpRoot,
    assertAllowedPath: (p) => p,
    readRootsForCall: () => [tmpRoot],
    normalizeFilePathInput: (p, cwd) => path.resolve(String(cwd || tmpRoot), String(p))
  });

  let threw = null;
  let res = null;
  try {
    res = await handlers['lsp.query']({ operation: 'goToDefinition' });
  } catch (err) {
    threw = err;
  }
  assert(!threw, `local lsp.query must not throw on missing filePath (${threw && threw.message})`);
  assert(res && res.ok === false && res.errorCode === 'MISSING_PATH', 'local lsp.query returns MISSING_PATH');

  const okRes = await handlers['lsp.query']({
    operation: 'goToDefinition',
    filePath: 'sample.ts',
    line: 2
  });
  assert(okRes && okRes.ok === true, 'local lsp.query delegates to diagnostics service');

  const denied = createLspWorkspaceHandlers({
    perms: { hostControl: false, fsRead: true },
    ctx: { getWorkspaceTarget: () => null },
    lspDiagnostics: { queryPosition: async () => ({ ok: true }) },
    cwdForCall: () => tmpRoot,
    defaultCwd: tmpRoot,
    assertAllowedPath: (p) => p,
    readRootsForCall: () => [tmpRoot],
    normalizeFilePathInput: (p, cwd) => path.resolve(String(cwd || tmpRoot), String(p))
  });
  let deniedCode = '';
  try {
    await denied['lsp.query']({ operation: 'goToDefinition', filePath: 'sample.ts', line: 2 });
  } catch (err) {
    deniedCode = err && err.code;
  }
  assert(deniedCode === 'FS_READ_DISABLED', 'unauthorized lsp.query still throws FS_READ_DISABLED');
}

/** server 不存在时必须立刻失败：不能等 initialize 的 45s 超时。 */
async function assertLspClientFailsFast() {
  const client = new LspClient({
    spec: { id: 'missing-lsp', command: 'dieyun-definitely-not-a-real-lsp-binary', args: [], shell: false },
    workspaceRoot: tmpRoot,
    serverKey: 'typescript',
    log: () => {}
  });
  const startedAt = Date.now();
  let rejected = false;
  try {
    await client.ensureInitialized();
  } catch {
    rejected = true;
  }
  const elapsed = Date.now() - startedAt;
  assert(rejected, 'missing language server must reject initialize');
  assert(elapsed < 15000, `missing language server should fail fast (took ${elapsed}ms)`);
}

/** 可选端到端：真起 LSP 抓一条类型错误（原 test-lsp-diagnostics 口径，需网络）。 */
async function e2eDiagnostics() {
  const { createLspDiagnosticsService } = require('../src/lsp/diagnostics-service');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-e2e-'));
  fs.writeFileSync(
    path.join(ws, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' }, include: ['*.ts'] },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(ws, 'bad.ts'), 'const x: number = "hello";\n');
  const userDataPath = path.join(ws, 'user-data');
  fs.mkdirSync(userDataPath, { recursive: true });
  const svc = createLspDiagnosticsService({ userDataPath, log: () => {} });
  try {
    const result = await svc.diagnoseFiles({
      workspaceRoot: ws,
      files: ['bad.ts'],
      maxFiles: 1,
      timeoutMs: 120000
    });
    const item = (result.items || [])[0];
    const hasError = item && (item.diagnostics || []).some((d) => d.severity === 'error');
    assert(hasError, `expected an error diagnostic (item=${JSON.stringify(item && (item.error || item.file))})`);
  } finally {
    await svc.shutdown();
  }
}

async function main() {
  assertHoverNormalization();
  assertLocationNormalization();
  assertCharacterCorrection();
  assertServerSpecs();
  await assertQueryPosition();
  await assertLocalHandlerMissingPath();
  await assertRemoteGatewayLspHandler();
  await assertLspClientFailsFast();

  if (process.env.DIEYUN_LSP_E2E === '1') {
    await e2eDiagnostics();
    console.log('e2e diagnostics ok');
  } else {
    console.log('e2e diagnostics skipped (set DIEYUN_LSP_E2E=1 to run, needs network/npx)');
  }

  console.log('test-lsp.cjs ok');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
