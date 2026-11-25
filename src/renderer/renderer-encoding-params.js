/* global document, $, AGENT_LIMITS_SCHEMA, getAgentLimits, setAgentLimits, resetAgentLimits, formatAgentLimitValue, formatModelRuntimeValue, hydrateAgentLimitsFromDisk, hydrateRuntimeByTierFromMain, applyAgentLimitsToRuntime, getModelRuntimeValues, setModelRuntimeValues, resetModelRuntimeValues, getEditingContextTierId, setEditingContextTierId, MODEL_RUNTIME_PRESETS, settings, syncModelSettingsToMain, saveSettings */
'use strict';

function getModelRuntimeSchema() {
  return typeof window !== 'undefined' && window.MODEL_RUNTIME_SCHEMA ? window.MODEL_RUNTIME_SCHEMA : null;
}

function getModelRuntimePresets() {
  return typeof window !== 'undefined' && window.MODEL_RUNTIME_PRESETS ? window.MODEL_RUNTIME_PRESETS : [];
}

function showEncodingParamsHint(text, ms = 2400) {
  const hint = $('encoding-params-hint');
  if (!hint) return;
  hint.textContent = text;
  if (ms > 0) {
    setTimeout(() => {
      if (hint.textContent === text) hint.textContent = '';
    }, ms);
  }
}

function getActiveEditingTierId() {
  if (typeof getEditingContextTierId === 'function') {
    return getEditingContextTierId();
  }
  return 'default';
}

/**
 * 面板「自己写自己」期间为 true。
 *
 * 为什么必须有：`setAgentLimits` / `setModelRuntimeValues` 会**同步派发** change 事件
 * （`dieyun:agent-limits-change` / `dieyun:model-runtime-change`），监听器随即
 * `root.innerHTML = ''` 整块重绘 —— 正在拖动的 `input[type=range]` 被替换成新元素，
 * 指针捕获当场丢失，表现就是「滑杆只能点一下，一拖就断」。
 * 自己发起的写入不需要重绘（值标签已在 input 处理器里更新），因此整段写入期间屏蔽重绘。
 */
let panelWriteInFlight = false;

function withPanelWrite(fn) {
  panelWriteInFlight = true;
  try {
    return fn();
  } finally {
    panelWriteInFlight = false;
  }
}

/** 已生效部分的轨道填充宽度（拖动时跟着拇指走；纯视觉，不参与取值）。 */
function paintRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const span = max - min;
  const pct = span > 0 ? ((value - min) / span) * 100 : 0;
  input.style.setProperty('--range-fill', `${Math.max(0, Math.min(100, pct))}%`);
}

