'use strict';

/* global window, document, $, escapeHtml, gwState, gatewayCall, loadSqlConfigUI, saveSqlConfig, testSqlConnection, renderSqlDbList, sqlStatusCache */

let activePluginSchemaId = '';
let pluginDetailMode = '';

function schemaFieldLabel(key, prop) {
  if (prop && prop.title) return String(prop.title);
  return key;
}

function renderPluginSchemaFields(schema, values, prefix = 'pd-') {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return '<p class="skills-empty">无效的设置 schema</p>';
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const rows = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!prop || typeof prop !== 'object') continue;
    const fieldId = `${prefix}${key}`;
    const val = values && values[key] != null ? values[key] : prop.default != null ? prop.default : '';
    const label = escapeHtml(schemaFieldLabel(key, prop));
    const hint = prop.description ? `<span class="field-hint">${escapeHtml(prop.description)}</span>` : '';
    const req = required.has(key) ? ' *' : '';

    if (prop.type === 'boolean') {
      rows.push(`<label class="check-row">
        <input type="checkbox" id="${fieldId}" data-schema-key="${escapeHtml(key)}" ${val ? 'checked' : ''} />
        <span>${label}${req}</span>
      </label>${hint ? `<p class="field-hint">${escapeHtml(prop.description)}</p>` : ''}`);
      continue;
    }

    if (prop.type === 'integer' || prop.type === 'number') {
      rows.push(`<label class="field">
        <span class="field-label">${label}${req}</span>
        <input type="number" id="${fieldId}" data-schema-key="${escapeHtml(key)}" value="${escapeHtml(String(val))}" />
        ${hint}
      </label>`);
      continue;
    }

    const inputType = prop.format === 'password' ? 'password' : 'text';
    rows.push(`<label class="field">
      <span class="field-label">${label}${req}</span>
      <input type="${inputType}" id="${fieldId}" data-schema-key="${escapeHtml(key)}" value="${escapeHtml(String(val))}" autocomplete="off" />
      ${hint}
    </label>`);
  }
  return rows.join('');
}

function collectPluginSchemaValues(formEl, schema) {
  const out = {};
  if (!formEl || !schema || !schema.properties) return out;
  for (const key of Object.keys(schema.properties)) {
    const prop = schema.properties[key];
    const input = formEl.querySelector(`[data-schema-key="${key}"]`);
    if (!input) continue;
    if (prop.type === 'boolean') {
      out[key] = !!input.checked;
    } else if (prop.type === 'integer') {
      out[key] = parseInt(input.value, 10) || 0;
    } else if (prop.type === 'number') {
      out[key] = Number(input.value) || 0;
    } else {
      out[key] = input.value;
    }
  }
  return out;
}

function setPluginDetailHint(text) {
  const el = $('plugin-detail-hint');
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }
}

function switchPluginDetailDbTab(tab) {
  const dbTab = tab || 'settings';
  document.querySelectorAll('[data-pd-db-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.pdDbTab === dbTab);
  });
  document.querySelectorAll('[data-pd-db-panel]').forEach((el) => {
    el.classList.toggle('active', el.dataset.pdDbPanel === dbTab);
  });
  if (dbTab === 'list' && gwState.authed && typeof loadSqlConfigUI === 'function') {
    loadSqlConfigUI().catch(() => {});
  }
}

function closePluginDetail() {
  const overlay = $('plugin-detail-overlay');
  if (overlay) overlay.hidden = true;
  activePluginSchemaId = '';
  pluginDetailMode = '';
}

