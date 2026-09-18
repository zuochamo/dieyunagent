'use strict';

/**
 * 事件时间线（"点了没反应"类问题的直接证据）。
 *
 * 两个来源合成一条时间线：
 * - 页面侧：capture 阶段的 click / input / change / keydown / submit 等真实事件，
 *   经 CDP Runtime.addBinding（BrowserView）或 context.exposeBinding（Playwright）
 *   回传到 Node；每个 frame 都会安装（iframe 内的事件同样可见）。
 * - Agent 侧：navigate / click / type / press_key 等工具调用，
 *   由 controller / playwright-runner 直接写入同一环形缓冲。
 *
 * 纯逻辑 + 内存环形缓冲，零 Electron 依赖，便于单测。
 */

const DEFAULT_MAX_ENTRIES = 400;
const TIMELINE_BINDING = '__dieyunEmit';
const TIMELINE_CHANNEL = 'timeline';
const RECORDER_FLAG = '__dieyunTimelineInstalled';

const PAGE_EVENT_TYPES = ['click', 'dblclick', 'contextmenu', 'input', 'change', 'keydown', 'submit', 'focus'];

/** 页面内记录器：capture 阶段挂事件，把结构化条目回传 Node。 */
function buildTimelineRecorderScript() {
  return `(() => {
  if (window.${RECORDER_FLAG}) return 'already';
  window.${RECORDER_FLAG} = true;
  var seq = 0;
  var MAX_TEXT = 120;
  function inFrame() {
    try { return window !== window.top; } catch (_) { return true; }
  }
  function cssHint(el) {
    try {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + el.id;
      var names = [];
      if (typeof el.className === 'string' && el.className.trim()) {
        var parts = el.className.trim().split(' ');
        for (var i = 0; i < parts.length && names.length < 2; i++) if (parts[i]) names.push(parts[i]);
      }
      return String(el.tagName || '').toLowerCase() + (names.length ? '.' + names.join('.') : '');
    } catch (_) { return ''; }
  }
  function describe(el) {
    try {
      if (!el || el.nodeType !== 1) return { tag: '', selector: '' };
      var text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        tag: String(el.tagName || '').toLowerCase(),
        id: el.id ? String(el.id) : '',
        class: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
        text: text.slice(0, MAX_TEXT),
        selector: cssHint(el)
      };
    } catch (_) { return { tag: '', selector: '' }; }
  }
  function emit(type, payload) {
    var row = {
      channel: '${TIMELINE_CHANNEL}',
      type: type,
      ts: Date.now(),
      seq: seq++,
      frame: inFrame() ? 'iframe' : 'main'
    };
    if (payload) {
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) row[k] = payload[k];
      }
    }
    try {
      if (typeof window.${TIMELINE_BINDING} === 'function') {
        window.${TIMELINE_BINDING}(JSON.stringify(row));
      }
    } catch (_) {}
  }
  var LISTENED = ${JSON.stringify(PAGE_EVENT_TYPES)};
  for (var i = 0; i < LISTENED.length; i++) {
    (function (type) {
      document.addEventListener(type, function (ev) {
        try {
          if (type === 'keydown') {
            var key = String((ev && ev.key) || '');
            if (key !== 'Enter' && key !== 'Escape' && key !== 'Tab') return;
          }
          var payload = { target: describe(ev && ev.target) };
          if (type === 'input' || type === 'change') {
            var v = ev && ev.target ? ev.target.value : '';
            if (v != null) payload.value = String(v).slice(0, MAX_TEXT);
          }
          if (type === 'keydown') payload.key = String((ev && ev.key) || '');
          if (ev && ev.isTrusted === false) payload.synthetic = true;
          emit(type, payload);
        } catch (_) {}
      }, true);
    })(LISTENED[i]);
  }
  window.addEventListener('popstate', function () { emit('navigate', { reason: 'popstate', url: String(location.href) }); }, true);
  window.addEventListener('hashchange', function () { emit('navigate', { reason: 'hashchange', url: String(location.href) }); }, true);
  return 'installed';
})()`;
}

