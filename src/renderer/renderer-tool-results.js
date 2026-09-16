/* global parseDiffFromSummary */

function formatToolArgsBrief(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'sql_query') {
    const sql = String(args.sql || '').replace(/\s+/g, ' ').trim();
    const db = args.database ? `[${args.database}] ` : '';
    const cut = sql.length > 120 ? `${sql.slice(0, 120)}…` : sql;
    return `${db}${cut}`;
  }
  if (name === 'sql_list_tables') return args.database || '';
  if (name === 'sql_list_databases') return '';
  if (name === 'host_exec') return String(args.command || '').slice(0, 100);
  if (name === 'fs_read_file' || name === 'fs_write_file' || name === 'fs_edit' || name === 'fs_list_dir') {
    return args.filePath || args.dirPath || '';
  }
  if (name === 'read_symbol') {
    const target = args.filePath || args.file_path || args.path || '';
    const sym = args.name || args.symbol || args.query || '';
    return `${sym}${target ? ` @ ${target}` : ''}`.trim().slice(0, 120);
  }
  if (name === 'grep') return String(args.pattern || args.query || '').slice(0, 120);
  if (name === 'glob') return String(args.pattern || '').slice(0, 120);
  if (name === 'lsp') {
    const loc = args.filePath || args.file_path || args.path || '';
    return `${args.operation || ''} ${loc}:${args.line || ''}`.trim().slice(0, 120);
  }
  if (name === 'host_open_url') return args.url || '';
  if (name === 'web_fetch') return (args.url || '').slice(0, 120);
  if (name === 'web_search') {
    const eng = args.engine ? ` [${args.engine}]` : '';
    return `${args.query || ''}${eng}`.slice(0, 120);
  }
  if (name === 'codebase_search') return String(args.query || '').slice(0, 120);
  if (name === 'host_print_image') return args.filePath || '';
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '';
  }
}

function summarizeHostExecResult(result, error) {
  if (error) return `错误: ${String(error).slice(0, 160)}`;
  if (!result || typeof result !== 'object') return '完成';
  if (result.detached) {
    const pid = result.pid != null ? ` PID ${result.pid}` : '';
    return String(result.stdout || `已后台启动${pid}`).slice(0, 120);
  }
  const exit = result.code != null ? result.code : result.exitCode;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr && exit != null && exit !== 0) {
    return `exit ${exit} · ${stderr.slice(0, 80)}`;
  }
  const out = String(result.stdout ?? result.output ?? '').trim();
  if (out) {
    if ((/^\/\*|^#|^import |^<!DOCTYPE|^<html[\s>]/i.test(out) || out.includes('{')) && out.length > 80) {
      return exit != null && exit !== 0 ? `exit ${exit}` : `exit ${exit ?? 0} · 输出 ${out.length} 字`;
    }
    if (/^(True|False|OK|null|None)$/i.test(out)) return `exit ${exit ?? 0} · ${out}`;
    return out.length > 100 ? `${out.slice(0, 100)}…` : out;
  }
  if (stderr) return stderr.length > 100 ? `${stderr.slice(0, 100)}…` : stderr;
  return exit != null ? (exit === 0 ? 'exit 0' : `exit ${exit}`) : '命令成功（无输出）';
}

