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

describe('resolveDefaultApiConfig / 显式默认文本模型（textModel）优先', () => {
  const SUPPLIER_ORDERED = {
    id: 's1',
    baseUrl: 'https://lan/v1',
    apiKey: 'sk-lan',
    enabledModels: { 'space-bunny': true, 'm-c': true },
    modelModalities: { 'space-bunny': 'vision', 'm-c': 'text' }
  };

  it('供应商已启用模型里有同 id → 用它，而不是数组第一个', () => {
    // 不带 textModel 时按数组顺序，会选中第一个（vision 那个）
    expect(
      resolveDefaultApiConfig(settingsWith({ modelSuppliers: [SUPPLIER_ORDERED] })).model
    ).toBe('space-bunny');
    expect(
      resolveDefaultApiConfig(settingsWith({ textModel: 'm-c', modelSuppliers: [SUPPLIER_ORDERED] }))
    ).toEqual({ baseUrl: 'https://lan/v1', apiKey: 'sk-lan', model: 'm-c' });
  });

  it('自定义模型里有同 name → 用它（vision 类也认：用户点名的就是它）', () => {
    const settings = settingsWith({
      textModel: 'deepseek-flash',
      modelSuppliers: [SUPPLIER_ORDERED],
      customModels: [
        {
          id: 'v1',
          name: 'deepseek-flash',
          kind: 'vision',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-ds'
        }
      ]
    });
    // 供应商仍然可用，但显式点名优先
    expect(resolveDefaultApiConfig(settings)).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-ds',
      model: 'deepseek-flash'
    });
  });

  it('点名的是被禁用的供应商模型 / 找不到承载端点 → 回落到原顺序（不猜、不换 key）', () => {
    // m-b 被显式禁用：显式点名不该复活一个被关掉的模型
    const disabled = settingsWith({
      textModel: 'm-b',
      modelSuppliers: [{ ...SUPPLIER_ORDERED, enabledModels: { 'm-b': false } }]
    });
    expect(resolveDefaultApiConfig(disabled)).toEqual({
      baseUrl: 'https://lan/v1',
      apiKey: 'sk-lan',
      model: 'space-bunny'
    });

    const ghost = settingsWith({ textModel: 'ghost-model', modelSuppliers: [SUPPLIER_ORDERED] });
    expect(resolveDefaultApiConfig(ghost).model).toBe('space-bunny');
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

describe('请求修饰字段（headers / authMode / userAgent）解析与装配', () => {
  const OPENCODE_LIKE = {
    id: 's1',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'sk-1',
    userAgent: 'dieyunagent/1.0',
    headers: { 'x-opencode-session': '{{sessionId}}' }
  };

  it('供应商上的自定义头 / User-Agent 随解析结果一并带出', () => {
    const settings = settingsWith({ modelSuppliers: [OPENCODE_LIKE] });
    const cfg = resolveApiConfigForRoute(settings, 'builtin:s1:m1');
    expect(cfg.headers).toEqual({ 'x-opencode-session': '{{sessionId}}' });
    expect(cfg.userAgent).toBe('dieyunagent/1.0');
  });

  it('未配置请求修饰时返回值仍是三键（不污染既有结构契约）', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'sk-1' }]
    });
    expect(resolveSupplierApiConfig(settings, 's1')).toEqual({
      baseUrl: 'https://s1/v1',
      apiKey: 'sk-1',
      model: ''
    });
  });

  it('authMode 非默认值才透出；bearer 不写进配置', () => {
    const settings = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'k', authMode: 'x-api-key' }]
    });
    expect(resolveSupplierApiConfig(settings, 's1').authMode).toBe('x-api-key');

    const legacy = settingsWith({
      modelSuppliers: [{ id: 's1', baseUrl: 'https://s1/v1', apiKey: 'k', authMode: 'bearer' }]
    });
    expect(resolveSupplierApiConfig(legacy, 's1').authMode).toBeUndefined();
  });

  it('端到端：路由解析 → 请求头装配，产出上游要的会话头（原 400 场景）', () => {
    const { buildLlmHeadersFromConfig } = require('../../src/agent/llm-request');
    const settings = settingsWith({ modelSuppliers: [OPENCODE_LIKE] });
    const cfg = resolveApiConfigForRoute(settings, 'builtin:s1:m1');
    // 调用点只需补运行时标识：会话级 sessionId + 每轮 runId
    const headers = buildLlmHeadersFromConfig({ ...cfg, sessionId: 'conv-1' }, { runId: 'r1' });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer sk-1');
    expect(headers['x-opencode-session']).toBe('conv-1');
    expect(headers['User-Agent']).toBe('dieyunagent/1.0');
  });

  it('端到端：无会话标识时该头不发送（不产生空值头）', () => {
    const { buildLlmHeadersFromConfig } = require('../../src/agent/llm-request');
    const settings = settingsWith({ modelSuppliers: [OPENCODE_LIKE] });
    const cfg = resolveApiConfigForRoute(settings, 'builtin:s1:m1');
    const headers = buildLlmHeadersFromConfig(cfg, {});
    expect(Object.prototype.hasOwnProperty.call(headers, 'x-opencode-session')).toBe(false);
    expect(headers.Authorization).toBe('Bearer sk-1');
  });

  it('回归：vars 传空 sessionId 不得抹掉 config 上的会话标识（压缩 400 场景）', () => {
    const { buildLlmHeadersFromConfig } = require('../../src/agent/llm-request');
    const settings = settingsWith({ modelSuppliers: [OPENCODE_LIKE] });
    const cfg = resolveApiConfigForRoute(settings, 'builtin:s1:m1');
    // 压缩调用点历史上传 `{ sessionId: opts.sessionId }`，opts 为空时会整条头消失
    for (const empty of [undefined, null, '']) {
      const headers = buildLlmHeadersFromConfig({ ...cfg, sessionId: 'conv-1' }, { sessionId: empty });
      expect(headers['x-opencode-session']).toBe('conv-1');
    }
  });

  it('vars 非空值仍可覆盖 config 同名变量，并可新增 config 没有的键', () => {
    const { buildLlmHeadersFromConfig } = require('../../src/agent/llm-request');
    const cfg = {
      apiKey: 'sk-1',
      model: 'm-default',
      headers: { 'x-model': '{{model}}', 'x-run': '{{runId}}' }
    };
    // runId 每轮变化：config 上没有，由 vars 补
    const headers = buildLlmHeadersFromConfig(cfg, { model: 'm-per-turn', runId: 'r-9' });
    expect(headers['x-model']).toBe('m-per-turn');
    expect(headers['x-run']).toBe('r-9');
  });

  it('自定义模型同样支持请求修饰字段', () => {
    const settings = settingsWith({
      customModels: [{ ...CUSTOM_TEXT, userAgent: 'ua/2', headers: { 'X-Title': 'dieyun' } }]
    });
    const cfg = resolveApiConfigForRoute(settings, 'custom:c1');
    expect(cfg.userAgent).toBe('ua/2');
    expect(cfg.headers).toEqual({ 'X-Title': 'dieyun' });
  });
});
