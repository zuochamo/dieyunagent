'use strict';

const { applyStrReplace, applyFileEdits, collectFileEdits, normalizeEditArgs } = require('../src/gateway/str-replace');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const unique = applyStrReplace('alpha\nbeta\ngamma\n', 'beta', 'BETA', false);
assert(unique.ok && unique.text === 'alpha\nBETA\ngamma\n' && unique.replacements === 1, 'unique replace');

const missing = applyStrReplace('abc', 'zzz', 'q', false);
assert(!missing.ok && missing.errorCode === 'FS_EDIT_NOT_FOUND', 'missing needle');

const dup = applyStrReplace('x a x a x', 'a', 'b', false);
assert(!dup.ok && dup.errorCode === 'FS_EDIT_NOT_UNIQUE' && dup.occurrences === 2, 'not unique');

const all = applyStrReplace('x a x a x', 'a', 'b', true);
assert(all.ok && all.text === 'x b x b x' && all.replacements === 2, 'replaceAll');

const crlf = applyStrReplace('a\r\nb\r\nc\r\n', 'b\n', 'B\n', false);
assert(crlf.ok && crlf.text.includes('B\r\n'), 'lf needle against crlf file');

const empty = applyStrReplace('abc', '', 'x', false);
assert(!empty.ok && empty.errorCode === 'FS_EDIT_EMPTY_OLD', 'empty old');

const same = applyStrReplace('abc', 'ab', 'ab', false);
assert(!same.ok && same.errorCode === 'FS_EDIT_NO_CHANGE', 'no change');

const fuzzy = applyStrReplace('say "hello"\n', 'say \u201Chello\u201D\n', 'say "hi"\n', false);
assert(fuzzy.ok && fuzzy.text.includes('say "hi"'), 'smart quotes fuzzy match');

const trail = applyStrReplace('foo  \nbar\n', 'foo\nbar', 'FOO\nBAR', false);
assert(trail.ok && trail.text.startsWith('FOO'), 'trailing space fuzzy match');

const multi = applyFileEdits('alpha\nbeta\ngamma\n', [
  { oldText: 'alpha', newText: 'A' },
  { oldText: 'gamma', newText: 'G' }
]);
assert(multi.ok && multi.text === 'A\nbeta\nG\n' && multi.replacements === 2, 'multi hunk against original');

const overlap = applyFileEdits('abcdef', [
  { oldText: 'abc', newText: 'X' },
  { oldText: 'bcd', newText: 'Y' }
]);
assert(!overlap.ok && overlap.errorCode === 'FS_EDIT_OVERLAP', 'overlap rejected');

const incrementalWouldFail = applyFileEdits('aa\nbb\n', [
  { oldText: 'aa', newText: 'xx' },
  { oldText: 'aa', newText: 'yy' }
]);
assert(!incrementalWouldFail.ok, 'second hunk still matches original (duplicate not unique or overlap)');

const collected = collectFileEdits({
  path: 'src/a.js',
  edits: JSON.stringify([{ oldText: 'foo', newText: 'bar' }])
});
assert(collected.ok && collected.edits.length === 1 && collected.edits[0].oldText === 'foo', 'edits json string');

const mixed = collectFileEdits({
  filePath: 'a.js',
  old_string: 'foo',
  new_string: 'bar',
  edits: [{ oldText: 'x', newText: 'y' }]
});
assert(mixed.ok && mixed.edits.length === 2, 'legacy plus edits[]');

const bom = applyStrReplace('\uFEFFkeep\n', 'keep', 'KEEP', false);
assert(bom.ok && bom.text.charCodeAt(0) === 0xfeff && bom.text.includes('KEEP'), 'preserve bom');

const norm = normalizeEditArgs({
  path: 'src/a.js',
  old_string: 'foo',
  new_string: 'bar',
  replace_all: true
});
assert(norm.filePath === 'src/a.js' && norm.oldString === 'foo' && norm.newString === 'bar' && norm.replaceAll === true, 'normalize snake_case');

const { REMOTE_GATEWAY_SOURCE_PATHS } = require('./remote-gateway-source-paths.cjs');
assert(
  REMOTE_GATEWAY_SOURCE_PATHS.includes('src/gateway/fs-edit-file.js'),
  'remote pack must include fs-edit-file.js (minimal-gateway-host requires it)'
);

console.log('test-fs-edit.cjs ok');
