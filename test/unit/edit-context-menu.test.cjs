'use strict';

const { buildEditContextMenuTemplate, trayPixelSizeFor } = require('../../src/main/window-tray');

describe('edit context menu', () => {
  it('builds cut/copy/paste/selectAll for editable fields', () => {
    const t = buildEditContextMenuTemplate({
      isEditable: true,
      selectionText: '',
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true }
    });
    expect(t.map((i) => i.label).filter(Boolean)).toEqual(['剪切', '复制', '粘贴', '全选']);
    expect(t.find((i) => i.role === 'cut').enabled).toBe(false);
    expect(t.find((i) => i.role === 'paste').enabled).toBe(true);
    expect(t.filter((i) => i.type === 'separator')).toHaveLength(1);
  });

  it('exposes only copy/selectAll for a plain selection', () => {
    const t = buildEditContextMenuTemplate({
      isEditable: false,
      selectionText: 'hello',
      editFlags: {}
    });
    expect(t.map((i) => i.label).filter(Boolean)).toEqual(['复制', '全选']);
    expect(t.some((i) => i.role === 'paste')).toBe(false);
  });

  it('returns empty when there is nothing to act on', () => {
    expect(buildEditContextMenuTemplate({ isEditable: false, selectionText: '   ' })).toEqual([]);
    expect(buildEditContextMenuTemplate(null)).toEqual([]);
    expect(buildEditContextMenuTemplate(undefined)).toEqual([]);
  });

  it('keeps items enabled when editFlags are missing', () => {
    const t = buildEditContextMenuTemplate({ isEditable: true, selectionText: '' });
    expect(t.every((i) => i.enabled !== false)).toBe(true);
  });
});

describe('tray icon pixel size', () => {
  // 托盘槽位是 16 DIP：高缩放下必须给足像素，否则系统放大 → 图标糊
  it('scales with the display scale factor', () => {
    expect(trayPixelSizeFor(1)).toBe(16);
    expect(trayPixelSizeFor(1.25)).toBe(20);
    expect(trayPixelSizeFor(1.5)).toBe(24);
    expect(trayPixelSizeFor(2)).toBe(32);
    expect(trayPixelSizeFor(3)).toBe(48);
  });

  it('never goes below the 16px tray slot', () => {
    expect(trayPixelSizeFor(0.5)).toBe(16);
    expect(trayPixelSizeFor(0)).toBe(16);
    expect(trayPixelSizeFor(Number.NaN)).toBe(16);
    expect(trayPixelSizeFor(undefined)).toBe(16);
  });
});
