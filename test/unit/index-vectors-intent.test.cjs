'use strict';
/**
 * 「这次建库要不要带向量」的唯一判定（`src/model-settings.js:resolveIndexVectorsIntent`）。
 *
 * 背景（docs/SSH-INDEX-COLD-START-PLAN.md §0.5）：向量以前只有两条触发路径——
 * 索引面板的「建向量」按钮（人手点）和增量调度器的「库里已有向量就沿用」。
 * agent / prep 触发建库时固定 `vectors:false`，而 SSH 会话的索引库是每会话一份，
 * 于是 `vectorCount` 长期为 0，检索只剩子串通道（中文自然语言查询基本不命中）。
 *
 * 这里锁死三件事：
 *   1. 显式 true/false 永远优先（面板一次性动作、调度器沿用都要能覆盖持久意图）；
 *   2. 没说话（undefined）才看持久意图 `indexSemanticSearch`；
 *   3. 缺配置文件 / 脏值 → false（绝不因为「读不到」就默认调 embedding 花钱）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveIndexVectorsIntent, DEFAULTS } = require('../../src/model-settings');

function tmpUserData(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-vectors-intent-'));
  if (payload) fs.writeFileSync(path.join(dir, 'model-settings.json'), JSON.stringify(payload), 'utf8');
  return dir;
}

describe('建库向量意图', () => {
  it('默认关：没有配置文件时不建向量', () => {
    assert.equal(DEFAULTS.indexSemanticSearch, false);
    assert.equal(resolveIndexVectorsIntent(tmpUserData(null), undefined), false);
  });

  it('持久意图打开后，缺省建库就带向量', () => {
    assert.equal(resolveIndexVectorsIntent(tmpUserData({ indexSemanticSearch: true }), undefined), true);
  });

  it('持久意图是脏值时按关处理（不会因为「未设置」就调用 embedding）', () => {
    assert.equal(resolveIndexVectorsIntent(tmpUserData({ indexSemanticSearch: 'yes' }), undefined), false);
  });

  it('显式 true / false 永远优先于持久意图', () => {
    const on = tmpUserData({ indexSemanticSearch: true });
    const off = tmpUserData({ indexSemanticSearch: false });
    assert.equal(resolveIndexVectorsIntent(off, true), true, '面板「建向量」要能一次建');
    assert.equal(resolveIndexVectorsIntent(on, false), false, '增量调度器要能显式不要');
  });
});
