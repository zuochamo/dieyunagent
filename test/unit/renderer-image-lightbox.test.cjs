'use strict';
/**
 * 通用图片全屏查看（`src/renderer/renderer-attachments.js`）的状态机。
 *
 * 它是 composer 附件预览与「回答里的截图」共用的**唯一**大图查看器，所以行为要钉住：
 * 开 → 亮图 + 底部文件名/次要动作；关（按钮 / Esc / 点空白）→ 清 src、收回底部栏、
 * 释放临时 URL；次要动作先关灯箱再执行（否则面板被盖住，像没反应）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-attachments.js');

function makeEl(id) {
  const el = {
    id,
    hidden: true,
    textContent: '',
    _attrs: {},
    listeners: {},
    setAttribute(k, v) {
      el._attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null;
    },
    removeAttribute(k) {
      delete el._attrs[k];
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    dispatch(type, ev) {
      const event = ev || { target: el, preventDefault() {} };
      for (const fn of el.listeners[type] || []) fn(event);
    }
  };
  Object.defineProperty(el, 'src', {
    get: () => el._attrs.src || '',
    set: (v) => {
      el._attrs.src = String(v);
    },
    configurable: true
  });
  Object.defineProperty(el, 'alt', {
    get: () => el._attrs.alt || '',
    set: (v) => {
      el._attrs.alt = String(v);
    },
    configurable: true
  });
  return el;
}

function mount() {
  const ids = [
    'image-lightbox',
    'image-lightbox-close',
    'image-lightbox-img',
    'image-lightbox-bar',
    'image-lightbox-name',
    'image-lightbox-action'
  ];
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  const docListeners = {};
  const document = {
    getElementById: (id) => els[id] || null,
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    }
  };
  const $ = (id) => document.getElementById(id);
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    '$',
    `${source}
     return { openImageLightbox, closeImageLightbox, bindImageLightbox };`
  );
  const api = factory({}, document, $);
  api.bindImageLightbox();
  return { ...api, els, docListeners };
}

test('开灯箱：亮图 + 文件名 + 次要动作可见', () => {
  const lb = mount();
  let acted = 0;
  lb.openImageLightbox('blob:abc', '04-导出企业.png', {
    name: '04-导出企业.png',
    actionLabel: '在产物面板打开',
    onAction: () => {
      acted += 1;
    }
  });
  assert.equal(lb.els['image-lightbox'].hidden, false);
  assert.equal(lb.els['image-lightbox-img'].src, 'blob:abc');
  assert.equal(lb.els['image-lightbox-img'].getAttribute('alt'), '04-导出企业.png');
  assert.equal(lb.els['image-lightbox-name'].textContent, '04-导出企业.png');
  assert.equal(lb.els['image-lightbox-name'].hidden, false);
  assert.equal(lb.els['image-lightbox-action'].hidden, false);
  assert.equal(lb.els['image-lightbox-action'].textContent, '在产物面板打开');

  // 点动作：先关灯箱，再执行（否则面板被盖住）
  lb.els['image-lightbox-action'].dispatch('click');
  assert.equal(lb.els['image-lightbox'].hidden, true);
  assert.equal(acted, 1);
});

test('关灯箱：清 src / 底部栏，并回调 onClose 释放临时 URL', () => {
  const lb = mount();
  const revoked = [];
  lb.openImageLightbox('blob:temp', 'chart.png', {
    name: 'chart.png',
    onClose: () => revoked.push('blob:temp')
  });
  lb.closeImageLightbox();
  assert.equal(lb.els['image-lightbox'].hidden, true);
  assert.equal(lb.els['image-lightbox-img'].getAttribute('src'), null);
  assert.equal(lb.els['image-lightbox-name'].textContent, '');
  assert.equal(lb.els['image-lightbox-bar'].hidden, true);
  assert.equal(lb.els['image-lightbox-action'].hidden, true);
  assert.deepEqual(revoked, ['blob:temp'], '临时 URL 必须释放');
});

test('无文件名/无次要动作时底部栏整条隐藏（composer 的旧行为不变）', () => {
  const lb = mount();
  lb.openImageLightbox('blob:plain', 'photo.jpg');
  assert.equal(lb.els['image-lightbox'].hidden, false);
  assert.equal(lb.els['image-lightbox-bar'].hidden, true);
  assert.equal(lb.els['image-lightbox-action'].hidden, true);
});

test('Esc 与点空白关闭；点图片本身不关闭', () => {
  const lb = mount();
  lb.openImageLightbox('blob:abc', 'a.png', { name: 'a.png' });

  lb.els['image-lightbox-img'].dispatch('click', { target: lb.els['image-lightbox-img'], preventDefault() {} });
  assert.equal(lb.els['image-lightbox'].hidden, false, '点图不该关（看大图时最常点的地方）');

  lb.els['image-lightbox'].dispatch('click', { target: lb.els['image-lightbox'], preventDefault() {} });
  assert.equal(lb.els['image-lightbox'].hidden, true, '点空白关');

  lb.openImageLightbox('blob:abc', 'a.png', { name: 'a.png' });
  for (const fn of lb.docListeners.keydown || []) fn({ key: 'Escape' });
  assert.equal(lb.els['image-lightbox'].hidden, true, 'Esc 关');
});
