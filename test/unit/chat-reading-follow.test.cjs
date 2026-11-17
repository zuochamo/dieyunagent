'use strict';

/**
 * 朗读的「视野跟随」（`src/renderer/renderer-chat-scroll.js#followChatReadingRange`）。
 *
 * 守的是三条边界 —— 它们都是从「下滑内容时朗读抢视野」现场倒推出来的，不是观感偏好：
 *
 * 1. 起点不在视野里 → 整段一次都不滚。自动朗读一条长回复时视口停在这条回复的末尾，
 *    第一块合成回来（2~3s 后）若照「看不见就居中」办，视口会被搬到回复开头。
 * 2. 用户自己滚过（`chatUserScrollSeq` 变了）→ 这一段朗读不再碰视口。旧实现每念一句
 *    都重新居中一次，用户每滚一下就被拽回去一下，一场朗读被拽几十次。
 * 3. 只往下带、不回拽。念到的句子跑到视野上方时不往回滚（用户已经看下面去了）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-scroll.js');

/** 视口 400px 高、内容 5000px；range 按「内容坐标」给，测里自动换算成视口坐标 */
function makeHost({ scrollTop = 0, height = 400 } = {}) {
  const calls = [];
  const host = {
    scrollTop,
    clientHeight: height,
    scrollHeight: 5000,
    dataset: {},
    addEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: height, height, left: 0, right: 800, width: 800 }),
    scrollTo(opts) {
      calls.push(opts);
      host.scrollTop = opts.top;
    }
  };
  /** 内容坐标 → 视口坐标（浏览器的 Range 给的就是视口坐标） */
  const range = (contentTop, { height: h = 20, width = 800 } = {}) => ({
    getBoundingClientRect: () => {
      const top = contentTop - host.scrollTop;
      return { top, bottom: top + h, height: h, left: 0, right: width, width };
    }
  });
  return { host, calls, range };
}

function load(host) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'chatList',
    `${source}
     return {
       beginChatReadingFollow,
       endChatReadingFollow,
       followChatReadingRange,
       markChatUserScrollIntent
     };`
  );
  return factory({}, { getElementById: () => host }, host);
}

test('起点在视野外（自动朗读长回复、视口停在末尾）：整段都不滚', () => {
  const { host, calls, range } = makeHost({ scrollTop: 4600 });
  const api = load(host);
  api.beginChatReadingFollow();
  // 第一块合成回来那一拍：第一句远在视野上方
  api.followChatReadingRange(range(200));
  api.followChatReadingRange(range(900));
  api.followChatReadingRange(range(4900));
  assert.deepEqual(calls, [], '起点看不到就说明用户在看别处，一次都不该动视口');
  assert.equal(host.scrollTop, 4600);
});

test('起点在视野里：念到下方时往下带，已经看得见就不动', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.beginChatReadingFollow();
  api.followChatReadingRange(range(100)); // 起点就在眼前
  assert.deepEqual(calls, [], '已经在视野里不该滚');

  api.followChatReadingRange(range(600)); // 念到了视野下方
  assert.equal(calls.length, 1);
  // 居中：600 - 400/2 + 20/2 = 410
  assert.equal(calls[0].top, 410);
  assert.equal(calls[0].behavior, 'smooth');

  api.followChatReadingRange(range(600)); // 滚完之后这一句就在视野里了
  assert.equal(calls.length, 1, '看得到就不再滚');
});

test('用户自己滚过就永久让位（整段不再抢视野）', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.beginChatReadingFollow();
  api.followChatReadingRange(range(100)); // 正常跟随模式
  api.markChatUserScrollIntent(); // wheel / 触摸 / 键盘 / 拖滚动条
  api.followChatReadingRange(range(600));
  api.followChatReadingRange(range(900));
  assert.deepEqual(calls, [], '用户接管滚动后，这一段朗读不许再动视口');
});

test('念到视野上方不往回拽', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.beginChatReadingFollow();
  api.followChatReadingRange(range(100));
  api.followChatReadingRange(range(-200)); // 句子跑到视野上方（用户往下看了）
  api.followChatReadingRange(range(700));
  assert.deepEqual(calls, [], '一旦往回滚就是把视口从用户眼前抢走，直接收摊');
});

test('朗读结束后迟到的 range 不动视口', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.beginChatReadingFollow();
  api.followChatReadingRange(range(100));
  api.endChatReadingFollow();
  api.followChatReadingRange(range(700));
  assert.deepEqual(calls, []);
});

test('没开始朗读时（idle）什么都不做', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.followChatReadingRange(range(700));
  assert.deepEqual(calls, []);
});

test('高亮范围量不出尺寸（节点已脱离文档）时不滚', () => {
  const { host, calls, range } = makeHost();
  const api = load(host);
  api.beginChatReadingFollow();
  api.followChatReadingRange(range(100));
  api.followChatReadingRange(range(700, { height: 0, width: 0 }));
  assert.deepEqual(calls, []);
});