function summarizeToolResult(name, result) {
  if (!result || typeof result !== 'object') return '完成';
  if (result.error) {
    const code = result.errorCode ? `[${result.errorCode}] ` : '';
    const fix = result.suggestedFix ? ` · ${result.suggestedFix}` : '';
    return `失败：${code}${String(result.error).slice(0, 120)}${fix}`;
  }
  if (name === 'host_exec') return summarizeHostExecResult(result, null);
  if ((name === 'fs_write_file' || name === 'fs_edit') && result.path) {
    const file = String(result.path).replace(/\\/g, '/').split('/').pop() || result.path;
    const diff = result.diff
      ? ` · +${Number(result.diff.added) || 0} -${Number(result.diff.removed) || 0}`
      : '';
    const n = Number(result.replacements);
    const repl = name === 'fs_edit' && Number.isFinite(n) && n > 0 ? ` · ${n} 处` : '';
    return `${file}${result.diff?.created ? ' · 新建' : name === 'fs_edit' ? ' · 已替换' : ' · 已写入'}${diff}${repl}`;
  }
  if (name === 'sql_query') {
    const n = result.rowCount != null ? result.rowCount : (result.rows && result.rows.length) || 0;
    const trunc = result.truncated ? '（已截断）' : '';
    return `返回 ${n} 行${trunc}`;
  }
  if (name === 'sql_list_databases' && result.databases) {
    return `${result.databases.length} 个库`;
  }
  if (name === 'sql_list_tables' && result.tables) {
    return `${result.tables.length} 张表`;
  }
  if (name === 'fs_list_dir' && result.entries) return `${result.entries.length} 项`;
  if (result.stdout != null) {
    const out = String(result.stdout).trim();
    if (out) return out.slice(0, 100);
    return result.exitCode === 0 ? '命令成功（无输出）' : `exit ${result.exitCode ?? 0}`;
  }
  if (name === 'agent_clarify' && (result.selectedIds || result.freeText)) {
    const parts = [];
    if (result.selectedIds?.length) {
      parts.push(`已选：${(result.labels || result.selectedIds).join('、')}`);
    }
    if (result.freeText) {
      const note = String(result.freeText).trim();
      parts.push(`补充：${note.length > 80 ? `${note.slice(0, 80)}…` : note}`);
    }
    return parts.join(' · ') || '已确认';
  }
  if ((name === 'playbook_propose' || name === 'agents_md_propose') && result.message) {
    return String(result.message).slice(0, 120);
  }
  if (name === 'web_fetch' || name === 'web_search') {
    if (result.error) return `失败：${String(result.error).slice(0, 120)}`;
    if (name === 'web_search' && result.resultCount != null) {
      const n = Number(result.resultCount) || 0;
      const suffix = result.truncated ? '（已截断）' : '';
      return `${n} 个结果 · ${result.length || 0} 字${suffix}`;
    }
    if (result.text != null) {
      const n = result.length != null ? result.length : result.text.length;
      const trunc = result.truncated ? '（已截断）' : '';
      return `${n} 字${trunc}`;
    }
  }
  if (name === 'browser_navigate' && result.url) {
    const eng = result.engine ? ` · ${result.engine}` : '';
    const ch = result.channel ? `/${result.channel}` : '';
    const note = result.note ? ` · ${String(result.note).slice(0, 60)}` : '';
    return `${result.title || result.url}${eng}${ch}${note}`;
  }
  if (name === 'browser_reload' || name === 'browser_back' || name === 'browser_forward') {
    if (result.error) return `${name.replace('browser_', '')} 失败：${String(result.error).slice(0, 80)}`;
    return `${name.replace('browser_', '')} → ${(result.title || result.url || '').slice(0, 80)}`;
  }
  if (name === 'browser_import_storage') {
    if (result.cancelled) return '用户取消导入';
    if (result.error) return `导入失败：${String(result.error).slice(0, 80)}`;
    const c = result.cookies?.applied != null ? `Cookie ${result.cookies.applied}` : '';
    const ls = result.localStorage?.applied != null ? `localStorage ${result.localStorage.applied}` : '';
    return ['已导入', c, ls].filter(Boolean).join(' · ');
  }
  if (name === 'browser_snapshot' && result.elements) {
    const epoch = result.refEpoch != null ? ` · epoch ${result.refEpoch}` : '';
    const iframeNote = Array.isArray(result.blockedIframes) && result.blockedIframes.length
      ? ` · ${result.blockedIframes.length} 个跨域 iframe`
      : '';
    return `${result.elements.length} 个元素 · ${(result.title || result.url || '').slice(0, 60)}${epoch}${iframeNote}`;
  }
  if (name === 'browser_a11y_snapshot' && Array.isArray(result.nodes)) {
    const src = result.source ? ` · ${result.source}` : '';
    return `${result.count || result.nodes.length} 个 a11y 节点${src} · ${(result.title || result.url || '').slice(0, 60)}`;
  }
  if (name === 'browser_network' && Array.isArray(result.entries)) {
    if (result.cleared) return '已清空网络记录';
    const failed = result.entries.filter((e) => e.failed || (e.status != null && e.status >= 400)).length;
    return `${result.count} 条请求${failed ? ` · ${failed} 条异常` : ''}`;
  }
  if (name === 'browser_console' && Array.isArray(result.entries)) {
    if (result.cleared) return '已清空 console 记录';
    const errors = result.errorCount || 0;
    return `${result.count} 条${errors ? ` · ${errors} 条 error` : ''}`;
  }
  if (name === 'browser_click' || name === 'browser_double_click' || name === 'browser_right_click' || name === 'browser_fill' || name === 'browser_type' || name === 'browser_select_option' || name === 'browser_hover' || name === 'browser_drag' || name === 'browser_scroll' || name === 'browser_press_key') {
    if (result.error) return `失败：${String(result.error).slice(0, 80)}`;
    return result.ok === false ? '失败' : '完成';
  }
  if (name === 'browser_visual_diff') {
    if (result.error) return `比较失败：${String(result.error).slice(0, 80)}`;
    if (result.baselineCreated) return '已创建视觉基准';
    if (result.dimensionChanged) return '尺寸变化（视口/内容高度不同）';
    const pct = Number(result.changedPercent) || 0;
    return result.changed ? `画面有变化 · ${pct}% 像素` : `画面无显著变化（${pct}%）`;
  }
  if (name === 'browser_expect') {
    if (result.error) return `断言失败：${String(result.error).slice(0, 80)}`;
    const total = Number(result.total) || 0;
    const failed = Number(result.failed) || 0;
    if (!total) return '断言未执行';
    return failed ? `断言 ${total - failed}/${total} 通过 · ${failed} 条未通过` : `断言全部通过（${total} 条）`;
  }
  if (name === 'browser_viewport') {
    if (result.error) return `设置失败：${String(result.error).slice(0, 80)}`;
    if (result.reset && !result.viewport) return '已恢复默认视口';
    const v = result.viewport;
    if (!v) return '视口已更新';
    const mirrored = result.mirroredTo ? ` · 已同步 ${result.mirroredTo}` : '';
    return `视口 ${v.width}×${v.height}${v.mobile ? ' · 移动端' : ''}${mirrored}`;
  }
  if (name === 'browser_screenshot' && (result.base64 || result.base64Omitted || result.mime === 'image/png')) {
    const size = `${result.width || '?'}×${result.height || '?'}`;
    if (result.saveError) return `截图 ${size} · 保存失败：${String(result.saveError).slice(0, 40)}`;
    if (result.path) return `截图 ${size} · 已存 ${String(result.path).split(/[\\/]/).pop()}`;
    if (result.renderHealth && result.renderHealth.likelyBlank) {
      return `截图 ${size} · 画面疑似全黑`;
    }
    return `截图 ${size} · PNG`;
  }
  if (name === 'browser_pdf') {
    if (result.error) return `导出失败：${String(result.error).slice(0, 80)}`;
    const fileName = String(result.path || '').split(/[\\/]/).pop();
    const size = result.bytes ? `${Math.round(result.bytes / 1024)}KB · ` : '';
    return `PDF ${size}${fileName || ''}`;
  }
  if (name === 'browser_evaluate') {
    if (result.error) return `执行失败：${String(result.error).slice(0, 80)}`;
    if (result.ok === false) return '脚本报错';
    const len = result.json ? String(result.json).length : 0;
    return `返回 ${result.type || 'value'}${len ? ` · ${len} 字符` : ''}${result.truncated ? ' · 已截断' : ''}`;
  }
  if (name === 'browser_export_storage') {
    if (result.cancelled) return '已取消导出登录态';
    if (result.error) return `导出失败：${String(result.error).slice(0, 80)}`;
    const parts = [];
    if (result.cookieCount != null) parts.push(`Cookie ${result.cookieCount} 条`);
    if (result.localStorageCount != null) parts.push(`localStorage ${result.localStorageCount} 项`);
    if (!parts.length && result.localStorageError) return `导出失败：${String(result.localStorageError).slice(0, 60)}`;
    return `已导出 ${parts.join(' · ') || '登录态'}`;
  }
  if (name === 'browser_cookies') {
    if (result.error) return `Cookie 操作失败：${String(result.error).slice(0, 80)}`;
    const action = result.action || 'list';
    if (action === 'list') return `Cookie ${result.count || 0} 条${result.truncated ? ' · 已截断' : ''}`;
    if (action === 'set') return `已写入 Cookie ${result.applied != null ? result.applied : 0} 条`;
    return `已删除 Cookie ${result.removed != null ? result.removed : 0} 条`;
  }
  if (name === 'browser_dialog') {
    if (result.error) return `对话框处理失败：${String(result.error).slice(0, 80)}`;
    if (result.action === 'policy') return `对话框策略：${result.policy || 'auto'}`;
    if (result.pending) {
      return `当前 ${result.pending.type}：${String(result.pending.message || '').slice(0, 40)}`;
    }
    return `对话框 ${result.count || 0} 条`;
  }
  if (name === 'browser_route') {
    if (result.error) return `请求改写失败：${String(result.error).slice(0, 80)}`;
    if (result.action === 'add') {
      const rule = result.added || {};
      return `已加规则 ${rule.id || ''} · ${rule.type || ''} ${String(rule.urlPattern || '').slice(0, 30)}`;
    }
    if (result.action === 'remove') return `已删除规则 ${result.removed || ''}`;
    if (result.action === 'clear') return '已清空请求改写规则';
    return `请求改写规则 ${Array.isArray(result.routes) ? result.routes.length : 0} 条`;
  }
  if (name === 'browser_emulate') {
    if (result.error) return `设备/权限模拟失败：${String(result.error).slice(0, 80)}`;
    if (result.action === 'reset') return '已重置设备/权限模拟';
    const bits = [];
    if (result.geolocation) bits.push('定位');
    if (result.timezone) bits.push(result.timezone);
    if (result.locale) bits.push(result.locale);
    if (Array.isArray(result.permissions) && result.permissions.length) {
      bits.push(`权限 ${result.permissions.length}`);
    }
    return bits.length ? `已模拟 ${bits.join(' · ')}` : '设备/权限模拟：无变更';
  }
  if (name === 'browser_har_export') {
    if (result.error) return `导出失败：${String(result.error).slice(0, 80)}`;
    const fileName = String(result.path || '').split(/[\\/]/).pop();
    return `HAR ${result.count || 0} 条请求 · ${fileName || ''}`;
  }
  if (name === 'browser_wait_for') {
    if (result.error) return `等待失败：${String(result.error).slice(0, 80)}`;
    return result.ok === false ? '等待超时' : `已等待到 ${result.kind || result.selector || result.url || result.matched || '条件'}`;
  }
  if (name === 'browser_tabs' && result.tabs) {
    return `${result.tabs.length} 个标签 · 当前 ${result.activeTabId || '-'}`;
  }
  if (name === 'browser_downloads') {
    const dl = result.download || (Array.isArray(result.downloads) ? result.downloads[result.downloads.length - 1] : null);
    if (dl) return `${dl.status || 'download'} · ${dl.fileName || dl.path || ''}`;
    return '暂无下载';
  }
  if (name === 'browser_upload_file') {
    if (result.error) return `上传失败：${String(result.error).slice(0, 80)}`;
    return result.ok === false ? '上传失败' : `已上传 ${result.fileName || result.filePath || result.path || '文件'}`;
  }
  if (name === 'browser_observe') {
    const shot = result.screenshot ? ` · 截图 ${result.screenshot.width || '?'}×${result.screenshot.height || '?'}` : '';
    const blank = result.renderHealth && result.renderHealth.likelyBlank ? ' · 画面疑似全黑' : '';
    const fb = result.fallbackFrom ? ` · fallback ${result.fallbackFrom}->${result.engine || '?'}` : '';
    return `${Array.isArray(result.elements) ? result.elements.length : 0} 个元素 · ${(result.title || result.url || '').slice(0, 60)}${shot}${blank}${fb}`;
  }
  if (name === 'browser_status' && result.browserview) {
    const v = result.browserview;
    const blank = v.renderHealth && v.renderHealth.likelyBlank ? ' · 画面疑似全黑' : '';
    return `${v.title || v.url || '空闲'} · ${result.activeEngine || ''}${blank}`;
  }
  if (name === 'browser_close') return '已关闭';
  if (name === 'codebase_search') {
    if (result.error) return `失败：${String(result.error).slice(0, 120)}`;
    const n = Array.isArray(result.results) ? result.results.length : 0;
    return `${n} 个代码片段${result.vectorSearch ? ' · 向量' : ''}`;
  }
  if (name === 'grep') {
    if (result.error) return `失败：${String(result.error).slice(0, 120)}`;
    const n = Array.isArray(result.matches) ? result.matches.length : 0;
    return `${n} 处匹配${result.truncated ? ' · 已截断' : ''}`;
  }
  if (name === 'glob') {
    if (result.error) return `失败：${String(result.error).slice(0, 120)}`;
    const n = Array.isArray(result.files) ? result.files.length : 0;
    return `${n} 个文件${result.truncated ? ' · 已截断' : ''}`;
  }
  if (name === 'lsp') {
    if (result.error) return String(result.errorCode || result.error).slice(0, 120);
    if (result.kind === 'hover') return result.hover ? 'hover' : '无 hover';
    const n = Array.isArray(result.locations) ? result.locations.length : 0;
    return `${n} 个位置`;
  }
  return '完成';
}

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

