'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
  compareDotVersion,
  maxGlibcInBuffer,
  maxGlibcInFile,
  parseLddVersionText,
  glibcMismatchHint,
  sanitizeCoreErrorText
} = require('../src/remote/linux-elf-compat');

assert.strictEqual(compareDotVersion('2.43', '2.35'), 1);
assert.strictEqual(compareDotVersion('2.35', '2.43'), -1);
assert.strictEqual(compareDotVersion('2.35', '2.35'), 0);

const buf = Buffer.from('xxGLIBC_2.34\0GLIBC_2.43\0GLIBC_2.2.5\0yy');
assert.strictEqual(maxGlibcInBuffer(buf), '2.43');

assert.strictEqual(parseLddVersionText('ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35\n'), '2.35');

const hint = glibcMismatchHint('2.43', '2.35');
assert.ok(/GLIBC 2\.43/.test(hint) && /2\.35/.test(hint), hint);
assert.ok(hint.length <= 90, 'hint must fit thinking-trace slice');
assert.strictEqual(glibcMismatchHint('2.35', '2.39'), '');

assert.strictEqual(
  sanitizeCoreErrorText("version `GLIBC_2.43' not found"),
  "version 'GLIBC_2.43' not found"
);

const packed = path.join(__dirname, '..', 'build', 'dieyun-core-linux', 'dieyun-core');
if (fs.existsSync(packed)) {
  const need = maxGlibcInFile(packed);
  console.log('packed linux core max GLIBC:', need || '(none)');
  assert.ok(need, 'packed ELF should declare GLIBC symbols');
}

console.log('linux-elf-compat: ALL OK');
