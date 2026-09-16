/* global window, document, $, escapeHtml, skillsCatalog, loadEnabledSkillIds, isSkillEnabled, currentSessionId, resetDialogMaximize, showTrayBalloon, toastPreviewText, gwState, refreshHistoryList, loadChatFromGateway, scrollChatToBottom, SKILLS_GRID_PAGE_SIZE */
'use strict';

function getAutomationApi() {
  return window.diecloud || {};
}

function getAutomationGridEl() {
  return document.getElementById('automation-list');
}

let automationScheduleType = 'periodic';
let automationPlansCache = [];
let automationCategoryFilter = 'all';
let automationSearchQuery = '';
let automationPageIndex = 0;
let automationFetchSeq = 0;
let automationPlansLoaded = false;

const AUTOMATION_PAGE_SIZE =
  typeof window.SKILLS_GRID_PAGE_SIZE === 'number' ? window.SKILLS_GRID_PAGE_SIZE : 15;
const AUTOMATION_TAXONOMY_LIST = Array.isArray(window.AUTOMATION_TAXONOMY)
  ? window.AUTOMATION_TAXONOMY
  : [
      { id: 'periodic', label: '周期' },
      { id: 'interval', label: '按间隔' },
      { id: 'once', label: '单次' },
      { id: 'disabled', label: '已停用' }
    ];

function setAutomationHint(msg) {
  const el = $('automation-hint');
  if (el) el.textContent = msg || '';
}

function scheduleLabelPlan(plan) {
  if (plan.onceAt) {
    try {
      return `单次 · ${new Date(plan.onceAt).toLocaleString('zh-CN')}`;
    } catch {
      return `单次 · ${plan.onceAt}`;
    }
  }
  return plan.rrule || '—';
}

function automationPlanDesc(plan) {
  const prompt = String(plan.prompt || '').trim();
  if (prompt) {
    return prompt.length > 72 ? `${prompt.slice(0, 72)}…` : prompt;
  }
  return scheduleLabelPlan(plan);
}

function automationPlanHint(plan) {
  const schedule = scheduleLabelPlan(plan);
  const sessionNote = plan.deliver?.sessionId
    ? ` · 会话 …${String(plan.deliver.sessionId).slice(-10)}`
    : '';
  if (plan.lastRunAt) {
    const status = plan.lastRunOk ? '上次成功' : '上次失败';
    const when = new Date(plan.lastRunAt).toLocaleString('zh-CN');
    const summary = plan.lastRunSummary ? ` · ${String(plan.lastRunSummary).slice(0, 36)}` : '';
    return `${status} ${when}${summary}${sessionNote}`;
  }
  if (promptInPlan(plan)) return `${schedule}${sessionNote}`;
  return sessionNote ? `点击卡片编辑${sessionNote}` : '点击卡片编辑';
}

function promptInPlan(plan) {
  return !!String(plan.prompt || '').trim();
}

function resolveAutomationCategory(plan) {
  if (!plan || plan.enabled === false) return 'disabled';
  if (plan.onceAt) return 'once';
  const r = String(plan.rrule || '').toUpperCase();
  if (r.includes('MINUTELY') || r.includes('FREQ=HOURLY')) return 'interval';
  return 'periodic';
}

