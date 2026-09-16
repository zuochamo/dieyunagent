'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { globToRegExp, matchGlob, grepWorkspace, globWorkspace } = require('../src/gateway/rg-search');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-rg-'));
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'function renderHUD() {\n  return 1;\n}\n');
fs.writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const unused = 1;\n');
fs.writeFileSync(path.join(dir, 'README.md'), '# demo\nrenderHUD lives in src\n');

assert(matchGlob('src/app.js', '*.js'), '*.js matches nested');
assert(matchGlob('src/app.js', '**/*.js'), '**/*.js matches');
assert(!matchGlob('src/app.js', '*.ts'), '*.ts rejects js');
assert(globToRegExp('src/**/*.ts').test('src/util.ts'), 'src/**/*.ts');

(async () => {
  try {
    const g = await grepWorkspace(dir, { pattern: 'renderHUD', maxResults: 20 });
    assert(g.ok, 'grep ok');
    assert(Array.isArray(g.matches) && g.matches.length >= 2, 'grep finds both files');
    assert(
      g.matches.some((m) => m.path.replace(/\\/g, '/').includes('src/app.js') && m.line === 1),
      'grep line in app.js'
    );

    const glob = await globWorkspace(dir, { pattern: '**/*.ts', maxResults: 20 });
    assert(glob.ok, 'glob ok');
    assert(glob.files.some((f) => f.replace(/\\/g, '/').endsWith('src/util.ts')), 'glob finds ts');
    assert(!glob.files.some((f) => f.endsWith('.js')), 'glob excludes js');

    const missing = await grepWorkspace(dir, { pattern: '' });
    assert(!missing.ok && missing.errorCode === 'MISSING_PATTERN', 'empty pattern');

    console.log('test-rg-search.cjs ok', { grepSource: g.source, globSource: glob.source });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
