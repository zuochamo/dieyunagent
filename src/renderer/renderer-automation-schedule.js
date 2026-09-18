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
   * 另一条硬规则：UI 只能表达 DAILY / WEEKLY / MINUTELY 三种频率。
   * 模型（plan_create）或用户可能写入更复杂的规则（多 BYDAY、COUNT、MONTHLY…），
   * 此时 `exact: false` 表示「界面显示的是近似值」，未真正改动调度控件前必须原样保留原规则。
   */

  const PERIODIC_UNIT_OPTIONS = [
    { key: 'day', label: '每天' },
    { key: 'week', label: '每周' }
  ];

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
  const EXPRESSIBLE_KEYS = ['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY', 'UNTIL', 'DTSTART'];

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

  function clampInterval(n) {
    const v = numOrNull(n);
    if (v == null) return DEFAULT_INTERVAL_MIN;
    return Math.max(MIN_INTERVAL_MIN, Math.min(1440, Math.round(v)));
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
      intervalMin: DEFAULT_INTERVAL_MIN,
      onceAtInput: '',
      dtstartDate,
      untilDate: '',
      exact: false
    };

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

    // 频率之外还有别的字段（COUNT / BYMONTHDAY / 多 BYDAY…）时，表单显示的是近似值
    let exact = Object.keys(parts).every((k) => EXPRESSIBLE_KEYS.includes(k));

    if (freq === 'MINUTELY') {
      out.tab = 'interval';
      out.intervalMin = clampInterval(parts.INTERVAL || DEFAULT_INTERVAL_MIN);
    } else if (freq === 'HOURLY') {
      // 界面只有「每 N 分钟」，小时级间隔只能近似显示，不能按它回写
      out.tab = 'interval';
      out.intervalMin = clampInterval((numOrNull(parts.INTERVAL) || 1) * 60);
      exact = false;
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

  /** 表单值 → rrule / onceAt（与 automationScheduleFromPlan 对称）。 */
  function buildAutomationRrule(input) {
    const s = input && typeof input === 'object' ? input : {};
    if (s.tab === 'once') {
      const raw = String(s.onceAtInput || '').trim();
      return { rrule: '', onceAt: raw ? new Date(raw).toISOString() : '' };
    }
    const until = untilSuffix(s.untilDate);
    if (s.tab === 'interval') {
      return { rrule: `FREQ=MINUTELY;INTERVAL=${clampInterval(s.intervalMin)}${until}`, onceAt: '' };
    }
    const hour = Math.min(23, Math.max(0, Math.round(numOrNull(s.hour) == null ? DEFAULT_HOUR : numOrNull(s.hour))));
    const minute = Math.min(
      59,
      Math.max(0, Math.round(numOrNull(s.minute) == null ? DEFAULT_MINUTE : numOrNull(s.minute)))
    );
    if (s.unit === 'week') {
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${bydayForKey(s.weekdayKey)};BYHOUR=${hour};BYMINUTE=${minute}${until}`,
        onceAt: ''
      };
    }
    return { rrule: `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}${until}`, onceAt: '' };
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
      intervalMin: r.intervalMin,
      onceAtInput: String(r.onceAtInput || ''),
      untilDate: String(r.untilDate || '')
    };
  }

  window.DieyunAutomationSchedule = {
    PERIODIC_UNIT_OPTIONS,
    WEEK_DAY_OPTIONS,
    DEFAULT_INTERVAL_MIN,
    MIN_INTERVAL_MIN,
    parseRruleParts,
    untilToDateInput,
    untilSuffix,
    toLocalDateInputValue,
    toLocalDatetimeInputValue,
    timeValueOf,
    parseTimeValue,
    timePartsOf,
    bydayForKey,
    keyForByday,
    automationScheduleFromPlan,
    buildAutomationRrule,
    automationScheduleFormValue
  };
}());