function renderEncodingParamsTierTabs() {
  const wrap = $('encoding-params-presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  const presets = getModelRuntimePresets();
  const activeTierId = getActiveEditingTierId();
  for (const preset of presets) {
    if (wrap.childElementCount) {
      const sep = document.createElement('span');
      sep.className = 'encoding-params-preset-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      wrap.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn encoding-params-preset-btn';
    btn.dataset.tierId = preset.id;
    btn.textContent = preset.label;
    if (preset.hint) btn.title = preset.hint;
    btn.setAttribute('aria-pressed', preset.id === activeTierId ? 'true' : 'false');
    btn.classList.toggle('is-active', preset.id === activeTierId);
    btn.addEventListener('click', () => {
      if (typeof setEditingContextTierId === 'function') {
        setEditingContextTierId(preset.id);
      }
      renderEncodingParamsTierTabs();
      renderEncodingParamsPanel();
      showEncodingParamsHint(`正在编辑档位：${preset.label}`);
    });
    wrap.appendChild(btn);
  }
}

function renderSchemaGroup(root, group, opts) {
  const { prefix, getValue, formatValue, scope = 'tier', showTierNote = false } = opts;
  const section = document.createElement('section');
  section.className = `encoding-params-group encoding-params-group--${scope}`;
  section.dataset.groupId = group.groupId;
  section.dataset.paramScope = scope;

  const title = document.createElement('h3');
  title.className = 'encoding-params-group-title';
  title.textContent = group.group;
  section.appendChild(title);

  if (showTierNote) {
    const tierNote = document.createElement('p');
    tierNote.className = 'encoding-params-tier-note';
    const tierLabel =
      getModelRuntimePresets().find((p) => p.id === getActiveEditingTierId())?.label ||
      getActiveEditingTierId();
    tierNote.textContent = `正在编辑「${tierLabel}」档；切换上方档位可分别保存。`;
    section.appendChild(tierNote);
  }

  const fields = document.createElement('div');
  fields.className = 'encoding-params-fields settings-runtime-fields';

  for (const item of group.items) {
    const value = getValue(item.key);
    if (item.type === 'boolean') {
      const label = document.createElement('label');
      label.className = 'check-row encoding-params-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.paramKind = prefix;
      input.dataset.paramKey = item.key;
      input.checked = !!value;
      const span = document.createElement('span');
      span.textContent = item.label;
      label.append(input, span);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'field-hint encoding-params-hint';
        hint.textContent = item.hint;
        label.appendChild(hint);
      }
      fields.appendChild(label);
      continue;
    }

    const label = document.createElement('label');
    label.className = 'field encoding-params-field';
    const head = document.createElement('span');
    head.className = 'field-label';
    const tag = document.createElement('span');
    tag.className = 'field-tag';
    tag.id = `encoding-param-${prefix}-${item.key}-value`;
    tag.textContent = formatValue(item, value);
    head.append(item.label + ' ', tag);
    label.appendChild(head);
    const input = document.createElement('input');
    input.type = 'range';
    input.dataset.paramKind = prefix;
    input.dataset.paramKey = item.key;
    input.min = String(item.min);
    input.max = String(item.max);
    input.step = String(item.step != null ? item.step : 1);
    input.value = String(value);
    paintRangeFill(input);
    if (item.hint) input.title = item.hint;
    label.appendChild(input);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint encoding-params-hint';
      hint.textContent = item.hint;
      label.appendChild(hint);
    }
    fields.appendChild(label);
  }

  section.appendChild(fields);
  root.appendChild(section);
}

function renderEncodingParamsPanel() {
  const root = $('encoding-params-root');
  if (!root) return;
  root.innerHTML = '';

  if (typeof getModelRuntimeValues === 'function') {
    const runtimeSchema = getModelRuntimeSchema();
    const runtimeValues = getModelRuntimeValues({ editing: true });
    if (runtimeSchema) {
      let firstGroup = true;
      for (const group of runtimeSchema) {
        renderSchemaGroup(root, group, {
          prefix: 'runtime',
          scope: 'tier',
          showTierNote: firstGroup,
          getValue: (key) => runtimeValues[key],
          formatValue: formatModelRuntimeValue
        });
        firstGroup = false;
      }
    }
  }

  if (!AGENT_LIMITS_SCHEMA) return;
  const limits = getAgentLimits({ editing: true });
  for (const group of AGENT_LIMITS_SCHEMA) {
    renderSchemaGroup(root, group, {
      prefix: 'limit',
      scope: 'tier',
      showTierNote: false,
      getValue: (key) => limits[key],
      formatValue: formatAgentLimitValue
    });
  }
}

function findSchemaItem(kind, key) {
  const schema = kind === 'runtime' ? getModelRuntimeSchema() : AGENT_LIMITS_SCHEMA;
  for (const group of schema || []) {
    for (const item of group.items) {
      if (item.key === key) return item;
    }
  }
  return null;
}

/**
 * 拖动 / 键盘操作结束（change）时，把「落库后的真实值」写回滑杆。
 * 为什么需要：写入路径会 clamp（如温度 0.3–0.95、轮次 15–600），用户拖到的值可能被改；
 * 不重绘面板（要保持拖动连续性），所以只能就地回写 value + 标签。
 */
function reconcileRangeInput(el, item, stored, kind, key) {
  const n = Number(stored);
  if (!Number.isFinite(n)) return;
  if (Number(el.value) === n) return;
  el.value = String(n);
  paintRangeFill(el);
  const tag = document.getElementById(`encoding-param-${kind}-${key}-value`);
  if (tag) {
    tag.textContent =
      kind === 'runtime' ? formatModelRuntimeValue(item, n) : formatAgentLimitValue(item, n);
  }
}

