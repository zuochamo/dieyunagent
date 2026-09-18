/* global window, document, $, escapeHtml, skillsCatalog, loadEnabledSkillIds, isSkillEnabled, currentSessionId, resetDialogMaximize, showTrayBalloon, toastPreviewText, gwState, refreshHistoryList, loadChatFromGateway, ensureLocalGatewayReady, invalidateSessionMessageCache, scrollChatToBottom, SKILLS_GRID_PAGE_SIZE, settings, getSupplierById, isSupplierModelEnabled, builtinModelsFromSavedSuppliers, ensureSelectMenu, sessionActiveRuns, updateSessionRunProgress, dispatchAgentRunEvent, finishSessionActiveRun, mapRustAgentTrace, registerActiveAgentBackendCancel, AGENT_RUN_EVENT_TYPES, normalizeAgentRunEvent, reconcileSessionLiveRunUi, syncComposerForActiveSession, saveAssistantTraceRecord */
'use strict';

function getAutomationApi() {
  return window.diecloud || {};
}

function getAutomationGridEl() {
  return document.getElementById('automation-list');
}

let automationScheduleType = 'periodic';
let automationPlansCache = [];
/** 正在编辑的计划原值：表单里没有的字段（如投递会话）保存时必须沿用，否则编辑一次就丢一次。 */
let automationEditingPlan = null;
/**
 * 编辑中的调度快照与「用户是否真的动过」标记。
 *
 * 调度字段有两套输入：结构化控件（频率/时间/间隔/日期）与 plan-rrule 文本框。
 * 只有知道「哪一侧被用户改过」，才能在保存时决定用哪一侧，
 * 同时把界面表达不了的复杂规则（多 BYDAY、COUNT…）原样透传。
 */
let automationScheduleOrigin = { rrule: '', onceAt: '' };
let automationScheduleDirty = false;
let automationRruleEdited = false;
let automationDtstartDirty = false;
/** 编辑器回合号：回填是异步取列表的，快速连点两个计划时不能让前一次的回填后到覆盖后一次。 */
let automationEditorSeq = 0;
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
    tile.dataset.planId = String(plan.id || '');
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
  updateAutomationRunningTiles();
  if (typeof window.updateGridPagination === 'function') {
    window.updateGridPagination('automation', automationPageIndex, pageCount, visible.length);
  }
}

/** 运行态可见文案：与聊天侧「思考中」同义，只是把轮次与最新思考摊在卡片上 */
function planRunHintText(rec) {
  const rows = Array.isArray(rec?.trace) ? rec.trace : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const thought = String((last && (last.fullThought || last.thought)) || '').trim();
  const head = rec?.stopping ? '停止中…' : `运行中 · 第 ${rows.length || 1} 轮`;
  return thought ? `${head} · ${thought.slice(0, 60)}` : head;
}

/**
 * 就地刷新卡片的运行态（不重建网格）：
 * 运行中的计划每来一条 trace 都重建整格会把滚动、焦点和暂停的动画全部打回。
 */
function updateAutomationRunningTiles() {
  const grid = getAutomationGridEl();
  if (!grid) return;
  for (const tile of grid.querySelectorAll('.automation-tile[data-plan-id]')) {
    const planId = tile.dataset.planId;
    const rec = getPlanLiveRun(planId);
    const hintEl = tile.querySelector('.skill-tile-hint');
    const runBtn = tile.querySelector('.automation-run');
    if (rec) {
      tile.classList.add('running');
      tile.classList.toggle('stopping', !!rec.stopping);
      if (hintEl) hintEl.textContent = planRunHintText(rec);
      if (runBtn) {
        // 运行中时这个按钮变成「停止」：定时任务不该只能等它自己跑完
        runBtn.disabled = !!rec.stopping;
        runBtn.textContent = rec.stopping ? '停止中' : '停止';
        runBtn.title = rec.stopping ? '正在停止' : '停止本次运行';
      }
      continue;
    }
    if (!tile.classList.contains('running') && !tile.classList.contains('stopping')) continue;
    tile.classList.remove('running', 'stopping');
    const plan = automationPlansCache.find((p) => String(p.id) === planId);
    if (hintEl && plan) hintEl.textContent = automationPlanHint(plan);
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = '运行';
      runBtn.title = '立即运行';
    }
  }
}

