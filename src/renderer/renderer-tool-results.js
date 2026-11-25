/* global parseDiffFromSummary */

function formatToolArgsBrief(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'host_exec') return String(args.command || '').slice(0, 100);
  if (name === 'fs_read_file' || name === 'fs_write_file' || name === 'fs_edit' || name === 'fs_list_dir') {
    return args.filePath || args.dirPath || '';
  }
  if (name === 'read_symbol') {
    const target = args.filePath || args.file_path || args.path || '';
    const sym = args.name || args.symbol || args.query || '';
    return `${sym}${target ? ` @ ${target}` : ''}`.trim().slice(0, 120);
  }
  if (name === 'grep') return String(args.pattern || '').slice(0, 120);
  if (name === 'glob') return String(args.pattern || '').slice(0, 120);
  if (name === 'lsp') {
    const loc = args.filePath || args.file_path || args.path || '';
    return `${args.operation || ''} ${loc}:${args.line || ''}`.trim().slice(0, 120);
  }
  if (name === 'host_open_url') return args.url || '';
  if (name === 'web_fetch') return (args.url || '').slice(0, 120);
  if (name === 'web_search') {
    const eng = args.engine ? ` [${args.engine}]` : '';
    const site = args.site ? ` site:${args.site}` : '';
    const page = Number(args.page) > 1 ? ` p${args.page}` : '';
    const top = Number(args.fetchTop) > 0 ? ` +${args.fetchTop}篇` : '';
    return `${args.query || ''}${site}${page}${eng}${top}`.slice(0, 120);
  }
  if (name === 'codebase_search') return String(args.query || '').slice(0, 120);
  if (name === 'host_print_image') return args.filePath || '';
  if (name === 'computer') {
    const act = String(args.action || '');
    const pt = Array.isArray(args.coordinate) ? ` (${args.coordinate[0]}, ${args.coordinate[1]})` : '';
    const to = Array.isArray(args.to) ? `→(${args.to[0]}, ${args.to[1]})` : '';
    const detail = args.text
      ? ` ${String(args.text).slice(0, 40)}`
      : args.key
        ? ` ${String(args.key)}`
        : args.direction
          ? ` ${args.direction}`
          : '';
    return `${act}${pt}${to}${detail}`.trim().slice(0, 120);
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '';
  }
}

/**
 * 工具结果摘要的**唯一实现**是 `src/agent/tool-result-summary.js`（Main 的 planner / 子 Agent
 * 卡片也用它），经 agent-bundle 暴露成全局 `summarizeToolResult` / `summarizeHostExecResult`
 * —— 本文件**不再声明同名壳**：经典 script 的顶层函数声明会覆盖 window 上的同名属性，
 * 「壳里读 window.X」会变成自己调自己（栈溢出）。调用点（含本文件内）直接用全局名即可。
 *
 * 本文件以前自带一份 280 行的同名实现，与 Main 那份已经漂出四种不同说法
 * （后台化文案、退出码、「不像输出」正则、无输出兜底）。
 */

function isShellToolName(name) {
  const n = String(name || '').toLowerCase();
  return n === 'host_exec' || n.includes('shell') || n.includes('powershell') || n.includes('terminal');
}

function isEditToolName(name) {
  const n = String(name || '').toLowerCase();
  return (
    n === 'fs_write_file' ||
    n === 'fs.write_file' ||
    n === 'write_file' ||
    n === 'fs_edit' ||
    n === 'fs.edit_file'
  );
}

function entryHasShellTool(entry) {
  return (entry.tools || []).some((t) => isShellToolName(t.name));
}

function entryHasEditTool(entry) {
  return (entry.tools || []).some((t) => isEditToolName(t.name));
}

function compactDiffForTrace(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const out = {
    added: Number(diff.added) || 0,
    removed: Number(diff.removed) || 0,
    created: !!diff.created,
    textTruncated: !!diff.textTruncated
  };
  const snippetCap = 12000;
  if (diff.beforeSnippet != null) {
    const s = String(diff.beforeSnippet);
    out.beforeSnippet = s.length > snippetCap ? s.slice(0, snippetCap) : s;
  }
  if (diff.afterSnippet != null) {
    const s = String(diff.afterSnippet);
    out.afterSnippet = s.length > snippetCap ? s.slice(0, snippetCap) : s;
  }
  if (!diff.textTruncated) {
    if (diff.beforeText != null) {
      const t = String(diff.beforeText);
      if (t.length <= 120000) out.beforeText = t;
    }
    if (diff.afterText != null) {
      const t = String(diff.afterText);
      if (t.length <= 120000) out.afterText = t;
    }
  }
  return out;
}

function toolDiffHasBody(diff) {
  if (!diff || typeof diff !== 'object') return false;
  return (
    diff.beforeText != null ||
    diff.afterText != null ||
    diff.beforeSnippet != null ||
    diff.afterSnippet != null ||
    !!diff.created
  );
}