function onEncodingParamInput(ev) {
  const el = ev.target;
  if (!el || !el.dataset || !el.dataset.paramKey) return;
  const kind = el.dataset.paramKind;
  const key = el.dataset.paramKey;
  const item = findSchemaItem(kind, key);
  if (!item) return;
  /** 'change' = 本次拖动 / 按键结束；'input' = 拖动过程中（不重绘、只更新标签） */
  const committed = ev.type === 'change';

  if (kind === 'runtime') {
    if (item.type === 'boolean') {
      withPanelWrite(() => setModelRuntimeValues({ [key]: el.checked }, { editing: true }));
      return;
    }
    paintRangeFill(/** @type {HTMLInputElement} */ (el));
    const tag = document.getElementById(`encoding-param-runtime-${key}-value`);
    if (tag) tag.textContent = formatModelRuntimeValue(item, el.value);
    withPanelWrite(() => setModelRuntimeValues({ [key]: Number(el.value) }, { editing: true }));
    if (committed && typeof getModelRuntimeValues === 'function') {
      const stored = getModelRuntimeValues({ editing: true })[key];
      reconcileRangeInput(el, item, stored, kind, key);
    }
    return;
  }

  if (item.type === 'boolean') {
    withPanelWrite(() => {
      setAgentLimits({ [key]: el.checked }, { editing: true });
      if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime({ editing: true });
    });
    return;
  }

  paintRangeFill(/** @type {HTMLInputElement} */ (el));
  const tag = document.getElementById(`encoding-param-limit-${key}-value`);
  if (tag) tag.textContent = formatAgentLimitValue(item, el.value);
  withPanelWrite(() => {
    setAgentLimits({ [key]: Number(el.value) }, { editing: true });
    if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime({ editing: true });
  });
  if (committed) {
    reconcileRangeInput(el, item, getAgentLimits({ editing: true })[key], kind, key);
  }
}

async function loadEncodingParamsFromMain() {
  const api = window.diecloud;
  if (!api) return;
  if (api.getAgentLimitsFromMain) {
    try {
      const disk = await api.getAgentLimitsFromMain();
      if (disk && typeof disk === 'object') {
        hydrateAgentLimitsFromDisk(disk);
        if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime();
      }
    } catch {
      // ignore
    }
  }
  // 模型与段预算的按档覆盖同样以 Main 存档为准（压缩 / planner / 定时计划读的是那份）
  if (typeof hydrateRuntimeByTierFromMain === 'function') {
    await hydrateRuntimeByTierFromMain();
  }
}

/**
 * 「子 Agent 判定模型」（可选）：留空 = 用本轮主模型。
 *
 * 存在 `model-settings.json` 的 `plannerRouterModel` / `plannerRouterBaseUrl` /
 * `plannerRouterApiKey`，与 `reviewerModel` 同一类配置（都是「换个模型去判/去审」），
 * 所以不塞进 agent-limits 那套数字护栏里。读写只有这一处：写进全局 `settings` 再 sync 给 Main，
 * Main 的 `agent:planner-route` 每次判定前重新 `loadModelSettings`。
 *
 * 半套配置要当面说清楚：只填模型名、没填接口地址时 `resolvePlannerRouterConfig` 会当「没配」
 * —— 不提示的话用户会以为判定换模型了，其实还是主模型在判。
 */
const PLANNER_ROUTER_FIELDS = [
  ['planner-router-model', 'plannerRouterModel'],
  ['planner-router-base-url', 'plannerRouterBaseUrl'],
  ['planner-router-api-key', 'plannerRouterApiKey']
];