function automationSearchHaystack(plan) {
  return [
    plan.id,
    plan.name,
    plan.prompt,
    plan.rrule,
    plan.onceAt,
    plan.lastRunSummary,
    scheduleLabelPlan(plan)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getFilteredAutomationPlans() {
  const q = automationSearchQuery.trim().toLowerCase();
  let list = automationPlansCache.slice();
  if (automationCategoryFilter !== 'all') {
    list = list.filter((p) => resolveAutomationCategory(p) === automationCategoryFilter);
  }
  if (q) {
    list = list.filter((p) => automationSearchHaystack(p).includes(q));
  }
  list.sort((a, b) => {
    const ea = a.enabled ? 1 : 0;
    const eb = b.enabled ? 1 : 0;
    if (eb !== ea) return eb - ea;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN');
  });
  return list;
}

function countAutomationInCategory(catId) {
  if (catId === 'all') return automationPlansCache.length;
  return automationPlansCache.filter((p) => resolveAutomationCategory(p) === catId).length;
}

function renderAutomationCategoryTabs() {
  const renderTabs = window.renderGridCategoryTabs;
  if (typeof renderTabs !== 'function') return;
  renderTabs(
    document.getElementById('automation-category-tabs') || $('automation-category-tabs'),
    automationCategoryFilter,
    AUTOMATION_TAXONOMY_LIST,
    countAutomationInCategory,
    (id) => {
      automationCategoryFilter = id;
      automationPageIndex = 0;
      renderAutomationCategoryTabs();
      renderAutomationGrid();
    }
  );
}

function renderAutomationGrid() {
  const grid = getAutomationGridEl();
  if (!grid) return;
  if (!automationPlansLoaded) return;
  if (!automationPlansCache.length) {
    grid.innerHTML = '<div class="skills-empty">暂无定时任务，请点击「添加」。</div>';
    if (typeof window.updateGridPagination === 'function') window.updateGridPagination('automation', 0, 0, 0);
    return;
  }
  const visible = getFilteredAutomationPlans();
  if (!visible.length) {
    const hint = automationSearchQuery.trim()
      ? '没有匹配的任务，请调整搜索或分类'
      : '当前分类下暂无任务';
    grid.innerHTML = `<div class="skills-empty">${escapeHtml(hint)}</div>`;
    if (typeof window.updateGridPagination === 'function') window.updateGridPagination('automation', 0, 0, 0);
    return;
  }
  const pageCount = Math.max(1, Math.ceil(visible.length / AUTOMATION_PAGE_SIZE));
  if (automationPageIndex >= pageCount) automationPageIndex = pageCount - 1;
  if (automationPageIndex < 0) automationPageIndex = 0;
  const slice = visible.slice(
    automationPageIndex * AUTOMATION_PAGE_SIZE,
    automationPageIndex * AUTOMATION_PAGE_SIZE + AUTOMATION_PAGE_SIZE
  );
  grid.innerHTML = '';
  for (const plan of slice) {
    const on = !!plan.enabled;
    const tile = document.createElement('article');
    tile.className = `skill-tile automation-tile${on ? ' enabled' : ''}`;
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.title = '点击编辑计划';
    tile.innerHTML = `
        <div class="skill-tile-head">
          <div class="skill-tile-title">${escapeHtml(plan.name || '未命名计划')}</div>
        </div>
        <p class="skill-tile-desc">${escapeHtml(automationPlanDesc(plan))}</p>
        <p class="skill-tile-hint">${escapeHtml(automationPlanHint(plan))}</p>
        <div class="skill-tile-foot automation-tile-foot">
          <label>
            <input type="checkbox" ${on ? 'checked' : ''} />
            <span>${on ? '已启用' : '启用'}</span>
          </label>
          <span class="automation-tile-actions">
            <button type="button" class="skill-tile-delete automation-run" title="立即运行">运行</button>
            <button type="button" class="skill-tile-delete automation-del" title="删除">删除</button>
          </span>
        </div>`;
    wireAutomationTile(tile, plan);
    grid.appendChild(tile);
  }
  if (typeof window.updateGridPagination === 'function') {
    window.updateGridPagination('automation', automationPageIndex, pageCount, visible.length);
  }
}

function buildScheduleFromForm() {
  const manual = ($('plan-rrule')?.value || '').trim();
  if (manual) return { rrule: manual, onceAt: '' };
  if (automationScheduleType === 'once') {
    const raw = $('automation-run-at')?.value || '';
    return {
      rrule: '',
      onceAt: raw ? new Date(raw).toISOString() : ''
    };
  }
  if (automationScheduleType === 'interval') {
    const n = Math.max(5, Number($('automation-interval-min')?.value) || 60);
    return { rrule: `FREQ=MINUTELY;INTERVAL=${n}`, onceAt: '' };
  }
  const [h, m] = ($('automation-daily-time')?.value || '09:00').split(':');
  const hour = Number(h) || 9;
  const minute = Number(m) || 0;
  if (($('automation-periodic-unit')?.value || 'day') === 'week') {
    const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const wd = days[Number($('automation-week-day')?.value) || 1] || 'MO';
    return { rrule: `FREQ=WEEKLY;BYDAY=${wd};BYHOUR=${hour};BYMINUTE=${minute}`, onceAt: '' };
  }
  return { rrule: `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`, onceAt: '' };
}

function parseTodoText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
}

function wireAutomationTile(tile, plan) {
  tile.querySelector('.skill-tile-foot')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const cb = tile.querySelector('input[type="checkbox"]');
  if (cb) {
    cb.addEventListener('change', async (e) => {
      e.stopPropagation();
      cb.disabled = true;
      try {
        await getAutomationApi().plansSave({ ...plan, enabled: cb.checked });
        await refreshAutomationList();
      } catch (err) {
        cb.checked = !cb.checked;
        setAutomationHint(`启用失败：${err.message || err}`);
      } finally {
        cb.disabled = false;
      }
    });
  }

  tile.querySelector('.automation-run')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setAutomationHint('执行中…');
    try {
      const r = await getAutomationApi().plansRunNow(plan.id);
      setAutomationHint(r.ok ? '执行完成' : `失败：${r.error || ''}`);
      await refreshAutomationList();
    } catch (err) {
      setAutomationHint(`失败：${err.message || err}`);
    }
  });

  tile.querySelector('.automation-del')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除计划「${plan.name || plan.id}」？`)) return;
    try {
      await getAutomationApi().plansDelete(plan.id);
      await refreshAutomationList();
    } catch (err) {
      setAutomationHint(`删除失败：${err.message || err}`);
    }
  });

  const openEditor = () => openAutomationEditor(plan.id);
  tile.addEventListener('click', openEditor);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEditor();
    }
  });
}

async function fetchAutomationPlans() {
  const api = getAutomationApi();
  if (!api.plansList) throw new Error('计划 API 不可用');
  const timeoutMs = 15000;
  let timer;
  try {
    return await Promise.race([
      api.plansList(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('加载超时，请重试')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshAutomationList() {
  const grid = getAutomationGridEl();
  if (!grid) return;
  const api = getAutomationApi();
  if (!api.plansList) {
    automationPlansLoaded = true;
    automationPlansCache = [];
    grid.innerHTML = '<div class="skills-empty">计划 API 不可用</div>';
    if (typeof window.updateGridPagination === 'function') window.updateGridPagination('automation', 0, 0, 0);
    return;
  }
  const seq = ++automationFetchSeq;
  grid.innerHTML = '<div class="skills-empty">加载中…</div>';
  try {
    const plans = await fetchAutomationPlans();
    if (seq !== automationFetchSeq) return;
    automationPlansLoaded = true;
    automationPlansCache = Array.isArray(plans) ? plans : [];
    renderAutomationCategoryTabs();
    renderAutomationGrid();
  } catch (e) {
    if (seq !== automationFetchSeq) return;
    automationPlansLoaded = true;
    automationPlansCache = [];
    grid.innerHTML = `<div class="skills-empty">加载失败：${escapeHtml(e.message || e)}</div>`;
    if (typeof window.updateGridPagination === 'function') window.updateGridPagination('automation', 0, 0, 0);
  }
}

function activateAutomationTab() {
  renderAutomationCategoryTabs();
  return refreshAutomationList();
}

function setAutomationScheduleType(type) {
  automationScheduleType = type || 'periodic';
  document.querySelectorAll('.automation-schedule-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.schedule === automationScheduleType);
  });
  document.querySelectorAll('.automation-schedule-panel').forEach((el) => {
    el.classList.toggle('active', el.dataset.schedulePanel === automationScheduleType);
  });
}

async function populateAutomationSkillSelect(selectedId) {
  const sel = $('automation-skill-id');
  if (!sel) return;
  const prev = selectedId != null ? selectedId : sel.value;
  sel.innerHTML = '<option value="">不关联技能</option>';
  try {
    const catalog = window.skillsCatalog;
    if (!catalog?.skills?.length && getAutomationApi().scanSkills) {
      window.skillsCatalog = await getAutomationApi().scanSkills();
    }
    const enabled = loadEnabledSkillIds();
    for (const sk of (window.skillsCatalog?.skills || [])) {
      if (!isSkillEnabled(enabled, sk.id)) continue;
      const opt = document.createElement('option');
      opt.value = sk.id;
      opt.textContent = sk.name || sk.id;
      sel.appendChild(opt);
    }
  } catch {
    // ignore
  }
  if (prev) sel.value = prev;
}

function openAutomationEditor(taskId) {
  const overlay = $('automation-editor-overlay');
  if (!overlay) return;
  const title = $('automation-editor-title');
  $('automation-edit-id').value = taskId || '';
  if (title) title.textContent = taskId ? '编辑计划' : '添加计划';
  const fillPlan = (p) => {
    $('automation-name').value = p.name;
    $('plan-rrule').value = p.rrule || '';
    $('automation-prompt').value = p.prompt || '';
    $('automation-todos').value = Array.isArray(p.todos) ? p.todos.join('\n') : '';
    $('automation-enabled').checked = !!p.enabled;
    if (p.onceAt) {
      setAutomationScheduleType('once');
      if ($('automation-run-at')) $('automation-run-at').value = p.onceAt.slice(0, 16);
    } else {
      setAutomationScheduleType('periodic');
    }
    populateAutomationSkillSelect((p.skillIds && p.skillIds[0]) || '').catch(() => {});
  };
  if (!taskId) {
    $('automation-editor-form')?.reset();
    $('automation-enabled').checked = true;
    $('automation-daily-time').value = '09:00';
    $('automation-interval-min').value = '60';
    if ($('plan-rrule')) $('plan-rrule').value = '';
    if ($('automation-todos')) $('automation-todos').value = '';
    setAutomationScheduleType('periodic');
    populateAutomationSkillSelect('').catch(() => {});
  } else {
    getAutomationApi().plansList().then((plans) => {
      const p = plans.find((x) => x.id === taskId);
      if (p) fillPlan(p);
    });
  }
  overlay.hidden = false;
}

function closeAutomationEditor() {
  const overlay = $('automation-editor-overlay');
  if (overlay) overlay.hidden = true;
  resetDialogMaximize('automation-editor-overlay', 'automation-editor-max');
}

function collectAutomationForm() {
  const id = $('automation-edit-id')?.value || '';
  const sched = buildScheduleFromForm();
  return {
    id: id || undefined,
    name: $('automation-name')?.value || '未命名计划',
    prompt: $('automation-prompt')?.value || '',
    todos: parseTodoText($('automation-todos')?.value || ''),
    rrule: sched.rrule,
    onceAt: sched.onceAt,
    tz: 'Asia/Shanghai',
    dtstart: new Date().toISOString(),
    enabled: $('automation-enabled')?.checked !== false,
    skillIds: (() => {
      const sid = $('automation-skill-id')?.value || '';
      return sid ? [sid] : [];
    })(),
    deliver: {
      type: 'session',
      sessionId: ''
    }
  };
}

function initAutomationUI() {
  $('automation-add')?.addEventListener('click', () => openAutomationEditor(null));
  $('automation-editor-cancel')?.addEventListener('click', closeAutomationEditor);
  $('automation-editor-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'automation-editor-overlay') closeAutomationEditor();
  });
  $('automation-editor-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await getAutomationApi().plansSave(collectAutomationForm());
      closeAutomationEditor();
      setAutomationHint('已保存');
      await refreshAutomationList();
    } catch (err) {
      setAutomationHint(`保存失败：${err.message || err}`);
    }
  });
  $('automation-periodic-unit')?.addEventListener('change', () => {
    const weekEl = $('automation-week-day');
    if (weekEl) weekEl.hidden = $('automation-periodic-unit')?.value !== 'week';
  });
  document.querySelectorAll('.automation-schedule-tab').forEach((el) => {
    el.addEventListener('click', () => setAutomationScheduleType(el.dataset.schedule));
  });
  if (getAutomationApi().onPlanRan) {
    getAutomationApi().onPlanRan((payload) => {
      handlePlanRan(payload);
    });
  }

  if (typeof window.bindGridSearchInput === 'function') {
    window.bindGridSearchInput(
      'automation-search',
      () => automationSearchQuery,
      (v) => {
        automationSearchQuery = v;
      },
      () => automationPageIndex,
      (v) => {
        automationPageIndex = v;
      },
      () => renderAutomationGrid()
    );
  }
  if (typeof window.bindGridPagination === 'function') {
    window.bindGridPagination(
      'automation',
      () => automationPageIndex,
      (v) => {
        automationPageIndex = v;
      },
      () => renderAutomationGrid()
    );
  }
}

window.renderAutomationCategoryTabs = renderAutomationCategoryTabs;
window.renderAutomationGrid = renderAutomationGrid;
window.refreshAutomationList = refreshAutomationList;
window.activateAutomationTab = activateAutomationTab;
window.initAutomationUI = initAutomationUI;
window.closeAutomationEditor = closeAutomationEditor;

async function handlePlanRan(payload) {
  await refreshAutomationList().catch(() => {});
  const planName = (payload && payload.planName) || '定时任务';
  const ok = !payload || payload.ok !== false;
  showTrayBalloon(
    ok ? `计划完成 · ${planName}` : `计划失败 · ${planName}`,
    toastPreviewText(payload && (payload.summary || payload.error))
  );
  const sessionId = payload && payload.sessionId;
  if (!sessionId || !gwState.authed) return;
  await refreshHistoryList().catch(() => {});
  if (sessionId === currentSessionId) {
    await loadChatFromGateway(null, currentSessionId).catch(() => {});
    scrollChatToBottom();
  }
}
