'use strict';

const { withEngineTag, defaultBaselineName } = require('../../src/browser/visual-diff');

describe('visual-diff：引擎隔离靠文件名', () => {
  it('引擎标记插在扩展名前', () => {
    expect(withEngineTag('shots/login.png', 'browserview')).toBe('shots/login.browserview.png');
    expect(withEngineTag('shots/login.png', 'playwright')).toBe('shots/login.playwright.png');
  });

  it('换引擎必然换文件 —— 跨引擎比较无从发生，不需要元信息文件配合', () => {
    expect(withEngineTag('b.png', 'browserview')).not.toBe(withEngineTag('b.png', 'playwright'));
  });

  it('没写扩展名时按 png 补全', () => {
    expect(withEngineTag('shots/login', 'browserview')).toBe('shots/login.browserview.png');
  });

  it('目录名里的点不算扩展名（两种分隔符都要认）', () => {
    expect(withEngineTag('a.b/login.png', 'playwright')).toBe('a.b/login.playwright.png');
    expect(withEngineTag('v1.2\\login.png', 'playwright')).toBe('v1.2\\login.playwright.png');
  });

  it('幂等：把上次返回的路径原样传回来，不会再套一层标记', () => {
    const once = withEngineTag('shots/login.png', 'browserview');
    expect(withEngineTag(once, 'browserview')).toBe(once);
    expect(withEngineTag(withEngineTag(once, 'browserview'), 'browserview')).toBe(once);
  });

  it('换成别的引擎仍会换文件（不会误判成「已带标记」）', () => {
    expect(withEngineTag('shots/login.browserview.png', 'playwright')).toBe(
      'shots/login.browserview.playwright.png'
    );
  });
});

describe('visual-diff：默认基准名', () => {
  const params = { selector: '.card' };

  it('同目标 → 稳定同名（多次调用比的是同一张）', () => {
    expect(defaultBaselineName(params)).toBe(defaultBaselineName(params));
  });

  it('元素 / 整页 / ref 各自一份基准，互不覆盖', () => {
    const base = defaultBaselineName(params);
    expect(defaultBaselineName({ selector: '.list' })).not.toBe(base);
    expect(defaultBaselineName({ selector: '.card', fullPage: true })).not.toBe(base);
    expect(defaultBaselineName({ ref: 'e12' })).not.toBe(base);
  });

  it('默认名本身不含引擎标记 —— 标记由 withEngineTag 统一附加', () => {
    expect(defaultBaselineName(params)).not.toContain('.browserview.');
    expect(withEngineTag(defaultBaselineName(params), 'browserview')).toContain('.browserview.png');
  });

  it('默认名经标记后：换引擎换一份基准', () => {
    const name = withEngineTag(defaultBaselineName(params), 'browserview');
    expect(name).not.toBe(withEngineTag(defaultBaselineName(params), 'playwright'));
  });
});