function renderPlannerRouterFields() {
  const fields = PLANNER_ROUTER_FIELDS.map(([id, key]) => [$(id), key]).filter(([el]) => !!el);
  if (!fields.length) return;
  const hint = $('planner-router-hint');
  const fill = () => {
    for (const [el, key] of fields) el.value = String((settings && settings[key]) || '');
  };
  const paint = (model, baseUrl) => {
    if (!hint) return;
    if (!model && !baseUrl) {
      hint.textContent = '留空 = 用本轮主模型判定';
      return;
    }
    if (model && baseUrl) {
      hint.textContent = `已保存：判定用 ${model}`;
      return;
    }
    hint.textContent = model
      ? '只填了模型名：还需要「判定接口地址」才会真的用侧模型，否则仍回落主模型'
      : '只填了接口地址：还需要「判定模型名」才会真的用侧模型，否则仍回落主模型';
  };
  const persist = () => {
    const next = {};
    for (const [el, key] of fields) next[key] = String(el.value || '').trim();
    if (settings) Object.assign(settings, next);
    // 落盘走规范入口：localStorage + 同步给 Main（`saveSettings` 两件一起做）。
    if (typeof saveSettings === 'function') saveSettings(settings);
    else if (typeof syncModelSettingsToMain === 'function') void syncModelSettingsToMain();
    paint(next.plannerRouterModel, next.plannerRouterBaseUrl);
  };
  for (const [el] of fields) el.addEventListener('change', persist);
  fill();
  paint(
    String((settings && settings.plannerRouterModel) || '').trim(),
    String((settings && settings.plannerRouterBaseUrl) || '').trim()
  );
  // 手改过 model-settings.json（或换了机器）时 Renderer 的 localStorage 可能没有这三个键：
  // 面板全空就向 Main 取一次存档回填，免得「Main 里有、界面空着，一改就被覆盖成空」。
  if (fields.every(([el]) => !String(el.value || '').trim())) {
    const api = window.diecloud || {};
    if (typeof api.getModelSettingsFromMain === 'function') {
      api
        .getModelSettingsFromMain()
        .then((disk) => {
          if (!disk || typeof disk !== 'object') return;
          let changed = false;
          for (const [, key] of fields) {
            const v = String(disk[key] || '').trim();
            if (!v) continue;
            if (settings) settings[key] = v;
            changed = true;
          }
          if (!changed) return;
          fill();
          paint(
            String((settings && settings.plannerRouterModel) || '').trim(),
            String((settings && settings.plannerRouterBaseUrl) || '').trim()
          );
        })
        .catch(() => {});
    }
  }
}

function initEncodingParamsUI() {
  const root = $('encoding-params-root');
  if (!root) return;

  void loadEncodingParamsFromMain().then(() => {
    renderEncodingParamsTierTabs();
    renderEncodingParamsPanel();
  });

  // 判定模型存的是 model-settings（不是本页的 agent-limits 档位），所以单独渲染、单独保存。
  // `settings` 在 renderer-model-settings.js 启动时已从 Main 水合过，这里只负责填表与绑定。
  renderPlannerRouterFields();

  root.addEventListener('input', onEncodingParamInput);
  root.addEventListener('change', onEncodingParamInput);

  renderEncodingParamsTierTabs();

  const resetBtn = $('encoding-params-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (typeof resetModelRuntimeValues === 'function') {
        resetModelRuntimeValues({ editing: true });
      }
      resetAgentLimits({ editing: true });
      renderEncodingParamsTierTabs();
      renderEncodingParamsPanel();
      if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime({ editing: true });
      const tierLabel =
        getModelRuntimePresets().find((p) => p.id === getActiveEditingTierId())?.label ||
        getActiveEditingTierId();
      showEncodingParamsHint(`已恢复当前档位：${tierLabel}`);
    });
  }

  window.addEventListener('dieyun:agent-limits-change', () => {
    if (panelWriteInFlight) return;
    if (!$('help-overlay')?.hidden && document.querySelector('.help-page[data-help-tab="encoding-params"]')?.classList.contains('active')) {
      renderEncodingParamsPanel();
    }
  });

  window.addEventListener('dieyun:model-runtime-change', () => {
    if (panelWriteInFlight) return;
    if (!$('help-overlay')?.hidden && document.querySelector('.help-page[data-help-tab="encoding-params"]')?.classList.contains('active')) {
      renderEncodingParamsTierTabs();
      renderEncodingParamsPanel();
    }
  });

  window.addEventListener('dieyun:context-tier-change', () => {
    if (typeof refreshContextProgress === 'function') refreshContextProgress();
  });
}

window.renderEncodingParamsPanel = renderEncodingParamsPanel;
window.initEncodingParamsUI = initEncodingParamsUI;
