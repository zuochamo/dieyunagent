'use strict';

/**
 * 市场页/列表页共用的分页条与翻页按钮（`renderer-skills-grid.js` 的单一来源）。
 *
 * 锁两件事：
 * 1. 「末页但服务端还有更多」时必须出现分页条、且「下一页」可点 —— 否则用户看不到
 *    还有内容（技能市场原来就在末页把按钮禁掉，只能靠再点一次才动）；
 * 2. `onNext` 返回 true（= 自己处理了服务端加载）时，helper 不得再本地 +1 ——
 *    否则会跳过一页（这正是「加载更多之后不推进索引」那个 bug 的镜像面）。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` + 极简 window/$ 桩来加载
 * （手法同 `renderer-chat-load-mode.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-skills-grid.js'),
  'utf8'
);

function makeEl() {
  return {
    id: '',
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function makeEls() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const el = makeEl();
      el.id = id;
      els.set(id, el);
    }
    return els.get(id);
  };
  return { $, els };
}

/**
 * 加载 `renderer-skills-grid.js` 里的共用 helper。
 * 传 `$` 可与别的脚本共用同一套 DOM 桩（市场页测试要同一份，否则绑定的监听器落在别的桩上）。
 */
function loadHelpers(providedDollar) {
  const box = providedDollar ? null : makeEls();
  const $ = providedDollar || box.$;
  const window = { diecloud: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  const factory = new Function(
    'window',
    'document',
    '$',
    'escapeHtml',
    `${SRC}
     return { updateGridPagination, bindGridPagination, bindGridSearchInput, parseGridListResult };`
  );
  const api = factory(window, { addEventListener() {}, querySelectorAll: () => [] }, $, (s) => String(s));
  return { ...api, $, els: box ? box.els : null };
}

describe('目录列表返回形状（parseGridListResult）', () => {
  const { parseGridListResult } = loadHelpers();

  it('对象形状原样解析，errors 缺省为空表', () => {
    const parsed = parseGridListResult({
      entries: [{ id: 'a' }],
      hasMore: true,
      loadedCount: 45,
      searchRemote: true
    });
    assert.deepEqual(parsed.entries, [{ id: 'a' }]);
    assert.equal(parsed.hasMore, true);
    assert.equal(parsed.loadedCount, 45);
    assert.equal(parsed.searchRemote, true);
    assert.deepEqual(parsed.errors, []);
  });

  it('MCP 侧的多源失败原因被透出（技能侧不用但共用一份解析）', () => {
    const parsed = parseGridListResult({ entries: [], errors: [{ url: 'u', message: 'HTTP 500' }] });
    assert.deepEqual(parsed.errors, [{ url: 'u', message: 'HTTP 500' }]);
    assert.equal(parsed.loadedCount, 0);
    assert.equal(parsed.hasMore, false);
  });

  it('旧「结果是数组」的形状不再兼容（Main 早已只返回对象）', () => {
    const parsed = parseGridListResult([{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(parsed.entries, []);
    assert.equal(parsed.hasMore, false);
  });
});

describe('分页条（updateGridPagination）', () => {
  it('单页且没有更多时整条隐藏', () => {
    const { updateGridPagination, $ } = loadHelpers();
    updateGridPagination('x', 0, 1, 3);
    assert.equal($('x-pagination').hidden, true);
  });

  it('末页但 canLoadMore：分页条出现，「下一页」保持可点', () => {
    const { updateGridPagination, $ } = loadHelpers();
    updateGridPagination('x', 1, 2, 30, { canLoadMore: true, label: '当前 30 项 · 可继续加载' });
    assert.equal($('x-pagination').hidden, false);
    assert.equal($('x-page-next').disabled, false);
    assert.equal($('x-page-prev').disabled, false);
    assert.match($('x-page-info').textContent, /2 \/ 2/);
    assert.match($('x-page-info').textContent, /可继续加载/);
  });

  it('末页且没有更多：下一页禁用；首页上一页禁用', () => {
    const { updateGridPagination, $ } = loadHelpers();
    updateGridPagination('x', 1, 2, 30);
    assert.equal($('x-page-next').disabled, true);
    updateGridPagination('x', 0, 2, 30);
    assert.equal($('x-page-prev').disabled, true);
    assert.equal($('x-page-next').disabled, false);
  });

  it('加载中：信息位写「加载中…」，两个按钮都禁用', () => {
    const { updateGridPagination, $ } = loadHelpers();
    updateGridPagination('x', 0, 3, 90, { loading: true });
    assert.equal($('x-page-info').textContent, '加载中…');
    assert.equal($('x-page-prev').disabled, true);
    assert.equal($('x-page-next').disabled, true);
  });
});

describe('翻页按钮（bindGridPagination）', () => {
  it('普通翻页：本地 +1 后重绘', async () => {
    const { bindGridPagination, $ } = loadHelpers();
    let index = 0;
    let renders = 0;
    bindGridPagination('x', () => index, (v) => (index = v), () => (renders += 1));
    await $('x-page-next').listeners.click();
    assert.equal(index, 1);
    assert.equal(renders, 1);
    await $('x-page-prev').listeners.click();
    assert.equal(index, 0);
    assert.equal(renders, 2);
  });

  it('首页点上一页：不动也不重绘', async () => {
    const { bindGridPagination, $ } = loadHelpers();
    let index = 0;
    let renders = 0;
    bindGridPagination('x', () => index, (v) => (index = v), () => (renders += 1));
    await $('x-page-prev').listeners.click();
    assert.equal(index, 0);
    assert.equal(renders, 0);
  });

  it('onNext 返回 true（自己做了服务端加载）：helper 不再本地 +1', async () => {
    const { bindGridPagination, $ } = loadHelpers();
    let index = 1;
    let renders = 0;
    let handled = 0;
    bindGridPagination('x', () => index, (v) => (index = v), () => (renders += 1), {
      onNext: async () => {
        handled += 1;
        return true;
      }
    });
    await $('x-page-next').listeners.click();
    assert.equal(handled, 1);
    assert.equal(index, 1, 'helper 不能把它再 +1（会跳过一页）');
    assert.equal(renders, 0);
  });

  it('onNext 返回 false（不是末页加载场景）：落回本地翻页', async () => {
    const { bindGridPagination, $ } = loadHelpers();
    let index = 0;
    let renders = 0;
    bindGridPagination('x', () => index, (v) => (index = v), () => (renders += 1), {
      onNext: async () => false
    });
    await $('x-page-next').listeners.click();
    assert.equal(index, 1);
    assert.equal(renders, 1);
  });
});

/**
 * 技能市场「下一页」的回归：**末页加载更多之后必须真的翻到新的一页**。
 * 2026-11-03 审查就记下过这个 bug（`renderer-skill-catalog.js` 只重渲染、不推进索引），
 * 用户点一次看到的还是同一页，要再点一次才动。
 */
describe('技能市场：末页加载更多后推进索引', () => {
  function loadSkillCatalog() {
    const box = makeEls();
    const $ = box.$;
    const PAGE = 15;
    const browse = Array.from({ length: 35 }, (_, i) => ({
      id: `owner/repo/skill-${i}`,
      name: `skill-${i}`,
      installState: 'available',
      canAdd: true
    }));
    let calls = 0;
    const window = {
      SKILLS_GRID_PAGE_SIZE: PAGE,
      localStorage: { getItem: () => null, setItem: () => {} },
      diecloud: {
        /** 首屏给 20 条（2 页），loadMore 一次性补齐剩下的 */
        skillCatalogList: async ({ loadMore } = {}) => {
          calls += 1;
          const entries = loadMore ? browse.slice() : browse.slice(0, 20);
          return { entries, hasMore: entries.length < browse.length, loadedCount: entries.length, searchRemote: false };
        }
      }
    };
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-skill-catalog.js'),
      'utf8'
    );
    const grid = loadHelpers($);
    const factory = new Function(
      'window',
      'document',
      '$',
      'escapeHtml',
      'updateGridPagination',
      'bindGridSearchInput',
      'bindGridPagination',
      'parseGridListResult',
      'refreshSkillsCatalog',
      'gatewayCall',
      `${source}
       return { initSkillCatalogUI, loadSkillCatalogUI, getPageIndex: () => skillCatalogPageIndex, entryCount: () => skillCatalogEntries.length };`
    );
    const api = factory(
      window,
      { addEventListener() {}, querySelectorAll: () => [] },
      $,
      (s) => String(s),
      grid.updateGridPagination,
      grid.bindGridSearchInput,
      grid.bindGridPagination,
      grid.parseGridListResult,
      () => {},
      async () => {}
    );
    return { api, $, window, calls: () => calls, PAGE };
  }

  it('首屏 2 页；末页点「下一页」= 先加载更多、再把索引推进一页', async () => {
    const { api, $ } = loadSkillCatalog();
    api.initSkillCatalogUI();
    await api.loadSkillCatalogUI();
    assert.equal(api.getPageIndex(), 0);
    assert.equal(api.entryCount(), 20);

    // 第一页 → 第二页（末页，还有更多，所以按钮可点）
    await $('skill-catalog-page-next').listeners.click();
    assert.equal(api.getPageIndex(), 1);
    assert.equal($('skill-catalog-page-next').disabled, false, '末页还有更多时下一页必须可点');

    // 末页 → 加载更多并推进到新一页（修的就是这一步：以前只重渲染、索引不动）
    await $('skill-catalog-page-next').listeners.click();
    assert.equal(api.entryCount(), 35);
    assert.equal(api.getPageIndex(), 2, '加载更多之后必须真的翻到新页');
    assert.match($('skill-catalog-page-info').textContent, /^3 \/ 3/);
  });
});
