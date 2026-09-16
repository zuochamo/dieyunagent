'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { hoverToText, normalizeLocations } = require('../src/lsp/navigate-service');
const { getServerSpec, resolveTsServerPath, getLanguageIdForPath, shouldOpenOnTypescriptLanguageServer } = require('../src/lsp/language-registry');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(hoverToText({ contents: 'hello' }) === 'hello', 'string hover');
assert(
  hoverToText({ contents: { kind: 'markdown', value: '**x**' } }) === '**x**',
  'markup hover'
);
assert(
  hoverToText({ contents: [{ language: 'ts', value: 'n: number' }, 'note'] }).includes('n: number'),
  'array hover'
);
assert(hoverToText(null) == null, 'empty hover');

const root = path.resolve('C:\\proj');
const fileUri = pathToFileURL(path.join(root, 'src', 'a.ts')).href;
const locs = normalizeLocations(
  [
    {
      uri: fileUri,
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }
    },
    {
      targetUri: fileUri,
      targetSelectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }
    }
  ],
  root
);
assert(locs.length === 1, 'dedupe location + locationLink');
assert(locs[0].line === 3 && locs[0].character === 5, '1-based line/character');
assert(String(locs[0].path).replace(/\\/g, '/').endsWith('src/a.ts'), 'rel path');

const spec = getServerSpec('typescript', path.join(os.tmpdir(), 'dieyun-lsp-no-override'), os.tmpdir());
assert(spec, 'typescript server spec');
assert(spec.args.includes('typescript'), 'npx must install typescript peer');
assert(spec.args.includes('typescript-language-server'), 'npx must run typescript-language-server');

const { resolveTscCommand, childEnvForCommand } = require('../src/lsp/cli-fallback');
assert(childEnvForCommand(process.execPath).ELECTRON_RUN_AS_NODE === '1', 'electron child must run as node');
assert(childEnvForCommand('npx').ELECTRON_RUN_AS_NODE == null, 'npx child keeps default env');

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-tsserver-'));
const fakeLib = path.join(fakeRoot, 'node_modules', 'typescript', 'lib');
fs.mkdirSync(fakeLib, { recursive: true });
fs.writeFileSync(
  path.join(fakeRoot, 'node_modules', 'typescript', 'package.json'),
  JSON.stringify({ name: 'typescript', version: '5.0.0', main: 'lib/typescript.js' })
);
const fakeTsServer = path.join(fakeLib, 'tsserver.js');
fs.writeFileSync(fakeTsServer, 'module.exports = {};\n');
const fakeTscJs = path.join(fakeLib, 'tsc.js');
fs.writeFileSync(fakeTscJs, 'module.exports = {};\n');
fs.mkdirSync(path.join(fakeRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n');
const resolved = resolveTsServerPath(fakeRoot);
assert(resolved, 'resolve tsserver from workspace node_modules');
assert(path.normalize(resolved).toLowerCase() === path.normalize(fakeTsServer).toLowerCase(), 'resolved tsserver path');
const tscCmd = resolveTscCommand(fakeRoot);
assert(tscCmd.command === process.execPath, 'tsc via current node/electron');
assert(String(tscCmd.args[0]).replace(/\\/g, '/').endsWith('lib/tsc.js'), 'tsc entry must be lib/tsc.js not bin/tsc');

assert(getLanguageIdForPath('src/a.ts') === 'typescript', 'ts language');
assert(getLanguageIdForPath('pkg/package.json') == null, 'package.json is not a tsserver document');
assert(getLanguageIdForPath('tsconfig.json') == null, 'tsconfig.json is not a tsserver document');
assert(shouldOpenOnTypescriptLanguageServer('src/a.ts', 'typescript') === true, 'open ts');
assert(shouldOpenOnTypescriptLanguageServer('website/package.json', 'json') === false, 'skip package.json');
assert(shouldOpenOnTypescriptLanguageServer('tsconfig.base.json', 'json') === false, 'skip tsconfig.*');
assert(shouldOpenOnTypescriptLanguageServer('apps/web/tsconfig.json') === false, 'skip nested tsconfig');

console.log('test-lsp-navigate.cjs ok');
