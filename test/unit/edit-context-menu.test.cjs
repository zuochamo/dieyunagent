'use strict';

const { buildEditContextMenuTemplate } = require('../../src/main/window-tray');

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
