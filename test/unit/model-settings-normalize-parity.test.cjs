'use strict';

/**
 * 模型设置归一化的**双侧一致性**：Main（`src/model-settings.js`）与 Renderer
 * （`src/renderer/renderer-model-runtime.js`）对同一份磁盘配置必须给出同一个答案。
 *
 * 为什么值得一条专门的 parity 用例：这两处曾经各写一套 embedding 归一化，Renderer 那套只重建
 * `id/name/baseUrl/apiKey/dimensions/active` 六个键，把 `headers` / `authMode` / `userAgent`
 * 静默丢掉 —— 而 `src/agent/embedding-config.js` 真读这些字段。表现是「设置页保存一次，
 * 手写的自定义请求头就没了，向量端点开始 401，界面上没有任何报错」。
 * 现在两侧都调 `src/agent/model-settings-embedding.js`，本用例锁住这条等式。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const mainSettings = require(path.join(ROOT, 'src', 'model-settings.js'));
const embeddingShared = require(path.join(ROOT, 'src', 'agent', 'model-settings-embedding.js'));
const presets = require(path.join(ROOT, 'src', 'agent', 'model-runtime-presets.js'));
const schema = require(path.join(ROOT, 'src', 'agent', 'model-runtime-schema.js'));

/** 把「无 module.exports 的渲染层脚本」装进沙箱（同 test/unit/lib/load-renderer-fmt.cjs 的做法）。 */
function loadRendererModelRuntime() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer-model-runtime.js'), 'utf8');
  const storage = new Map();
  const win = {
    DieyunModelRuntimePresets: presets,
    clampModelRuntimeValue: schema.clampModelRuntimeValue,
    normalizeEmbeddingModels: embeddingShared.normalizeEmbeddingModels,
    applyActiveEmbedding: embeddingShared.applyActiveEmbedding,
    EMBEDDING_DIMENSIONS_MIN: embeddingShared.EMBEDDING_DIMENSIONS_MIN,
    EMBEDDING_DIMENSIONS_MAX: embeddingShared.EMBEDDING_DIMENSIONS_MAX,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    addEventListener() {}
  };
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      addEventListener() {},
      remove() {}
    }),
    addEventListener() {},
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }
  };
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    '$',
    src + '\nreturn { normalizeSettings };'
  );
  return factory(win, doc, win.localStorage, () => null);
}

/** Main 侧：写一份 model-settings.json 再读回来（走的就是真实落盘/读取路径）。 */
function loadViaMain(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ms-parity-'));
  fs.writeFileSync(path.join(dir, 'model-settings.json'), JSON.stringify(raw), 'utf8');
  return mainSettings.loadModelSettings(dir);
}

const FIXTURES = {
  '请求修饰字段必须原样保留': {
    embeddingModels: [
      {
        id: 'e1',
        name: 'bge-m3',
        baseUrl: 'https://embed.example/v1',
        apiKey: 'k1',
        dimensions: 1024,
        active: true,
        headers: { 'X-Tenant': 't1', 'X-Route': 'cn' },
        authMode: 'bearer',
        userAgent: 'dieyun/1.0'
      }
    ]
  },
  '内置 BGE 条目应被丢弃': {
    embeddingModels: [
      { id: 'embedding-builtin-bge', name: '内置 BGE', baseUrl: '内置', active: true },
      { id: 'e2', name: 'text-embedding-3-large', baseUrl: 'https://api.example/v1', apiKey: 'k', dimensions: 3072, active: true }
    ]
  },
  '历史占位条目（embedding-default / text-embedding-v4）应被丢弃': {
    embeddingModels: [
      { id: 'embedding-default', name: 'text-embedding-v4', baseUrl: 'https://dash.example/v1', apiKey: 'k', dimensions: 64, active: true },
      { id: 'e3', name: 'bge-small', baseUrl: 'https://x/v1', dimensions: 512, active: false }
    ]
  },
  'active 单选：只保留第一个': {
    embeddingModels: [
      { id: 'a', name: 'a', baseUrl: 'https://a/v1', active: true },
      { id: 'b', name: 'b', baseUrl: 'https://b/v1', active: true }
    ]
  },
  '缺名字或缺端点的条目丢弃': {
    embeddingModels: [
      { id: 'n', name: '', baseUrl: 'https://n/v1', active: true },
      { id: 'u', name: 'u', baseUrl: '', active: true },
      { id: 'ok', name: 'ok', baseUrl: 'https://ok/v1', active: true }
    ]
  },
  '维度夹取到 64–8192': {
    embeddingModels: [
      { id: 'lo', name: 'lo', baseUrl: 'https://lo/v1', dimensions: 1, active: true },
      { id: 'hi', name: 'hi', baseUrl: 'https://hi/v1', dimensions: 999999, active: false }
    ]
  },
  '老配置（顶层单条字段）迁移成列表': {
    embeddingModel: 'bge-m3',
    embeddingBaseUrl: 'https://legacy/v1',
    embeddingApiKey: 'lg',
    embeddingDimensions: 1024,
    embeddingEnabled: true
  },
  '全都不启用是合法状态': {
    embeddingModels: [{ id: 'x', name: 'x', baseUrl: 'https://x/v1', active: false }]
  }
};

test('Main 与 Renderer 的 embedding 归一对同一份配置给出同一答案', () => {
  const renderer = loadRendererModelRuntime();
  for (const [label, raw] of Object.entries(FIXTURES)) {
    const mainOut = loadViaMain(raw);
    const rendererOut = renderer.normalizeSettings(JSON.parse(JSON.stringify(raw)));

    assert.deepEqual(
      rendererOut.embeddingModels,
      mainOut.embeddingModels,
      `${label}：embeddingModels 两侧不一致`
    );
    assert.equal(rendererOut.embeddingModel, mainOut.embeddingModel, `${label}：embeddingModel`);
    assert.equal(rendererOut.embeddingBaseUrl, mainOut.embeddingBaseUrl, `${label}：embeddingBaseUrl`);
    assert.equal(rendererOut.embeddingDimensions, mainOut.embeddingDimensions, `${label}：embeddingDimensions`);
    assert.equal(rendererOut.embeddingEnabled, mainOut.embeddingEnabled, `${label}：embeddingEnabled`);
  }
});

test('请求修饰字段经 Renderer 归一化后仍在（这条以前是静默丢）', () => {
  const renderer = loadRendererModelRuntime();
  const out = renderer.normalizeSettings({
    embeddingModels: [
      {
        id: 'e1',
        name: 'bge-m3',
        baseUrl: 'https://x/v1',
        apiKey: 'k',
        dimensions: 1024,
        active: true,
        headers: { 'X-Tenant': 't1' },
        authMode: 'bearer',
        userAgent: 'dieyun/1.0'
      }
    ]
  });
  const entry = out.embeddingModels[0];
  assert.deepEqual(entry.headers, { 'X-Tenant': 't1' });
  assert.equal(entry.authMode, 'bearer');
  assert.equal(entry.userAgent, 'dieyun/1.0');
});

test('缺 id 的条目拿到确定性 id（不能每次归一化都换一个）', () => {
  const renderer = loadRendererModelRuntime();
  const raw = { embeddingModels: [{ name: 'n', baseUrl: 'https://n/v1', active: true }] };
  const a = renderer.normalizeSettings(JSON.parse(JSON.stringify(raw))).embeddingModels[0].id;
  const b = renderer.normalizeSettings(JSON.parse(JSON.stringify(raw))).embeddingModels[0].id;
  assert.equal(a, b, '同一份配置两次归一化必须给出同一个 id');
});
