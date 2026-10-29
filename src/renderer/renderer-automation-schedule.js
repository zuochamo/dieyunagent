(function () {
  'use strict';

  /**
   * 定时任务「RRULE ⇄ 表单」的唯一实现。
   *
   * 计划的调度真相是 rrule / onceAt 字符串（Main 的 PlansScheduler 直接按它算下次触发），
   * 表单只是它的一种编辑视图。因此两个方向必须成对：
   *   - automationScheduleFromPlan：计划 → 表单值（打开编辑器时回填）
   *   - buildAutomationRrule：     表单值 → 计划（保存时合成）
   * 只做其中一个方向，就会出现「保存了但界面显示不对」或「界面改了但保存不进去」。
   *
   * 另一条硬规则：UI 只能表达 DAILY / WEEKLY / MINUTELY / HOURLY 这几种频率，
   * 外加两个通用限次字段（COUNT = 总共执行多少次、UNTIL = 生效结束日期）。
   * 模型（plan_create）或用户可能写入更复杂的规则（多 BYDAY、MONTHLY、BYMONTHDAY…），
   * 此时 `exact: false` 表示「界面显示的是近似值」，未真正改动调度控件前必须原样保留原规则。
   */

  const PERIODIC_UNIT_OPTIONS = [
    { key: 'day', label: '每天' },
    { key: 'week', label: '每周' }
  ];

  /**
   * 「每 N <单位>」的单位表：UI 的下拉选项与 rrule 的 FREQ 的唯一映射。
   * 上下限按「一次触发的最短间隔」定：分钟 ≥5（避免把模型额度打空），小时/天 ≥1。
   */
  const INTERVAL_UNIT_OPTIONS = [
    { key: 'minute', label: '分钟', freq: 'MINUTELY', min: 5, max: 1440, def: 60 },
    { key: 'hour', label: '小时', freq: 'HOURLY', min: 1, max: 168, def: 1 },
    { key: 'day', label: '天', freq: 'DAILY', min: 1, max: 365, def: 1 }
  ];

  /** 「总共执行多少次」上限（COUNT 是纯计数，仅防手滑填出天文数字） */
  const MAX_RUN_COUNT = 9999;

  /** 周几的唯一映射：key 同时用作下拉选项与 rrule 的 BYDAY 索引来源。 */
  const WEEK_DAY_OPTIONS = [
    { key: '1', label: '周一', byday: 'MO' },
    { key: '2', label: '周二', byday: 'TU' },
    { key: '3', label: '周三', byday: 'WE' },
    { key: '4', label: '周四', byday: 'TH' },
    { key: '5', label: '周五', byday: 'FR' },
    { key: '6', label: '周六', byday: 'SA' },
    { key: '0', label: '周日', byday: 'SU' }
  ];

  const DEFAULT_HOUR = 9;
  const DEFAULT_MINUTE = 0;
  const DEFAULT_INTERVAL_MIN = 60;
  const MIN_INTERVAL_MIN = 5;

  /** 界面完整表达的字段（出现其它字段即说明规则被简化显示过） */
  const EXPRESSIBLE_KEYS = [
    'FREQ',
    'INTERVAL',
    'BYHOUR',
    'BYMINUTE',
    'BYDAY',
    'UNTIL',
    'COUNT',
    'DTSTART'
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function toDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** date 输入框值（本地日期，绝不 slice ISO——那是 UTC，会差一个时区） */
  function toLocalDateInputValue(value) {
    const d = toDate(value);
    if (!d) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** datetime-local 输入框值（本地时间） */
  function toLocalDatetimeInputValue(value) {
    const d = toDate(value);
    if (!d) return '';
    return `${toLocalDateInputValue(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function timeValueOf(hour, minute) {
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  function parseTimeValue(value) {
    const [h, m] = String(value || '').split(':');
    return {
      hour: numOrNull(h) == null ? DEFAULT_HOUR : numOrNull(h),
      minute: numOrNull(m) == null ? DEFAULT_MINUTE : numOrNull(m)
    };
  }

  function timePartsOf(value) {
    const d = toDate(value);
    if (!d) return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
    return { hour: d.getHours(), minute: d.getMinutes() };
  }

  function normalizeRruleText(rrule) {
    return String(rrule || '').trim().replace(/^RRULE:/i, '').trim();
  }

  /** 拆 rrule 为「字段 → 值」表（值统一大写，便于比较 FREQ/BYDAY）。 */
  function parseRruleParts(rrule) {
    const text = normalizeRruleText(rrule);
    const out = {};
    if (!text) return out;
    for (const seg of text.split(';')) {
      const idx = seg.indexOf('=');
      if (idx <= 0) continue;
      out[seg.slice(0, idx).trim().toUpperCase()] = seg.slice(idx + 1).trim().toUpperCase();
    }
    return out;
  }

  function bydayForKey(key) {
    const hit = WEEK_DAY_OPTIONS.find((o) => o.key === String(key));
    return hit ? hit.byday : 'MO';
  }

  function keyForByday(byday) {
    const want = String(byday || '').trim().toUpperCase();
    const hit = WEEK_DAY_OPTIONS.find((o) => o.byday === want);
    return hit ? hit.key : '1';
  }

  /** YYYYMMDD[THHMMSS][Z] / ISO → 本地 date 输入框值（UNTIL 缺省时刻按当天 23:59:59 处理） */
  function untilToDateInput(until) {
    const raw = String(until || '').trim().toUpperCase();
    if (!raw) return '';
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
    if (m) {
      const [, y, mo, d, hh, mm, ss, zulu] = m;
      const parts = [Number(y), Number(mo) - 1, Number(d), hh ? Number(hh) : 23, mm ? Number(mm) : 59, ss ? Number(ss) : 59];
      // 带 Z 的是 UTC，转成本地再进 date 输入框；不带 Z 的 rrule 库按 UTC 解析，这里保持同样口径
      const date = zulu || raw.includes('T')
        ? new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]))
        : new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
      return toLocalDateInputValue(date);
    }
    return toLocalDateInputValue(raw);
  }

  /** 生效结束日期 → rrule 的 UNTIL 片段（本地当天 23:59:59，转 UTC 后按 iCal 格式写死时区） */
  function untilSuffix(dateInput) {
    const raw = String(dateInput || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
    const utc = `${end.getUTCFullYear()}${pad2(end.getUTCMonth() + 1)}${pad2(end.getUTCDate())}T${pad2(
      end.getUTCHours()
    )}${pad2(end.getUTCMinutes())}${pad2(end.getUTCSeconds())}Z`;
    return `;UNTIL=${utc}`;
  }

  /** 间隔单位元数据（未知 key 归到「分钟」，与历史表单默认一致） */
  function intervalUnitMeta(key) {
    const hit = INTERVAL_UNIT_OPTIONS.find((o) => o.key === String(key || ''));
    return hit || INTERVAL_UNIT_OPTIONS[0];
  }

  /** rrule FREQ → 间隔单位 key（DAILY 由调用方按是否带 INTERVAL 判定，见 automationScheduleFromPlan） */
  function intervalUnitForFreq(freq) {
    const want = String(freq || '').toUpperCase();
    const hit = INTERVAL_UNIT_OPTIONS.find((o) => o.freq === want);
    return hit ? hit.key : '';
  }

  /** 间隔值 clamp：默认值与上下限都跟着单位走（分钟 5~1440 / 小时 1~168 / 天 1~365） */
  function clampInterval(unitKey, value) {
    const meta = intervalUnitMeta(unitKey);
    const v = numOrNull(value);
    if (v == null) return meta.def;
    return Math.max(meta.min, Math.min(meta.max, Math.round(v)));
  }

  /** 「总共执行多少次」：空 / 0 = 不限（不写 COUNT） */
  function clampRunCount(value) {
    const v = numOrNull(value);
    if (v == null) return 0;
    const n = Math.floor(v);
    return n > 0 ? Math.min(MAX_RUN_COUNT, n) : 0;
  }

  /**
   * 限次后缀：COUNT 与 UNTIL 在 RFC 5545 里互斥，两者都填时以「次数」为准
   * （次数是用户更明确的那一侧：填了就是想跑够就停）。
   */
  function limitSuffix(runCount, untilDate) {
    const count = clampRunCount(runCount);
    if (count > 0) return `;COUNT=${count}`;
    return untilSuffix(untilDate);
  }

  /**
   * 计划 → 表单值。
   *
   * onceAt 优先按「单次」展示；其余按 rrule 频率归到周期/间隔两个面板，
   * 并把 BYHOUR/BYMINUTE/BYDAY/INTERVAL/UNTIL/dtstart 逐个还原到对应控件。
   * `exact: false` 时表单只是近似视图，调用方未收到用户改动就不得用它重写规则。
   */
  function automationScheduleFromPlan(plan) {
    const p = plan && typeof plan === 'object' ? plan : {};
    const dtstartDate = toLocalDateInputValue(p.dtstart);
    const fromDtstart = timePartsOf(p.dtstart);
    const onceAt = String(p.onceAt || '').trim();

    const out = {
      tab: 'periodic',
      unit: 'day',
      weekdayKey: '1',
      hour: fromDtstart.hour,
      minute: fromDtstart.minute,
      intervalUnit: 'minute',
      intervalValue: DEFAULT_INTERVAL_MIN,
      runCount: '',
      onceAtInput: '',
      dtstartDate,
      untilDate: '',
      exact: false
    };

    // 空闲触发（trigger=idle）：无 rrule/onceAt，表单只负责选中「空闲时」页签
    if (p.trigger === 'idle' && !onceAt && !normalizeRruleText(p.rrule)) {
      out.tab = 'idle';
      out.exact = true;
      return out;
    }

    // 目标型（trigger=goal）：没有调度语义，跑到验收命令通过为止；表单只负责选中「目标」页签
    if (p.trigger === 'goal') {
      out.tab = 'goal';
      out.exact = true;
      return out;
    }

    if (onceAt) {
      out.tab = 'once';
      out.onceAtInput = toLocalDatetimeInputValue(onceAt);
      out.exact = true;
      return out;
    }

    const rrule = normalizeRruleText(p.rrule);
    if (!rrule) return out;

    const parts = parseRruleParts(rrule);
    const freq = parts.FREQ || '';
    const byhour = numOrNull(parts.BYHOUR);
    const byminute = numOrNull(parts.BYMINUTE);
    if (byhour != null) out.hour = Math.min(23, Math.max(0, Math.round(byhour)));
    if (byminute != null) out.minute = Math.min(59, Math.max(0, Math.round(byminute)));
    const byday = parts.BYDAY
      ? parts.BYDAY.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (byday.length) out.weekdayKey = keyForByday(byday[0]);
    out.untilDate = untilToDateInput(parts.UNTIL);
    // 总共执行多少次（COUNT）：与 untilDate 互斥，表单里也是二选一
    const count = clampRunCount(parts.COUNT);
    out.runCount = count > 0 ? String(count) : '';

    // 频率之外还有别的字段（BYMONTHDAY / BYMONTH / 多 BYDAY…）时，表单显示的是近似值
    let exact = Object.keys(parts).every((k) => EXPRESSIBLE_KEYS.includes(k));

    // 「每 N <单位>」：MINUTELY / HOURLY 天然是间隔；DAILY 只有带 INTERVAL 时才归到间隔页签
    //（不带 INTERVAL 的 DAILY 是周期页签的「每天 HH:MM」）
    const intervalUnit = intervalUnitForFreq(freq);
    const isInterval = intervalUnit !== '' && (freq !== 'DAILY' || parts.INTERVAL != null);
    if (isInterval) {
      out.tab = 'interval';
      out.intervalUnit = intervalUnit;
      out.intervalValue = clampInterval(intervalUnit, parts.INTERVAL);
      // 间隔页签没有时刻/星期控件：规则里带了它们就只是近似显示，不能按它回写
      if (byhour != null || byminute != null || byday.length) exact = false;
      // 边界外的间隔（如 每 999 天）被 clamp 过：界面显示的不是原值，同样不许回写
      const rawInterval = numOrNull(parts.INTERVAL);
      if (rawInterval != null && rawInterval !== Number(out.intervalValue)) exact = false;
    } else if (freq === 'WEEKLY') {
      out.unit = 'week';
      if (byday.length !== 1) exact = false;
    } else if (freq === 'DAILY') {
      if (byday.length) exact = false;
    } else {
      exact = false;
    }
    out.exact = exact;
    return out;
  }

  /** 表单值 → rrule / onceAt / trigger（与 automationScheduleFromPlan 对称）。 */
  function buildAutomationRrule(input) {
    const s = input && typeof input === 'object' ? input : {};
    if (s.tab === 'idle') {
      return { rrule: '', onceAt: '', trigger: 'idle' };
    }
    if (s.tab === 'goal') {
      // 目标型没有调度字符串：验收命令与预算在 collectAutomationForm 里单独收集
      return { rrule: '', onceAt: '', trigger: 'goal' };
    }
    if (s.tab === 'once') {
      const raw = String(s.onceAtInput || '').trim();
      return { rrule: '', onceAt: raw ? new Date(raw).toISOString() : '', trigger: 'schedule' };
    }
    // COUNT（总共执行多少次）与 UNTIL（生效结束）二选一，见 limitSuffix
    const tail = limitSuffix(s.runCount, s.untilDate);
    if (s.tab === 'interval') {
      const meta = intervalUnitMeta(s.intervalUnit);
      const value = clampInterval(meta.key, s.intervalValue);
      return {
        rrule: `FREQ=${meta.freq};INTERVAL=${value}${tail}`,
        onceAt: '',
        trigger: 'schedule'
      };
    }
    const hour = Math.min(23, Math.max(0, Math.round(numOrNull(s.hour) == null ? DEFAULT_HOUR : numOrNull(s.hour))));
    const minute = Math.min(
      59,
      Math.max(0, Math.round(numOrNull(s.minute) == null ? DEFAULT_MINUTE : numOrNull(s.minute)))
    );
    if (s.unit === 'week') {
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${bydayForKey(s.weekdayKey)};BYHOUR=${hour};BYMINUTE=${minute}${tail}`,
        onceAt: '',
        trigger: 'schedule'
      };
    }
    return { rrule: `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}${tail}`, onceAt: '', trigger: 'schedule' };
  }

  /** 表单里的读数（把 DOM 值收敛成一个对象，供 buildAutomationRrule 使用） */
  function automationScheduleFormValue(read) {
    const r = read || {};
    return {
      tab: String(r.tab || 'periodic'),
      unit: String(r.unit || 'day'),
      weekdayKey: String(r.weekdayKey || '1'),
      hour: r.hour,
      minute: r.minute,
      intervalUnit: String(r.intervalUnit || 'minute'),
      intervalValue: r.intervalValue,
      runCount: r.runCount,
      onceAtInput: String(r.onceAtInput || ''),
      untilDate: String(r.untilDate || '')
    };
  }

  window.DieyunAutomationSchedule = {
    PERIODIC_UNIT_OPTIONS,
    INTERVAL_UNIT_OPTIONS,
    WEEK_DAY_OPTIONS,
    DEFAULT_INTERVAL_MIN,
    MIN_INTERVAL_MIN,
    MAX_RUN_COUNT,
    parseRruleParts,
    untilToDateInput,
    untilSuffix,
    limitSuffix,
    toLocalDateInputValue,
    toLocalDatetimeInputValue,
    timeValueOf,
    parseTimeValue,
    timePartsOf,
    bydayForKey,
    keyForByday,
    intervalUnitMeta,
    clampInterval,
    clampRunCount,
    automationScheduleFromPlan,
    buildAutomationRrule,
    automationScheduleFormValue
  };
}());
