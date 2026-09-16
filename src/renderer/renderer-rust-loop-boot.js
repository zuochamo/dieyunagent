/* global document */
'use strict';

const RUST_LOOP_BOOT_STEP_DEFS = Object.freeze([
  { id: 'compact_preflight', label: '再次压缩上下文' },
  { id: 'ipc_start', label: 'IPC → Main → agent.loop.start' },
  { id: 'loop_init', label: 'Rust loop 初始化' },
  { id: 'compact_loop', label: 'Loop 内压缩（messages > 12）', optional: true },
  { id: 'llm_handoff', label: '移交模型请求' }
]);

function cloneRustBootSteps(steps) {
  return (steps || []).map((s) => ({ ...s }));
}

function createInitialRustLoopBootSteps() {
  return RUST_LOOP_BOOT_STEP_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    optional: !!def.optional,
    status: 'pending'
  }));
}

function updateRustBootStep(steps, stepId, patch) {
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id !== id) continue;
    Object.assign(step, patch || {});
    changed = true;
    break;
  }
  return changed;
}

function rustBootStepStart(steps, stepId) {
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id) {
      if (step.status !== 'done' && step.status !== 'skipped' && step.status !== 'failed') {
        step.status = 'active';
        changed = true;
      }
    }
  }
  return changed ? steps : null;
}

function rustBootStepNote(steps, stepId, detail) {
  const id = String(stepId || '');
  const next = detail != null ? String(detail).trim().slice(0, 160) : '';
  let changed = false;
  for (const step of steps) {
    if (step.id !== id || step.status !== 'active') continue;
    if (step.detail !== next) {
      if (next) step.detail = next;
      else delete step.detail;
      changed = true;
    }
    break;
  }
  return changed ? steps : null;
}

function rustBootStepDone(steps, stepId, detail) {
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id && (step.status === 'pending' || step.status === 'active')) {
      step.status = 'done';
      if (detail != null && String(detail).trim()) {
        step.detail = String(detail).slice(0, 120);
      } else {
        delete step.detail;
      }
      changed = true;
    }
  }
  return changed ? steps : null;
}

function rustBootStepSkip(steps, stepId, detail) {
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id && step.status !== 'done' && step.status !== 'failed') {
      step.status = 'skipped';
      if (detail != null && String(detail).trim()) {
        step.detail = String(detail).slice(0, 120);
      } else {
        delete step.detail;
      }
      changed = true;
    }
  }
  return changed ? steps : null;
}

function rustBootStepsSig(steps) {
  return (steps || [])
    .map((s) => `${s.id}:${s.status}${s.detail ? `:${s.detail}` : ''}`)
    .join(',');
}

function rustBootStepGlyph(status) {
  if (status === 'done') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'skipped') return '—';
  if (status === 'active') return '…';
  return '○';
}

function formatRustBootStepText(step) {
  const label = String(step.label || step.id || '');
  let text = label;
  if (step.status === 'active') text += '…';
  if (step.detail) {
    if (step.status === 'skipped') text += `（${step.detail}）`;
    else if (step.status === 'done') text += ` · ${step.detail}`;
    else if (step.status === 'failed') text += `：${step.detail}`;
    else if (step.status === 'active') text += ` · ${step.detail}`;
  }
  return `${rustBootStepGlyph(step.status)} ${text}`;
}

function visibleRustBootSteps(steps) {
  return (steps || []).filter((step) => {
    if (!step) return false;
    if (!step.optional) return true;
    return step.status !== 'pending';
  });
}

function renderRustLoopBootPanel(steps) {
  const panel = document.createElement('div');
  panel.className = 'msg-thinking-rust-boot';
  syncRustLoopBootPanel(panel, steps);
  return panel;
}

function syncRustLoopBootPanel(panel, steps) {
  if (!panel) return;
  let title = panel.querySelector('.msg-thinking-rust-boot-title');
  let scroll = panel.querySelector('.msg-thinking-rust-boot-scroll');
  if (!title || !scroll) {
    panel.replaceChildren();
    title = document.createElement('span');
    title.className = 'msg-thinking-rust-boot-title';
    title.textContent = 'Rust loop 启动';
    scroll = document.createElement('div');
    scroll.className = 'msg-thinking-rust-boot-scroll';
    panel.append(title, scroll);
  }

  const rows = visibleRustBootSteps(steps);
  scroll.replaceChildren();
  rows.forEach((step, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'msg-thinking-rust-boot-sep';
      sep.textContent = '·';
      sep.setAttribute('aria-hidden', 'true');
      scroll.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = 'msg-thinking-rust-boot-seg' + (step.status ? ` is-${step.status}` : '');
    seg.textContent = formatRustBootStepText(step);
    scroll.appendChild(seg);
  });

  const active = scroll.querySelector('.msg-thinking-rust-boot-seg.is-active');
  if (active) {
    const nextLeft = Math.max(0, active.offsetLeft + active.offsetWidth - scroll.clientWidth);
    if (Math.abs(scroll.scrollLeft - nextLeft) > 1) scroll.scrollLeft = nextLeft;
  } else {
    scroll.scrollLeft = scroll.scrollWidth;
  }
}

if (typeof window !== 'undefined') {
  window.RUST_LOOP_BOOT_STEP_DEFS = RUST_LOOP_BOOT_STEP_DEFS;
  window.createInitialRustLoopBootSteps = createInitialRustLoopBootSteps;
  window.cloneRustBootSteps = cloneRustBootSteps;
  window.rustBootStepStart = rustBootStepStart;
  window.rustBootStepNote = rustBootStepNote;
  window.rustBootStepDone = rustBootStepDone;
  window.rustBootStepSkip = rustBootStepSkip;
  window.rustBootStepsSig = rustBootStepsSig;
  window.renderRustLoopBootPanel = renderRustLoopBootPanel;
  window.syncRustLoopBootPanel = syncRustLoopBootPanel;
}
