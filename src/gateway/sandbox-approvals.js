'use strict';

// @ts-check
/**
 * ask-once 审批：**越界操作问用户一次，记住到本会话结束**。
 *
 * 为什么是这个粒度（而不是每次弹窗 / 永远放行）：
 * - 每次都问 = 用户点「允许」点到麻木，等于没有审阅；
 * - 永远放行 = 等于没锁；
 * - 一次批准按「会话 × 类别 × 目录」记忆 = 同一目录里反复发生的事只打扰一次，
 *   换个任务（新 sessionId）或换个目录重新问 —— 这正是"你批准的是这一个位置上的这一次任务"的语义。
 *
 * 为什么带目录：只按「类别」记会退化成"批准过 /tmp 就等于批准过主目录"
 * （类别命中后新路径也会被并进写白名单），一次批准就把整个档位打穿。目录粒度是
 * 「不打扰用户」和「批准的范围要可解释」之间的最小公约数。
 *
 * 责任边界：本模块**不做判定**（判定在 `sandbox-policy.js`），只负责
 * 「问一次 → 记住 → 下次直接放行」，以及在没有人可以问的时候**拒绝**（fail-closed）。
 *
 * 批准可以**晚于工具调用到达**（`resolveLater`）：人离开座位超过 2 分钟，`ask()` 早已
 * 超时返回、那次工具调用也早已失败，但此刻才点下的「允许」不该白点 —— 它记的是
 * 「本会话在这个位置允许这类操作」，不是「重试刚才那条命令」。所以迟到的批准只落
 * grant，不重放工具调用；Agent 下一轮再发同一条命令时由 grant 命中直接放行。
 */

const { SANDBOX_CATEGORIES } = require('./sandbox-policy');
const { withTimeout } = require('../timeout');

/** 批准记忆的存活上限：防止进程长跑时几个月的旧批准还在生效。 */
const GRANT_TTL_MS = 2 * 60 * 60 * 1000;
/** 等人点按钮的上限。超时 = 拒绝（fail-closed），不是放行。 */
const APPROVAL_TIMEOUT_MS = 120000;

/** 会话 id 的唯一归一：''、'  '、undefined 都是同一个「无会话」桶（'-'）。 */
function sessionKey(sessionId) {
  return String(sessionId || '').trim() || '-';
}

function grantKey(sessionId, category, scope) {
  return `${sessionKey(sessionId)}|${String(category || '').trim()}|${String(scope || '-').toLowerCase()}`;
}

/** 卷根（`D:\`、`/`、UNC 根）：批准它等于批准整个盘，永远不能作为记忆的粒度。 */
function isVolumeRoot(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]?$/.test(s) || /^[\\/]+$/.test(s) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(s);
}

/**
 * 授权粒度 = 路径的父目录；父目录是卷根时退化成**该文件本身**（精确授权）。
 * 没有路径（网络/无目标的命令）用 '-' 这个类别级粒度。
 */
function scopeOf(absPath) {
  const p = String(absPath || '');
  if (!p) return '-';
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const parent = idx > 0 ? p.slice(0, idx) : p;
  if (!parent || isVolumeRoot(parent)) return p;
  return parent;
}

/**
 * @param {{
 *   request?: (payload: object) => Promise<boolean> | null,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   grantTtlMs?: number
 * }} [deps]
 */
