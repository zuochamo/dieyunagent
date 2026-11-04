/* global window, document, $, uiText, setDialogMaximized, resetDialogMaximize, closeAllMenus, closeSettingsModal, closeSettingsSkillsPage, closeExecuteModal, loadCompactionStats, refreshUpdateState */
'use strict';

const helpApi = window.diecloud || {};

const HELP_TAB_TITLE_KEYS = {
  usage: ['help_usage', '使用说明'],
  stats: ['help_stats', '统计信息'],
  logs: ['help_logs', '运行日志'],
  'encoding-params': ['help_encoding_params', '编码参数'],
  about: ['help_about', '关于应用']
};

function titleFromHelpMap(key, fallback) {
  const pair = HELP_TAB_TITLE_KEYS[key];
  return pair ? uiText(pair[0], pair[1]) : fallback;
}

function switchHelpTab(tab) {
  const helpTab = tab || 'usage';
  document.querySelectorAll('.settings-nav-item[data-help-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.helpTab === helpTab);
  });
  document.querySelectorAll('.help-page').forEach((el) => {
    el.classList.toggle('active', el.dataset.helpTab === helpTab);
  });
  const titleEl = $('help-main-title');
  if (titleEl) titleEl.textContent = titleFromHelpMap(helpTab, helpTab);
  if (helpTab === 'logs') loadHelpLogs().catch(() => {});
  if (helpTab === 'about') loadHelpAbout().catch(() => {});
  if (helpTab === 'stats') {
    loadHelpToolStats().catch(() => {});
  }
  if (helpTab === 'encoding-params' && typeof renderEncodingParamsPanel === 'function') {
    renderEncodingParamsPanel();
  }
}


async function loadHelpToolStats() {
  const totalEl = $('help-harness-total');
  const successEl = $('help-harness-success');
  const repeatEl = $('help-harness-repeat');
  const retriesEl = $('help-harness-retries');
  const byToolEl = $('help-harness-by-tool');
  if (!helpApi.agentToolTelemetrySummary) {
    if (byToolEl) byToolEl.innerHTML = '<p class="model-usage-empty">Telemetry 不可用</p>';
    return;
  }
  if (byToolEl) byToolEl.innerHTML = '<p class="model-usage-empty">加载中…</p>';
  try {
    const s = await helpApi.agentToolTelemetrySummary();
    const total = s.total || 0;
    if (totalEl) totalEl.textContent = String(total);
    if (successEl) {
      successEl.textContent = total ? `${s.successRate ?? 0}% (${s.ok || 0}/${total})` : '—';
    }
    if (repeatEl) repeatEl.textContent = String(s.repeatBlocks || 0);
    if (retriesEl) retriesEl.textContent = String(s.retries || 0);

    if (byToolEl) {
      const tools = s.byTool || [];
      if (!tools.length) {
        byToolEl.innerHTML = '<p class="model-usage-empty">暂无工具调用记录</p>';
      } else {
        byToolEl.innerHTML = tools
          .map(
            (t) =>
              `<div class="help-harness-tool-row">` +
              `<span class="help-harness-tool-name" title="${escapeHelpHtml(t.tool)}">${escapeHelpHtml(t.tool)}</span>` +
              `<span class="help-harness-tool-rate">${t.successRate}%</span>` +
              `<span class="help-harness-tool-count">${t.ok}/${t.total}${t.repeatBlocks ? ` · 拦截 ${t.repeatBlocks}` : ''}</span>` +
              `</div>`
          )
          .join('');
      }
    }

    const topErr = s.topErrors || [];
    if (topErr.length && byToolEl) {
      const errHtml = topErr
      .map((e) => `<span class="help-harness-err-tag">${escapeHelpHtml(e.errorCode)} ×${e.count}</span>`)
        .join('');
      byToolEl.insertAdjacentHTML(
        'beforeend',
        `<div class="help-harness-errors"><span class="meta-label">常见错误</span>${errHtml}</div>`
      );
    }
    renderIndexUsage(s.indexUsage, s.indexInjections);
  } catch (e) {
    if (byToolEl) byToolEl.innerHTML = `<p class="model-usage-empty">加载失败: ${escapeHelpHtml(e.message || String(e))}</p>`;
  }
}

