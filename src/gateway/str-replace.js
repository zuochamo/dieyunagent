'use strict';

/**
 * Literal unique-replace used by fs_edit (DeepSeek Harness `edit` semantics).
 * Multiple disjoint hunks match the original file (not incrementally).
 * Exact match first, then CRLF/LF, then light fuzzy (quotes/dashes/trailing space).
 */

function countLiteralOccurrences(haystack, needle) {
  return findExactSpans(haystack, needle).length;
}

function findExactSpans(haystack, needle) {
  const spans = [];
  if (!needle) return spans;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    spans.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return spans;
}

function withAltNewlines(s) {
  if (!s) return null;
  if (s.includes('\r\n')) return s.replace(/\r\n/g, '\n');
  if (s.includes('\n')) return s.replace(/\n/g, '\r\n');
  return null;
}

function alignNewlines(src, like) {
  if (like.includes('\r\n') && src.includes('\n') && !src.includes('\r\n')) {
    return src.replace(/\n/g, '\r\n');
  }
  if (!like.includes('\r\n') && src.includes('\r\n')) {
    return src.replace(/\r\n/g, '\n');
  }
  return src;
}

function isReplaceAllFlag(v) {
  return v === true || v === 'true' || v === 1;
}

function splitBom(text) {
  const s = text == null ? '' : String(text);
  if (s.charCodeAt(0) === 0xfeff) {
    return { bom: '\uFEFF', rest: s.slice(1) };
  }
  return { bom: '', rest: s };
}

function detectLineEnding(content) {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

function normalizeToLF(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function normalizeForFuzzyMatch(text) {
  return String(text)
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function lineStartOffsets(hay) {
  const starts = [0];
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function findFuzzySpans(hayLf, needleLf) {
  const needleNorm = normalizeForFuzzyMatch(needleLf);
  if (!needleNorm) return [];
  const hLines = hayLf.split('\n');
  const nCount = needleLf.split('\n').length;
  if (nCount < 1 || nCount > hLines.length) return [];
  const starts = lineStartOffsets(hayLf);
  const spans = [];
  for (let i = 0; i + nCount - 1 < hLines.length; i++) {
    const slice = hLines.slice(i, i + nCount).join('\n');
    if (normalizeForFuzzyMatch(slice) !== needleNorm) continue;
    const start = starts[i] != null ? starts[i] : 0;
    spans.push({ start, end: start + slice.length });
  }
  return spans;
}

function parseEditsField(raw) {
  if (raw == null || raw === '') return { ok: true, edits: [] };
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
        errorCode: 'FS_EDIT_BAD_EDITS',
        error: 'edits 不是合法 JSON',
        suggestedFix: 'edits 须为数组，每项含 oldText/newText（或 oldString/newString）'
      };
    }
  }
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') {
      value = [value];
    } else {
      return {
        ok: false,
        errorCode: 'FS_EDIT_BAD_EDITS',
        error: 'edits 必须是数组',
        suggestedFix: '多个不相交改动放在 edits[]，均对原文件匹配'
      };
    }
  }
  const edits = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const oldText = item.oldText != null ? item.oldText : item.oldString != null ? item.oldString : item.old_string;
    const newText = item.newText != null ? item.newText : item.newString != null ? item.newString : item.new_string;
    const replaceAll = item.replaceAll != null ? item.replaceAll : item.replace_all;
    edits.push({ oldText, newText, replaceAll });
  }
  return { ok: true, edits };
}

function normalizeEditArgs(args) {
  const a = args && typeof args === 'object' ? { ...args } : {};
  if (!a.filePath) a.filePath = a.path || a.file || a.filename;
  if (a.oldString == null) a.oldString = a.old_string;
  if (a.newString == null) a.newString = a.new_string;
  if (a.replaceAll == null) a.replaceAll = a.replace_all;
  a.replaceAll = isReplaceAllFlag(a.replaceAll);
  if (a.edits == null) a.edits = a.replacements;
  return a;
}

/**
 * @returns {{ ok: true, filePath?: string, edits: Array<{oldText: string, newText: *, replaceAll?: boolean}> } | { ok: false, error: string, errorCode: string, suggestedFix?: string }}
 */
function collectFileEdits(args) {
  const a = normalizeEditArgs(args);
  const parsed = parseEditsField(a.edits);
  if (!parsed.ok) return parsed;
  const edits = parsed.edits.slice();
  if (typeof a.oldString === 'string' && a.oldString.length && typeof a.newString === 'string') {
    edits.push({ oldText: a.oldString, newText: a.newString, replaceAll: a.replaceAll });
  }
  if (!edits.length) {
    return {
      ok: false,
      errorCode: 'FS_EDIT_EMPTY_OLD',
      error: '缺少 oldString / edits。请从最近一次 fs_read_file 原文复制要替换的片段',
      suggestedFix: '提供 oldString+newString，或 edits[{oldText,newText}]'
    };
  }
  return { ok: true, filePath: a.filePath, edits };
}