function createSandboxApprovals(deps = {}) {
  /**
   * 审批通道用**可变**引用：Gateway 由 `bootWorkspaceRemoteRuntime` 构造，
   * 而窗口（能弹窗的那个对象）在 Main 里稍后才就绪，所以由 Main 事后注入。
   * 未注入 = 没有人可以问 = 一律拒绝（fail-closed），不是放行。
   */
  let request = typeof deps.request === 'function' ? deps.request : null;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timeoutMs = Number(deps.timeoutMs) || APPROVAL_TIMEOUT_MS;
  const grantTtlMs = Number(deps.grantTtlMs) || GRANT_TTL_MS;

  function setRequest(fn) {
    request = typeof fn === 'function' ? fn : null;
  }

  /** @type {Map<string, { sessionId: string, category: string, scope: string, at: number }>} */
  const grants = new Map();
  /** @type {Map<string, { sessionId: string, root: string, at: number }>} */
  const pathGrants = new Map();
  /** @type {Map<string, { resolve: Function, timer: any }>} */
  const pending = new Map();
  let seq = 0;
  const audit = [];

  /**
   * 待批请求登记：`requestId → 批准所需的上下文`。
   *
   * 和 `grants` 同寿命（`grantTtlMs`）而不是和「等人点按钮」（`timeoutMs`）同寿命：
   * 用户 20 分钟后回来点「允许」时，这里还得答得出「他批的是哪个会话、哪个类别、哪个目录」，
   * 否则那个按钮只能落到一个类别级授权（等于批准过 `/tmp` 就批过主目录）。
   * @type {Map<string, { sessionId: string, category: string, scope: string, path: string,
   *                       mode: string, tool: string, at: number }>}
   */
  const requests = new Map();

  function recordAudit(entry) {
    audit.push({ at: now(), ...entry });
    if (audit.length > 200) audit.shift();
  }

  /** 懒清：只在有审批动作时清一次，不起定时器。 */
  function pruneRequests() {
    const t = now();
    for (const [id, r] of requests) if (t - r.at > grantTtlMs) requests.delete(id);
  }

  /**
   * 记住「这个位置被批准过写」。批准的是目录（或卷根下的那一个文件）：
   * 同一目录下的后续写入不该再问，也不该再撞一次白名单。
   *
   * `remote` 单独标出来：远端（POSIX）目录**不进本机写白名单** —— 远端写根本不用那份清单，
   * 而 `/home/me` 在 Windows 上会被 resolve 成 `E:\home\me`（假根），把远端授权变成
   * 一条本机白名单等于凭空开了个口子。
   */
  function rememberPath(sessionId, absPath, opts = {}) {
    if (!absPath) return;
    const root = scopeOf(absPath);
    if (!root || root === '-') return;
    const sid = sessionKey(sessionId);
    const key = `${sid}|${root.toLowerCase()}`;
    if (pathGrants.has(key)) return;
    pathGrants.set(key, { sessionId: sid, root, remote: opts.remote === true, at: now() });
  }

  /**
   * 该会话被批准过写的**本机**位置（给 `writeRootsForCall()` 并入白名单用）。
   * 远端授权不在这里返回：它只对远端生效，进本机白名单只会污染可写根。
   */
  function grantedPathsFor(sessionId) {
    const sid = sessionKey(sessionId);
    const out = [];
    for (const [key, g] of pathGrants) {
      if (g.sessionId !== sid) continue;
      if (now() - g.at > grantTtlMs) {
        pathGrants.delete(key);
        continue;
      }
      if (g.remote === true) continue;
      out.push(g.root);
    }
    return out;
  }

  function grantedFor(sessionId, category, scope) {
    const key = grantKey(sessionId, category, scope);
    const hit = grants.get(key);
    if (!hit) return false;
    if (now() - hit.at > grantTtlMs) {
      grants.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 需要用户批准时调用。返回 `{ granted, remembered, reason, noChannel?, expired? }`。
   * 没有可用的 UI 通道时**拒绝**（fail-closed），并说明原因。
   */
  async function ask(decision, ctx = {}) {
    const sessionId = String(ctx.sessionId || '').trim();
    const category = decision && decision.category ? decision.category : SANDBOX_CATEGORIES.WRITE;
    // 判定可以自带授权粒度（`decision.scope`）：os-control 没有路径，但「哪台机器的键鼠」
    // 必须分开记 —— 否则同意过远端点一下，本机键鼠也跟着免问了。没有时按路径父目录记。
    const scope = (decision && decision.scope) || scopeOf(ctx.path);

    if (grantedFor(sessionId, category, scope)) {
      // 记忆的是「这一类别在这一位置」的操作，具体路径仍要落进放行根，
      // 否则旧白名单（writeRootsForCall）会挡下用户刚刚批准过的写。卷根下的精确授权只放它自己。
      if (scope !== '-') rememberPath(sessionId, ctx.path, { remote: ctx.remote === true });
      recordAudit({ kind: 'grant-reuse', sessionId, category, scope, action: decision.action });
      return { granted: true, remembered: true, reason: '本会话此前已批准过同一位置的同类操作' };
    }

    if (!request) {
      recordAudit({ kind: 'no-channel', sessionId, category, scope });
      log(`SANDBOX_NO_APPROVAL_CHANNEL category=${category} session=${sessionId || '-'}`);
      return { granted: false, remembered: false, noChannel: true, reason: '当前没有可用的确认界面' };
    }

    const requestId = `sbx-${++seq}-${now().toString(36)}`;
    const absPath = String(ctx.path || '');

    // 先登记再发问：即使这次 ask() 超时返回，迟到的按钮仍然找得到「批的是什么」。
    pruneRequests();
    requests.set(requestId, {
      sessionId: sessionKey(sessionId),
      category,
      scope,
      path: absPath,
      remote: ctx.remote === true,
      mode: String(decision.mode || ''),
      tool: String(ctx.tool || ''),
      at: now()
    });

    const payload = {
      requestId,
      mode: decision.mode,
      category,
      reason: decision.reason || '',
      detail: decision.detail || '',
      tool: ctx.tool || '',
      /** 迟到的批准要靠它算授权粒度（没有它只能退化成类别级，等于把档位打穿） */
      path: absPath,
      sessionId: sessionId || undefined
    };

    log(
      `SANDBOX_ASK request=${requestId} category=${category} mode=${decision.mode} session=${sessionId || '-'} scope=${scope}`
    );

    let answer;
    try {
      answer = await withTimeout(Promise.resolve(request(payload)), timeoutMs, {
        message: '等待确认超时',
        // 给上层区分"超时"和"通道炸了"用
        code: 'APPROVAL_TIMEOUT'
      });
    } catch (e) {
      const expired = !!(e && e.code === 'APPROVAL_TIMEOUT');
      recordAudit({ kind: expired ? 'ask-timeout' : 'ask-error', requestId, sessionId, category, error: String(e && e.message) });
      return {
        granted: false,
        remembered: false,
        expired,
        // 通道本身出错 = 实际上没人能回答，按"没有通道"报，别让用户以为是自己的点击没生效
        noChannel: !expired,
        reason: expired ? '等待确认超时' : `确认请求失败：${e && e.message ? e.message : e}`
      };
    }

    const granted = answer === true || (answer && answer.granted === true);
    recordAudit({ kind: granted ? 'grant' : 'decline', requestId, sessionId, category, scope, mode: decision.mode });
    if (!granted) {
      log(`SANDBOX_DECLINED request=${requestId} category=${category} session=${sessionId || '-'}`);
      return { granted: false, remembered: false, reason: (answer && answer.reason) || '用户拒绝' };
    }

    grants.set(grantKey(sessionId, category, scope), { sessionId: sessionKey(sessionId), category, scope, at: now() });
    if (scope !== '-') rememberPath(sessionId, ctx.path, { remote: ctx.remote === true });
    log(`SANDBOX_GRANTED request=${requestId} category=${category} session=${sessionId || '-'} scope=${scope}`);
    return { granted: true, remembered: false, reason: '用户同意' };
  }

  /**
   * 迟到的决定：`ask()` 已经超时返回（甚至那次工具调用早已失败）之后，用户才点的按钮。
   *
   * 只做一件事 —— **把批准记进 grant**，不重放、不重试任何工具调用：
   * - 记的是「本会话在这个位置允许这类操作」，所以下一次同类操作直接放行；
   * - 已经过期的请求返回 `ok:false + expired`，界面据此告诉用户「这次得重新执行」，
   *   而不是像以前那样点了没反应。
   *
   * @returns {{ ok: boolean, granted?: boolean, expired?: boolean, reason?: string,
   *             sessionId?: string, category?: string, scope?: string, mode?: string, tool?: string }}
   */
  function resolveLater(requestId, granted) {
    const id = String(requestId || '');
    const rec = requests.get(id);
    const expiredReason = '该确认已过期（超过有效时间），请重新让 Agent 执行';
    if (!rec) return { ok: false, expired: true, reason: expiredReason };
    if (now() - rec.at > grantTtlMs) {
      requests.delete(id);
      return { ok: false, expired: true, reason: expiredReason };
    }

    const base = {
      sessionId: rec.sessionId,
      category: rec.category,
      scope: rec.scope,
      mode: rec.mode,
      tool: rec.tool
    };

    if (!granted) {
      recordAudit({ kind: 'decline-late', requestId: id, sessionId: rec.sessionId, category: rec.category, scope: rec.scope });
      log(`SANDBOX_DECLINED_LATE request=${id} category=${rec.category} session=${rec.sessionId || '-'}`);
      return { ok: true, granted: false, reason: '用户拒绝（本次执行已结束）', ...base };
    }

    grants.set(grantKey(rec.sessionId, rec.category, rec.scope), {
      sessionId: rec.sessionId,
      category: rec.category,
      scope: rec.scope,
      at: now()
    });
    if (rec.scope !== '-' && rec.path) rememberPath(rec.sessionId, rec.path, { remote: rec.remote === true });
    recordAudit({ kind: 'grant-late', requestId: id, sessionId: rec.sessionId, category: rec.category, scope: rec.scope });
    log(`SANDBOX_GRANT_LATE request=${id} category=${rec.category} session=${rec.sessionId || '-'} scope=${rec.scope}`);
    return { ok: true, granted: true, reason: '已记住本会话对该位置的授权', ...base };
  }

  /** 显式批准（UI 回包路径之外的管理入口 / 测试用）。 */
  function grant(sessionId, category, scope) {
    const s = String(scope || '-');
    grants.set(grantKey(sessionId, category, s), {
      sessionId: sessionKey(sessionId),
      category,
      scope: s,
      at: now()
    });
  }

  function clearSession(sessionId) {
    const sid = sessionKey(sessionId);
    for (const [key, g] of grants) if (g.sessionId === sid) grants.delete(key);
    for (const [key, g] of pathGrants) if (g.sessionId === sid) pathGrants.delete(key);
    for (const [key, r] of requests) if (r.sessionId === sid) requests.delete(key);
  }

  function clearAll() {
    grants.clear();
    pathGrants.clear();
    requests.clear();
    for (const [, p] of pending) {
      try {
        clearTimeout(p.timer);
      } catch {
        /* ignore */
      }
    }
    pending.clear();
  }

  function snapshot() {
    const out = [];
    for (const g of grants.values()) {
      if (now() - g.at > grantTtlMs) continue;
      out.push({ sessionId: g.sessionId, category: g.category, scope: g.scope, grantedAt: g.at });
    }
    return out;
  }

  return {
    ask,
    resolveLater,
    setRequest,
    rememberPath,
    grantedPathsFor,
    grantedFor,
    grant,
    clearSession,
    clearAll,
    snapshot,
    auditLog: () => audit.slice(),
    timeoutMs,
    grantTtlMs
  };
}

module.exports = { createSandboxApprovals, sessionKey};
