'use strict';

const {
  parseModelRoute,
  resolveApiConfigForRoute,
  resolveDefaultApiConfig,
  resolveSupplierApiConfig,
  pickSupplierModelId,
  isSupplierModelEnabled,
  supplierModelIds,
  isUsableApiConfig,
  asConfig
} = require('../../src/agent/model-api-config');

const CUSTOM_TEXT = {
  id: 'c1',
  name: 'my-text',
  kind: 'text',
  baseUrl: 'https://custom.example/v1',
  apiKey: 'sk-custom'
};

function settingsWith(extra) {
  return {
    baseUrl: '',
    apiKey: '',
    textModel: '',
    builtinBaseUrl: '',
    builtinApiKey: '',
    modelSuppliers: [],
    customModels: [],
    ...extra
  };
}

describe('parseModelRoute', () => {
  it('识别 custom / auto-custom / builtin / bare / empty', () => {
    expect(parseModelRoute('custom:c1')).toEqual({ kind: 'custom', customId: 'c1' });
    expect(parseModelRoute('auto-custom:c1')).toEqual({ kind: 'custom', customId: 'c1' });
    expect(parseModelRoute('builtin:s1:m1')).toEqual({
      kind: 'builtin',
      supplierId: 's1',
      modelId: 'm1'
    });
    // auto-builtin:<modelId> 不带 supplierId（Renderer 既有写法）
    expect(parseModelRoute('auto-builtin:m1')).toEqual({
      kind: 'builtin',
      supplierId: '',
      modelId: 'm1'
    });
    expect(parseModelRoute('my-text')).toEqual({ kind: 'plain', name: 'my-text' });
    expect(parseModelRoute('')).toEqual({ kind: 'default' });
    expect(parseModelRoute(null)).toEqual({ kind: 'default' });
  });
});

describe('isUsableApiConfig', () => {
  it('baseUrl 与 apiKey 均非空才算可用', () => {
    expect(isUsableApiConfig(asConfig('https://a/v1', 'k'))).toBe(true);
    expect(isUsableApiConfig(asConfig('https://a/v1', ''))).toBe(false);
    expect(isUsableApiConfig(asConfig('', 'k'))).toBe(false);
    expect(isUsableApiConfig(null)).toBe(false);
  });

  it('两侧空白会被裁剪', () => {
    expect(isUsableApiConfig({ baseUrl: '  https://a/v1  ', apiKey: '  k  ' })).toBe(true);
  });
});

describe('resolveSupplierApiConfig', () => {
  it('未指定 supplierId：按数组顺序取第一个 baseUrl+apiKey 均非空的供应商', () => {
    const settings = settingsWith({
      modelSuppliers: [
        { id: 's0', baseUrl: '', apiKey: 'sk-0' },
        { id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' },
        { id: 's2', baseUrl: 'https://s2/v1', apiKey: 'sk-2' }
      ]
    });
    expect(resolveSupplierApiConfig(settings)).toEqual({
      baseUrl: 'https://s1/v1',
      apiKey: 'sk-1',
      model: ''
    });
  });

  it('指定 supplierId：命中用命中项', () => {
    const settings = settingsWith({
      modelSuppliers: [
        { id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' },
        { id: 's2', baseUrl: 'https://s2/v1', apiKey: 'sk-2' }
      ]
    });
    expect(resolveSupplierApiConfig(settings, 's2')).toEqual({
      baseUrl: 'https://s2/v1',
      apiKey: 'sk-2',
      model: ''
    });
  });

  it('指定 supplierId 但未命中：返回不可用配置，绝不静默串到别的供应商', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }]
    });
    const cfg = resolveSupplierApiConfig(settings, 'gone');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.apiKey).toBe('');
    expect(isUsableApiConfig(cfg)).toBe(false);
  });

  it('供应商全不可用：退回 builtin', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: '' }],
      builtinBaseUrl: 'https://builtin/v1',
      builtinApiKey: 'sk-builtin'
    });
    expect(resolveSupplierApiConfig(settings)).toEqual({
      baseUrl: 'https://builtin/v1',
      apiKey: 'sk-builtin',
      model: ''
    });
  });
});

