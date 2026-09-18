/* global window, document */
'use strict';

/**
 * 直角自定义下拉（select-menu）—— 全站「实体选择」的唯一实现。
 *
 * 为什么不用原生 <select>：它的**弹出列表**由系统/Chromium 绘制，圆角无法用 CSS 去掉
 * （可控需要 Chromium 135+ 的 `appearance: base-select` / `::picker(select)`，
 * 本仓 Electron 28 对应 Chromium 120，不支持），与全站 `border-radius: 0` 的设计语言冲突。
 * 因此凡是「从若干实体里选一个」（选模型、选技能、选档位、选传输类型…）都走本组件，
 * 不要各处再手写菜单。
 *
 * DOM 结构由本组件生成（调用方只给容器），避免结构在多处重复描述：
 *   div.select-menu[id=baseId]     ← 调用方在 HTML 里放这个空容器
 *     button.select-menu-trigger[id=baseId-trigger] > span.select-menu-trigger-label[id=baseId-label]
 *     div.select-menu-list[id=baseId-menu][role=listbox]（初始 hidden）
 *
 * 两种用法：
 *  - 静态字段：`<div class="select-menu" id="my-field"></div>` 然后
 *      const api = ensureSelectMenu('my-field', { options, value, placeholder, onPick });
 *  - 动态行（每行一个）：自己 `document.createElement('div')` 作 wrap 后
 *      const api = mountSelectMenu({ wrap, options, value, onPick });
 *
 * options: [{ key, label, raw?, disabled?, title? }]；raw 原样透传，getItem() 可取回。
 * aria：自动关联同 `.field` 内的 `.field-label`；纯行内字段（无字段名元素）请传 ariaLabel。
 * 实例随容器一起被移除（如列表重渲染）后自动回收，无需显式销毁。
 */

/** 存活实例：document 级监听只注册一次，靠该集合实现「互斥打开 + 外点关闭 + 惰性回收」。 */
const selectMenuLive = new Set();
/** baseId → { wrap, api }：容器被移除后（isConnected=false）自动重建并覆盖。 */
const selectMenuCache = new Map();
let selectMenuDocumentBound = false;

function pruneSelectMenuLive() {
  for (const inst of Array.from(selectMenuLive)) {
    if (!inst.root.isConnected) selectMenuLive.delete(inst);
  }
}

/** 全站共用一个 mousedown 监听：菜单数量随表单行数变化，不能每个实例各挂一个。 */
function bindSelectMenuDocument() {
  if (selectMenuDocumentBound) return;
  selectMenuDocumentBound = true;
  document.addEventListener('mousedown', (e) => {
    for (const inst of Array.from(selectMenuLive)) {
      if (!inst.root.isConnected) selectMenuLive.delete(inst);
      else if (inst.isOpen() && !inst.root.contains(e.target)) inst.close();
    }
  });
}

function createSelectMenuDom(wrap, baseId, placeholder) {
  wrap.textContent = '';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-menu-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  if (baseId) trigger.id = `${baseId}-trigger`;
  const valueEl = document.createElement('span');
  valueEl.className = 'select-menu-trigger-label';
  if (baseId) valueEl.id = `${baseId}-label`;
  valueEl.textContent = placeholder;
  trigger.appendChild(valueEl);
  const menu = document.createElement('div');
  menu.className = 'select-menu-list';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  if (baseId) {
    menu.id = `${baseId}-menu`;
    trigger.setAttribute('aria-controls', menu.id);
  }
  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  return { trigger, valueEl, menu };
}

function bindSelectMenuLabel(wrap, trigger, baseId, cfg) {
  const field = typeof wrap.closest === 'function' ? wrap.closest('.field') : null;
  const fieldLabel = cfg.fieldLabelEl || (field ? field.querySelector('.field-label') : null);
  const valueId = trigger.querySelector('.select-menu-trigger-label')?.id || '';
  if (fieldLabel) {
    if (!fieldLabel.id && baseId) fieldLabel.id = `${baseId}-field-label`;
    const ids = [fieldLabel.id, valueId].filter(Boolean);
    if (ids.length) trigger.setAttribute('aria-labelledby', ids.join(' '));
    return;
  }
  if (cfg.ariaLabel) trigger.setAttribute('aria-label', String(cfg.ariaLabel));
}