function createTimelineJournal(opts = {}) {
  const maxEntries = Math.max(50, Number(opts.maxEntries) || DEFAULT_MAX_ENTRIES);
  /** @type {Array<object>} */
  let entries = [];
  let seq = 0;

  function add(partial = {}) {
    seq += 1;
    const target = partial.target && typeof partial.target === 'object' ? partial.target : null;
    // 页面侧回传的事件自带 ts（同机时钟），优先采用；否则 auto 模式合并 browserview /
    // playwright 两条缓冲后按 ts 排序，得到的只是「Node 收到 JSON 的先后」，会失真。
    const rawTs = Number(partial.ts);
    const entry = {
      id: `evt-${seq}`,
      ts: Number.isFinite(rawTs) && rawTs > 0 ? rawTs : Date.now(),
      type: String(partial.type || 'unknown'),
      source: partial.source === 'agent' ? 'agent' : 'page',
      engine: partial.engine,
      url: partial.url ? String(partial.url).slice(0, 500) : '',
      frame: partial.frame ? String(partial.frame).slice(0, 40) : '',
      target: target
        ? {
            tag: String(target.tag || ''),
            id: String(target.id || ''),
            class: String(target.class || '').slice(0, 120),
            text: String(target.text || '').slice(0, 120),
            selector: String(target.selector || '').slice(0, 200)
          }
        : null,
      value: partial.value != null ? String(partial.value).slice(0, 200) : undefined,
      key: partial.key ? String(partial.key) : undefined,
      reason: partial.reason ? String(partial.reason).slice(0, 80) : undefined,
      ok: partial.ok === false ? false : undefined,
      error: partial.error ? String(partial.error).slice(0, 300) : undefined
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    return entry;
  }

  /** 页面侧回传的 JSON 行 → 结构化条目；非本通道一律返回 null。 */
  function addBindingPayload(rawJson) {
    let row = null;
    try {
      row = JSON.parse(String(rawJson == null ? '' : rawJson));
    } catch {
      return null;
    }
    if (!row || row.channel !== TIMELINE_CHANNEL) return null;
    return add({
      type: row.type,
      ts: row.ts,
      source: 'page',
      frame: row.frame,
      target: row.target,
      value: row.value,
      key: row.key,
      reason: row.reason,
      url: row.url
    });
  }

  function clear() {
    entries = [];
  }

  function list(args = {}) {
    const limit = Math.min(300, Math.max(1, Number(args.limit) || 80));
    let out = entries.slice();
    if (args.source) {
      const source = String(args.source).toLowerCase();
      out = out.filter((e) => e.source === source);
    }
    // frame 与 source 是两个维度，别混：source 只认 agent|page（数据来源），
    // frame 才是「事件所在 frame」的字符串（页面侧 main/iframe，Agent 侧 path=0.1 等）。
    if (args.frame) {
      const needle = String(args.frame).toLowerCase();
      out = out.filter((e) => String(e.frame || '').toLowerCase().includes(needle));
    }
    const types = Array.isArray(args.types) ? args.types.map((t) => String(t)) : [];
    if (types.length) out = out.filter((e) => types.indexOf(e.type) >= 0);
    if (args.type) {
      const t = String(args.type);
      out = out.filter((e) => e.type === t);
    }
    if (args.urlPattern) {
      const raw = String(args.urlPattern);
      let match;
      try {
        const re = new RegExp(raw, 'i');
        match = (e) => re.test(e.url || '');
      } catch {
        const needle = raw.toLowerCase();
        match = (e) => String(e.url || '').toLowerCase().includes(needle);
      }
      out = out.filter(match);
    }
    if (args.sinceMs) {
      const since = Date.now() - Math.max(0, Number(args.sinceMs) || 0);
      out = out.filter((e) => e.ts >= since);
    }
    return out.slice(-limit);
  }

  function status() {
    const counts = {};
    for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;
    return {
      total: entries.length,
      pageEvents: entries.filter((e) => e.source === 'page').length,
      agentEvents: entries.filter((e) => e.source === 'agent').length,
      counts
    };
  }

  return { add, addBindingPayload, clear, list, status };
}

/** 时间线 → 模型可读的短序列（默认压掉高频 input，避免刷屏）。 */
function summarizeTimeline(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const includeInput = opts.includeInput === true;
  const rows = list.filter((e) => includeInput || e.type !== 'input');
  return {
    count: list.length,
    shown: rows.length,
    entries: rows.map((e) => ({
      id: e.id,
      ts: e.ts,
      type: e.type,
      source: e.source,
      frame: e.frame || '',
      url: String(e.url || '').slice(0, 160),
      target: e.target ? e.target.selector || e.target.tag : '',
      text: e.target && e.target.text ? e.target.text.slice(0, 60) : '',
      value: e.value,
      key: e.key,
      reason: e.reason,
      ok: e.ok,
      error: e.error
    }))
  };
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  TIMELINE_BINDING,
  TIMELINE_CHANNEL,
  RECORDER_FLAG,
  PAGE_EVENT_TYPES,
  buildTimelineRecorderScript,
  createTimelineJournal,
  summarizeTimeline
};