describe('resolveDefaultApiConfig', () => {
  it('顺序：可用供应商 → 文本自定义模型 → 顶层 legacy → builtin', () => {
    const supplierWins = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }],
      customModels: [CUSTOM_TEXT],
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy'
    });
    expect(resolveDefaultApiConfig(supplierWins).baseUrl).toBe('https://s1/v1');

    const customWins = settingsWith({
      customModels: [CUSTOM_TEXT],
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy'
    });
    expect(resolveDefaultApiConfig(customWins)).toEqual({
      baseUrl: 'https://custom.example/v1',
      apiKey: 'sk-custom',
      model: 'my-text'
    });

    const legacyWins = settingsWith({
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy',
      textModel: 'legacy-model'
    });
    expect(resolveDefaultApiConfig(legacyWins)).toEqual({
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy',
      model: 'legacy-model'
    });
  });

  it('speech / vision 自定义模型不参与文本兜底', () => {
    const settings = settingsWith({
      customModels: [
        { id: 'v1', name: 'vv', kind: 'vision', baseUrl: 'https://v/v1', apiKey: 'sk-v' },
        { id: 'sp1', name: 'ss', kind: 'speech', baseUrl: 'https://s/v1', apiKey: 'sk-s' }
      ],
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy'
    });
    expect(resolveDefaultApiConfig(settings).baseUrl).toBe('https://legacy/v1');
  });

  it('全空时返回不可用配置（不抛错，由调用方决定报错文案）', () => {
    expect(isUsableApiConfig(resolveDefaultApiConfig(settingsWith()))).toBe(false);
    expect(isUsableApiConfig(resolveDefaultApiConfig(null))).toBe(false);
  });
});

describe('resolveApiConfigForRoute', () => {
  it('custom:<id> 命中自定义模型', () => {
    const settings = settingsWith({ customModels: [CUSTOM_TEXT] });
    expect(resolveApiConfigForRoute(settings, 'custom:c1')).toEqual({
      baseUrl: 'https://custom.example/v1',
      apiKey: 'sk-custom',
      model: 'my-text'
    });
  });

  it('custom:<id> 未命中：非 strict 走兜底，strict 判失效', () => {
    const settings = settingsWith({
      customModels: [CUSTOM_TEXT],
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy'
    });
    expect(resolveApiConfigForRoute(settings, 'custom:gone')).toEqual(resolveDefaultApiConfig(settings));
    expect(isUsableApiConfig(resolveApiConfigForRoute(settings, 'custom:gone', { strict: true }))).toBe(
      false
    );
  });

  it('builtin:<supplierId>:<modelId> 命中供应商；指定但未命中的供应商任何模式都判失效', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }],
      baseUrl: 'https://legacy/v1',
      apiKey: 'sk-legacy'
    });
    expect(resolveApiConfigForRoute(settings, 'builtin:s1:m1').baseUrl).toBe('https://s1/v1');
    // 绝不静默换到别的供应商的 key 上
    expect(
      isUsableApiConfig(resolveApiConfigForRoute(settings, 'builtin:gone:m1'))
    ).toBe(false);
    expect(
      isUsableApiConfig(resolveApiConfigForRoute(settings, 'builtin:gone:m1', { strict: true }))
    ).toBe(false);
  });

  it('auto-builtin:<modelId> 无 supplierId 时取第一个可用供应商', () => {
    const settings = settingsWith({
      modelSuppliers: [
        { id: 's0', baseUrl: '', apiKey: 'sk-0' },
        { id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }
      ]
    });
    expect(resolveApiConfigForRoute(settings, 'auto-builtin:m1').baseUrl).toBe('https://s1/v1');
  });

  it('裸模型名先按自定义模型名命中', () => {
    const settings = settingsWith({ customModels: [CUSTOM_TEXT] });
    expect(resolveApiConfigForRoute(settings, 'my-text').baseUrl).toBe('https://custom.example/v1');
  });

  it('空 route（default）：无"指定但失效"可言，任何模式都走兜底', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }]
    });
    expect(resolveApiConfigForRoute(settings, '').baseUrl).toBe('https://s1/v1');
    expect(resolveApiConfigForRoute(settings, '', { strict: true })).toEqual(
      resolveDefaultApiConfig(settings)
    );
  });
});

