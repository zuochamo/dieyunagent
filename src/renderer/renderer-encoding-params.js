/* global document, $, AGENT_LIMITS_SCHEMA, getAgentLimits, setAgentLimits, resetAgentLimits, formatAgentLimitValue, formatModelRuntimeValue, hydrateAgentLimitsFromDisk, applyAgentLimitsToRuntime, getModelRuntimeValues, setModelRuntimeValues, resetModelRuntimeValues, getEditingContextTierId, setEditingContextTierId, MODEL_RUNTIME_PRESETS */
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

function renderEncodingParamsTierTabs() {
  const wrap = $('encoding-params-presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  const presets = getModelRuntimePresets();
  const activeTierId = getActiveEditingTierId();
  for (const preset of presets) {
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
    if (item.hint && item.key === 'agentToolCallLimit') {
      input.title = item.hint;
    }
    if (item.hint && item.key === 'agentMaxRounds') {
      input.title = item.hint;
    }
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

function onEncodingParamInput(ev) {
  const el = ev.target;
  if (!el || !el.dataset || !el.dataset.paramKey) return;
  const kind = el.dataset.paramKind;
  const key = el.dataset.paramKey;
  const item = findSchemaItem(kind, key);
  if (!item) return;

  if (kind === 'runtime') {
    if (item.type === 'boolean') {
      setModelRuntimeValues({ [key]: el.checked }, { editing: true });
      return;
    }
    const tag = document.getElementById(`encoding-param-runtime-${key}-value`);
    if (tag) tag.textContent = formatModelRuntimeValue(item, el.value);
    setModelRuntimeValues({ [key]: Number(el.value) }, { editing: true });
    return;
  }

  if (item.type === 'boolean') {
    setAgentLimits({ [key]: el.checked }, { editing: true });
    if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime({ editing: true });
    return;
  }

  const tag = document.getElementById(`encoding-param-limit-${key}-value`);
  if (tag) tag.textContent = formatAgentLimitValue(item, el.value);
  setAgentLimits({ [key]: Number(el.value) }, { editing: true });
  if (typeof applyAgentLimitsToRuntime === 'function') applyAgentLimitsToRuntime({ editing: true });
}

async function loadEncodingParamsFromMain() {
  const api = window.diecloud;
  if (!api?.getAgentLimitsFromMain) return;
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

function initEncodingParamsUI() {
  const root = $('encoding-params-root');
  if (!root) return;

  void loadEncodingParamsFromMain().then(() => {
    renderEncodingParamsTierTabs();
    renderEncodingParamsPanel();
  });

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
    if (!$('help-overlay')?.hidden && document.querySelector('.help-page[data-help-tab="encoding-params"]')?.classList.contains('active')) {
      renderEncodingParamsPanel();
    }
  });

  window.addEventListener('dieyun:model-runtime-change', () => {
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
