'use strict';

/**
 * Main 侧「文本模型」解析（`resolveTextApiConfig`）：端点与模型名必须出自同一次解析。
 *
 * 这条链路是无 Renderer 的调用方（定时/目标型计划、频道、headless）唯一的模型入口。
 * 历史 bug：计划里存了 `model: deepseek-v4.1-flash` 但 `modelRoute: ''`，
 * 旧实现用默认端点（官方 api.deepseek.com）的 key 发这个名字，上游直接 400
 * （`The supported API model names are deepseek-flash, deepseek-v4-pro, ...`）。
 */
const { resolveTextApiConfig } = require('../../src/model-settings');

const SETTINGS = {
  baseUrl: '',
  apiKey: '',
  textModel: 'official-flash',
  builtinBaseUrl: '',
  builtinApiKey: '',
  modelSuppliers: [
    {
      id: 's-lan',
      baseUrl: 'http://lan:5018/v1',
      apiKey: 'sk-lan',
      enabledModels: { 'lan-flash': true }
    }
  ],
  customModels: [
    {
      id: 'c1',
      name: 'official-flash',
      kind: 'vision',
      baseUrl: 'https://api.official.com',
      apiKey: 'sk-official'
    }
  ]
};

describe('resolveTextApiConfig', () => {
  it('只给模型名（route 为空）：端点跟着「谁启用了它」走', () => {
    expect(resolveTextApiConfig(SETTINGS, { model: 'lan-flash', strict: true })).toEqual({
      baseUrl: 'http://lan:5018/v1',
      apiKey: 'sk-lan',
      model: 'lan-flash'
    });
  });

  it('有 route 时 route 就是模型身份：不同名的 model 不能把它覆盖掉', () => {
    // 旧实现 opts.model 优先 → 用供应商端点发官方模型名（或反之），必然 400
    const cfg = resolveTextApiConfig(SETTINGS, {
      route: 'builtin:s-lan:lan-flash',
      model: 'official-flash',
      strict: true
    });
    expect(cfg.baseUrl).toBe('http://lan:5018/v1');
    expect(cfg.model).toBe('lan-flash');
  });

  it("Renderer 的 'default' 记号等同空 route（不是模型名）", () => {
    const cfg = resolveTextApiConfig(SETTINGS, { route: 'default' });
    expect(cfg.baseUrl).toBe('https://api.official.com');
    expect(cfg.model).toBe('official-flash');
  });

  it('什么都没给：走默认解析（显式 textModel 优先）', () => {
    expect(resolveTextApiConfig(SETTINGS, {})).toEqual({
      baseUrl: 'https://api.official.com',
      apiKey: 'sk-official',
      model: 'official-flash'
    });
  });

  it('点名的模型没有任何端点提供：strict 下不猜（留给调用方明确报错）', () => {
    const cfg = resolveTextApiConfig(SETTINGS, { model: 'ghost-model', strict: true });
    expect(cfg.baseUrl && cfg.apiKey).toBeFalsy();
  });
});
