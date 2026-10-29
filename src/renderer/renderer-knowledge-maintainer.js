/* global window, document, $, loopApi */
'use strict';

/**
 * 记忆归纳 —— **Renderer 侧只剩设置页**。
 *
 * 执行体与**触发**都在 Main（`src/agent/knowledge-maintainer.js` 唯一实现）：
 * 三个 `runRustAgentLoop` 调用点（对话 / 计划模式 / 定时计划）跑完各调一次
 * `afterAgentRun`，计划 worktree 的「应用后才归纳」也暂存在 Main。
 *
 * 所以这里**没有**：定时器、队列、冷却、记忆写入、prompt、门闩、pending 上下文与兜底超时
 * —— 那些曾经写在窗口里，切会话或关窗就停摆。本文件只做三件事：
 *   1. 读 Main 的设置与选项清单（模式 / 间隔档都由 Main 给，不再本地写第二份默认值）；
 *   2. 写设置（Main 负责落盘与重排定时器）；
 *   3. 显示上次运行结果，并把「计划 worktree 的应用结果」回给 Main。
 */

/** 设置缓存：Main 是唯一真相源，这里只是异步读回来给 UI 同步渲染 */
let knowledgeSettingsCache = null;
let knowledgeSettingsLoading = null;
let knowledgeStatusUnsubscribe = null;

function knowledgeApi() {
  return typeof loopApi === 'object' && loopApi ? loopApi : null;
}

async function hydrateKnowledgeSettings() {
  const api = knowledgeApi();
  if (!api || typeof api.agentKnowledgeSettingsGet !== 'function') return knowledgeSettingsCache;
  if (knowledgeSettingsLoading) return knowledgeSettingsLoading;
  knowledgeSettingsLoading = api
    .agentKnowledgeSettingsGet()
    .then((raw) => {
      knowledgeSettingsCache = raw && typeof raw === 'object' ? raw : null;
      renderKnowledgeConsolIntervalTabs();
      syncKnowledgeConsolControls(knowledgeSettingsCache);
      return knowledgeSettingsCache;
    })
    .catch(() => knowledgeSettingsCache)
    .finally(() => {
      knowledgeSettingsLoading = null;
    });
  return knowledgeSettingsLoading;
}

/**
 * 写设置：Main 落盘并重排定时器，返回最新设置。
 * 不做本地乐观归一 —— 归一化只有 Main 一份（`normalizeKnowledgeSettings`）。
 * @param {{mode?: string, intervalHours?: number, scopes?: object}} patch
 */
async function saveKnowledgeConsolidationSettings(patch = {}) {
  const api = knowledgeApi();
  if (!api || typeof api.agentKnowledgeSettingsSet !== 'function') return knowledgeSettingsCache;
  try {
    const saved = await api.agentKnowledgeSettingsSet(patch || {});
    if (saved && typeof saved === 'object') {
      // 写回响应不带选项清单（choices 是读接口附带的），保留旧的那份
      const choices = knowledgeSettingsCache && knowledgeSettingsCache.choices;
      knowledgeSettingsCache = choices ? { ...saved, choices } : saved;
    }
  } catch {
    // 写失败保留当前展示，下次补水会覆盖回真相
  }
  refreshKnowledgeConsolStatusUi();
  syncKnowledgeConsolControls(knowledgeSettingsCache);
  return knowledgeSettingsCache;
}

/**
 * 计划 worktree 的应用结果 → Main（`resolvePending`）。
 *
 * 三种结论：`applied`（按应用后的路径整理）/ `no_changes`（验收通过但无待合并项）/
 * 其他（用户放弃，plan 相关知识不写）。上下文与兜底超时都在 Main，所以切会话、关窗都不会丢。
 */