const LINE_DIFF_MAX_LINE_SUM = 4000;
const LINE_DIFF_MAX_LINE_PRODUCT = 400000;

function computeLineDiffStats(beforeText, afterText) {
  const oldLines = String(beforeText ?? '').split('\n');
  const newLines = String(afterText ?? '').split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n === m && oldLines.every((line, i) => line === newLines[i])) {
    return { added: 0, removed: 0 };
  }
  if (n * m > LINE_DIFF_MAX_LINE_PRODUCT || n + m > LINE_DIFF_MAX_LINE_SUM) {
    return { added: Math.max(0, m - n), removed: Math.max(0, n - m) };
  }
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = 0;
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[m];
  return { added: m - lcs, removed: n - lcs };
}

function buildLineDiffOps(beforeText, afterText) {
  const oldLines = String(beforeText ?? '').split('\n');
  const newLines = String(afterText ?? '').split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > LINE_DIFF_MAX_LINE_PRODUCT || n + m > LINE_DIFF_MAX_LINE_SUM) return null;
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
    const stats = computeLineDiffStats(beforeText, afterText);
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
    if (before || after) return computeLineDiffStats(before, after);
  }
  const writeArgs =
    typeof window.resolveToolArgsFromTrace === 'function'
      ? window.resolveToolArgsFromTrace(tool)
      : tool.toolArgs && typeof tool.toolArgs === 'object'
        ? tool.toolArgs
        : {};
  if (isEditToolName(tool.name) && writeArgs.content != null) {
    const before = diff ? pickDiffDisplayText(diff, 'before') : '';
    return computeLineDiffStats(before, parseWriteToolContentArg(writeArgs.content));
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
window.computeLineDiffStats = computeLineDiffStats;
window.buildLineDiffOps = buildLineDiffOps;
window.compactDiffForTrace = compactDiffForTrace;
window.pickDiffDisplayText = pickDiffDisplayText;
window.toolDiffHasBody = toolDiffHasBody;
window.getLastTraceEntryFileChanges = getLastTraceEntryFileChanges;
window.collectTraceEntryFileChanges = collectTraceEntryFileChanges;