/**
 * 索引使用率（代码索引 / 结构索引）。
 *
 * 口径与分组**只来自** `src/agent/tool-telemetry.js`：
 * - `INDEX_TOOL_GROUPS`：哪些工具算「索引工具」；
 * - `describeIndexInjections`：注入那一半的口径（占比、空值）。
 * 这里只负责把后端算好的数字渲染出来，不在 Renderer 再列一遍工具名单，
 * 也不重算占比（否则两处口径迟早不一致，见 AGENTS.md 原则 1）。
 *
 * **为什么必须同时列「主动调用」和「自动注入」两半**：注入走 RPC、不进工具遥测，
 * 只列调用会把「一直在注入、所以不必调工具」读成「索引没人用」
 * （2026-11-03 实机：调用 0.6%，同期 `repo_map` 注入 833/1771 轮）。
 */
function renderIndexUsage(usage, injections) {
  const rowsEl = $('help-index-usage-rows');
  const windowEl = $('help-index-usage-window');
  if (!rowsEl) return;
  const u = usage || {};
  const total = Number(u.total) || 0;
  const groups = Array.isArray(u.groups) ? u.groups : [];
  // 工具遥测为空不等于「注入也没有」：两半是不同数据源，谁有就渲染谁
  const rows = total ? [] : ['<p class="model-usage-empty">暂无工具调用记录</p>'];
  if (windowEl) {
    const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
    windowEl.textContent = total ? `窗口 ${fmt(u.since)} ~ ${fmt(u.until)} · 共 ${total} 次调用` : '';
  }
  for (const g of groups) {
    const toolNote = (g.byTool || [])
      .filter((t) => t.calls > 0)
      .map((t) => `${escapeHelpHtml(t.tool)} ${t.calls}`)
      .join(' · ');
    const errNote = (g.topErrors || []).length
      ? `<div class="help-harness-errors"><span class="meta-label">错误</span>${g.topErrors
          .map((e) => `<span class="help-harness-err-tag">${escapeHelpHtml(e.errorCode)} ×${e.count}</span>`)
          .join('')}</div>`
      : '';
    const empty = g.calls === 0 ? '<div class="help-index-usage-zero">窗口内 0 次</div>' : '';
    rows.push(
      `<div class="help-index-usage-row">` +
        `<div class="help-index-usage-line">` +
        `<span class="help-harness-tool-name">${escapeHelpHtml(g.label)}</span>` +
        `<span class="help-index-usage-share">${g.share}%</span>` +
        `<span class="help-harness-tool-count">${g.calls} 次 · 成功 ${g.successRate}%` +
        `${toolNote ? `（${toolNote}）` : ''}</span>` +
        `</div>` +
        empty +
        errNote +
        `</div>`
    );
  }
  rows.push(...renderInjectionRows(injections));
  rowsEl.innerHTML = rows.join('');
}

/**
 * 注入那一半的两行（模板与上面工具行完全同构，不新增样式/口径）。
 * `injections` 为 null 表示 core 没起来读不到 —— 如实说「不可用」，绝不画成 0。
 */
function renderInjectionRows(injections) {
  if (!injections) {
    return [
      `<div class="help-index-usage-row">` +
        `<div class="help-index-usage-line">` +
        `<span class="help-harness-tool-name">自动注入</span>` +
        `<span class="help-index-usage-share">—</span>` +
        `<span class="help-harness-tool-count">读不到请求快照（core 未就绪）</span>` +
        `</div>` +
        `</div>`
    ];
  }
  const rounds = Number(injections.rounds) || 0;
  const denom = `${rounds} 轮`;
  const row = (label, share, count, note) =>
    `<div class="help-index-usage-row">` +
    `<div class="help-index-usage-line">` +
    `<span class="help-harness-tool-name">${escapeHelpHtml(label)}</span>` +
    `<span class="help-index-usage-share">${share}%</span>` +
    `<span class="help-harness-tool-count">${count}</span>` +
    `</div>` +
    (note ? `<div class="help-index-usage-zero">${note}</div>` : '') +
    `</div>`;
  if (!rounds) {
    return [
      row('自动注入', 0, `0/${denom}`, '还没有带索引审计的请求快照（本次改造前写入的行没有这项事实）')
    ];
  }
  return [
    row('注入 · 仓库结构图', injections.repoMapShare, `${injections.repoMap}/${denom}`),
    row(
      '注入 · 相关代码',
      injections.codeShare,
      `${injections.code}/${denom}`,
      `自动检索 ${injections.codeAuto} · @Codebase ${injections.codeExplicit}`
    )
  ];
}

function escapeHelpHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


async function loadHelpAbout() {
  const verEl = $('help-about-version');
  if (!verEl) return;
  let ver = $('meta-version')?.textContent || '';
  if (!ver && helpApi.getVersion) {
    try {
      ver = `v${await helpApi.getVersion()}`;
    } catch {
      ver = '';
    }
  }
  verEl.textContent = ver ? `版本 ${ver}` : '版本未知';
  // 更新状态行/按钮：面板可能是在后台检查完之后才打开的，回源一次拿当前阶段
  if (typeof refreshUpdateState === 'function') await refreshUpdateState();
}

async function loadHelpLogs(opts = {}) {
  const view = $('help-logs-view');
  const meta = $('help-logs-meta');
  if (!view || !helpApi.fetchAllLogs) return;
  view.textContent = '加载中…';
  if (meta && !opts.keepMeta) meta.textContent = '';
  try {
    const data = await helpApi.fetchAllLogs({ maxLinesPerFile: 500 });
    const parts = [];
    for (const sec of data.sections || []) {
      const header = `════ ${sec.label} ════\n${sec.path || ''}`;
      if (sec.missing) {
        parts.push(`${header}\n（文件不存在或尚未生成）\n`);
        continue;
      }
      if (sec.error) {
        parts.push(`${header}\n读取失败: ${sec.error}\n`);
        continue;
      }
      const body = sec.content ? sec.content : '（空）';
      const tailNote =
        sec.totalLines && sec.lineCount && sec.totalLines > sec.lineCount
          ? `\n… 仅显示末尾 ${sec.lineCount} / 共 ${sec.totalLines} 行`
          : '';
      parts.push(`${header}\n${body}${tailNote}\n`);
    }
    view.textContent = parts.join('\n') || '暂无日志';
    if (meta && data.fetchedAt && !opts.keepMeta) {
      const t = new Date(data.fetchedAt);
      const days = data.retentionDays || 3;
      meta.textContent = `已刷新 ${t.toLocaleTimeString()} · 仅保留 ${days} 天`;
    }
    view.scrollTop = view.scrollHeight;
  } catch (e) {
    view.textContent = `加载失败: ${e.message || e}`;
  }
}