function reportKnowledgePlanOutcome(sessionId, outcome, extra = {}) {
  const api = knowledgeApi();
  const verdict =
    outcome === 'applied' ? 'applied' : outcome === 'no_changes' ? 'no_changes' : 'skipped';
  if (!api || typeof api.agentKnowledgePlanOutcome !== 'function') return;
  Promise.resolve(
    api.agentKnowledgePlanOutcome({
      sessionId: String(sessionId || ''),
      outcome: verdict,
      appliedPaths: verdict === 'applied' && Array.isArray(extra.appliedPaths) ? extra.appliedPaths : []
    })
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// 设置页 UI（只做展示与写入，不做执行）
// ---------------------------------------------------------------------------

/**
 * 状态只讲「有没有在跑、上次什么时候、成没成」；
 * 归纳器内部的计数（记忆+3 合并0 弃0 归档0）放进 title，不占版面。
 */
function formatKnowledgeConsolLastRun(settings) {
  if (!settings) return { text: '状态读取中…', detail: '', state: '' };
  const off = settings.mode === 'off';
  if (!settings.lastRunAt) {
    return { text: off ? '已关闭 · 尚未运行' : '尚未运行', detail: '', state: '' };
  }
  const t = new Date(settings.lastRunAt);
  let when = String(settings.lastRunAt);
  if (!Number.isNaN(t.getTime())) {
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const sameDay = t.toDateString() === new Date().toDateString();
    when = sameDay ? `今天 ${hhmm}` : `${t.getMonth() + 1}/${t.getDate()} ${hhmm}`;
  }
  const state = settings.lastRunOk === true ? 'ok' : settings.lastRunOk === false ? 'fail' : '';
  const verdict = state === 'ok' ? '成功' : state === 'fail' ? '失败' : '';
  const text = off
    ? `已关闭 · 上次 ${when}${verdict ? ` ${verdict}` : ''}`
    : `上次归纳 ${when}${verdict ? ` · ${verdict}` : ''}`;
  return { text, detail: settings.lastRunSummary ? String(settings.lastRunSummary) : '', state: off ? '' : state };
}

function refreshKnowledgeConsolStatusUi() {
  const el = typeof $ === 'function' ? $('knowledge-consol-status') : null;
  if (!el) return;
  const view = formatKnowledgeConsolLastRun(knowledgeSettingsCache);
  el.textContent = view.text;
  el.title = view.detail;
  el.classList.toggle('is-ok', view.state === 'ok');
  el.classList.toggle('is-fail', view.state === 'fail');
}

/** 状态事件（Main 定时器跑完 / 用户改设置）→ 刷新展示 */
function bindKnowledgeStatusEvents() {
  const api = knowledgeApi();
  if (knowledgeStatusUnsubscribe || !api || typeof api.onKnowledgeStatus !== 'function') return;
  knowledgeStatusUnsubscribe = api.onKnowledgeStatus((payload) => {
    if (payload && typeof payload === 'object' && 'lastRunAt' in payload) {
      knowledgeSettingsCache = {
        ...payload,
        choices: (knowledgeSettingsCache && knowledgeSettingsCache.choices) || null
      };
      refreshKnowledgeConsolStatusUi();
      syncKnowledgeConsolControls(knowledgeSettingsCache);
      return;
    }
    void hydrateKnowledgeSettings();
  });
}

function syncKnowledgeConsolModeTabs(mode) {
  document.querySelectorAll('.knowledge-consol-mode-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function syncKnowledgeConsolIntervalTabs(hours) {
  document.querySelectorAll('.knowledge-consol-interval-tab').forEach((btn) => {
    const active = Number(btn.dataset.hours) === Number(hours);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function syncKnowledgeConsolScopeChecks(scopes) {
  document.querySelectorAll('#knowledge-consol-scopes input[data-scope]').forEach((input) => {
    const key = input.dataset.scope;
    input.checked = (scopes || {})[key] !== false;
  });
}

/**
 * 归纳模式关掉后，频率与整理范围整块置灰 + 禁用：
 * 否则用户改了它们却不生效，只能靠猜为什么没用。
 */
function syncKnowledgeConsolDependents(mode) {
  const off = mode === 'off';
  for (const id of ['knowledge-consol-interval-field', 'knowledge-consol-scope-field']) {
    const field = typeof document === 'undefined' ? null : document.getElementById(id);
    if (!field) continue;
    field.classList.toggle('is-dimmed', off);
    field.querySelectorAll('button, input').forEach((el) => {
      el.disabled = off;
    });
  }
}

function syncKnowledgeConsolControls(settings) {
  if (!settings) return;
  syncKnowledgeConsolModeTabs(settings.mode);
  syncKnowledgeConsolIntervalTabs(settings.intervalHours);
  syncKnowledgeConsolScopeChecks(settings.scopes);
  syncKnowledgeConsolDependents(settings.mode);
}

function setKnowledgeConsolHint(text) {
  const el = typeof $ === 'function' ? $('knowledge-consol-hint') : null;
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }
}

/**
 * 间隔档位按 Main 下发的 `choices.intervals` 渲染。
 * 加一档只改 Main 的 `KNOWLEDGE_INTERVAL_CHOICES`，不用同时改 HTML / Renderer 校验 / Main 常量。
 */
function renderKnowledgeConsolIntervalTabs() {
  const host = typeof $ === 'function' ? $('knowledge-consol-interval-tabs') : null;
  const choices = knowledgeSettingsCache && knowledgeSettingsCache.choices;
  const intervals = Array.isArray(choices && choices.intervals) ? choices.intervals : [];
  if (!host || !intervals.length) return;
  const signature = intervals.join('|');
  if (host.dataset.rendered === signature) return;
  host.dataset.rendered = signature;
  host.textContent = '';
  for (const hours of intervals) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-segmented-tab knowledge-consol-interval-tab';
    btn.dataset.hours = String(hours);
    btn.textContent = `${hours} 小时`;
    btn.setAttribute('role', 'radio');
    host.appendChild(btn);
  }
  bindKnowledgeConsolIntervalTabs();
}

function bindKnowledgeConsolIntervalTabs() {
  document.querySelectorAll('.knowledge-consol-interval-tab').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const hours = Number(btn.dataset.hours);
      if (!(hours > 0)) return;
      const cur = knowledgeSettingsCache || {};
      if (hours === Number(cur.intervalHours)) return;
      void saveKnowledgeConsolidationSettings({ intervalHours: hours }).then(() => setKnowledgeConsolHint('已保存'));
      syncKnowledgeConsolIntervalTabs(hours);
    });
  });
}

