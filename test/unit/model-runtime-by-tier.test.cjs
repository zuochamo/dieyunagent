'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const {
  applyTierRuntime,
  computeEffectiveInputBudget,
  loadRuntimeByTierFromMain,
  saveRuntimeByTierToMain,
  getRuntimeValuesForTierFromMain,
  listContextTierIds,
  migrateGlobalSettingsToDefaultTier,
  reloadRuntimeByTier,
  STORAGE_KEY,
  MIN_INPUT_BUDGET_TOKENS,
  RUNTIME_BY_TIER_FILE,
  resolveModelFacts,
  resolveModelContextWindowFromSettings,
  resolveContextTierIdFromSettings
} = require('../../src/agent/model-runtime-by-tier');
const { MODEL_RUNTIME_PRESETS } = require('../../src/agent/model-runtime-presets');

function withTempUserData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-runtime-tier-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('编码参数按档生效（Main 侧唯一入口）', () => {
  it('档位清单只有 model-runtime-presets 一份（9 档，无 8K）', () => {
    assert.deepEqual(
      listContextTierIds(),
      MODEL_RUNTIME_PRESETS.map((p) => p.id)
    );
    assert.equal(listContextTierIds().includes('ctx-8k'), false);
  });

  it('default 档直接用磁盘 settings（Renderer 只镜像 default 档）', () => {
    withTempUserData((dir) => {
      const settings = { tierId: undefined, contextWindow: 524288, textModel: 'unknown-model' };
      const same = applyTierRuntime(settings, dir, { tierId: 'default' });
      assert.equal(same, settings, 'default 档必须原样返回，不能再叠工厂值');
    });
  });

  it('非 default 档叠上该档覆盖值（否则压缩侧仍按 default 档算阈值）', () => {
    withTempUserData((dir) => {
      saveRuntimeByTierToMain(dir, {
        'ctx-16k': { contextWindow: 16384, maxOutputTokens: 4096, compactionTriggerRatio: 0.5 }
      });
      const merged = applyTierRuntime(
        { contextWindow: 524288, maxOutputTokens: 32768, compactionTriggerRatio: 0.88 },
        dir,
        { tierId: 'ctx-16k' }
      );
      assert.equal(merged.contextWindow, 16384);
      assert.equal(merged.maxOutputTokens, 4096);
      assert.equal(merged.compactionTriggerRatio, 0.5);
    });
  });

  it('预留不超过「窗口 − 输出」的不变量在叠加时重新生效', () => {
    withTempUserData((dir) => {
      saveRuntimeByTierToMain(dir, {
        'ctx-32k': { contextWindow: 32768, maxOutputTokens: 8192, contextReserveTokens: 30000 }
      });
      const merged = applyTierRuntime({}, dir, { tierId: 'ctx-32k' });
      assert.equal(merged.contextReserveTokens, 32768 - 8192);
    });
  });

  it('落盘只存与工厂值不同的键，未知档位丢弃', () => {
    withTempUserData((dir) => {
      const written = saveRuntimeByTierToMain(dir, {
        // ctx-16k 工厂值本来就是 16384 / 4096，同值不该落盘
        'ctx-16k': { contextWindow: 16384, maxOutputTokens: 4096, agentMaxRounds: 40 },
        'ctx-8k': { contextWindow: 8192 },
        bogus: { contextWindow: 1 }
      });
      assert.deepEqual(Object.keys(written), ['ctx-16k']);
      assert.deepEqual(written['ctx-16k'], { agentMaxRounds: 40 });
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(dir, RUNTIME_BY_TIER_FILE), 'utf8')
      );
      assert.deepEqual(onDisk, { 'ctx-16k': { agentMaxRounds: 40 } });
      assert.deepEqual(loadRuntimeByTierFromMain(dir), { 'ctx-16k': { agentMaxRounds: 40 } });
    });
  });

  it('按档取值 = 工厂值 + 该档覆盖；缺档回落到工厂值', () => {
    withTempUserData((dir) => {
      saveRuntimeByTierToMain(dir, { 'ctx-128k': { agentToolCallLimit: 200 } });
      const v = getRuntimeValuesForTierFromMain(dir, 'ctx-128k');
      assert.equal(v.agentToolCallLimit, 200);
      assert.equal(v.contextWindow, 128000);
      const untouched = getRuntimeValuesForTierFromMain(dir, 'ctx-64k');
      assert.equal(untouched.contextWindow, 65536);
    });
  });

  it('旧全局 settings 迁移进 default 档：写 localStorage，且不引用未定义函数', () => {
    const store = new Map();
    const prev = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    };
    try {
      reloadRuntimeByTier();
      // 出厂值 temperature 0.3 / contextWindow 524288，这里两个都不同 → 应被迁移
      const changed = migrateGlobalSettingsToDefaultTier({
        temperature: 0.7,
        contextWindow: 131072,
        // 与出厂值相同的键不该写进覆盖
        maxOutputTokens: 32768
      });
      assert.equal(changed, true);
      const saved = JSON.parse(store.get(STORAGE_KEY));
      assert.deepEqual(saved.default, { temperature: 0.7, contextWindow: 131072 });
      // 已经迁过：内存表非空，再调不再重复迁移
      assert.equal(migrateGlobalSettingsToDefaultTier({ temperature: 0.1 }), false);
    } finally {
      if (prev === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prev;
      reloadRuntimeByTier();
    }
  });

  it('预算公式只有一份，且带地板', () => {
    assert.equal(
      computeEffectiveInputBudget({
        contextWindow: 32768,
        maxOutputTokens: 8192,
        contextReserveTokens: 8192
      }),
      32768 - 8192 - 8192
    );
    assert.equal(
      computeEffectiveInputBudget({ contextWindow: 8192, maxOutputTokens: 8192 }),
      MIN_INPUT_BUDGET_TOKENS
    );
  });
});

