'use strict';

/* globals describe, it, expect */

/**
 * 设置页（`src/renderer/renderer-pet.js`）的提交契约：
 *
 * 滑杆是「防抖提交」，但**多次改动必须合并**——旧实现每次只用最后一次调用的 patch，
 * 先拖「点数量」再拖「点大小」时，点数那次会被静默丢掉（界面显示新值、磁盘上没写）。
 * 这里用「加载真源码 + 极简 DOM 桩 + 假定时器」把这个行为钉住。
 */

const fs = require('node:fs');
const path = require('node:path');
const PetShapes = require('../../src/renderer/pet-window/pet-shapes');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-pet.js');

function makeEl(id) {
  return {
    id,
    value: '',
    checked: false,
    textContent: '',
    childElementCount: 0,
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    _handlers: {},
    addEventListener(name, fn) {
      this._handlers[name] = fn;
    },
    fire(name) {
      if (this._handlers[name]) this._handlers[name]();
    },
    setAttribute() {},
    appendChild() {}
  };
}

/** 装载设置页脚本，返回 { els, sent, flush } */
function loadPanel(initial) {
  const ids = [
    'pet-enabled',
    'pet-alive-bind',
    'pet-count',
    'pet-count-value',
    'pet-dot',
    'pet-dot-value',
    'pet-size',
    'pet-size-value',
    'pet-motion',
    'pet-motion-value',
    'pet-color-row',
    'pet-hint'
  ];
  const els = {};
  for (const id of ids) els[id] = makeEl(id);

  const sent = [];
  let seq = 0;
  const timers = new Map();
  const win = {
    setTimeout(fn) {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    diecloud: {
      petGetSettings: async () => ({ ok: true, settings: { ...initial } }),
      petSetSettings: async (patch) => {
        sent.push({ ...patch });
        return { ok: true, settings: { ...initial, ...patch } };
      },
      petSetEnabled: async (enabled) => ({ ok: true, settings: { ...initial, enabled } })
    }
  };
  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: () => makeEl('created'),
    querySelectorAll: () => []
  };
  const factory = new Function('window', 'document', 'PetShapes', 'uiText', `${fs.readFileSync(SRC, 'utf8')}`);
  factory(win, doc, PetShapes, (key, fallback) => fallback || key);

  return {
    els,
    sent,
    /** 跑掉所有挂起的防抖定时器（并等异步回调落地） */
    async flush() {
      const fns = Array.from(timers.values());
      timers.clear();
      for (const fn of fns) await fn();
      await Promise.resolve();
    }
  };
}

const BASE = { enabled: true, aliveBind: true, count: 128, size: 0.75, motion: 1, dotScale: 0.5, color: 'white' };

describe('pet settings panel', () => {
  it('两次滑杆改动合并成一次提交（先拖点数、再拖大小，点数不会被丢）', async () => {
    const panel = loadPanel(BASE);
    await Promise.resolve(); // 等 refresh() 拿到设置

    panel.els['pet-count'].value = '200';
    panel.els['pet-count'].fire('input');
    panel.els['pet-size'].value = '1.2';
    panel.els['pet-size'].fire('input');

    await panel.flush();

    expect(panel.sent).toHaveLength(1);
    expect(panel.sent[0].count).toBe(200);
    expect(panel.sent[0].size).toBe(1.2);
  });

  it('提交后清空待写内容：下一次改动只发新键', async () => {
    const panel = loadPanel(BASE);
    await Promise.resolve();

    panel.els['pet-motion'].value = '1.6';
    panel.els['pet-motion'].fire('input');
    await panel.flush();

    panel.els['pet-dot'].value = '1.4';
    panel.els['pet-dot'].fire('input');
    await panel.flush();

    expect(panel.sent).toHaveLength(2);
    expect(panel.sent[0]).toEqual({ motion: 1.6 });
    expect(panel.sent[1]).toEqual({ dotScale: 1.4 });
  });
});