function failEmptyOld() {
  return {
    ok: false,
    errorCode: 'FS_EDIT_EMPTY_OLD',
    error: 'oldString 不能为空',
    suggestedFix: '从最近一次 fs_read_file 原文复制要替换的片段；多处改动用 edits[]，每条 oldText 尽量短但须唯一'
  };
}

/**
 * Apply one or more replacements against the original file contents.
 * @returns {{ ok: true, text: string, replacements: number } | { ok: false, error: string, errorCode: string, suggestedFix?: string, occurrences?: number }}
 */
function applyFileEdits(text, edits) {
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) return failEmptyOld();

  const { bom, rest } = splitBom(text);
  const ending = detectLineEnding(rest);
  const hayLf = normalizeToLF(rest);
  const resolved = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const oldText = item.oldText;
    const newText = item.newText;
    if (typeof oldText !== 'string' || !oldText.length) {
      return failEmptyOld();
    }
    if (typeof newText !== 'string') {
      return {
        ok: false,
        errorCode: 'FS_EDIT_INVALID_NEW',
        error: 'newString 必须是字符串'
      };
    }
    const needleLf = normalizeToLF(oldText);
    const nextNewLf = normalizeToLF(newText);
    if (needleLf === nextNewLf) {
      return {
        ok: false,
        errorCode: 'FS_EDIT_NO_CHANGE',
        error: 'oldString 与 newString 相同'
      };
    }

    const replaceAll = list.length === 1 && isReplaceAllFlag(item.replaceAll);
    let spans = findExactSpans(hayLf, needleLf);
    if (!spans.length) {
      spans = findFuzzySpans(hayLf, needleLf);
    }
    if (!spans.length) {
      return {
        ok: false,
        errorCode: 'FS_EDIT_NOT_FOUND',
        error: `第 ${i + 1} 处 oldText 在文件中未找到。各 edits 均对原文件匹配，不要依赖前一处改动。`,
        suggestedFix: '从最近一次 fs_read_file 原样复制；oldText 尽量短但须唯一，不要垫大段未改区域。可用轻度模糊（引号/破折号/行尾空白）'
      };
    }
    if (!replaceAll && spans.length > 1) {
      return {
        ok: false,
        errorCode: 'FS_EDIT_NOT_UNIQUE',
        error: `第 ${i + 1} 处 oldText 匹配 ${spans.length} 处。请扩大上下文使替换唯一，或单处改动时设 replaceAll=true。`,
        occurrences: spans.length,
        suggestedFix: '加入前后若干行使 oldText 唯一；同一文件多处不相交改动放入一次 fs_edit 的 edits[]'
      };
    }
    const useSpans = replaceAll ? spans : [spans[0]];
    for (const span of useSpans) {
      resolved.push({ start: span.start, end: span.end, newText: nextNewLf, index: i });
    }
  }

  const ordered = resolved.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      return {
        ok: false,
        errorCode: 'FS_EDIT_OVERLAP',
        error: 'edits 存在重叠或嵌套。每条 oldText 对原文件匹配且不得重叠；邻近改动请合并为一条。',
        suggestedFix: '把同一块的改动合成一个 oldText/newText'
      };
    }
  }

  let out = hayLf;
  for (const span of resolved.slice().sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + span.newText + out.slice(span.end);
  }
  return {
    ok: true,
    text: bom + restoreLineEndings(out, ending),
    replacements: resolved.length
  };
}

function applyEditFromArgs(text, args) {
  const collected = collectFileEdits(args);
  if (!collected.ok) return collected;
  return applyFileEdits(text, collected.edits);
}

/**
 * @returns {{ ok: true, text: string, replacements: number } | { ok: false, error: string, errorCode: string, suggestedFix?: string, occurrences?: number }}
 */
function applyStrReplace(text, oldString, newString, replaceAll) {
  return applyFileEdits(text, [{ oldText: oldString, newText: newString, replaceAll }]);
}

module.exports = {
  applyStrReplace,
  applyFileEdits,
  applyEditFromArgs,
  collectFileEdits,
  normalizeEditArgs,
  normalizeForFuzzyMatch,
  countLiteralOccurrences,
  alignNewlines,
  withAltNewlines
};
