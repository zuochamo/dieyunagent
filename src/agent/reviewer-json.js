'use strict';

function closeTruncatedJson(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  let inStr = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length) stack.pop();
    }
  }
  if (inStr) s += '"';
  while (stack.length) s += stack.pop();
  return s;
}

function inferReviewerFromPartial(text) {
  const raw = String(text || '');
  const acceptedMatch = raw.match(/"accepted"\s*:\s*(true|false)/i);
  if (!acceptedMatch) return null;
  const accepted = acceptedMatch[1].toLowerCase() === 'true';
  const reasonMatch = raw.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)/);
  let reason = '';
  if (reasonMatch) {
    try {
      reason = JSON.parse(`"${reasonMatch[1]}"`);
    } catch {
      reason = reasonMatch[1];
    }
  }
  if (!reason) {
    reason = accepted ? 'Reviewer JSON 不完整，按已通过处理' : 'Reviewer JSON 被截断，按未通过处理';
  }
  return {
    accepted,
    acceptancePlan: [],
    reason,
    missing: accepted ? [] : ['Reviewer 输出不完整'],
    nextAction: accepted ? '' : '请针对用户问题给出完整答复并补齐证据'
  };
}

function reviewerToolPath(tool) {
  const args = tool && typeof tool.toolArgs === 'object' && tool.toolArgs ? tool.toolArgs : {};
  return String(
    args.filePath || args.path || args.file || tool?.filePath || tool?.path || ''
  ).trim();
}

function compactReviewerDiffSnippet(diff, maxChars) {
  const cap = Math.max(200, Number(maxChars) || 3500);
  if (!diff || typeof diff !== 'object') return '';
  const before = String(diff.beforeSnippet || diff.beforeText || '');
  const after = String(diff.afterSnippet || diff.afterText || '');
  let body = '';
  if (diff.created && !before) body += '(new file)\n';
  if (before) body += `--- before\n${before}\n`;
  if (after) body += `+++ after\n${after}`;
  body = body.trim();
  if (body.length > cap) return body.slice(0, cap) + '\n…';
  return body;
}

function collectReviewerFileDiffs(sessionChanges, trace, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles) || 12);
  const maxSnippet = Math.max(200, Number(opts.maxSnippetChars) || 3500);
  const byPath = new Map();
  const upsert = (path, diff) => {
    const p = String(path || '').trim();
    if (!p) return;
    const prev = byPath.get(p) || {
      path: p,
      added: 0,
      removed: 0,
      created: false,
      diff: ''
    };
    const d = diff && typeof diff === 'object' ? diff : null;
    if (d) {
      prev.added = Number(d.added) || prev.added;
      prev.removed = Number(d.removed) || prev.removed;
      prev.created = !!(d.created || prev.created);
      const snippet = compactReviewerDiffSnippet(d, maxSnippet);
      if (snippet && snippet.length >= String(prev.diff || '').length) prev.diff = snippet;
    }
    byPath.set(p, prev);
  };
  for (const row of Array.isArray(sessionChanges) ? sessionChanges : []) {
    upsert(row.path || row.file, row.diff);
  }
  for (const entry of Array.isArray(trace) ? trace : []) {
    for (const tool of entry.tools || []) {
      const p = reviewerToolPath(tool);
      if (p) upsert(p, tool.diff);
    }
  }
  return [...byPath.values()].slice(0, maxFiles);
}

function extractReviewerJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      return obj && typeof obj === 'object' ? obj : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf('{');
  if (start < 0) return inferReviewerFromPartial(body);
  const slice = body.slice(start);
  const end = slice.lastIndexOf('}');
  if (end > 0) {
    const sliced = tryParse(slice.slice(0, end + 1));
    if (sliced) return sliced;
  }
  const closed = tryParse(closeTruncatedJson(slice));
  if (closed) return closed;
  return inferReviewerFromPartial(slice);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    closeTruncatedJson,
    extractReviewerJson,
    inferReviewerFromPartial,
    collectReviewerFileDiffs,
    compactReviewerDiffSnippet
  };
}

if (typeof window !== 'undefined') {
  window.closeTruncatedJson = closeTruncatedJson;
  window.extractReviewerJson = extractReviewerJson;
  window.inferReviewerFromPartial = inferReviewerFromPartial;
  window.collectReviewerFileDiffs = collectReviewerFileDiffs;
}
