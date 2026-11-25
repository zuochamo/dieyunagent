'use strict';

/**
 * 「后台在 Main 里跑完一轮 → 正开着的那条会话就地补上」的回归。
 *
 * 这条行为决定用户到底看不看得见：企业微信频道与生命感心跳都在 Main 里跑、不推流，
 * 消息只落进账本。判据三条，缺一条就是用户报的那个现象
 * （"企业微信那边答完了、这边还没刷出来"）：
 *   1. 不管是不是当前会话，都要把该会话的消息缓存作废 + 刷一次历史列表；
 *   2. **正开着它**且没有别的轮在跑，就地重读一次（`forceRefresh`）；
 *   3. 不是当前会话 / 正在由 Renderer 自己驱动 / sid 为空 → 不重读。
 *
 * 这是浏览器脚本（没有 module.exports），用 `new Function` 摘函数来验，手法同
 * `renderer-chat-history-edge.test.cjs`。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-history.js'),
  'utf8'
);

/** 从浏览器脚本里摘一个顶层函数（整文件 eval 要的桩太多）。 */
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  // `async function` 要连关键字一起摘，否则 `await` 在这个独立函数里非法
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const build = new Function(
  'invalidateSessionMessageCache',
  'refreshHistoryList',
  'currentSessionId',
  'isSessionSending',
  'loadChatFromGateway',
  `${extractFn(SOURCE, 'refreshSessionAfterBackgroundTurn')}
   return refreshSessionAfterBackgroundTurn;`
);

function run({ sid, openSession = '', sending = false } = {}) {
  const calls = { invalidated: [], listed: 0, loaded: [] };
  const fn = build(
    (sessionId) => calls.invalidated.push(sessionId),
    () => {
      calls.listed += 1;
      return Promise.resolve();
    },
    openSession,
    () => sending,
    async (switchGen, target, opts) => calls.loaded.push({ switchGen, target, opts })
  );
  const done = fn(sid);
  return { calls, done };
}

describe('renderer 后台轮结束后的会话刷新', () => {
  it('正开着那条会话且没在跑：作废缓存 + 刷列表 + 就地重读一次', async () => {
    const { calls, done } = run({ sid: 's-1', openSession: 's-1' });
    await done;
    expect(calls.invalidated).toEqual(['s-1']);
    expect(calls.listed).toBe(1);
    expect(calls.loaded).toEqual([{ switchGen: null, target: 's-1', opts: { forceRefresh: true } }]);
  });

  it('不是当前会话：只作废缓存与刷列表，不重读（别把用户正在看的对话顶掉）', async () => {
    const { calls, done } = run({ sid: 's-1', openSession: 's-2' });
    await done;
    expect(calls.invalidated).toEqual(['s-1']);
    expect(calls.listed).toBe(1);
    expect(calls.loaded).toEqual([]);
  });

  it('正在由 Renderer 自己驱动（用户在打字的会话）：不插一脚', async () => {
    const { calls, done } = run({ sid: 's-1', openSession: 's-1', sending: true });
    await done;
    expect(calls.listed).toBe(1);
    expect(calls.loaded).toEqual([]);
  });

  it('没有 sessionId：什么都不做（事件形状变了也不乱刷）', async () => {
    const { calls, done } = run({ sid: '' });
    await done;
    expect(calls.invalidated).toEqual([]);
    expect(calls.listed).toBe(0);
    expect(calls.loaded).toEqual([]);
  });
});