/** 表单当前值 → 调度对象（含「生效结束」→ UNTIL）。结构化控件的唯一读取入口。 */
function readAutomationScheduleForm() {
  const time =
    typeof AUTOMATION_SCHEDULE_API.parseTimeValue === 'function'
      ? AUTOMATION_SCHEDULE_API.parseTimeValue($('automation-daily-time')?.value)
      : { hour: 9, minute: 0 };
  return {
    tab: automationScheduleType,
    unit: automationPeriodicUnitMenu?.getValue() || 'day',
    weekdayKey: automationWeekDayMenu?.getValue() || '1',
    hour: time.hour,
    minute: time.minute,
    intervalMin: $('automation-interval-min')?.value || '',
    onceAtInput: $('automation-run-at')?.value || '',
    untilDate: $('automation-date-end')?.value || ''
  };
}

/** 表单当前值 → rrule / onceAt（调度合成只有 renderer-automation-schedule.js 一份实现）。 */
function buildScheduleFromForm() {
  return AUTOMATION_SCHEDULE_API.buildAutomationRrule(readAutomationScheduleForm());
}

/**
 * 调度控件改动后把合成结果回显到 plan-rrule。
 * 文本框与结构化控件是同一份真相的两个视图，不回显会出现「时间改了、规则框里还是旧的」。
 */
function syncAutomationRrulePreview() {
  const el = $('plan-rrule');
  if (!el) return;
  el.value = buildScheduleFromForm().rrule || '';
}

function resetAutomationScheduleDirty() {
  automationScheduleDirty = false;
  automationRruleEdited = false;
  automationDtstartDirty = false;
}

/**
 * 用户改动结构化调度控件：置脏并回显 rrule。
 * 此时文本框不再代表用户意图（最后一次操作在控件上），手改标记一并清掉。
 */
function markAutomationScheduleDirty() {
  automationScheduleDirty = true;
  automationRruleEdited = false;
  syncAutomationRrulePreview();
}

/**
 * 保存时的调度取值，按「用户最后操作的是哪一侧」决定：
 * 1. 手动改过 plan-rrule → 用文本框（清空则回到结构化控件）
 * 2. 动过结构化控件 → 用表单合成
 * 3. 都没动 → 原样沿用打开编辑器时的规则（界面表达不了的复杂 rrule 必须保真）
 */
function resolveScheduleFromForm() {
  if (automationRruleEdited) {
    const manual = ($('plan-rrule')?.value || '').trim();
    return manual ? { rrule: manual, onceAt: '' } : buildScheduleFromForm();
  }
  if (automationScheduleDirty) return buildScheduleFromForm();
  const origin = automationScheduleOrigin;
  if (origin.rrule || origin.onceAt) return { rrule: origin.rrule, onceAt: origin.onceAt };
  return buildScheduleFromForm();
}

/**
 * 计划 → 表单（打开编辑器时的回填入口）。
 * 回填之后只要用户没碰调度控件，保存就原样沿用原规则；
 * 这正是「rrule 里有 BYHOUR=14 却总显示 09:00」的根因所在——回填必须双向。
 */
