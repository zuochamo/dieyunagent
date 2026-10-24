/* global document, scrollChatToBottom, getSessionAbortSignal, currentSessionId */
'use strict';

const CLARIFY_DISMISS_MS = 5000;

function scheduleClarifyCardDismiss(card) {
  if (!card) return;
  const timer = window.setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.add('agent-clarify-dismiss');
    const remove = () => {
      if (card.parentNode) card.remove();
    };
    card.addEventListener('transitionend', remove, { once: true });
    window.setTimeout(remove, 480);
  }, CLARIFY_DISMISS_MS);
  card.dataset.dismissTimer = String(timer);
}

function buildClarifySelectionSummary(selectedIds, freeText, options) {
  const labels = selectedIds.map((id) => {
    const opt = (options || []).find((o) => String(o.id) === String(id));
    return opt ? opt.label : id;
  });
  const parts = [];
  if (labels.length) parts.push(labels.join('、'));
  if (freeText) parts.push(freeText);
  return parts.length ? `已选择：${parts.join(' · ')}` : '已确认';
}
function hasClarifyPreviews(options) {
  return (options || []).some((o) => o && typeof o.preview === 'string' && o.preview.trim());
}

function buildClarifyPreviewPane(options) {
  const wrap = document.createElement('div');
  wrap.className = 'agent-clarify-preview';
  const title = document.createElement('p');
  title.className = 'agent-clarify-preview-title';
  const pre = document.createElement('pre');
  wrap.appendChild(title);
  wrap.appendChild(pre);
  const show = (optionId) => {
    const opt = (options || []).find((o) => String(o.id) === String(optionId));
    if (!opt) return;
    title.textContent = String(opt.label || opt.id || '');
    pre.textContent = String(opt.preview || '');
  };
  return { wrap, show };
}

function buildClarifyCard(args, onSubmit) {
  const card = document.createElement('div');
  card.className = 'agent-clarify-card';
  const q = document.createElement('p');
  q.className = 'agent-clarify-question';
  q.textContent = String(args.question || '请确认以下选项');
  card.appendChild(q);

  const options = Array.isArray(args.options) ? args.options.slice(0, 8) : [];
  const allowMultiple = !!args.allowMultiple;
  const table = document.createElement('table');
  table.className = 'agent-clarify-table';
  const thead = document.createElement('thead');
  thead.innerHTML = allowMultiple
    ? '<tr><th>选</th><th>选项</th><th>说明</th></tr>'
    : '<tr><th></th><th>选项</th><th>说明</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const inputs = [];
  for (const opt of options) {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    const input = document.createElement('input');
    input.type = allowMultiple ? 'checkbox' : 'radio';
    input.name = 'agent-clarify-opt';
    input.value = String(opt.id || opt.label || '');
    inputs.push(input);
    td0.appendChild(input);
    const td1 = document.createElement('td');
    td1.textContent = String(opt.label || opt.id || '');
    const td2 = document.createElement('td');
    td2.textContent = String(opt.description || '');
    tr.appendChild(td0);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  if (hasClarifyPreviews(options)) {
    // 带预览的选项走并排布局：左侧选项表，右侧当前聚焦选项的等宽预览。
    const split = document.createElement('div');
    split.className = 'agent-clarify-split';
    const preview = buildClarifyPreviewPane(options);
    split.appendChild(table);
    split.appendChild(preview.wrap);
    card.appendChild(split);
    const firstWithPreview = options.find((o) => hasClarifyPreviews([o]));
    if (firstWithPreview) preview.show(firstWithPreview.id);
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const row = tbody.children[i];
      const focus = () => preview.show(input.value);
      input.addEventListener('change', focus);
      row.addEventListener('mouseenter', focus);
      row.addEventListener('focusin', focus);
    }
  } else {
    card.appendChild(table);
  }

  const actions = document.createElement('div');
  actions.className = 'agent-clarify-actions';
  const freeInput = document.createElement('input');
  freeInput.type = 'text';
  freeInput.className = 'agent-clarify-free-input';
  freeInput.placeholder = String(args.inputPlaceholder || '补充说明或手动输入…');
  freeInput.autocomplete = 'off';
  const submitSelection = () => {
    const selected = inputs.filter((inp) => inp.checked).map((inp) => inp.value);
    const freeText = freeInput.value.trim();
    if (!selected.length && !freeText) return;
    btn.disabled = true;
    freeInput.disabled = true;
    for (const inp of inputs) inp.disabled = true;
    onSubmit(selected, freeText);
  };
  freeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSelection();
    }
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'agent-clarify-submit';
  btn.textContent = '确认选择';
  btn.addEventListener('click', submitSelection);
  actions.appendChild(freeInput);
  actions.appendChild(btn);
  card.appendChild(actions);
  return card;
}

function showClarifyInBubble(container, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const card = buildClarifyCard(args, (selectedIds, freeText) => {
      if (settled) return;
      settled = true;
      const summary = buildClarifySelectionSummary(selectedIds, freeText, args.options);
      const q = card.querySelector('.agent-clarify-question');
      if (q) q.textContent = summary;
      const split = card.querySelector('.agent-clarify-split');
      if (split) split.remove();
      else card.querySelector('.agent-clarify-table')?.remove();
      card.querySelector('.agent-clarify-actions')?.remove();
      card.classList.add('agent-clarify-done');
      scheduleClarifyCardDismiss(card);
      resolve({
        ok: true,
        selectedIds,
        labels: selectedIds.map((id) => {
          const opt = (args.options || []).find((o) => String(o.id) === String(id));
          return opt ? opt.label : id;
        }),
        freeText: freeText || undefined
      });
    });
    container.appendChild(card);
    scrollChatToBottom();
    const signal = typeof getSessionAbortSignal === 'function' ? getSessionAbortSignal(currentSessionId) : null;
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          const timer = card.dataset.dismissTimer;
          if (timer) window.clearTimeout(Number(timer));
          if (card.parentNode) card.remove();
          const err = new Error('已停止');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true }
      );
    }
  });
}
