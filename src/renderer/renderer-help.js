/* global window, document, $, uiText, setDialogMaximized, resetDialogMaximize, closeAllMenus, closeSettingsModal, closeSettingsSkillsPage, closeExecuteModal, formatTokenCountFull */
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
    loadHelpCompactionStats().catch(() => {});
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
  } catch (e) {
    if (byToolEl) byToolEl.innerHTML = `<p class="model-usage-empty">加载失败: ${escapeHelpHtml(e.message || String(e))}</p>`;
  }
}

/**
 * 压缩失败的原始原因是 Rust 侧分类码，展示前翻成人话。
 * 码的唯一来源是 `crates/dieyun-core/src/compaction/llm.rs`；这里只是展示层映射，
 * 未收录的新码会原样显示（便于发现新增分类），不会被吞掉。
 */
const COMPACTION_REASON_LABELS = {
  LLM_UPSTREAM_TIMEOUT: '代理上游写超时',
  LLM_UPSTREAM_5XX: '上游服务错误',
  LLM_TIMEOUT: '请求超时',
  LLM_CONNECT: '连不上服务',
  LLM_BAD_JSON: '响应非 JSON',
  LLM_BAD_REQUEST: '请求被拒',
  LLM_AUTH: '鉴权失败',
  LLM_RATE_LIMIT: '被限流',
  LLM_EMPTY_CONTENT: '模型未输出正文',
  LLM_REASONING_ONLY: '模型只输出思考',
  LLM_HTTP: '网络错误',
  LLM_CONFIG: '模型未配置',
  content_policy: '内容审核拒绝',
  llm_error: 'LLM 调用失败'
};

/**
 * 上下文压缩统计（次数 / 动态 / 强制 / 成功率 / 失败原因）。
 * 口径见 Main 侧 `agent/compaction-telemetry.js`：一次「压缩次数」= 一次真正发起摘要 LLM 的
 * 尝试，未达触发线或仍在冷却的空转不计入 —— 所以这里的成功率不会被空转轮次稀释。
 */
async function loadHelpCompactionStats() {
  const attemptedEl = $('help-compaction-attempted');
  const autoEl = $('help-compaction-auto');
  const forcedEl = $('help-compaction-forced');
  const successEl = $('help-compaction-success');
  const failedEl = $('help-compaction-failed');
  const savedEl = $('help-compaction-saved');
  const elapsedEl = $('help-compaction-elapsed');
  const reasonsEl = $('help-compaction-reasons');
  if (!helpApi.agentCompactionTelemetrySummary) {
    if (reasonsEl) reasonsEl.innerHTML = '<p class="model-usage-empty">Telemetry 不可用</p>';
    return;
  }
  if (reasonsEl) reasonsEl.innerHTML = '<p class="model-usage-empty">加载中…</p>';
  try {
    const s = await helpApi.agentCompactionTelemetrySummary();
    const attempted = s.attempted || 0;
    if (attemptedEl) attemptedEl.textContent = String(attempted);
    if (autoEl) autoEl.textContent = String(s.auto || 0);
    if (forcedEl) forcedEl.textContent = String(s.forced || 0);
    if (successEl) {
      successEl.textContent = attempted ? `${s.successRate ?? 0}% (${s.ok || 0}/${attempted})` : '—';
    }
    if (failedEl) failedEl.textContent = String(s.failed || 0);
    if (savedEl) {
      savedEl.textContent = s.savedTokensAvg ? formatTokenCountFull(s.savedTokensAvg) : '—';
    }
    if (elapsedEl) elapsedEl.textContent = attempted ? `${s.elapsedMsAvg || 0} ms` : '—';

    if (reasonsEl) {
      const reasons = s.byReason || [];
      if (!attempted) {
        reasonsEl.innerHTML = '<p class="model-usage-empty">暂无压缩记录</p>';
      } else if (!reasons.length) {
        reasonsEl.innerHTML = '<p class="model-usage-empty">无压缩失败</p>';
      } else {
        const tags = reasons
          .map(
            (r) =>
              `<span class="help-harness-err-tag">${escapeHelpHtml(
                COMPACTION_REASON_LABELS[r.reason] || r.reason
              )} ×${r.count}</span>`
          )
          .join('');
        reasonsEl.innerHTML = `<div class="help-harness-errors"><span class="meta-label">失败原因</span>${tags}</div>`;
      }
    }
  } catch (e) {
    if (reasonsEl) {
      reasonsEl.innerHTML = `<p class="model-usage-empty">加载失败: ${escapeHelpHtml(e.message || String(e))}</p>`;
    }
  }
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
      meta.textContent = `已刷新 ${t.toLocaleTimeString()} · 仅保留 ${days} 天 · 已隐藏 SQL Server 日志`;
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

function initHelpUI() {
  const menuHelpLogs = $('menu-help-logs');
  if (menuHelpLogs) {
    menuHelpLogs.addEventListener('click', () => openHelpModal('logs'));
  }
  const menuAbout = $('menu-about');
  if (menuAbout) {
    menuAbout.addEventListener('click', () => openHelpModal('about'));
  }
  const helpOverlay = $('help-overlay');
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) closeHelpModal();
    });
  }
  const helpLogsRefresh = $('help-logs-refresh');
  if (helpLogsRefresh) {
    helpLogsRefresh.addEventListener('click', () => loadHelpLogs().catch(() => {}));
  }
  const helpLogsClean = $('help-logs-clean');
  if (helpLogsClean) {
    helpLogsClean.addEventListener('click', () => cleanHelpLogs().catch(() => {}));
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
