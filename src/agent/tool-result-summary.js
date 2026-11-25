'use strict';

/**
 * 工具结果 → 思考区那一行摘要 —— **唯一实现**（Main 与 Renderer 共用）。
 *
 * 为什么在这里：同一块思考区里，桌面主循环的工具行由 Renderer 摘要，planner / 并发子 Agent 的
 * 工具行由 Main 的 `live-loop-trace` 摘要（`rust-planner-runner.js` 用 createLiveLoopTraceTracker）。
 * 以前两处各写一份，已经漂出四种不同说法：同一个后台化的长命令一边显示「已后台启动 PID 123」、
 * 一边显示「转后台继续运行（hostproc-7）」；一边保留真实退出码、一边压成 exit 0；
 * 一边认 `import` 开头为「不像输出」、一边不认；无输出兜底一边「完成」一边「命令成功（无输出）」。
 *
 * 合并口径（保留信息更多的一侧）：
 * - 后台化的判据统一为 `(result.timedOut && result.stillRunning) || result.detached`（两个字段名都是真实存在的）；
 * - 非零退出码一律保留真实值，不再压成 exit 0；
 * - 「看起来不像输出」的正则取并集（`/*` `#` `import ` `<!DOCTYPE` `<html`）；
 * - 无输出兜底用「命令成功（无输出）」（比「完成」能说明「确实执行了、没有输出」）。
 *
 * 纯函数：只吃 `name` + `result` 对象（外加可选的独立 `error` 字符串），不碰 DOM / fs / electron。
 */

/**
 * 后台化（长命令转后台继续跑）的**唯一判据**。
 * 主循环用 `timedOut && stillRunning` 表达，宿主 exec 用 `detached` 表达 —— 同一件事两个字段名，
 * 以前两边各判一个，于是同一次运行在两处界面给出「转后台继续运行（hostproc-7）」与
 * 「已后台启动 PID 123」两种说法。
 * @param {any} result
 */
function isBackgroundedHostExec(result) {
  if (!result || typeof result !== 'object') return false;
  return !!(result.detached || (result.timedOut && result.stillRunning));
}

function summarizeHostExecResult(result, error) {
  if (error) return `错误: ${String(error).slice(0, 160)}`;
  if (!result || typeof result !== 'object') return '完成';
  if (isBackgroundedHostExec(result)) {
    const handle = result.handle ? `${result.handle}` : result.pid != null ? `PID ${result.pid}` : '';
    const fallback = handle ? `已后台启动（${handle}）` : '已转后台继续运行';
    return String(result.stdout || fallback).slice(0, 120);
  }
  const exit = result.code != null ? result.code : result.exitCode;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr && exit != null && exit !== 0) {
    return `exit ${exit} · ${stderr.slice(0, 80)}`;
  }
  const out = String(result.stdout ?? result.output ?? '').trim();
  if (out) {
    // 「看起来不像用户要的输出」（注释块 / markdown 标题 / import 行 / HTML）就别原样贴。
    if ((/^\/\*|^#|^import |^<!DOCTYPE|^<html[\s>]/i.test(out) || out.includes('{')) && out.length > 80) {
      return exit != null && exit !== 0 ? `exit ${exit} · 输出 ${out.length} 字` : `exit ${exit ?? 0} · 输出 ${out.length} 字`;
    }
    if (/^(True|False|OK|null|None)$/i.test(out)) return `exit ${exit ?? 0} · ${out}`;
    return out.length > 100 ? `${out.slice(0, 100)}…` : out;
  }
  if (stderr) return stderr.length > 100 ? `${stderr.slice(0, 100)}…` : stderr;
  return exit != null ? (exit === 0 ? 'exit 0' : `exit ${exit}`) : '命令成功（无输出）';
}

/**
 * @param {string} name
 * @param {any} result
 * @param {string} [error] 独立的失败原因（Main 的 phase 事件把 error 与 result 分开给）
 */
function summarizeToolResult(name, result, error) {
  if (error) {
    const code = result && result.errorCode ? `[${result.errorCode}] ` : '';
    const fix = result && result.suggestedFix ? ` · ${result.suggestedFix}` : '';
    return `失败：${code}${String(error).slice(0, 120)}${fix}`;
  }
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
  if (name === 'agents_md_propose' && result.message) {
    return String(result.message).slice(0, 120);
  }
  if (name === 'web_fetch' || name === 'web_search') {
    if (result.error) return `失败：${String(result.error).slice(0, 120)}`;
    if (name === 'web_search' && result.resultCount != null) {
      const n = Number(result.resultCount) || 0;
      const suffix = result.truncated ? '（已截断）' : '';
      const pages =
        Array.isArray(result.pages) && result.pages.length
          ? ` · 正文 ${result.pages.filter((p) => p && p.ok).length}/${result.pages.length} 篇`
          : '';
      return `${n} 个结果${pages} · ${result.length || 0} 字${suffix}`;
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
      return `截图 ${size} · 页面未渲染（全黑且无可见内容）`;
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
    const blank = result.renderHealth && result.renderHealth.likelyBlank ? ' · 页面未渲染' : '';
    const fb = result.fallbackFrom ? ` · fallback ${result.fallbackFrom}->${result.engine || '?'}` : '';
    return `${Array.isArray(result.elements) ? result.elements.length : 0} 个元素 · ${(result.title || result.url || '').slice(0, 60)}${shot}${blank}${fb}`;
  }
  if (name === 'browser_status' && result.browserview) {
    const v = result.browserview;
    const blank = v.renderHealth && v.renderHealth.likelyBlank ? ' · 页面未渲染' : '';
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
  if (name === 'computer') {
    const parts = [String(result.action || '动作')];
    if (result.display != null) parts.push(`屏 ${result.display}`);
    if (result.screen) parts.push(`${result.screen.width}×${result.screen.height}`);
    if (result.typed != null) parts.push(`输入 ${result.typed} 字`);
    if (Array.isArray(result.windows)) parts.push(`${result.windows.length} 个窗口`);
    // 动作生效但截图失败：必须让用户看见「做了，但这一帧没截到」
    if (result.screenshotError) parts.push('动作已执行 · 截图失败');
    if (result.changed === false) parts.push('画面未变');
    if (result.stable === false) parts.push('画面仍在变');
    // wait_until：等到了没有（超时 = 等的东西没发生，是重要信号）
    if (result.timedOut === true) parts.push('等待超时');
    else if (result.waitedMs != null) parts.push(`等了 ${Math.round(result.waitedMs / 100) / 10}s`);
    if (result.activeWindow) parts.push(String(result.activeWindow).slice(0, 40));
    return parts.join(' · ');
  }
  return '完成';
}


module.exports = { summarizeToolResult, summarizeHostExecResult };