function pickDiffDisplayText(diff, side) {
  if (!diff) return '';
  if (side === 'before') {
    if (diff.beforeText != null) return String(diff.beforeText);
    if (diff.created) return '';
    if (diff.beforeSnippet != null) return String(diff.beforeSnippet);
    return '';
  }
  if (diff.afterText != null) return String(diff.afterText);
  if (diff.afterSnippet != null) return String(diff.afterSnippet);
  return '';
}

function parseDiffStatsFromSummary(summary) {
  const m = String(summary || '').match(/\+(\d+)\s+-(\d+)/);
  if (!m) return null;
  return {
    added: Number(m[1]) || 0,
    removed: Number(m[2]) || 0
  };
}

/**
 * +/- 行差异统计的单一来源：`src/gateway/line-diff-stats.js`（Main 侧 remote-fs / rpc /
 * remote minimal host 也用它），经 agent-bundle 暴露成 `window.computeLineDiffStats`。
 *
 * 本文件以前自己写了一份 LCS：**不裁公共前后缀**、按 `'\n'` 切（CRLF 文件的每行都不同 →
 * 整份文件算成全改）、超上限时用 `max(0, m-n)` 兜底。于是同一个写文件动作，
 * 徽标（Renderer 算）与工具回包（Main 算）会给出两个数。
 */
function resolveLineDiffApi() {
  var pick = function (name) {
    return typeof window !== 'undefined' ? window[name] : undefined;
  };
  var api = {
    computeLineDiffStats: pick('computeLineDiffStats'),
    withinLineDiffBudget: pick('withinLineDiffBudget')
  };
  if (typeof api.computeLineDiffStats !== 'function' || typeof api.withinLineDiffBudget !== 'function') {
    throw new Error(
      'agent-bundle 未加载：renderer-tool-results 需要 window.computeLineDiffStats / window.withinLineDiffBudget'
    );
  }
  return api;
}