function mountSelectMenu(options) {
  const cfg = options || {};
  const wrap = cfg.wrap;
  if (!wrap) return null;
  wrap.classList.add('select-menu');
  const baseId = String(cfg.baseId || wrap.id || '').trim();
  const state = {
    open: false,
    items: [],
    value: '',
    activeIndex: -1,
    placeholder: cfg.placeholder || '',
    emptyText: cfg.emptyText || '暂无可选项',
    onPick: typeof cfg.onPick === 'function' ? cfg.onPick : null
  };
  const { trigger, valueEl, menu } = createSelectMenuDom(wrap, baseId, state.placeholder);
  if (cfg.title) trigger.title = String(cfg.title);
  bindSelectMenuLabel(wrap, trigger, baseId, cfg);

  let api = null;

  function normalize(list) {
    return (Array.isArray(list) ? list : []).map((o) => ({
      key: o && o.key != null ? String(o.key) : '',
      label: o && o.label != null ? String(o.label) : '',
      title: o && o.title ? String(o.title) : '',
      disabled: !!(o && o.disabled),
      raw: o && o.raw !== undefined ? o.raw : o
    }));
  }

  function currentItem() {
    return state.items.find((it) => it.key === state.value) || null;
  }

  function syncTrigger() {
    const hit = currentItem();
    valueEl.textContent = hit && hit.label ? hit.label : state.placeholder;
    trigger.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    trigger.disabled = state.items.length === 0;
  }

  function paintActive() {
    Array.from(menu.children).forEach((el, idx) => {
      if (el.classList && el.classList.contains('select-menu-item')) {
        el.classList.toggle('active', idx === state.activeIndex);
      }
    });
  }

  function render() {
    menu.textContent = '';
    if (!state.items.length) {
      const empty = document.createElement('div');
      empty.className = 'select-menu-empty';
      empty.textContent = state.emptyText;
      menu.appendChild(empty);
      return;
    }
    for (const it of state.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'select-menu-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', it.key === state.value ? 'true' : 'false');
      // 焦点始终留在 trigger 上（aria-activedescendant 模式），避免 Tab 落进列表
      btn.tabIndex = -1;
      btn.disabled = it.disabled;
      btn.textContent = it.label;
      if (it.title) btn.title = it.title;
      btn.addEventListener('click', () => pick(it.key));
      menu.appendChild(btn);
    }
    paintActive();
  }

  function stepActive(delta) {
    const n = state.items.length;
    if (!n) return;
    let i = state.activeIndex;
    for (let k = 0; k < n; k += 1) {
      if (i < 0) i = delta > 0 ? 0 : n - 1;
      else i = (i + delta + n) % n;
      if (!state.items[i].disabled) break;
    }
    state.activeIndex = i;
    paintActive();
  }

  function closeMenu(refocus) {
    if (!state.open) return;
    state.open = false;
    menu.hidden = true;
    syncTrigger();
    if (refocus) trigger.focus();
  }

  function openMenu() {
    if (state.open) return;
    if (!state.items.length) return;
    // 同一时刻只允许一个菜单展开
    if (api) {
      for (const other of Array.from(selectMenuLive)) {
        if (other !== api && other.isOpen()) other.close();
      }
    }
    state.open = true;
    menu.hidden = false;
    const idx = state.items.findIndex((it) => it.key === state.value && !it.disabled);
    state.activeIndex = idx >= 0 ? idx : -1;
    render();
    syncTrigger();
  }

  function pick(key) {
    const it = state.items.find((x) => x.key === key);
    if (!it || it.disabled) return;
    state.value = it.key;
    syncTrigger();
    closeMenu(true);
    if (state.onPick) state.onPick(it.key, it.raw);
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.open) closeMenu();
    else openMenu();
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!state.open) openMenu();
      else stepActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!state.open) return;
      e.preventDefault();
      state.activeIndex = e.key === 'Home' ? 0 : state.items.length - 1;
      paintActive();
      return;
    }
    if (e.key === 'Escape') {
      if (state.open) {
        e.preventDefault();
        closeMenu(true);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // 自己处理：button 的按键激活会再合成一次 click，把刚打开的菜单又关掉
      e.preventDefault();
      if (!state.open) {
        openMenu();
        return;
      }
      const it = state.items[state.activeIndex];
      if (it) pick(it.key);
      return;
    }
    if (e.key === 'Tab' && state.open) closeMenu();
  });

  if (Array.isArray(cfg.options)) state.items = normalize(cfg.options);
  if (cfg.value != null) state.value = String(cfg.value);
  syncTrigger();

  api = {
    root: wrap,
    isOpen: () => state.open,
    close: () => closeMenu(false),
    setOptions(list) {
      state.items = normalize(list);
      state.activeIndex = -1;
      if (state.open) render();
      syncTrigger();
    },
    setValue(v) {
      state.value = v != null ? String(v) : '';
      if (state.open) {
        const idx = state.items.findIndex((it) => it.key === state.value && !it.disabled);
        state.activeIndex = idx >= 0 ? idx : -1;
        render();
      }
      syncTrigger();
    },
    getValue() {
      return state.value;
    },
    /** 取当前选中项（含调用方透传的 raw），无匹配时返回 null。 */
    getItem() {
      return currentItem();
    }
  };
  selectMenuLive.add(api);
  bindSelectMenuDocument();
  return api;
}

/** 按容器 id 取实例（按 id 约定生成子元素 id），容器不存在或已被移除时返回 null。 */
function ensureSelectMenu(baseId, options) {
  const id = String(baseId || '').trim();
  if (!id) return null;
  const cached = selectMenuCache.get(id);
  if (cached && cached.wrap.isConnected) return cached.api;
  pruneSelectMenuLive();
  selectMenuCache.delete(id);
  const wrap = document.getElementById(id);
  if (!wrap) return null;
  const api = mountSelectMenu({ ...(options || {}), wrap, baseId: id });
  if (api) selectMenuCache.set(id, { wrap, api });
  return api;
}
