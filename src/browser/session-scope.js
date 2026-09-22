'use strict';

const { normalizeSnapshotId } = require('./ref-namespace');

/**
 * 会话 id 统一归一（空 / 非字符串一律 null，避免写出 '__proto__' 之类的脏 key）。
 * 模块级单一来源：session-scope 与 journal-scope（观察账本归属键）共用同一份会话身份规则。
 */
function normalizeSessionId(sessionId) {
  if (sessionId == null) return null;
  const sid = String(sessionId).trim();
  return sid ? sid : null;
}

/** url 归一：空值一律视为「未知」（不参与跳转判定），避免用空串臆断出「没跳转」。 */
function normalizeUrl(raw) {
  if (raw == null) return null;
  const url = String(raw).trim();
  return url || null;
}

/**
 * Per-session browser metadata + active view session (BrowserView is singleton).
 */
function createBrowserSessionScope() {
  /** @type {string | null} */
  let activeViewSessionId = null;
  /**
   * @type {Map<string, {
   *   url?: string,
   *   title?: string,
   *   engine?: string,
   *   snapshot?: { id: string, epoch: number, engine: string, url: string, at: number },
   *   navigation?: { url: string, at: number },
   *   updatedAt?: number
   * }>}
   */
  const meta = new Map();

  function setActiveViewSessionId(sessionId) {
    activeViewSessionId = normalizeSessionId(sessionId);
  }

  function getActiveViewSessionId() {
    return activeViewSessionId;
  }

  /**
   * 生效会话身份（唯一来源）：显式 sessionId 优先，否则落到前台 BrowserView 承载的会话。
   *
   * 实例名（engine-target.instanceIdFor）、归属引擎（meta.engine）与前台缺省账本键
   * 必须按同一个身份取名，否则同一个实例会出现两个名字：
   * 显式调用（带 sessionId）是 `browserview#s-1790…`，auto 调用（不带）曾经是
   * `browserview#default` —— 调用方会误以为打到了两个不同的实例。
   * 只有「确实还没绑定任何会话」时才是 null（instanceId 落到 `#default` 缺省键）。
   */
  function resolveEffectiveSessionId(sessionId) {
    return normalizeSessionId(sessionId) || activeViewSessionId || null;
  }

  function isBackgroundSession(sessionId) {
    if (!sessionId) return false;
    const sid = String(sessionId).trim();
    if (!sid) return false;
    if (!activeViewSessionId) return false;
    return sid !== activeViewSessionId;
  }

  function updateMeta(sessionId, patch) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return;
    const prev = meta.get(sid) || {};
    meta.set(sid, { ...prev, ...(patch || {}), updatedAt: Date.now() });
  }

  function getMeta(sessionId) {
    const sid = normalizeSessionId(sessionId);
    return sid ? meta.get(sid) || null : null;
  }

  function removeMeta(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (sid) meta.delete(sid);
  }

  /** 删除某会话 meta 上的一个字段（clearEngineOwners / clearSnapshots 共用）。 */
  function clearField(key) {
    for (const [sid, entry] of meta) {
      if (!entry || entry[key] == null) continue;
      const next = { ...entry };
      delete next[key];
      meta.set(sid, next);
    }
  }

  /**
   * 记录一次 snapshot 的 origin 身份。epoch 是「本会话第几次 snapshot」，只在这里递增，
   * 因此同一次 snapshot 的多个 frame（Playwright 逐 frame evaluate）共享同一个 id / epoch。
   * seq 是本会话的单调事件序号（snapshot 与导航共用一条），用于判定「谁在前」——时间戳同毫秒不可靠。
   * @returns {{ id: string, epoch: number, engine: string, url: string, at: number, seq: number } | null}
   */
  function recordSnapshot(sessionId, info = {}) {
    const sid = normalizeSessionId(sessionId);
    const id = normalizeSnapshotId(info.id);
    if (!sid || !id) return null;
    const prev = meta.get(sid) || {};
    const prevSnapshot = prev.snapshot || null;
    const snapshot = {
      id,
      epoch: (prevSnapshot && Number(prevSnapshot.epoch) > 0 ? Number(prevSnapshot.epoch) : 0) + 1,
      engine: info.engine ? String(info.engine) : (prevSnapshot && prevSnapshot.engine) || '',
      url: info.url != null ? String(info.url) : '',
      at: Date.now(),
      seq: (Number(prev.seq) || 0) + 1
    };
    meta.set(sid, { ...prev, snapshot, seq: snapshot.seq, updatedAt: snapshot.at });
    return snapshot;
  }

  /** 该会话「当前 snapshot」的 origin；从未 snapshot 过返回 null。 */
  function getSnapshot(sessionId) {
    const m = getMeta(sessionId);
    return (m && m.snapshot) || null;
  }

  /**
   * 记录一次导航（navigate / reload / back / forward）。
   * 只在这里写时间：ref 失效诊断要回答「这次 snapshot 之后页面是否跳转过」。
   */
  function recordNavigation(sessionId, info = {}) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return null;
    const prev = meta.get(sid) || {};
    const navigation = {
      url: info.url != null ? String(info.url) : '',
      at: Date.now(),
      seq: (Number(prev.seq) || 0) + 1
    };
    meta.set(sid, { ...prev, navigation, seq: navigation.seq, updatedAt: navigation.at });
    return navigation;
  }

  /** 该会话最后一次导航；从未导航过返回 null。 */
  function getNavigation(sessionId) {
    const m = getMeta(sessionId);
    return (m && m.navigation) || null;
  }

  /**
   * 当前 snapshot 是否已被一次导航甩在身后（= 旧 ref 很可能已失效）。
   * 两个证据任一成立即为 true，缺证据时一律 false（不臆断）：
   *   1. 工具导航（navigate / reload / back / forward）在账本里留下了比 snapshot 更晚的事件序号；
   *   2. snapshot 时的 url 与当前 url 不同 —— 页面自己跳转（表单提交 / JS 重定向 / 点链接）
   *      不经过 navigate 工具，账本里没有任何事件，只有 url 能把它认出来；
   *      这同时让「跳转导致失效」与「被新 snapshot 取代导致失效」一眼可分。
   * 用事件序号比较而不是时间戳：同一毫秒内 snapshot + 导航不能判成「没跳转过」。
   * @param {string} sessionId
   * @param {{ currentUrl?: string }} [evidence]
   *        调用方当场能拿到的页面 url（引擎自报的失败体 url / 会话 meta），缺省则用 meta.url
   */
  function navigatedSinceSnapshot(sessionId, evidence = {}) {
    const m = getMeta(sessionId);
    const snapshot = (m && m.snapshot) || null;
    if (!snapshot) return false;
    const nav = (m && m.navigation) || null;
    if (nav && Number(nav.seq || 0) > Number(snapshot.seq || 0)) return true;
    const currentUrl = normalizeUrl(evidence.currentUrl != null ? evidence.currentUrl : m && m.url);
    const snapshotUrl = normalizeUrl(snapshot.url);
    return !!(currentUrl && snapshotUrl && currentUrl !== snapshotUrl);
  }

  /**
   * 清空全部会话的「页面归属引擎」（navigation owner）。
   * browser.close 之后两个引擎都没有页面，遗留的归属会让 auto 打到错误的引擎。
   */
  function clearEngineOwners() {
    clearField('engine');
  }

  /** close 之后页面全没了，旧 snapshot 的 ref 必须判为失效而不是继续命中残留 DOM。 */
  function clearSnapshots() {
    clearField('snapshot');
  }

  return {
    setActiveViewSessionId,
    getActiveViewSessionId,
    resolveEffectiveSessionId,
    isBackgroundSession,
    updateMeta,
    getMeta,
    removeMeta,
    recordSnapshot,
    getSnapshot,
    recordNavigation,
    getNavigation,
    navigatedSinceSnapshot,
    clearEngineOwners,
    clearSnapshots
  };
}

module.exports = { createBrowserSessionScope, normalizeSessionId };
