'use strict';

/**
 * 浏览器观察账本（network / console / timeline）的归属（唯一来源）。
 *
 * 为什么按会话分桶，而不是按引擎分桶：
 *   同一个会话可能先跑 BrowserView，再被兜底改道到 Playwright（或反之）。
 *   按引擎分桶时，「这条观察属于谁」取决于当时用的引擎，于是
 *     - 会话 A 的轮次开始 reset 会把会话 B 的缓冲一起清掉；
 *     - 会话 A 的请求/日志会被会话 B 的 browser_network / browser_console 读到；
 *     - auto 语义只能靠「合并两条引擎缓冲」来兜，顺序与归属都失真。
 *   把归属键收敛成会话 id 之后，engine 退化为条目属性（只用于显式过滤），
 *   读写两侧用同一个 key，观察不再随引擎漂移。
 *
 * 归属键规则（与 session-scope 的会话身份同一来源）：
 *   显式 sessionId → 默认会话（前台可见 BrowserView 的会话）→ VIEW_OWNER_KEY
 */

const { createNetworkJournal } = require('./network-collector');
const { createConsoleJournal } = require('./console-collector');
const { createTimelineJournal } = require('./timeline');
const { normalizeSessionId } = require('./session-scope');

/** 没有会话身份时的归属键（历史键名，保持稳定以免存量读法变化）。 */
const VIEW_OWNER_KEY = '__view__';

/**
 * @param {{
 *   resolveDefaultSessionId?: () => (string | null | undefined),
 *   createNetworkJournal?: () => object,
 *   createConsoleJournal?: () => object,
 *   createTimelineJournal?: () => object
 * }} [deps]
 */
function createJournalScope(deps = {}) {
  const resolveDefaultSessionId = deps.resolveDefaultSessionId || (() => '');
  const makeNetwork = deps.createNetworkJournal || (() => createNetworkJournal());
  const makeConsole = deps.createConsoleJournal || (() => createConsoleJournal());
  const makeTimeline = deps.createTimelineJournal || (() => createTimelineJournal());

  /** @type {Map<string, { key: string, network: object, console: object, timeline: object, clearedAt: number }>} */
  const buckets = new Map();

  /**
   * 归一归属键：显式 sessionId 优先；否则落到默认会话（前台 BrowserView 会话）。
   * 读写两侧都必须走这里，否则「写进 A、读 B」又会重新出现。
   */
  function keyOf(sessionId) {
    return (
      normalizeSessionId(sessionId) ||
      normalizeSessionId(resolveDefaultSessionId()) ||
      VIEW_OWNER_KEY
    );
  }

  function bucket(sessionId) {
    const key = keyOf(sessionId);
    let found = buckets.get(key);
    if (!found) {
      found = {
        key,
        network: makeNetwork(),
        console: makeConsole(),
        timeline: makeTimeline(),
        clearedAt: 0
      };
      buckets.set(key, found);
    }
    return found;
  }

  return {
    VIEW_OWNER_KEY,
    keyOf,
    /** 该会话的请求账本。 */
    network: (sessionId) => bucket(sessionId).network,
    /** 该会话的 console 账本。 */
    console: (sessionId) => bucket(sessionId).console,
    /** 该会话的事件时间线账本。 */
    timeline: (sessionId) => bucket(sessionId).timeline,
    keys: () => [...buckets.keys()],
    /** 最后一次清空该会话缓冲的时间（0 = 从未清空）；用于让「查不到」可自解释。 */
    clearedAt: (sessionId) => bucket(sessionId).clearedAt,
    /**
     * 清空指定会话的观察缓冲（不传 sessionId 则清当前归属会话）。
     * 只影响这一个会话：别的会话的轮次开始不再清掉本会话的记录。
     * @param {string} [sessionId]
     * @param {string[]} [kinds] 默认 console + network
     */
    clear(sessionId, kinds) {
      const found = bucket(sessionId);
      const list = Array.isArray(kinds) && kinds.length ? kinds : ['console', 'network'];
      for (const kind of list) {
        if (found[kind] && typeof found[kind].clear === 'function') found[kind].clear();
      }
      found.clearedAt = Date.now();
      return { ok: true, sessionKey: found.key, cleared: list, clearedAt: found.clearedAt };
    },
    /** 会话回收：整桶丢弃（观察账本没有跨会话价值）。 */
    drop(sessionId) {
      return buckets.delete(keyOf(sessionId));
    },
    /** 浏览器整体关闭：所有会话的账本一起丢弃。 */
    reset() {
      buckets.clear();
    }
  };
}

module.exports = { createJournalScope, VIEW_OWNER_KEY };
