'use strict';
/**
 * 向量模型的「当前」是单选，但「全都不启用」必须合法。
 *
 * 背景：用户只想先存着配置、暂不跑语义检索（「我加了但不想用，也不想删」）。
 * 以前 `normalize()` 里有一条「没有 active 就自动点亮第一个」的兜底，结果是
 * 每次保存都被重新点亮 —— 界面上永远有一个「当前」，用户做不到全关。
 *
 * 这里锁死四件事：
 *   1. 全都不启用 → 保持全关，`embeddingEnabled=false`，`getEmbeddingConfig` 返回 disabled；
 *   2. 落盘再读还是全关（不会被 normalize 重新点亮）；
 *   3. 多个 true 时只认第一个（active 单选语义不变）；
 *   4. 有一个 true 时旧的扁平字段（embeddingModel/BaseUrl/Dimensions）照旧同步。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadModelSettings, saveModelSettings, getEmbeddingConfig } = require('../../src/model-settings');

function tmpUserData(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-embedding-active-'));
  if (payload) fs.writeFileSync(path.join(dir, 'model-settings.json'), JSON.stringify(payload), 'utf8');
  return dir;
}

const OFF = {
  embeddingModels: [
    { id: 'a', name: 'text-embedding-zen', baseUrl: 'http://10.0.0.1:1234/v1/embeddings', dimensions: 4096, active: false },
    { id: 'b', name: 'text-embedding-qwen3', baseUrl: 'http://10.0.0.2:5018/v1', apiKey: 'sk-test', dimensions: 2560, active: false }
  ]
};

describe('向量模型启用状态', () => {
  it('全部未启用时保持全关，不自动点亮第一个', () => {
    const s = loadModelSettings(tmpUserData(OFF));
    assert.deepEqual(s.embeddingModels.map((m) => m.active), [false, false]);
    assert.equal(s.embeddingEnabled, false);
    assert.equal(s.embeddingModel, '');
    const cfg = getEmbeddingConfig(s);
    assert.equal(cfg.disabled, true);
    assert.equal(cfg.model, '');
  });

  it('落盘再读仍是全关（保存不会把「未启用」改回「当前」）', () => {
    const dir = tmpUserData(OFF);
    saveModelSettings(dir, loadModelSettings(dir));
    const again = loadModelSettings(dir);
    assert.deepEqual(again.embeddingModels.map((m) => m.active), [false, false]);
    assert.equal(again.embeddingEnabled, false);
  });

  it('多个 active 只认第一个（单选语义不变）', () => {
    const s = loadModelSettings(tmpUserData({
      embeddingModels: [
        { id: 'a', name: 'm-a', baseUrl: 'http://a/v1', active: true },
        { id: 'b', name: 'm-b', baseUrl: 'http://b/v1', active: true }
      ]
    }));
    assert.deepEqual(s.embeddingModels.map((m) => m.active), [true, false]);
    assert.equal(s.embeddingModel, 'm-a');
  });

  it('启用其中一个时扁平字段同步到它', () => {
    const s = loadModelSettings(tmpUserData({
      embeddingModels: [
        { id: 'a', name: 'm-a', baseUrl: 'http://a/v1', dimensions: 4096, active: false },
        { id: 'b', name: 'm-b', baseUrl: 'http://b/v1', apiKey: 'sk-b', dimensions: 2560, active: true }
      ]
    }));
    assert.equal(s.embeddingEnabled, true);
    assert.equal(s.embeddingModel, 'm-b');
    assert.equal(s.embeddingBaseUrl, 'http://b/v1');
    assert.equal(s.embeddingDimensions, 2560);
    assert.equal(getEmbeddingConfig(s).model, 'm-b');
  });
});
