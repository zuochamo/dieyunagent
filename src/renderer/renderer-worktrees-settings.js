/* global window, document, $, showAgentToast, getPendingWorktreeApply, escapeHtml */
'use strict';

const WORKTREE_CLEANUP_KEY = 'dieyun.worktrees.cleanup.v1';
const DEFAULT_WORKTREE_CLEANUP = { maxRuns: 25, maxSizeGb: 0 };

const worktreesApi = window.diecloud || {};

function loadWorktreeCleanupSettings() {
  try {
    const raw = window.localStorage.getItem(WORKTREE_CLEANUP_KEY);
    if (!raw) return { ...DEFAULT_WORKTREE_CLEANUP };
    const parsed = JSON.parse(raw);
    return {
      maxRuns: Math.max(0, Number(parsed.maxRuns) || DEFAULT_WORKTREE_CLEANUP.maxRuns),
      maxSizeGb: Math.max(0, Number(parsed.maxSizeGb) || 0)
    };
  } catch {
    return { ...DEFAULT_WORKTREE_CLEANUP };
  }
}

function saveWorktreeCleanupSettings(next) {
  const out = {
    maxRuns: Math.max(0, Number(next.maxRuns) || DEFAULT_WORKTREE_CLEANUP.maxRuns),
    maxSizeGb: Math.max(0, Number(next.maxSizeGb) || 0)
  };
  window.localStorage.setItem(WORKTREE_CLEANUP_KEY, JSON.stringify(out));
  return out;
}

function formatWorktreeBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWorktreeTime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '—';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return '—';
  }
}

function protectedWorktreeRunIds() {
  const ids = [];
  if (typeof getPendingWorktreeApply === 'function') {
    const pending = getPendingWorktreeApply();
    if (pending && pending.runId) ids.push(String(pending.runId));
  }
  return ids;
}

async function maybeEnforceWorktreeCleanupPolicy() {
  if (typeof worktreesApi.worktreeEnforceCleanup !== 'function') return null;
  const settings = loadWorktreeCleanupSettings();
  if (settings.maxRuns <= 0 && settings.maxSizeGb <= 0) return null;
  try {
    return await worktreesApi.worktreeEnforceCleanup({
      maxRuns: settings.maxRuns > 0 ? settings.maxRuns : 0,
      maxSizeGb: settings.maxSizeGb,
      protectedRunIds: protectedWorktreeRunIds()
    });
  } catch (err) {
    console.warn('worktree cleanup policy', err);
    return null;
  }
}

function setWorktreesSettingsHint(text) {
  const el = $('worktrees-settings-hint');
  if (el) el.textContent = text || '';
}

function bindWorktreeStepper(inputId, minusId, plusId, onChange) {
  const input = $(inputId);
  const minus = $(minusId);
  const plus = $(plusId);
  if (!input) return;
  const apply = () => {
    if (typeof onChange === 'function') onChange(Number(input.value) || 0);
  };
  input.addEventListener('change', apply);
  if (minus) {
    minus.addEventListener('click', () => {
      const min = Number(input.min) || 0;
      const step = Number(input.step) || 1;
      input.value = String(Math.max(min, (Number(input.value) || 0) - step));
      apply();
    });
  }
  if (plus) {
    plus.addEventListener('click', () => {
      const max = Number(input.max) || 999;
      const step = Number(input.step) || 1;
      input.value = String(Math.min(max, (Number(input.value) || 0) + step));
      apply();
    });
  }
}

function readWorktreeCleanupForm() {
  const maxRunsEl = $('worktrees-max-runs');
  const maxSizeEl = $('worktrees-max-size-gb');
  return saveWorktreeCleanupSettings({
    maxRuns: maxRunsEl ? Number(maxRunsEl.value) : DEFAULT_WORKTREE_CLEANUP.maxRuns,
    maxSizeGb: maxSizeEl ? Number(maxSizeEl.value) : 0
  });
}