function openHelpModal(tab = 'usage') {
  const overlay = $('help-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeSettingsModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  overlay.hidden = false;
  setDialogMaximized('help-overlay', 'help-max');
  switchHelpTab(tab);
}

function closeHelpModal() {
  const overlay = $('help-overlay');
  if (overlay) overlay.hidden = true;
  resetDialogMaximize('help-overlay', 'help-max');
}

function isHelpModalOpen() {
  const overlay = $('help-overlay');
  return overlay && !overlay.hidden;
}

function isSettingsModalOpen() {
  const overlay = $('settings-overlay');
  return overlay && !overlay.hidden;
}

async function cleanHelpLogs() {
  const meta = $('help-logs-meta');
  const view = $('help-logs-view');
  if (!helpApi.cleanLogs) {
    if (meta) meta.textContent = '清理接口不可用';
    return;
  }
  if (meta) meta.textContent = '清理中…';
  try {
    const r = await helpApi.cleanLogs({ all: true });
    const clearedLines = (r.results || []).reduce(
      (n, x) => n + (x.previousLines || x.removedLines || 0),
      0
    );
    const deletedArchives = (r.deletedArchives || []).length;
    if (meta) {
      meta.textContent = `已清理全部日志 · 清空 ${clearedLines} 行${deletedArchives ? ` · 删除 ${deletedArchives} 个归档文件` : ''}`;
    }
    await loadHelpLogs({ keepMeta: true });
  } catch (e) {
    if (meta) meta.textContent = `清理失败: ${e.message || e}`;
    if (view) view.textContent = `清理失败: ${e.message || e}`;
  }
}

/**
 * 清空统计数据的全部来源：本机活动统计 + 工具 Harness + 上下文压缩。
 * 清完必须把遥测重新拉一遍 —— 否则页面还停在被清空前的快照上，看着像没生效。
 * 上下文压缩区已迁到「上下文」侧栏面板，这里顺带刷它一次（不可见时也刷，成本仅一次本地文件读）。
 * 本机统计那一栏由 Main 侧清空后 pushStatus 重推，这里不用管。
 */
async function clearHelpStats() {
  const btn = $('help-stats-clear');
  if (!helpApi.clearStats) return;
  const restoreLabel = btn ? btn.textContent : '清空统计';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '清空中…';
  }
  try {
    await helpApi.clearStats();
    await Promise.all([
      loadHelpToolStats().catch(() => {}),
      typeof loadCompactionStats === 'function'
        ? loadCompactionStats({ force: true }).catch(() => {})
        : null
    ]);
    if (btn) btn.textContent = '已清空';
  } catch (e) {
    if (btn) {
      btn.textContent = '清空失败';
      btn.title = `清空失败: ${e.message || e}`;
    }
  }
  if (btn) {
    setTimeout(() => {
      btn.textContent = restoreLabel;
      btn.disabled = false;
    }, 900);
  }
}

function initHelpUI() {
  const menuHelpLogs = $('menu-help-logs');
  if (menuHelpLogs) {
    menuHelpLogs.addEventListener('click', () => openHelpModal('logs'));
  }
  const menuAbout = $('menu-about');
  if (menuAbout) {
    menuAbout.addEventListener('click', () => openHelpModal('about'));
  }
  const helpLogsRefresh = $('help-logs-refresh');
  if (helpLogsRefresh) {
    helpLogsRefresh.addEventListener('click', () => loadHelpLogs().catch(() => {}));
  }
  const helpLogsClean = $('help-logs-clean');
  if (helpLogsClean) {
    helpLogsClean.addEventListener('click', () => cleanHelpLogs().catch(() => {}));
  }
  const helpStatsClear = $('help-stats-clear');
  if (helpStatsClear) {
    helpStatsClear.addEventListener('click', () => clearHelpStats().catch(() => {}));
  }
  const helpLogsCopy = $('help-logs-copy');
  if (helpLogsCopy) {
    helpLogsCopy.addEventListener('click', async () => {
      const view = $('help-logs-view');
      const meta = $('help-logs-meta');
      const text = view?.textContent || '';
      if (!text || text === '加载中…') return;
      try {
        await navigator.clipboard.writeText(text);
        if (meta) meta.textContent = '已复制到剪贴板';
      } catch {
        if (view) {
          const range = document.createRange();
          range.selectNodeContents(view);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        if (meta) meta.textContent = '请 Ctrl+C 复制已选内容';
      }
    });
  }
  document.querySelectorAll('.settings-nav-item[data-help-tab]').forEach((el) => {
    el.addEventListener('click', () => switchHelpTab(el.dataset.helpTab));
  });
  const menuHelpTrigger = $('menu-help-trigger');
  if (menuHelpTrigger) {
    menuHelpTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openHelpModal('usage');
    });
  }
  window.addEventListener('dieyun:language-change', () => {
    const activeHelp = document.querySelector('.settings-nav-item.active[data-help-tab]');
    if (activeHelp && !$('help-overlay')?.hidden) switchHelpTab(activeHelp.dataset.helpTab || 'usage');
  });
  if (typeof initEncodingParamsUI === 'function') initEncodingParamsUI();
}