function buildLineDiffOps(beforeText, afterText) {
  const oldLines = String(beforeText ?? '').split(/\r?\n/);
  const newLines = String(afterText ?? '').split(/\r?\n/);
  const n = oldLines.length;
  const m = newLines.length;
  if (!resolveLineDiffApi().withinLineDiffBudget(n, m)) return null;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'eq', line: oldLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', line: newLines[j - 1] });
      j -= 1;
    } else {
      ops.push({ type: 'del', line: oldLines[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

function formatInlineUnifiedDiffHtml(beforeText, afterText, opts) {
  const escape =
    opts && typeof opts.escapeHtml === 'function'
      ? opts.escapeHtml
      : typeof escapeHtml === 'function'
        ? escapeHtml
        : (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const contextLines = opts && opts.contextLines != null ? Number(opts.contextLines) : 3;
  const ops = buildLineDiffOps(beforeText, afterText);
  if (!ops || !ops.length) {
    return '<div class="artifacts-empty">无 diff 内容</div>';
  }
  const show = new Set();
  ops.forEach((op, idx) => {
    if (op.type === 'eq') return;
    for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k++) {
      show.add(k);
    }
  });
  if (!show.size) {
    return '<div class="artifacts-empty">无 diff 内容</div>';
  }
  const indices = [...show].sort((a, b) => a - b);
  let html = '';
  let prev = -2;
  for (const idx of indices) {
    if (idx > prev + 1) {
      html += '<div class="diff-line diff-gap">…</div>';
    }
    const op = ops[idx];
    const cls =
      op.type === 'add' ? 'diff-add' : op.type === 'del' ? 'diff-del' : 'diff-eq';
    const prefix = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
    html += `<div class="diff-line ${cls}">${escape(prefix + op.line)}</div>`;
    prev = idx;
  }
  return html;
}

function formatAgentsMdSideBySideDiffHtml(beforeText, afterText, opts) {
  const escape =
    opts && typeof opts.escapeHtml === 'function'
      ? opts.escapeHtml
      : typeof escapeHtml === 'function'
        ? escapeHtml
        : (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const before = String(beforeText ?? '').slice(0, 24000);
  const after = String(afterText ?? '').slice(0, 24000);
  const ops = buildLineDiffOps(before, after);
  if (!ops || !ops.length) {
    return { beforeHtml: escape(before), afterHtml: escape(after) };
  }
  const lineHtml = (line, cls) => {
    const content = line ? escape(line) : '&nbsp;';
    return `<div class="agents-md-diff-line ${cls}">${content}</div>`;
  };
  let beforeHtml = '';
  let afterHtml = '';
  for (const op of ops) {
    if (op.type === 'eq') {
      beforeHtml += lineHtml(op.line, 'diff-eq');
      afterHtml += lineHtml(op.line, 'diff-eq');
    } else if (op.type === 'del') {
      beforeHtml += lineHtml(op.line, 'diff-del');
      afterHtml += lineHtml('', 'diff-pad');
    } else if (op.type === 'add') {
      beforeHtml += lineHtml('', 'diff-pad');
      afterHtml += lineHtml(op.line, 'diff-add');
    }
  }
  return { beforeHtml, afterHtml };
}

window.formatAgentsMdSideBySideDiffHtml = formatAgentsMdSideBySideDiffHtml;

function isPlausibleArtifactPath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.length > 480) return false;
  if (/[\r\n]/.test(p)) return false;
  if (/^[\s+\->@]/.test(p)) return false;
  if (/^(const|let|var|function|import|export|class|return)\b/.test(p)) return false;
  if ((p.match(/\s/g) || []).length > 2) return false;
  const hasSep = /[\\/]/.test(p);
  const hasExt = /\.[a-zA-Z0-9]{1,16}$/.test(p);
  const simpleFile = /^[\w.-]+$/.test(p) && hasExt;
  return hasSep || simpleFile;
}

function editToolFilePath(tool) {
  if (!tool) return '';
  const args =
    typeof window.resolveToolArgsFromTrace === 'function'
      ? window.resolveToolArgsFromTrace(tool)
      : { ...(tool.args || {}), ...(tool.toolArgs || {}) };
  const fromResult =
    tool.result && typeof tool.result === 'object'
      ? String(tool.result.path || tool.result.filePath || '')
      : '';
  let raw = String(fromResult || args.filePath || args.path || tool.filePath || tool.path || '')
    .trim()
    .replace(/\s+→[\s\S]*$/, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  if (!raw) {
    const brief = String(tool.argsBrief || '').trim();
    if (brief && !brief.startsWith('{') && !brief.startsWith('[')) {
      raw = brief.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
    } else if (brief.startsWith('{')) {
      const partial =
        typeof window.extractPathFieldsFromArgsBrief === 'function'
          ? window.extractPathFieldsFromArgsBrief(brief)
          : {};
      raw = String(partial.filePath || partial.path || '').trim();
    }
  }
  if (!raw && isEditToolName(tool.name)) {
    const sum = String(tool.summary || '').trim();
    const head = sum.split('·')[0].trim();
    if (head && head !== sum) raw = head;
  }
  return isPlausibleArtifactPath(raw) ? raw : '';
}

function parseWriteToolContentArg(content) {
  const rawContent = String(content ?? '');
  if (rawContent.startsWith('{') && rawContent.includes('"content"')) {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed && parsed.content != null) return String(parsed.content);
    } catch {
      // fall through
    }
  }
  return rawContent;
}

/** Build a display-ready diff object from a trace tool row (any file edit tool). */
function resolveToolDiffBody(tool) {
  if (!tool || !isEditToolName(tool.name)) return null;
  const diff = tool.diff && typeof tool.diff === 'object' ? { ...tool.diff } : {};
  if (tool.result && tool.result.diff && typeof tool.result.diff === 'object') {
    const rd = tool.result.diff;
    if (rd.beforeText != null && diff.beforeText == null) diff.beforeText = rd.beforeText;
    if (rd.afterText != null && diff.afterText == null) diff.afterText = rd.afterText;
    if (rd.beforeSnippet != null && diff.beforeSnippet == null) diff.beforeSnippet = rd.beforeSnippet;
    if (rd.afterSnippet != null && diff.afterSnippet == null) diff.afterSnippet = rd.afterSnippet;
    if (rd.created != null && diff.created == null) diff.created = rd.created;
    if (rd.textTruncated != null && diff.textTruncated == null) diff.textTruncated = rd.textTruncated;
    if (Number(rd.added) || Number(rd.removed)) {
      diff.added = Number(rd.added) || 0;
      diff.removed = Number(rd.removed) || 0;
    }
  }
  const args =
    typeof window.resolveToolArgsFromTrace === 'function'
      ? window.resolveToolArgsFromTrace(tool)
      : tool.toolArgs && typeof tool.toolArgs === 'object'
        ? tool.toolArgs
        : {};
  let beforeText = pickDiffDisplayText(diff, 'before');
  let afterText = pickDiffDisplayText(diff, 'after');
  if (!afterText && args.content != null) {
    afterText = parseWriteToolContentArg(args.content);
  }
  const hasBody =
    beforeText ||
    afterText ||
    diff.beforeSnippet != null ||
    diff.afterSnippet != null ||
    !!diff.created;
  if (!hasBody) return toolDiffHasBody(diff) ? diff : null;
  if (beforeText && diff.beforeText == null) diff.beforeText = beforeText;
  if (afterText && diff.afterText == null) diff.afterText = afterText;
  if (diff.created == null && !beforeText && afterText) diff.created = true;
  if (!(Number(diff.added) || Number(diff.removed))) {
    const stats = resolveLineDiffApi().computeLineDiffStats(beforeText, afterText);
    diff.added = stats.added;
    diff.removed = stats.removed;
  }
  return diff;
}

function canonicalArtifactPathFromTool(tool) {
  if (!tool) return '';
  const fromResult =
    tool.result && typeof tool.result === 'object'
      ? String(tool.result.path || tool.result.filePath || '').trim()
      : '';
  if (fromResult && isPlausibleArtifactPath(fromResult)) return fromResult;
  return editToolFilePath(tool);
}

function resolveArtifactDiffFromTrace(filePath, trace) {
  const rows = Array.isArray(trace)
    ? trace
    : typeof getLastAgentDisplayedTrace === 'function'
      ? getLastAgentDisplayedTrace()
      : [];
  const canon =
    typeof window.applyWorkspaceArtifactPath === 'function'
      ? window.applyWorkspaceArtifactPath.bind(window)
      : (p) => String(p || '').trim();
  const target = canon(String(filePath || '').trim());
  if (!target) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    for (const tool of rows[i].tools || []) {
      if (!isEditToolName(tool.name) || tool.failed) continue;
      const p = canon(editToolFilePath(tool));
      if (!p) continue;
      const match =
        typeof pathsMatch === 'function' ? pathsMatch(p, target) : p === target;
      if (!match) continue;
      const body = resolveToolDiffBody(tool);
      if (body && toolDiffHasBody(body)) return body;
    }
  }
  return null;
}

function resolveToolDiffStats(tool) {
  const diff = tool.diff && typeof tool.diff === 'object' ? tool.diff : null;
  if (diff && (Number(diff.added) || Number(diff.removed))) {
    return { added: Number(diff.added) || 0, removed: Number(diff.removed) || 0 };
  }
  const fromSummary = parseDiffStatsFromSummary(tool.summary);
  if (fromSummary) return fromSummary;
  if (diff) {
    const before = pickDiffDisplayText(diff, 'before');
    const after = pickDiffDisplayText(diff, 'after');
    if (before || after) return resolveLineDiffApi().computeLineDiffStats(before, after);
  }
  const writeArgs =
    typeof window.resolveToolArgsFromTrace === 'function'
      ? window.resolveToolArgsFromTrace(tool)
      : tool.toolArgs && typeof tool.toolArgs === 'object'
        ? tool.toolArgs
        : {};
  if (isEditToolName(tool.name) && writeArgs.content != null) {
    const before = diff ? pickDiffDisplayText(diff, 'before') : '';
    return resolveLineDiffApi().computeLineDiffStats(before, parseWriteToolContentArg(writeArgs.content));
  }
  return null;
}

function collectTraceEntryFileChanges(entry) {
  const byKey = new Map();
  const canon =
    typeof window.applyWorkspaceArtifactPath === 'function'
      ? window.applyWorkspaceArtifactPath.bind(window)
      : (p) => String(p || '').trim();
  for (const t of entry?.tools || []) {
    if (!isEditToolName(t.name) || t.failed) continue;
    const rawPath = editToolFilePath(t);
    if (!rawPath) continue;
    const path = canon(rawPath);
    const key =
      typeof normWritePath === 'function'
        ? normWritePath(path)
        : path.replace(/\\/g, '/').toLowerCase();
    const stats = resolveToolDiffStats(t);
    const name = path.replace(/\\/g, '/').split('/').pop() || path;
    byKey.set(key, {
      path,
      name,
      added: stats ? stats.added : null,
      removed: stats ? stats.removed : null,
      pending: !!t.pending
    });
  }
  return Array.from(byKey.values());
}

function getLastTraceEntryFileChanges(trace) {
  if (!trace || !trace.length) return [];
  return collectTraceEntryFileChanges(trace[trace.length - 1]);
}

window.isPlausibleArtifactPath = isPlausibleArtifactPath;
window.isEditToolName = isEditToolName;
window.editToolFilePath = editToolFilePath;
window.canonicalArtifactPathFromTool = canonicalArtifactPathFromTool;
window.resolveToolDiffBody = resolveToolDiffBody;
window.resolveArtifactDiffFromTrace = resolveArtifactDiffFromTrace;
window.resolveToolDiffStats = resolveToolDiffStats;
window.buildLineDiffOps = buildLineDiffOps;
window.compactDiffForTrace = compactDiffForTrace;
window.pickDiffDisplayText = pickDiffDisplayText;
window.toolDiffHasBody = toolDiffHasBody;
window.getLastTraceEntryFileChanges = getLastTraceEntryFileChanges;
window.collectTraceEntryFileChanges = collectTraceEntryFileChanges;