function worktreeListStatusMessage(payload) {
  if (!payload) return '无法加载';
  if (payload.ok) return '';
  switch (payload.code) {
    case 'no_workspace':
    case 'remote_workspace':
      return '暂无 worktree';
    case 'path_missing':
      return '工作空间路径无效';
    default:
      return payload.error ? String(payload.error) : '无法加载';
  }
}

function renderWorktreeRunsList(payload) {
  const listEl = $('worktrees-run-list');
  const summaryEl = $('worktrees-run-summary');
  if (!listEl) return;

  if (!payload || !payload.ok) {
    listEl.innerHTML =
      '<div class="worktrees-empty">' + escapeHtml(worktreeListStatusMessage(payload)) + '</div>';
    if (summaryEl) summaryEl.textContent = '';
    return;
  }

  const runs = payload.runs || [];
  if (summaryEl) {
    summaryEl.textContent = runs.length
      ? `共 ${runs.length} 个 run · 合计 ${formatWorktreeBytes(payload.totalBytes || 0)}`
      : '当前工作空间无遗留 worktree';
  }

  if (!runs.length) {
    listEl.innerHTML = '<div class="worktrees-empty">当前工作空间没有 Plan worktree 副本。</div>';
    return;
  }

  listEl.replaceChildren();
  const protectedIds = new Set(protectedWorktreeRunIds());

  for (const run of runs) {
    const row = document.createElement('div');
    row.className = 'worktrees-run-row';

    const main = document.createElement('div');
    main.className = 'worktrees-run-main';

    const title = document.createElement('div');
    title.className = 'worktrees-run-title';
    title.textContent = run.runId;
    if (protectedIds.has(String(run.runId))) {
      const tag = document.createElement('span');
      tag.className = 'worktrees-run-tag';
      tag.textContent = '待审';
      title.appendChild(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'worktrees-run-meta';
    const workerN = (run.workers || []).length;
    meta.textContent = `${formatWorktreeBytes(run.bytes)} · ${workerN} 个执行器 · ${formatWorktreeTime(run.mtimeMs)}`;

    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'worktrees-run-actions';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ghost-btn worktrees-run-delete';
    delBtn.textContent = '删除';
    delBtn.title = '删除此 run 的全部 worktree 副本';
    delBtn.addEventListener('click', () => {
      void removeWorktreeRun(run.runId);
    });

    actions.appendChild(delBtn);
    row.append(main, actions);
    listEl.appendChild(row);
  }
}

async function refreshWorktreesSettingsPanel(opts = {}) {
  const repoEl = $('worktrees-repo-path');
  const fromUser = !!opts.fromUser;
  if (typeof worktreesApi.worktreeListManaged !== 'function') {
    renderWorktreeRunsList({ ok: false, error: '接口不可用，请重启应用' });
    if (fromUser) {
      showAgentToast('Worktree', '接口不可用，请重启应用', { variant: 'error' });
    }
    return;
  }
  setWorktreesSettingsHint('加载中…');
  try {
    const payload = await worktreesApi.worktreeListManaged();
    const pathText = payload.repoPath ? String(payload.repoPath) : '';
    if (repoEl) {
      if (pathText) {
        repoEl.textContent = pathText;
        repoEl.title = pathText;
      } else if (payload.code === 'remote_workspace') {
        repoEl.textContent = pathText || payload.error || '远程工作空间';
        repoEl.title = pathText || '';
      } else {
        repoEl.textContent = '未设置工作空间';
        repoEl.title = '';
      }
    }
    renderWorktreeRunsList(payload);
    if (payload.ok) {
      const runs = payload.runs || [];
      const summary = runs.length
        ? `共 ${runs.length} 个 run · ${formatWorktreeBytes(payload.totalBytes || 0)}`
        : '当前无遗留 worktree';
      setWorktreesSettingsHint('已刷新');
      if (fromUser) {
        showAgentToast('Worktree 列表已刷新', summary, { variant: 'info', duration: 2200 });
      }
    } else {
      setWorktreesSettingsHint('已刷新');
      if (fromUser) {
        showAgentToast(payload.error || '无法加载列表', '详见 帮助 → 使用说明 → Worktree', {
          variant: payload.code === 'remote_workspace' ? 'warn' : 'error',
          duration: 3200
        });
      }
    }
  } catch (err) {
    renderWorktreeRunsList({ ok: false, error: err.message || String(err) });
    setWorktreesSettingsHint('');
    if (fromUser) {
      showAgentToast('刷新失败', err.message || String(err), { variant: 'error' });
    }
  }
}

async function removeWorktreeRun(runId) {
  const id = String(runId || '').trim();
  if (!id) return;
  const protectedIds = protectedWorktreeRunIds();
  if (protectedIds.includes(id)) {
    showAgentToast('无法删除', '该 run 仍在「变更」待审，请先在侧栏应用或放弃', { variant: 'warn' });
    return;
  }
  if (typeof worktreesApi.worktreeCleanupRun !== 'function') return;
  setWorktreesSettingsHint('删除中…');
  try {
    await worktreesApi.worktreeCleanupRun(id);
    await maybeEnforceWorktreeCleanupPolicy();
    await refreshWorktreesSettingsPanel();
    showAgentToast('已删除', `worktree run ${id}`, { variant: 'info', duration: 2400 });
  } catch (err) {
    setWorktreesSettingsHint('');
    showAgentToast('删除失败', err.message || String(err), { variant: 'error' });
  }
}

async function saveWorktreeCleanupAndEnforce() {
  readWorktreeCleanupForm();
  setWorktreesSettingsHint('保存中…');
  try {
    const result = await maybeEnforceWorktreeCleanupPolicy();
    await refreshWorktreesSettingsPanel();
    const removedN = result && result.removed ? result.removed.length : 0;
    setWorktreesSettingsHint(removedN ? `已保存 · 自动清理 ${removedN} 个旧 run` : '已保存');
    showAgentToast('Worktree 设置已保存', removedN ? `已清理 ${removedN} 个旧 run` : '', {
      variant: 'success',
      duration: 2600
    });
  } catch (err) {
    setWorktreesSettingsHint('');
    showAgentToast('保存失败', err.message || String(err), { variant: 'error' });
  }
}

function syncWorktreeCleanupForm() {
  const settings = loadWorktreeCleanupSettings();
  const maxRunsEl = $('worktrees-max-runs');
  const maxSizeEl = $('worktrees-max-size-gb');
  if (maxRunsEl) maxRunsEl.value = String(settings.maxRuns);
  if (maxSizeEl) maxSizeEl.value = String(settings.maxSizeGb);
}

function onWorktreesSettingsTabShown() {
  syncWorktreeCleanupForm();
  void refreshWorktreesSettingsPanel();
}

function initWorktreesSettings() {
  syncWorktreeCleanupForm();

  bindWorktreeStepper('worktrees-max-runs', 'worktrees-max-runs-minus', 'worktrees-max-runs-plus');
  bindWorktreeStepper('worktrees-max-size-gb', 'worktrees-max-size-gb-minus', 'worktrees-max-size-gb-plus');

  $('worktrees-cleanup-save')?.addEventListener('click', () => {
    void saveWorktreeCleanupAndEnforce();
  });
  $('worktrees-refresh')?.addEventListener('click', () => {
    void refreshWorktreesSettingsPanel({ fromUser: true });
  });
  $('worktrees-enforce-now')?.addEventListener('click', () => {
    void saveWorktreeCleanupAndEnforce();
  });
}

window.initWorktreesSettings = initWorktreesSettings;
window.onWorktreesSettingsTabShown = onWorktreesSettingsTabShown;
window.maybeEnforceWorktreeCleanupPolicy = maybeEnforceWorktreeCleanupPolicy;
window.loadWorktreeCleanupSettings = loadWorktreeCleanupSettings;