describe('route → 模型事实（唯一解析点）', () => {
  const settings = {
    modelSuppliers: [
      // 第 0 行不可用：`auto-builtin` 无 supplierId 时必须落到第一个「可用」行，而不是死盯第 0 行
      { id: 's0', baseUrl: '', apiKey: '' },
      {
        id: 's1',
        baseUrl: 'https://s1/v1',
        apiKey: 'k1',
        contextTier: 'ctx-128k',
        contextTierByModel: { 'glm-5.3': 'ctx-1m' },
        // 名字里带 4o，但用户声明是文本：声明优先，别按名字猜
        modelModalities: { 'glm-5.3': 'vision', 'gpt-4o': 'text' }
      }
    ],
    customModels: [
      { id: 'c1', name: 'my-vl', kind: 'vision', contextWindow: 32768, contextTier: 'ctx-200k' },
      { id: 'c2', name: 'my-text', kind: 'text' },
      { id: 'c3', name: 'vl-unset', modalitySetting: 'text', kind: 'vision' }
    ]
  };

  it('auto-* 与手选 route 解析出同一份档位 / 窗口（Auto 不再单独落 default 档）', () => {
    const withoutRoute = (f) => ({ ...f, route: undefined });
    const autoFacts = resolveModelFacts(settings, 'auto-builtin:s1:glm-5.3');
    const manualFacts = resolveModelFacts(settings, 'builtin:s1:glm-5.3');
    assert.deepEqual(withoutRoute(autoFacts), withoutRoute(manualFacts));
    assert.equal(autoFacts.contextTierId, 'ctx-1m');
    assert.equal(autoFacts.modality, 'vision');

    const autoCustom = resolveModelFacts(settings, 'auto-custom:c1');
    assert.deepEqual(withoutRoute(autoCustom), withoutRoute(resolveModelFacts(settings, 'custom:c1')));
    assert.equal(autoCustom.contextTierId, 'ctx-200k');
    assert.equal(autoCustom.contextWindow, 32768);
  });

  it('未指定 supplierId（老写法 auto-builtin:<modelId>）取第一个可用供应商', () => {
    const facts = resolveModelFacts(settings, 'auto-builtin:glm-5.3');
    assert.equal(facts.supplierId, '');
    assert.equal(facts.contextTierId, 'ctx-1m');
    // s0 没有 baseUrl，档位不该按 s0 算
    assert.equal(resolveContextTierIdFromSettings(settings, 'auto-builtin:other'), 'ctx-128k');
  });

  it('模态只看设置里的声明，不看模型名', () => {
    assert.equal(resolveModelFacts(settings, 'builtin:s1:gpt-4o').modality, 'text');
    assert.equal(resolveModelFacts(settings, 'custom:c3').modality, 'text');
    assert.equal(resolveModelFacts(settings, 'custom:c1').modality, 'vision');
  });

  it('显式档位优先于模型名线索（名字带 128k 也不再覆盖）', () => {
    const withName = {
      modelSuppliers: [
        { id: 's1', baseUrl: 'https://s1/v1', apiKey: 'k', contextTierByModel: { 'x-128k': 'ctx-512k' } }
      ],
      customModels: []
    };
    const facts = resolveModelFacts(withName, 'builtin:s1:x-128k');
    assert.equal(facts.contextTierId, 'ctx-512k');
    assert.equal(facts.contextWindow, null);
  });

  it('模型被删 / 供应商被删：不猜，档位 default、窗口 null', () => {
    assert.equal(resolveModelFacts(settings, 'custom:gone').contextTierId, 'default');
    assert.equal(resolveModelFacts(settings, 'custom:gone').contextWindow, null);
    assert.equal(resolveModelContextWindowFromSettings(settings, 'custom:gone'), null);
    assert.equal(resolveModelContextWindowFromSettings(settings, ''), null);
    assert.equal(resolveContextTierIdFromSettings(settings, ''), 'default');
    assert.equal(resolveContextTierIdFromSettings(settings, 'auto'), 'default');
  });
});