function applyAutomationScheduleToForm(plan) {
  const api = AUTOMATION_SCHEDULE_API;
  const state =
    typeof api.automationScheduleFromPlan === 'function'
      ? api.automationScheduleFromPlan(plan)
      : {
          tab: 'periodic',
          unit: 'day',
          weekdayKey: '1',
          hour: 9,
          minute: 0,
          intervalMin: 60,
          onceAtInput: '',
          dtstartDate: '',
          untilDate: ''
        };
  const timeEl = $('automation-daily-time');
  const intervalEl = $('automation-interval-min');
  const runAtEl = $('automation-run-at');
  const startEl = $('automation-date-start');
  const endEl = $('automation-date-end');
  if (timeEl && typeof api.timeValueOf === 'function') timeEl.value = api.timeValueOf(state.hour, state.minute);
  if (intervalEl) intervalEl.value = String(state.intervalMin || 60);
  if (runAtEl) runAtEl.value = state.onceAtInput || '';
  if (startEl) startEl.value = state.dtstartDate || '';
  if (endEl) endEl.value = state.untilDate || '';
  ensureAutomationPeriodicUnitMenu()?.setValue(state.unit);
  ensureAutomationWeekDayMenu()?.setValue(state.weekdayKey);
  syncAutomationWeekDayVisibility();
  setAutomationScheduleType(state.tab);
  const rruleEl = $('plan-rrule');
  const originRrule = String((plan && plan.rrule) || '').trim();
  if (rruleEl) rruleEl.value = originRrule;
  automationScheduleOrigin = { rrule: originRrule, onceAt: String((plan && plan.onceAt) || '').trim() };
  resetAutomationScheduleDirty();
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
    const live = getPlanLiveRun(plan.id);
    if (live) {
      if (live.stopping) return;
      live.stopping = true;
      updateAutomationRunningTiles();
      setAutomationHint('停止中…');
      try {
        const api = getAutomationApi();
        const r = api.plansCancel ? await api.plansCancel(plan.id) : { ok: false, error: '不支持停止' };
        if (!r || !r.ok) live.stopping = false;
        setAutomationHint(r && r.ok ? '已请求停止' : `停止失败：${(r && r.error) || ''}`);
      } catch (err) {
        live.stopping = false;
        setAutomationHint(`停止失败：${err.message || err}`);
      }
      updateAutomationRunningTiles();
      return;
    }
    setAutomationHint('执行中…');
    try {
      const r = await getAutomationApi().plansRunNow(plan.id);
      const stopped = !!(r && (r.aborted || r.stopped));
      setAutomationHint(stopped ? '已停止' : r && r.ok ? '执行完成' : `失败：${(r && r.error) || ''}`);
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
    syncPlanRunningFromList(automationPlansCache);
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

/**
 * 计划编辑器里的四处「实体选择」下拉统一走直角自定义下拉组件（renderer-select-menu.js）：
 * 原生 <select> 的弹出列表由系统绘制，圆角无法用 CSS 去掉，与全站直角设计冲突。
 */
const AUTOMATION_MODEL_KEEP_KEY = '__keep';

/**
 * 调度字段（频率 / 周几 / rrule 往返）只有 renderer-automation-schedule.js 一份实现，
 * 这里只取选项表，避免「界面显示 09:00、后台按 14:00 跑」这类两侧各写一套的老问题。
 */
const AUTOMATION_SCHEDULE_API = window.DieyunAutomationSchedule || {};
const AUTOMATION_PERIODIC_UNIT_OPTIONS = Array.isArray(AUTOMATION_SCHEDULE_API.PERIODIC_UNIT_OPTIONS)
  ? AUTOMATION_SCHEDULE_API.PERIODIC_UNIT_OPTIONS
  : [];
const AUTOMATION_WEEK_DAY_OPTIONS = Array.isArray(AUTOMATION_SCHEDULE_API.WEEK_DAY_OPTIONS)
  ? AUTOMATION_SCHEDULE_API.WEEK_DAY_OPTIONS
  : [];

let automationModelMenu = null;
let automationSkillMenu = null;
let automationPeriodicUnitMenu = null;
let automationWeekDayMenu = null;

function ensureAutomationModelMenu() {
  if (automationModelMenu) return automationModelMenu;
  automationModelMenu = ensureSelectMenu('automation-model', {
    placeholder: '跟随默认（Auto）',
    emptyText: '暂无可选模型'
  });
  return automationModelMenu;
}

function ensureAutomationSkillMenu() {
  if (automationSkillMenu) return automationSkillMenu;
  automationSkillMenu = ensureSelectMenu('automation-skill', {
    placeholder: '不关联技能',
    emptyText: '暂无已启用技能'
  });
  return automationSkillMenu;
}

/** 只有选「每周」时才显示星期下拉。 */
function syncAutomationWeekDayVisibility() {
  const wrap = $('automation-week-day');
  if (wrap) wrap.hidden = (automationPeriodicUnitMenu?.getValue() || 'day') !== 'week';
}

function ensureAutomationPeriodicUnitMenu() {
  if (automationPeriodicUnitMenu) return automationPeriodicUnitMenu;
  automationPeriodicUnitMenu = ensureSelectMenu('automation-periodic-unit', {
    options: AUTOMATION_PERIODIC_UNIT_OPTIONS,
    value: 'day',
    ariaLabel: '执行频率',
    // setValue 不触发 onPick，所以这里只会在用户真正选择时跑
    onPick: () => {
      syncAutomationWeekDayVisibility();
      markAutomationScheduleDirty();
    }
  });
  return automationPeriodicUnitMenu;
}

function ensureAutomationWeekDayMenu() {
  if (automationWeekDayMenu) return automationWeekDayMenu;
  automationWeekDayMenu = ensureSelectMenu('automation-week-day', {
    options: AUTOMATION_WEEK_DAY_OPTIONS,
    value: '1',
    ariaLabel: '星期',
    onPick: () => markAutomationScheduleDirty()
  });
  return automationWeekDayMenu;
}

async function populateAutomationSkillSelect(selectedId) {
  const ctl = ensureAutomationSkillMenu();
  if (!ctl) return;
  const prev = selectedId != null ? String(selectedId) : ctl.getValue();
  const items = [{ key: '', label: '不关联技能' }];
  try {
    const catalog = window.skillsCatalog;
    if (!catalog?.skills?.length && getAutomationApi().scanSkills) {
      window.skillsCatalog = await getAutomationApi().scanSkills();
    }
    const enabled = loadEnabledSkillIds();
    for (const sk of (window.skillsCatalog?.skills || [])) {
      if (!isSkillEnabled(enabled, sk.id)) continue;
      items.push({ key: sk.id, label: sk.name || sk.id });
    }
  } catch {
    // ignore
  }
  ctl.setOptions(items);
  // 与原 <select> 行为一致：绑定的技能已不在可选列表里时归零，避免保存悬挂 id
  ctl.setValue(items.some((it) => it.key === prev) ? prev : '');
}

/** 可选模型路由（与对话 Composer 同一套枚举来源）：供应商已启用模型 + 文本类自定义模型。 */
function listAutomationModelOptions() {
  const out = [];
  const seen = new Set();
  try {
    const builtins =
      typeof builtinModelsFromSavedSuppliers === 'function' ? builtinModelsFromSavedSuppliers() : [];
    for (const m of builtins) {
      const supplier = typeof getSupplierById === 'function' ? getSupplierById(m.supplierId) : null;
      if (!supplier || !isSupplierModelEnabled(supplier, m.id)) continue;
      const route = m.routeKey || `builtin:${m.supplierId}:${m.id}`;
      if (seen.has(route)) continue;
      seen.add(route);
      out.push({ key: route, route, model: m.id, label: `${m.supplierName || '供应商'} · ${m.id}` });
    }
  } catch {
    // ignore：模型列表不可用时只留「跟随默认」
  }
  for (const m of (settings && settings.customModels) || []) {
    if (!m || !m.id || !m.name || m.kind === 'speech') continue;
    const route = `custom:${m.id}`;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push({ key: route, route, model: m.name, label: `自定义 · ${m.name}` });
  }
  return out;
}

/**
 * 回填模型选择。计划绑定的路由已失效（供应商/模型被删）时保留原值并显式标注，
 * 避免「编辑一次就把计划改成跟随默认」这种静默改写。
 */
function populateAutomationModelSelect(route, model) {
  const ctl = ensureAutomationModelMenu();
  if (!ctl) return;
  const wantRoute = String(route || '').trim();
  const wantModel = String(model || '').trim();
  const options = listAutomationModelOptions();
  const items = [{ key: '', label: '跟随默认（Auto）', route: '', model: '' }];
  for (const o of options) items.push(o);
  const matched = wantRoute ? options.find((o) => o.route === wantRoute) : null;
  const byModel = !wantRoute && wantModel ? options.find((o) => o.model === wantModel) : null;
  const picked = matched || byModel;
  if (picked) {
    ctl.setOptions(items);
    ctl.setValue(picked.route);
    return;
  }
  if (wantRoute || wantModel) {
    const tail = wantRoute ? `路由 ${wantRoute}` : `模型 ${wantModel}`;
    items.push({
      key: AUTOMATION_MODEL_KEEP_KEY,
      label: `原绑定（当前不可选）：${tail}`,
      route: wantRoute,
      model: wantModel
    });
    ctl.setOptions(items);
    ctl.setValue(AUTOMATION_MODEL_KEEP_KEY);
    return;
  }
  ctl.setOptions(items);
  ctl.setValue('');
}

/** 读取模型选择：路由与模型名一并给出（定时执行无会话，两者都要随计划落盘）。 */
function readAutomationModelPick() {
  const pick = automationModelMenu ? automationModelMenu.getItem() : null;
  return {
    model: String((pick && pick.model) || '').trim(),
    modelRoute: String((pick && pick.route) || '').trim()
  };
}

function openAutomationEditor(taskId) {
  const overlay = $('automation-editor-overlay');
  if (!overlay) return;
  // 下拉是按需挂载的（容器常驻，实例懒建），保证本次打开一定有实例可读写
  ensureAutomationPeriodicUnitMenu();
  ensureAutomationWeekDayMenu();
  syncAutomationWeekDayVisibility();
  const title = $('automation-editor-title');
  const seq = ++automationEditorSeq;
  $('automation-edit-id').value = taskId || '';
  if (title) title.textContent = taskId ? '编辑计划' : '添加计划';
  const fillPlan = (p) => {
    $('automation-name').value = p.name;
    $('automation-prompt').value = p.prompt || '';
    $('automation-todos').value = Array.isArray(p.todos) ? p.todos.join('\n') : '';
    $('automation-enabled').checked = !!p.enabled;
    // 调度（频率/时间/间隔/单次/生效区间）统一由调度模块回填：
    // 只写不回填，界面就永远停在 HTML 默认值 09:00。
    applyAutomationScheduleToForm(p);
    populateAutomationModelSelect(p.modelRoute, p.model);
    populateAutomationSkillSelect((p.skillIds && p.skillIds[0]) || '').catch(() => {});
  };
  if (!taskId) {
    automationEditingPlan = null;
    $('automation-editor-form')?.reset();
    $('automation-enabled').checked = true;
    if ($('automation-todos')) $('automation-todos').value = '';
    // null = 全新计划：回填成默认调度（每天 09:00）并清空 origin / dirty
    applyAutomationScheduleToForm(null);
    populateAutomationModelSelect('', '');
    populateAutomationSkillSelect('').catch(() => {});
  } else {
    automationEditingPlan = null;
    getAutomationApi().plansList().then((plans) => {
      // 期间用户已切换到别的计划 / 关掉重开：这次回填作废
      if (seq !== automationEditorSeq) return;
      const p = plans.find((x) => x.id === taskId);
      if (p) {
        automationEditingPlan = p;
        fillPlan(p);
      }
    });
  }
  overlay.hidden = false;
}

function closeAutomationEditor() {
  const overlay = $('automation-editor-overlay');
  if (overlay) overlay.hidden = true;
  if (automationModelMenu) automationModelMenu.close();
  if (automationSkillMenu) automationSkillMenu.close();
  resetDialogMaximize('automation-editor-overlay', 'automation-editor-max');
}

function collectAutomationForm() {
  const id = $('automation-edit-id')?.value || '';
  const sched = resolveScheduleFromForm();
  const pick = readAutomationModelPick();
  const startInput = $('automation-date-start')?.value || '';
  return {
    id: id || undefined,
    name: $('automation-name')?.value || '未命名计划',
    prompt: $('automation-prompt')?.value || '',
    todos: parseTodoText($('automation-todos')?.value || ''),
    rrule: sched.rrule,
    onceAt: sched.onceAt,
    tz: 'Asia/Shanghai',
    // 生效开始只在用户显式填过时上送：undefined 会让 store 保留原 dtstart（新建则兜底为当前时间），
    // 否则「打开编辑器保存一次」就会把已有计划的起始相位冲成保存时刻。
    // 注意必须是本地 00:00 —— 直接塞日期串会被当 UTC 解析，要按本地时区换算成 ISO。
    dtstart: automationDtstartDirty && startInput ? new Date(`${startInput}T00:00:00`).toISOString() : undefined,
    enabled: $('automation-enabled')?.checked !== false,
    model: pick.model,
    modelRoute: pick.modelRoute,
    skillIds: (() => {
      const sid = automationSkillMenu ? automationSkillMenu.getValue() : '';
      return sid ? [sid] : [];
    })(),
    deliver: {
      type: 'session',
      // 编辑已有计划时沿用原投递会话，否则每次保存都会新建会话、丢掉历史
      sessionId: (automationEditingPlan && automationEditingPlan.deliver
        ? automationEditingPlan.deliver.sessionId
        : '') || ''
    }
  };
}

/**
 * 运行中的计划（planId → 运行态）。
 *
 * 计划由 Main 的调度器发起，Renderer 不是发起方，所以不能只「等结果再刷新」：
 * 这里把 `plans:phase`（AgentRunEvent）登记进 sessionActiveRuns，于是
 * 计划会话里的流式气泡、历史列表的「后台运行中」小环、Composer 的停止按钮
 * 全部复用聊天既有链路，不再需要手动刷新。
 */
const planLiveRuns = new Map();

function getPlanLiveRun(planId) {
  return planLiveRuns.get(String(planId || '')) || null;
}

function planEventTypes() {
  return typeof AGENT_RUN_EVENT_TYPES !== 'undefined' ? AGENT_RUN_EVENT_TYPES : {};
}

/** Main 侧 trace 行 → 聊天同款 trace 行（summary / argsBrief 只在 Renderer 生成一处） */
function mapPlanRunTrace(rows) {
  if (!Array.isArray(rows)) return [];
  if (typeof mapRustAgentTrace === 'function') return mapRustAgentTrace(rows, []);
  return rows;
}

/**
 * 把运行登记到计划专用会话。
 * 会话已存在运行（比如用户正好在该会话里跑聊天）时不抢登记，避免 trace 串台。
 */
function bindPlanRunSession(rec) {
  const sid = String(rec.sessionId || '');
  if (!sid) return;
  if (rec.liveSessionId === sid && sessionActiveRuns.has(sid)) return;
  if (rec.liveSessionId && rec.liveSessionId !== sid && typeof finishSessionActiveRun === 'function') {
    finishSessionActiveRun(rec.liveSessionId, rec.runId);
  }
  const existing = sessionActiveRuns.get(sid);
  if (existing && !existing.planRun) return;
  rec.liveSessionId = sid;
  if (!existing) {
    sessionActiveRuns.set(sid, {
      runId: rec.runId || `plan-${rec.planId}`,
      trace: [],
      placeholderEl: null,
      agentServiceRequestId: '',
      streamContent: '',
      abortController: null,
      gatewayRunId: null,
      workspacePath: null,
      planId: rec.planId,
      planRun: true
    });
  }
  if (rec.unregisterCancel) rec.unregisterCancel();
  const api = getAutomationApi();
  rec.unregisterCancel =
    typeof registerActiveAgentBackendCancel === 'function'
      ? registerActiveAgentBackendCancel(
          'plan',
          rec.runId || rec.planId,
          () => {
            rec.stopping = true;
            const live = sessionActiveRuns.get(sid);
            if (live) live.stopRequested = true;
            updateAutomationRunningTiles();
            return api.plansCancel ? api.plansCancel(rec.planId) : null;
          },
          sid
        )
      : null;
}

/**
 * 用户正停在计划会话里时，先把它这一轮的「用户轮次」load 出来，
 * 否则流式气泡会直接接在旧消息后面，看不到这次触发的内容。
 */
function showPlanSessionTurnIfOpen(rec) {
  const sid = String(rec.liveSessionId || '');
  if (!sid || sid !== String(currentSessionId || '')) return;
  if (rec.chatShownFor === sid) return;
  rec.chatShownFor = sid;
  Promise.resolve()
    .then(() => loadChatFromGateway(null, sid))
    .then(() => {
      if (typeof reconcileSessionLiveRunUi === 'function') reconcileSessionLiveRunUi(sid);
      // 计划跑在自己正看着的会话里：Composer 要跟着切成「停止」
      if (typeof syncComposerForActiveSession === 'function') syncComposerForActiveSession();
    })
    .catch(() => {});
}

function handlePlanPhase(rawEvent) {
  const event =
    typeof normalizeAgentRunEvent === 'function' ? normalizeAgentRunEvent(rawEvent) : rawEvent;
  const meta = event && event.meta && typeof event.meta === 'object' ? event.meta : null;
  const planId = String((meta && meta.planId) || '');
  if (!planId) return;
  const types = planEventTypes();
  const isTerminal =
    event.type === types.DONE || event.type === types.ERROR || event.type === types.STOPPED;
  if (isTerminal) {
    finishPlanLiveRun(planId, event);
    return;
  }

  let rec = getPlanLiveRun(planId);
  if (!rec) {
    rec = {
      planId,
      runId: event.runId || '',
      sessionId: event.sessionId || '',
      startedAt: Number(meta && meta.startedAt) || Date.now(),
      trace: [],
      streamContent: '',
      stopping: false,
      fromList: false,
      chatShownFor: '',
      liveSessionId: '',
      unregisterCancel: null
    };
    planLiveRuns.set(planId, rec);
  }
  if (event.runId) rec.runId = String(event.runId);
  if (event.sessionId) rec.sessionId = String(event.sessionId);

  if (event.type === types.RUN_START) {
    // Main 在广播 run_start 之前已经把会话与本次触发的用户轮次落库，所以这一拍就登记会话
    // 并走既有链路（历史列表刷新 / 移动端进度 / 气泡），不必等第一条 trace
    // —— 模型首字可能要等很久，那段时间里列表应该已经能看到这次运行。
    bindPlanRunSession(rec);
    if (rec.liveSessionId && typeof dispatchAgentRunEvent === 'function') {
      dispatchAgentRunEvent(rec.liveSessionId, event);
    }
    showPlanSessionTurnIfOpen(rec);
  } else if (Array.isArray(event.trace)) {
    rec.trace = mapPlanRunTrace(event.trace);
    rec.streamContent = event.streamContent || '';
    bindPlanRunSession(rec);
    if (rec.liveSessionId && typeof updateSessionRunProgress === 'function') {
      updateSessionRunProgress(rec.liveSessionId, rec.trace, rec.streamContent, { runId: rec.runId });
    }
  }
  updateAutomationRunningTiles();
}

/**
 * 把这次运行的思考过程落成 trace 记录：runId 与 assistant 消息里的 meta.traceRunId 一致
 * （Main 在运行收尾写消息时就带上了），下次打开该会话由 hydrateAssistantTraceFromStore 挂回气泡。
 *
 * 计划消息不走聊天发送链路，思考区只能在这里补；不落库的话刷新后只剩正文，
 * 还会留下一条 status=running 的 checkpoint（打开会话会被当成「可恢复的中断任务」）。
 *
 * @returns {Promise<unknown>|null}
 */
function persistPlanRunTrace(rec, live, event) {
  const sid = String(rec.liveSessionId || live.sessionId || '');
  const runId = String(rec.runId || live.runId || '');
  if (!sid || !runId || typeof saveAssistantTraceRecord !== 'function') return null;
  const trace = Array.isArray(live.trace) ? live.trace : [];
  if (!trace.length) return null;
  live.traceCheckpointClosed = true;
  const types = planEventTypes();
  const status = event.type === types.ERROR ? 'failed' : event.type === types.STOPPED ? 'stopped' : 'completed';
  try {
    return Promise.resolve(
      saveAssistantTraceRecord({
        runId,
        sessionId: sid,
        trace,
        status,
        summary: event.summary ? String(event.summary) : ''
      })
    ).catch(() => null);
  } catch {
    return null;
  }
}

function finishPlanLiveRun(planId, event) {
  const key = String(planId || '');
  const rec = planLiveRuns.get(key);
  if (!rec) return;
  // 绑定被跳过时退回事件自带 sessionId —— 否则终态被静默丢弃，界面会永久停在悬空的用户轮次上。
  const sid = String(rec.liveSessionId || (event && event.sessionId) || '');
  if (rec.unregisterCancel) {
    rec.unregisterCancel();
    rec.unregisterCancel = null;
  }
  planLiveRuns.delete(key);
  const live = sid ? sessionActiveRuns.get(sid) : null;
  // 只有登记确实属于本次计划运行，才能把终态灌进这条 live；
  // 属于别人的运行时不碰它，避免 trace / 气泡串台，但 UI 收尾不能因此被跳过。
  const owns = !!(sid && live && live.planRun);
  const isCurrent = !!sid && sid === String(currentSessionId || '');

  const finishTerminal = () => {
    if (owns) {
      if (typeof dispatchAgentRunEvent === 'function') dispatchAgentRunEvent(sid, event);
      if (typeof finishSessionActiveRun === 'function') finishSessionActiveRun(sid, rec.runId);
      // 计划跑完不会经过聊天发送链路的收尾，Composer 得在这里复位
      if (isCurrent && typeof syncComposerForActiveSession === 'function') {
        syncComposerForActiveSession();
      }
    }
    updateAutomationRunningTiles();
    // 终态以库为准：正文由 Main 落库，重载一次才能保证气泡与库一致。
    // 少了这一步，一旦 live 登记缺失或被别人的运行占住，界面就只会转圈、不见正文。
    // 必须跳过本地缓存：这一轮是 Main 直接写库的，Renderer 缓存里没有它，
    // 命中缓存重渲染等于把刚渲染好的正文擦掉。
    if (isCurrent && typeof loadChatFromGateway === 'function') {
      void Promise.resolve(loadChatFromGateway(null, sid, { forceRefresh: true }))
        .then(() => {
          if (typeof scrollChatToBottom === 'function') scrollChatToBottom();
        })
        .catch(() => {});
    }
  };
  if (!owns) {
    finishTerminal();
    return;
  }
  // 思考过程先落库再收尾（重载后靠 traceRunId 找回思考区）；但落库不能无限期挡住收尾，
  // 否则 saveAssistantTraceRecord 一旦不 settle，气泡会永远停在 loading、正文永不出现。
  const saving = persistPlanRunTrace(rec, live, event);
  if (saving && typeof saving.then === 'function') {
    const guard = new Promise((resolve) => setTimeout(resolve, 1500));
    Promise.race([saving, guard]).then(finishTerminal, finishTerminal);
  } else finishTerminal();
}

/** 页面加载 / 列表刷新时用服务端运行态兜底（例如运行中途刷新了窗口） */
function syncPlanRunningFromList(plans) {
  const list = Array.isArray(plans) ? plans : [];
  let changed = false;
  for (const [planId, rec] of [...planLiveRuns.entries()]) {
    if (!rec.fromList) continue;
    const fresh = list.find((p) => String(p && p.id) === planId);
    if (fresh && fresh.running) continue;
    if (rec.unregisterCancel) rec.unregisterCancel();
    planLiveRuns.delete(planId);
    changed = true;
  }
  for (const plan of list) {
    if (!plan || !plan.running) continue;
    const planId = String(plan.id);
    if (planLiveRuns.has(planId)) continue;
    const rec = {
      planId,
      runId: String(plan.runId || ''),
      sessionId: String(plan.runningSessionId || ''),
      startedAt: Number(plan.runningSince) || Date.now(),
      trace: [],
      streamContent: '',
      stopping: false,
      fromList: true,
      chatShownFor: '',
      liveSessionId: '',
      unregisterCancel: null
    };
    planLiveRuns.set(planId, rec);
    bindPlanRunSession(rec);
    changed = true;
  }
  if (changed) updateAutomationRunningTiles();
}

/**
 * 结构化调度控件 → 脏标记。
 * 时间/间隔/单次时间/生效结束都直接决定 rrule 或 onceAt，改动后必须回显到 plan-rrule；
 * 「生效开始」只决定 dtstart，不参与 rrule 合成，因此单独记脏。
 */
function bindAutomationScheduleInputs() {
  for (const id of ['automation-daily-time', 'automation-interval-min', 'automation-run-at', 'automation-date-end']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', markAutomationScheduleDirty);
    el.addEventListener('change', markAutomationScheduleDirty);
  }
  const startEl = $('automation-date-start');
  if (startEl) {
    const markStart = () => {
      automationDtstartDirty = true;
    };
    startEl.addEventListener('input', markStart);
    startEl.addEventListener('change', markStart);
  }
  // 手改 rrule = 以文本框为准；清空它则回落到结构化控件
  const rruleEl = $('plan-rrule');
  if (rruleEl) {
    rruleEl.addEventListener('input', () => {
      automationRruleEdited = true;
    });
  }
}

/**
 * 切换「周期 / 按间隔 / 单次」标签。
 * 切标签本身算一次调度意图变更（否则「切到单次却仍是每天 9 点」），
 * 切到单次时补一个默认时间，免得保存时才报「至少填一项」。
 */
function switchAutomationScheduleTab(type) {
  setAutomationScheduleType(type);
  if (type === 'once') {
    const runAtEl = $('automation-run-at');
    if (runAtEl && !runAtEl.value) {
      const next = new Date(Date.now() + 3600000);
      next.setSeconds(0, 0);
      runAtEl.value = AUTOMATION_SCHEDULE_API.toLocalDatetimeInputValue
        ? AUTOMATION_SCHEDULE_API.toLocalDatetimeInputValue(next)
        : '';
    }
  }
  markAutomationScheduleDirty();
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
  document.querySelectorAll('.automation-schedule-tab').forEach((el) => {
    el.addEventListener('click', () => switchAutomationScheduleTab(el.dataset.schedule));
  });
  bindAutomationScheduleInputs();
  if (getAutomationApi().onPlanRan) {
    getAutomationApi().onPlanRan((payload) => {
      handlePlanRan(payload);
    });
  }
  if (getAutomationApi().onPlanPhase) {
    getAutomationApi().onPlanPhase((payload) => {
      try {
        handlePlanPhase(payload);
      } catch (err) {
        console.warn('计划实时事件处理失败:', err);
      }
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
  // 终态事件可能因窗口重建而丢：这里以 plans:ran 兜底清掉运行态，避免卡片永远停在「运行中」
  const planId = String((payload && payload.planId) || '');
  if (planId && planLiveRuns.has(planId)) {
    const rec = planLiveRuns.get(planId);
    if (rec.unregisterCancel) rec.unregisterCancel();
    planLiveRuns.delete(planId);
  }
  await refreshAutomationList().catch(() => {});
  const planName = (payload && payload.planName) || '定时任务';
  const stopped = !!(payload && payload.stopped);
  const ok = !payload || payload.ok !== false;
  const title = stopped
    ? `计划已停止 · ${planName}`
    : ok
      ? `计划完成 · ${planName}`
      : `计划失败 · ${planName}`;
  showTrayBalloon(title, toastPreviewText(payload && (payload.summary || payload.error)));
  const sessionId = payload && payload.sessionId;
  if (!sessionId) return;
  // 这一轮由 Main 直接写库，Renderer 的会话缓存是运行前的旧快照（只有用户轮次）。
  // 无论用户此刻是否停在该会话都要失效，否则后台跑完再切回来只会看到空正文。
  if (typeof invalidateSessionMessageCache === 'function') invalidateSessionMessageCache(sessionId);
  // 计划跑完与连接恢复可能同时发生（此刻 gwState 尚未鉴权）。丢消息不是选项：
  // 这一轮正文只在库里，必须等 Gateway 就绪后重载，否则托盘弹了、正文却没了。
  if (!gwState.authed && typeof ensureLocalGatewayReady === 'function') {
    await ensureLocalGatewayReady().catch(() => {});
  }
  if (!gwState.authed) return;
  await refreshHistoryList().catch(() => {});
  if (sessionId === currentSessionId) {
    // 同 finishPlanLiveRun：这一轮由 Main 直接落库，本地缓存里没有，必须跳过缓存
    await loadChatFromGateway(null, currentSessionId, { forceRefresh: true }).catch(() => {});
    scrollChatToBottom();
  }
}