async function openPluginDetail(plugin) {
  const overlay = $('plugin-detail-overlay');
  const titleEl = $('plugin-detail-title');
  const introEl = $('plugin-detail-intro');
  const dbPanel = $('plugin-detail-database');
  const schemaPanel = $('plugin-detail-schema');
  const testBtn = $('plugin-detail-test');
  if (!overlay || !plugin || !plugin.id) return;

  overlay.hidden = false;
  if (titleEl) titleEl.textContent = plugin.name || plugin.id;
  setPluginDetailHint('');

  let introHtml = '';
  if (plugin.installPath) {
    introHtml += `<p class="skill-detail-path"><span class="field-label">路径</span> <code>${escapeHtml(plugin.installPath)}</code></p>`;
  }
  if (plugin.description) {
    introHtml += `<section class="skill-detail-section"><h3>简介</h3><p>${escapeHtml(plugin.description)}</p></section>`;
  }
  if (introEl) introEl.innerHTML = introHtml;

  if (plugin.id === 'builtin.database') {
    pluginDetailMode = 'database';
    activePluginSchemaId = '';
    if (dbPanel) dbPanel.hidden = false;
    if (schemaPanel) schemaPanel.hidden = true;
    if (testBtn) testBtn.hidden = false;
    switchPluginDetailDbTab(plugin.databaseTab || 'settings');
    if (gwState.authed && typeof loadSqlConfigUI === 'function') {
      await loadSqlConfigUI().catch(() => {});
    }
    return;
  }

  pluginDetailMode = 'schema';
  activePluginSchemaId = plugin.id;
  if (dbPanel) dbPanel.hidden = true;
  if (schemaPanel) schemaPanel.hidden = false;
  if (testBtn) testBtn.hidden = true;

  const formEl = $('plugin-detail-schema-form');
  if (!formEl) return;
  if (!gwState.authed) {
    formEl.innerHTML = '<p class="skills-empty">Gateway 未连接</p>';
    return;
  }
  formEl.innerHTML = '<p class="skills-empty">加载中…</p>';
  try {
    const schema = await gatewayCall('plugins.settings.schema', { id: plugin.id });
    const values = await gatewayCall('plugins.settings.get', { id: plugin.id });
    formEl.innerHTML = renderPluginSchemaFields(schema, values || {});
  } catch (err) {
    formEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(err.message || err)}</p>`;
  }
}

async function saveActivePluginDetail() {
  if (pluginDetailMode === 'database') {
    if (typeof saveSqlConfig === 'function') {
      await saveSqlConfig();
    }
    return;
  }
  const formEl = $('plugin-detail-schema-form');
  if (!activePluginSchemaId || !formEl || !gwState.authed) return;
  setPluginDetailHint('保存中…');
  try {
    const schema = await gatewayCall('plugins.settings.schema', { id: activePluginSchemaId });
    const values = collectPluginSchemaValues(formEl, schema);
    await gatewayCall('plugins.settings.set', { id: activePluginSchemaId, settings: values });
    setPluginDetailHint('已保存 ✓');
  } catch (err) {
    setPluginDetailHint(`失败：${err.message || err}`);
  }
}

async function testPluginDetailDatabase() {
  if (pluginDetailMode !== 'database' || !gwState.authed) return;
  setPluginDetailHint('正在连接…');
  try {
    if (typeof saveSqlConfig === 'function') await saveSqlConfig();
    if (typeof testSqlConnection === 'function') await testSqlConnection();
    setPluginDetailHint('连接成功 ✓');
  } catch (err) {
    setPluginDetailHint(`失败：${err.message || err}`);
  }
}

function initPluginDetailOverlay() {
  const overlay = $('plugin-detail-overlay');
  const closeX = $('plugin-detail-close');
  const saveBtn = $('plugin-detail-save');
  const testBtn = $('plugin-detail-test');

  if (closeX) closeX.addEventListener('click', closePluginDetail);
  if (saveBtn) saveBtn.addEventListener('click', () => saveActivePluginDetail());
  if (testBtn) testBtn.addEventListener('click', () => testPluginDetailDatabase());

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePluginDetail();
    });
  }

  document.querySelectorAll('[data-pd-db-tab]').forEach((el) => {
    el.addEventListener('click', () => switchPluginDetailDbTab(el.dataset.pdDbTab));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const el = $('plugin-detail-overlay');
    if (el && !el.hidden) closePluginDetail();
  });
}

function openPluginSchemaSettings(pluginId, pluginName) {
  openPluginDetail({
    id: pluginId,
    name: pluginName || pluginId
  });
}

function openDatabasePluginDetail(databaseTab = 'settings') {
  openPluginDetail({
    id: 'builtin.database',
    name: '数据库连接',
    description: 'SQL Server 只读连接，可查询当前账号有权限的所有数据库。',
    databaseTab
  });
}

window.openPluginDetail = openPluginDetail;
window.closePluginDetail = closePluginDetail;
window.openPluginSchemaSettings = openPluginSchemaSettings;
window.openDatabasePluginDetail = openDatabasePluginDetail;
window.initPluginDetailOverlay = initPluginDetailOverlay;