describe('pickSupplierModelId / 供应商默认模型名', () => {
  const SUPPLIER = {
    id: 's1',
    baseUrl: 'https://s1/v1',
    apiKey: 'sk-1',
    enabledModels: { 'm-a': true, 'm-b': false, 'm-c': true },
    modelModalities: { 'm-a': 'vision', 'm-c': 'text' }
  };

  it('取第一个未禁用模型；优先非 speech', () => {
    expect(pickSupplierModelId(SUPPLIER)).toBe('m-a');
    expect(
      pickSupplierModelId({
        ...SUPPLIER,
        modelModalities: { 'm-a': 'speech', 'm-c': 'text' }
      })
    ).toBe('m-c');
    expect(pickSupplierModelId({ ...SUPPLIER, enabledModels: { 'm-c': true, 'm-a': false } })).toBe(
      'm-c'
    );
  });

  it('enabledModels 全禁用：不猜，返回空', () => {
    // 三条来源上声明过的模型全部被显式禁用 ⇒ 没有可用候选，不猜。
    expect(
      pickSupplierModelId({
        id: 's1',
        enabledModels: { 'm-a': false, 'm-c': false },
        modelModalities: { 'm-c': 'text' }
      })
    ).toBe('');
    // 该供应商根本没有已启用模型（三个来源都空）
    expect(pickSupplierModelId({ ...SUPPLIER, enabledModels: {}, modelModalities: {} })).toBe('');
  });

  it('候选集三源合并：enabledModels 只声明了一个 false 时，其余来源键不得被误判为禁用', () => {
    // enabledModels 非空只说明「用户动过开关」，不等于「这是模型全集」：
    // m-c 只出现在 modelModalities 上，仍必须入选（与 Renderer 勾选态一致）。
    expect(
      pickSupplierModelId({
        id: 's1',
        enabledModels: { 'm-a': false },
        modelModalities: { 'm-c': 'text' }
      })
    ).toBe('m-c');
    // 反过来：m-c 被显式禁用时就不该再选中它
    expect(
      pickSupplierModelId({
        id: 's1',
        enabledModels: { 'm-a': false, 'm-c': false },
        modelModalities: { 'm-c': 'text' }
      })
    ).toBe('');
  });

  it('无 enabledModels 时退回 modelModalities / contextTierByModel 的键；全无信息返回空', () => {
    expect(pickSupplierModelId({ id: 's1', modelModalities: { 'm-x': 'text' } })).toBe('m-x');
    expect(pickSupplierModelId({ id: 's1', contextTierByModel: { 'm-y': 'long' } })).toBe('m-y');
    expect(pickSupplierModelId({ id: 's1' })).toBe('');
    expect(pickSupplierModelId(null)).toBe('');
    expect(pickSupplierModelId({ id: 's1', enabledModels: {} })).toBe('');
  });

  it('isSupplierModelEnabled 判据：空表全可用 / 显式 false 才禁用', () => {
    expect(isSupplierModelEnabled(SUPPLIER, 'm-a')).toBe(true);
    expect(isSupplierModelEnabled(SUPPLIER, 'm-b')).toBe(false);
    // 表为空 ⇒ 用户没筛过，任何 id 都可用
    expect(isSupplierModelEnabled({ id: 's1', enabledModels: {} }, 'm-z')).toBe(true);
    expect(isSupplierModelEnabled({ id: 's1' }, 'm-z')).toBe(true);
    expect(isSupplierModelEnabled(null, 'm-z')).toBe(false);
    expect(isSupplierModelEnabled(SUPPLIER, '')).toBe(false);
  });

  it('supplierModelIds 合并三源并保序去重', () => {
    expect(
      supplierModelIds({
        enabledModels: { 'm-a': true, 'm-b': false },
        modelModalities: { 'm-b': 'text', 'm-c': 'vision' },
        contextTierByModel: { 'm-d': 'long' }
      })
    ).toEqual(['m-a', 'm-b', 'm-c', 'm-d']);
    expect(supplierModelIds(null)).toEqual([]);
  });

  it('无 route 的兜底解析必须带出模型名（否则定时计划会以空模型名请求模型服务）', () => {
    const settings = settingsWith({ modelSuppliers: [SUPPLIER] });
    expect(resolveDefaultApiConfig(settings).model).toBe('m-a');
    expect(resolveSupplierApiConfig(settings).model).toBe('m-a');
    expect(resolveSupplierApiConfig(settings, 's1').model).toBe('m-a');
  });

  it('builtin:<supplierId>:<modelId> 把路由里的 modelId 解析成模型名', () => {
    const settings = settingsWith({ modelSuppliers: [SUPPLIER] });
    expect(resolveApiConfigForRoute(settings, 'builtin:s1:m-c')).toEqual({
      baseUrl: 'https://s1/v1',
      apiKey: 'sk-1',
      model: 'm-c'
    });
    // 路由未带 modelId → 退回供应商默认模型
    expect(resolveApiConfigForRoute(settings, 'builtin:s1:').model).toBe('m-a');
    // 无 supplierId 时同样带出默认模型
    expect(resolveApiConfigForRoute(settings, 'auto-builtin:m-c').model).toBe('m-a');
  });
});
