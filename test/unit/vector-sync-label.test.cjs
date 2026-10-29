'use strict';
/**
 * 「向量一致性」文案（`src/renderer/renderer-utils.js:describeVectorSync`）。
 *
 * 守的是「别把半残说成正常」：向量通道只有在「端点可用 + 库里有向量 + 签名一致
 * + 覆盖到全部 chunk」同时成立时才真正生效，缺哪一条都会**静默**退回子串。面板
 * 那一行是用户唯一能看见的解释，所以每种缺失都要有各自的措辞：
 * 1. 一条向量都没有 → 未写入向量；
 * 2. 签名与当前设置不符 → 提示重建（维度可能都不兼容）；
 * 3. 当前配置没启用向量、库里是旧数据 → 说清是旧数据；
 * 4. 向量数少于 chunk 数（增量改过的文件没补向量）→ 覆盖不足，必须给出数字；
 * 5. 全齐 → 一致。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-utils.js');

function loadDescribeVectorSync() {
  const source = fs.readFileSync(SRC, 'utf8');
  const window = { addEventListener() {} };
  const document = {
    getElementById() {
      return null;
    },
    createElement() {
      return { style: {} };
    }
  };
  const factory = new Function(
    'window',
    'document',
    `${source}\n;return window.describeVectorSync;`
  );
  const fn = factory(window, document);
  assert.equal(typeof fn, 'function', 'describeVectorSync 必须挂到 window 上');
  return fn;
}

const describeVectorSync = loadDescribeVectorSync();

describe('向量一致性文案', () => {
  it('没有向量时如实说「未写入」', () => {
    assert.equal(describeVectorSync({ count: 0, chunks: 100, enabled: true }), '未写入向量');
    assert.equal(describeVectorSync(), '未写入向量');
  });

  it('签名与当前设置不一致时提示重建', () => {
    assert.equal(
      describeVectorSync({ count: 100, chunks: 100, stale: true, enabled: true }),
      '⚠ 与当前设置不一致，建议重建'
    );
  });

  it('当前未启用向量时说明库里是旧数据', () => {
    assert.equal(
      describeVectorSync({ count: 100, chunks: 100, stale: false, enabled: false }),
      '当前未启用向量（库内为旧数据）'
    );
  });

  it('覆盖不足时报出真实比例（增量改过的文件没补向量）', () => {
    assert.equal(
      describeVectorSync({ count: 40, chunks: 100, stale: false, enabled: true }),
      '⚠ 仅覆盖 40/100 段，建议重建补齐'
    );
  });

  it('全齐时说一致', () => {
    assert.equal(
      describeVectorSync({ count: 100, chunks: 100, stale: false, enabled: true }),
      '与当前设置一致'
    );
  });

  it('未知 chunk 总数时不误报覆盖不足', () => {
    assert.equal(
      describeVectorSync({ count: 100, stale: false, enabled: true }),
      '与当前设置一致'
    );
  });

  it('向量多于 chunk（chunk 被增量清过）不算异常', () => {
    assert.equal(
      describeVectorSync({ count: 120, chunks: 100, stale: false, enabled: true }),
      '与当前设置一致'
    );
  });
});