function initKnowledgeConsolidationSettingsUI() {
  renderKnowledgeConsolIntervalTabs();
  syncKnowledgeConsolControls(knowledgeSettingsCache);
  refreshKnowledgeConsolStatusUi();
  void hydrateKnowledgeSettings();
  bindKnowledgeStatusEvents();

  document.querySelectorAll('.knowledge-consol-mode-tab').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === (knowledgeSettingsCache || {}).mode) return;
      void saveKnowledgeConsolidationSettings({ mode }).then(() => setKnowledgeConsolHint('已保存'));
      syncKnowledgeConsolModeTabs(mode);
    });
  });

  bindKnowledgeConsolIntervalTabs();

  document.querySelectorAll('#knowledge-consol-scopes input[data-scope]').forEach((input) => {
    if (input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      const scopes = { ...((knowledgeSettingsCache || {}).scopes || {}) };
      scopes[input.dataset.scope] = !!input.checked;
      void saveKnowledgeConsolidationSettings({ scopes }).then(() => setKnowledgeConsolHint('已保存'));
    });
  });
}

window.reportKnowledgePlanOutcome = reportKnowledgePlanOutcome;

window.initKnowledgeConsolidationSettingsUI = initKnowledgeConsolidationSettingsUI;

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initKnowledgeConsolidationSettingsUI();
    });
  } else {
    initKnowledgeConsolidationSettingsUI();
  }
}
