/* global window, document, $, isSettingsPageOpen, switchSettingsTab, openSettingsModal, currentSessionId, invalidateSessionMessageCache, loadChatFromGateway, isSessionSending, refreshHistoryList, showAgentToast */
'use strict';

/**
 * 设置 → 生命（**只读观察窗 + 一个总开关 + 感官开关**）。
 *
 * 这一页只有四件事：
 *   1. 总开关（开 = 起心跳；关 = 停表，体征留着，不是清空）
 *   2. 只读体征：相位 / 张力与阈值 / 疲劳 / 未闭合条数 / 决策计数（**页签可见时轮询刷新**）
 *   3. 感官：三个开关 + 「勾着但不可用」的可见告警 + 设备选择 + 主动开口授权
 *   4. 「日志」页：两组横向标签 —— 事件（`时间 · 事件 · 细节`）与抽屉（`note.md` 原文）
 *
 * **刻意不做的**（每一样都会把这个拟态变成假的）：
 *   - 不显示"为什么"（`intent` 在本机私有，不进 IPC）
 *   - 不给暂停/恢复/回滚（只有开关与「重新开始」）
 *   - 不给性格参数旋钮（数字唯一来源是 `src/agent/agent-limits.js`）
 *   - 不在 Renderer 判定生死、唤醒、续跑（全部在 Main 的 `src/alive/runtime.js`）
 *   - 不存「它看见的画面」（现实画面不落盘，见 docs/ALIVE.md）
 */

/** 页签可见时的刷新间隔：与体征漂移的心跳间隔同量级即可（不需要更快，也不该更慢） */
const ALIVE_POLL_MS = 5000;
/** 决策日志每 N 次轮询刷一次（文件读盘，不必跟体征一样频） */
const ALIVE_DECISIONS_EVERY = 3;
/** 事件流最多显示多少行（列表与角标的"共 N 条"口径都取这一个数） */
const ALIVE_EVENT_LINES = 40;
/**
 * 手打文本框（「允许它动的根目录」/「设定」）的保存间隔：打字停这么久就存一次。
 *
 * 为什么不复用页面轮询的 5s：那是"读"的节奏；写要跟手 —— 打完就切走的那一下不能丢。
 */
const ALIVE_TEXT_SAVE_DELAY_MS = 800;

const aliveUi = {
  loading: false,
  saving: false,
  /**
   * 「设定」页自己的三个标志（**不与 `saving` 共用**）。
   *
   * 为什么单独一份：`saving` 是总开关 / 清除体征 / 其它设置项共用的在途标志，
   * 拿它当闸门时，正有别的写操作在飞，点「保存」会被 `return` 静默吃掉 —— 没有提示、没有 IPC、
   * 也没有任何日志（2026-11-15 用户实测"设定的内容丢了"就是这条链路：日志里连
   * `[alive] 设定：` 都没出现过，说明请求从没发出去）。
   */
  setupSynced: '',
  setupSaving: false,
  setupPending: false,
  /**
   * 「允许它动的根目录」框里那一份是否已经等于磁盘上的那一份（与 `setupSynced` 同一个办法）。
   *
   * 不等于 = 用户改过还没落盘：这时任何一次状态刷新（5s 轮询 / 切页签 / 拨其它开关都会走到
   * `renderAliveStatus`）都必须让路，否则刚打的路径会被刷回旧值 —— 看起来就是"填了又丢了"。
   */
  rootSynced: '',
  devicesLoading: false,
  pollTimer: null,
  badgeTimer: null,
  pollTick: 0,
  devicesLoaded: false,
  /** 主窗口「它说…」被手动收起的时刻（下次它再开口会重新出现；不落盘 = 重启后照样看得到） */
  speechDismissedAt: 0
};

const ALIVE_PHASE_TEXT = {
  ALERT: '警觉',
  LOW: '低载',
  SETTLE: '舒张',
  COMPRESS: '压缩'
};

const ALIVE_EVENT_TEXT = {
  BIRTH: '出生',
  WAKE: '自发醒来',
  WAKE_END: '醒来结束',
  WAKE_NO_DECISION: '醒来却没表态',
  WAKE_SKIPPED: '醒来跳过',
  WAKE_ERROR: '醒来失败',
  DECISION: '决策',
  PHASE: '相位切换',
  SPEAK: '开口说话',
  LISTEN: '听了一段时间',
  EYE: '睁眼看',
  ACTION: '动了手',
  DONE_NO_EVIDENCE: '收口缺依据'
};

const ALIVE_SENSE_KEYS = ['drawer', 'eyes', 'voice'];

/**
 * 「它留下什么」只有两种东西，两个壳共用同一套标签名：
 *   - `events`：事件流（它做过什么）
 *   - `note`：抽屉（它自己写下的原文，`note.md`）
 *
 * 抽屉原来挂在「生命」页底部，与事件流分居两个页签；现在两者是同一个位置的两组横向标签，
 * 差别只在看哪一页（渲染仍是 `renderAliveDecisions` / `renderAliveNote` 各管各的）。
 */
const ALIVE_TABS = ['events', 'note'];


/** 感官事件的错误码 → 人话（事件日志里直接看代码等于没说） */
const ALIVE_CODE_TEXT = {
  NO_FFMPEG: '没有 ffmpeg',
  NO_FFPLAY: '没有 ffplay',
  NO_MIC_DEVICE: '没选麦克风',
  NO_SPEECH_CONFIG: '没配语音转写',
  NO_TTS_CONFIG: '没配语音合成',
  VOICE_NOT_ALLOWED: '没被允许主动开口',
  DEVICE_BUSY: '设备被占用',
  DEVICE_UNAVAILABLE: '找不到设备',
  NO_AUDIO: '没录到声音',
  TTS_EMPTY: '合成返回空音频',
  PLAY_TIMEOUT: '播放超时',
  SENSE_DISABLED: '感官关着',
  DESKTOP_CAMERA_NO_FFMPEG: '没有 ffmpeg',
  DESKTOP_CAMERA_NO_DEVICE: '没找到摄像头',
  DESKTOP_CAMERA_BUSY: '上一次还没结束',
  DESKTOP_CAMERA_TIMEOUT: '摄像头没出图',
  PERMISSION_DENIED: '权限没开'
};

function aliveCodeText(code) {
  const k = String(code || '');
  if (!k) return '';
  return ALIVE_CODE_TEXT[k] || k;
}

function aliveApi() {
  const api = window.diecloud;
  if (!api || typeof api.aliveStatus !== 'function') return null;
  return api;
}

function aliveHint(text, kind) {
  const el = $('alive-hint');
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.remove('show', 'ok', 'warn');
  if (kind === 'ok') el.classList.add('ok', 'show');
  else if (kind === 'bad') el.classList.add('warn', 'show');
  else if (text) el.classList.add('show');
}

/** 一行说明文字：`kind` 为 `bad` 时红字（感官"勾着但不可用"就靠这一条被看见） */
function aliveNoteText(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.remove('warn', 'ok');
  if (!text) return;
  if (kind === 'bad') el.classList.add('warn');
  else if (kind === 'ok') el.classList.add('ok');
}

function aliveFmtDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** token 数按人读的方式缩写（它花的是同一份账单，别让用户自己数零） */
function aliveFmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return `${(v / 1000).toFixed(1)}k`;
  // 额度调到 1 亿之后 "100.00M" 不好读，中文场景直接说亿
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  return `${(v / 1000000).toFixed(2)}M`;
}

/* ───────────── 趋势曲线（内联 SVG，不引图表库）───────────── */

const ALIVE_TREND_W = 100;
/** 相位色条单独占底部一行（不再当整幅底色），曲线区 + 空隙 + 色条 = 总高 */
const ALIVE_TREND_STRIP_H = 3;
const ALIVE_TREND_STRIP_GAP = 3;
const ALIVE_TREND_PLOT_H = 34;
const ALIVE_TREND_H = ALIVE_TREND_PLOT_H + ALIVE_TREND_STRIP_GAP + ALIVE_TREND_STRIP_H;
const ALIVE_TREND_PAD = 3;

/** 采样序号 → 横坐标（首尾贴边，中间等距） */
function aliveTrendX(index, count) {
  if (count <= 1) return ALIVE_TREND_PAD;
  return ALIVE_TREND_PAD + (index * (ALIVE_TREND_W - ALIVE_TREND_PAD * 2)) / (count - 1);
}

/** 0–100 的体征值 → 纵坐标（上高下低；只算曲线区，色条不参与） */
function aliveTrendY(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return ALIVE_TREND_PLOT_H - ALIVE_TREND_PAD - (v / 100) * (ALIVE_TREND_PLOT_H - ALIVE_TREND_PAD * 2);
}

function aliveTrendPath(samples, key) {
  return samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${aliveTrendX(i, samples.length).toFixed(2)},${aliveTrendY(s[key]).toFixed(2)}`)
    .join(' ');
}

/**
 * 相位色条：连续同相位的采样合成一段（底部长条里一眼看出它什么时候在压缩）。
 *
 * 首段贴左边界、末段贴右边界 —— 否则末段按 `to + 1` 取样会停在倒数第二个 x 上，
 * 右端留一条空白缝（看起来像图被截断了）。
 */
function aliveTrendBands(samples) {
  const bands = [];
  for (let i = 0; i < samples.length; i += 1) {
    const phase = String(samples[i].phase || '');
    const last = bands[bands.length - 1];
    if (last && last.phase === phase) {
      last.to = i;
      continue;
    }
    bands.push({ phase, from: i, to: i });
  }
  const y = ALIVE_TREND_PLOT_H + ALIVE_TREND_STRIP_GAP;
  return bands.map((b) => {
    const x1 = b.from === 0 ? 0 : aliveTrendX(b.from, samples.length);
    const x2 = b.to >= samples.length - 1 ? ALIVE_TREND_W : aliveTrendX(b.to + 1, samples.length);
    const w = Math.max(0.4, x2 - x1);
    const label = ALIVE_PHASE_TEXT[b.phase] || b.phase || '—';
    return (
      `<rect class="alive-trend-band alive-phase-${String(b.phase || '').toLowerCase()}"` +
      ` x="${x1.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${ALIVE_TREND_STRIP_H}">` +
      `<title>${label}</title></rect>`
    );
  });
}

/**
 * 末端读数点。
 *
 * 为什么不是 `<circle>`：整条曲线是 `preserveAspectRatio="none"` 拉伸出来的（宽度随窗口变、
 * 高度固定 54px），圆点会被横向拉成一根黑长条 —— 肉眼看到的就是「后面两个黑色的东西」。
 * 零长度线段 + 圆头 + `non-scaling-stroke`：屏幕直径恒定、宽度怎么变都是正圆。
 */
function aliveTrendEndDot(x, y, cls) {
  return `<path class="alive-trend-dot ${cls}" d="M${x.toFixed(2)},${y.toFixed(2)}h0.01" />`;
}

/** 曲线区中间那条 50 参考线（两条线都贴着底部时，没有它看不出 30 是哪一个高度） */
function aliveTrendMidLine() {
  const y = aliveTrendY(50).toFixed(2);
  return `<line class="alive-trend-grid" x1="0" y1="${y}" x2="${ALIVE_TREND_W}" y2="${y}" />`;
}

/**
 * 把 `alive:history` 的采样画成一条曲线（张力 + 疲劳 + 底部相位条）。
 *
 * 为什么手写 SVG 而不引图表库：只需要两条折线和一条色条，库的体积与升级成本都不值；
 * renderer 里已有 `<svg>` 的写法（rail 图标、气泡折线）。
 */
function buildAliveTrendSvg(payload) {
  const samples = Array.isArray(payload && payload.samples) ? payload.samples : [];
  if (samples.length < 2) return '';
  const last = samples[samples.length - 1];
  const lx = aliveTrendX(samples.length - 1, samples.length);
  return (
    `<svg class="alive-trend-svg" viewBox="0 0 ${ALIVE_TREND_W} ${ALIVE_TREND_H}"` +
    ` preserveAspectRatio="none" role="img" aria-label="体征趋势">` +
    aliveTrendMidLine() +
    aliveTrendBands(samples).join('') +
    `<path class="alive-trend-line alive-trend-tension" d="${aliveTrendPath(samples, 'tension')}" />` +
    `<path class="alive-trend-line alive-trend-fatigue" d="${aliveTrendPath(samples, 'fatigue')}" />` +
    aliveTrendEndDot(lx, aliveTrendY(last.tension), 'alive-trend-tension') +
    aliveTrendEndDot(lx, aliveTrendY(last.fatigue), 'alive-trend-fatigue') +
    `</svg>`
  );
}

/** 悬浮读数：把指针位置换算成采样序号，把那一刻的四个数写进一行文字 */
function aliveTrendPointAt(svg, clientX) {
  const samples = svg && svg.__aliveSamples;
  if (!Array.isArray(samples) || !samples.length) return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return null;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  // 注意 preserveAspectRatio=none：横向拉伸是线性的，直接按比例取序号即可
  const idx = Math.round(ratio * (samples.length - 1));
  return samples[idx] || null;
}

function mountAliveTrend(container, payload) {
  if (!container) return;
  const samples = Array.isArray(payload && payload.samples) ? payload.samples : [];
  if (samples.length < 2) {
    container.textContent = '还没有足够的样本（心跳跑满两跳后才会有曲线）';
    container.classList.add('alive-trend-empty');
    return;
  }
  container.classList.remove('alive-trend-empty');
  container.innerHTML = buildAliveTrendSvg(payload);
  const svg = container.querySelector('svg');
  if (!svg) return;
  svg.__aliveSamples = samples;
  if (!svg.dataset.bound) {
    svg.dataset.bound = '1';
    svg.addEventListener('pointermove', (ev) => {
      const s = aliveTrendPointAt(svg, ev.clientX);
      if (!s) return;
      aliveNoteText(
        'alive-trend-note',
        `${fmtClock(s.ts)} · ${ALIVE_PHASE_TEXT[s.phase] || s.phase || '—'}` +
          ` · 张力 ${Number(s.tension || 0).toFixed(1)}` +
          ` · 疲劳 ${Number(s.fatigue || 0).toFixed(1)}` +
          ` · 今日 token ${aliveFmtTokens(s.tokenToday)}`,
        null
      );
    });
    svg.addEventListener('pointerleave', () => {
      const samples2 = svg.__aliveSamples || [];
      const first = samples2[0];
      const last = samples2[samples2.length - 1];
      if (!first || !last) return;
      const max = (key) => samples2.reduce((m, s) => Math.max(m, Number(s[key]) || 0), 0);
      aliveNoteText(
        'alive-trend-note',
        `窗口 ${aliveFmtDuration(Number(last.ts) - Number(first.ts))}：` +
          `张力 ${Number(first.tension || 0).toFixed(1)} → ${Number(last.tension || 0).toFixed(1)}（峰 ${max('tension').toFixed(1)}）` +
          ` · 疲劳 ${Number(first.fatigue || 0).toFixed(1)} → ${Number(last.fatigue || 0).toFixed(1)}（峰 ${max('fatigue').toFixed(1)}）`,
        null
      );
    });
  }
}

function aliveDecisionText(evt) {
  const decision = String((evt && evt.decision) || '');
  if (decision === 'ACT') return '做（ACT）';
  if (decision === 'DEFER') return '先放下（DEFER）';
  if (decision === 'REFUSE') return '决定不做（REFUSE）';
  return decision || '—';
}

function aliveSenseInput(name) {
  return $(`alive-sense-${name}`);
}

function renderAliveSenses(status) {
  const st = status && typeof status === 'object' ? status : null;
  const s = (st && st.senses) || { drawer: false, eyes: false, voice: false };
  for (const key of ALIVE_SENSE_KEYS) {
    const el = aliveSenseInput(key);
    if (!el) continue;
    if (document.activeElement === el) continue;
    el.checked = s[key] === true;
  }
  const spontaneous = $('alive-sense-voice-spontaneous');
  if (spontaneous && document.activeElement !== spontaneous) {
    spontaneous.checked = !!(st && st.voiceSpontaneous);
  }
  renderAliveLook(st);
  renderAliveModel(st);
  renderAlivePower(st);
}

/**
 * 权力档的展示文案（**唯一来源**）：下拉选项与「当前：…」提示都从这份拼。
 *
 * `level` 就是"等级级别"：三档一眼看出高低，不用比两句描述谁更长。
 * 档位枚举本身在 `src/alive/store.js#WAKE_POWERS`（`read` / `write` / `exec`），
 * 这里只加人话——**别在别处再写一份档名**（提示里说"2 级"、下拉里说"可改文件"就是漂移）。
 */
const ALIVE_POWER_TIERS = [
  {
    value: 'read',
    level: '1 级',
    name: '只读（默认）',
    desc: '能读、能看、能听、能说、能写自己的抽屉，不动别的文件'
  },
  {
    value: 'write',
    level: '2 级',
    name: '可改文件',
    desc: '只能在下面那个目录里改，每轮有次数上限'
  },
  {
    value: 'exec',
    level: '3 级',
    name: '可改文件 + 跑命令 + 联网',
    desc: '只能在那个目录里动手，改动 / 命令各有每轮上限'
  }
];

/** 某一档的"级别 · 档名"（提示文字与选项标题同一份说法） */
function alivePowerTierText(value) {
  const tier = ALIVE_POWER_TIERS.find((t) => t.value === String(value || '')) || ALIVE_POWER_TIERS[0];
  return `${tier.level} · ${tier.name}`;
}

/**
 * 「它醒来能做什么」：`read`（默认）/ `write` / `exec` 三档 + 允许动的根目录。
 *
 * 为什么不是权限页那种"两道锁"：执行权是**另一个量级**的东西（它会在你不在时真的改文件、
 * 跑命令、出网），所以做成显式档位，并把"改了哪里"的账落在决策日志里（`ACTION` 事件）。
 * 页面只显示事实：档位（1 / 2 / 3 级）、根目录是否存在、每轮次数上限。
 */
function renderAlivePower(status) {
  const st = status && typeof status === 'object' ? status : null;
  const power = String((st && st.wakePower) || 'read');
  const caps = (st && st.capabilities && st.capabilities.power) || null;
  const el = $('alive-wake-power');
  // 选项标题也带级别：拉下来先看到"几级"，再看这一档能做什么
  const items = ALIVE_POWER_TIERS.map((t) => ({
    value: t.value,
    label: `${t.level} · ${t.name} — ${t.desc}`
  }));
  if (el) {
    const sig = items.map((it) => `${it.value}\u0001${it.label}`).join('\n');
    if (el.dataset.sig !== sig) {
      el.innerHTML = items
        .map((it) => `<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`)
        .join('');
      el.dataset.sig = sig;
    }
    if (document.activeElement !== el) el.value = power;
  }
  const root = String((caps && caps.root) || '');
  const missingRoot = !!(caps && caps.level !== 'read' && !caps.rootExists);
  const tierText = alivePowerTierText(power);
  aliveNoteText(
    'alive-wake-power-hint',
    !st
      ? ''
      : power === 'read'
        ? `${tierText}：它醒来能读文件、看一眼、说一句、往自己的抽屉写一行 —— 不会改你的任何东西。`
        : `当前：${tierText}${power === 'exec' ? '（web_search / web_fetch 都在这一档）' : ''}。它会在你不在时**真的动手**，` +
          '每次改动/命令都会记进「拟态 → 日志」（改了哪个文件、跑了哪条命令）；' +
          '越出根目录、超次数、需要你当场同意的操作都会被直接拒（后台不排队等审批）。',
    power === 'read' ? null : 'bad'
  );
  const rootInput = $('alive-wake-root');
  if (rootInput && st && document.activeElement !== rootInput) {
    const stored = String(st.wakeWorkspace || '');
    // 框里不是"上一次和磁盘对齐的那一份"→ 是还没存的草稿，留着（别把用户刚打的路径刷回去）
    if (String(rootInput.value || '') === aliveUi.rootSynced) {
      rootInput.value = stored;
      aliveUi.rootSynced = stored;
    }
  }
  aliveNoteText(
    'alive-wake-root-hint',
    !st
      ? ''
      : missingRoot
        ? `根目录不存在或不可用：${root} —— 这一档现在动不了任何文件，点「选择…」换个目录或先把它建好。`
        : `实际生效的根：${root || '(未知)'}${caps && caps.customRoot ? '' : '（默认：它自己的抽屉）'}`,
    missingRoot ? 'bad' : null
  );
}

/**
 * 「它用哪个模型」：唤醒轮绑定的路由（空 = 跟随机型设置里的默认文本模型）。
 *
 * 选项枚举复用 `listSelectableModelRoutes()`（与定时计划编辑器同一份，见
 * renderer-model-runtime.js）：语音模型不接受 chat 请求，这里不能让它出现在选项里。
 */
function renderAliveModel(status) {
  const st = status && typeof status === 'object' ? status : null;
  const el = $('alive-model-route');
  const want = String((st && st.modelRoute) || '');
  const options = typeof listSelectableModelRoutes === 'function' ? listSelectableModelRoutes() : [];
  const items = [{ value: '', label: '跟随默认（Auto）' }].concat(
    options.map((o) => ({ value: String(o.route || ''), label: String(o.label || o.model || o.route) }))
  );
  // 绑定的模型被删/禁用：保留原值并标注，别静默改回"跟随默认"（那会让它偷偷换脑子）
  if (want && !items.some((it) => it.value === want)) {
    items.push({ value: want, label: `原绑定（当前不可选）：${want}` });
  }
  if (el) {
    const sig = items.map((it) => `${it.value}\u0001${it.label}`).join('\n');
    if (el.dataset.sig !== sig) {
      el.innerHTML = items
        .map((it) => `<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`)
        .join('');
      el.dataset.sig = sig;
    }
    if (document.activeElement !== el) el.value = want;
  }
  const label = String((st && st.modelLabel) || '').trim();
  const vision = !!(st && st.modelVision);
  const lookOn = !!(st && (st.wakeLookCamera || st.wakeLookScreen));
  const missing = !!want && !label;
  aliveNoteText(
    'alive-model-hint',
    !st
      ? ''
      : missing
        ? `绑定的模型现在解析不到（${want}）：可能被删或停用了。唤醒轮会明确失败并记一条 WAKE_ERROR —— 换一个，或选回「跟随默认」。`
        : `${want ? `唤醒轮用 ${label}` : `跟随默认（现在解析到 ${label || '未知'}）`}` +
          ` · ${vision ? '能看图' : '只能读文字'}` +
          (lookOn && !vision
            ? '：看图开关开着，但这个模型没标成「全模态」，醒来时不会给图（会在状态里写明）。'
            : ''),
    missing || (lookOn && !vision) ? 'bad' : null
  );
}

/**
 * 「醒来时先看一眼」的两个开关 + 各自还差什么。
 *
 * 缺件必须写出来（和 `renderAliveCapabilities` 同一套语义）：勾着但取不到图，
 * 用户只会看到"它从来不说话/不看"，却不知道为什么。
 */
function renderAliveLook(status) {
  const st = status && typeof status === 'object' ? status : null;
  const look = (st && st.capabilities && st.capabilities.look) || null;
  const camEl = $('alive-wake-look-camera');
  if (camEl && document.activeElement !== camEl) camEl.checked = !!(st && st.wakeLookCamera);
  const screenEl = $('alive-wake-look-screen');
  if (screenEl && document.activeElement !== screenEl) screenEl.checked = !!(st && st.wakeLookScreen);
  const eyesOn = !!(st && st.senses && st.senses.eyes);
  aliveNoteText(
    'alive-wake-look-camera-hint',
    !look
      ? '读不到权限状态（旧版主进程？）'
      : !eyesOn
        ? '还差：「眼睛」这个感官要一起打开。'
        : !look.desktopCameraPermission
          ? '还差：「设置 → 权限 → 本机摄像头」没打开。'
          : (st && st.wakeLookCamera
              ? '会用它自己醒来那一刻的一帧（画面不落盘）。'
              : '打开后，它每次醒来都会先看一眼现场。'),
    look && st && st.wakeLookCamera && (!eyesOn || !look.desktopCameraPermission) ? 'bad' : null
  );
  aliveNoteText(
    'alive-wake-look-screen-hint',
    !look
      ? ''
      : !look.osControlPermission
        ? '还差：「设置 → 权限 → 电脑控制」没打开（截屏与 computer 工具同一份授权）。'
        : (st && st.wakeLookScreen
            ? '会截主屏一张（画面不落盘；屏幕内容会随这一轮发给模型）。'
            : '打开后，它每次醒来都会截主屏一张。'),
    look && st && st.wakeLookScreen && !look.osControlPermission ? 'bad' : null
  );
}

/** 感官能力自检：勾着但缺件必须红字说出来（"勾着但说不出一句话"是最伤的体验断点） */
function renderAliveCapabilities(status) {
  const st = status && typeof status === 'object' ? status : null;
  const caps = st && st.capabilities ? st.capabilities : null;
  const voiceOn = !!(st && st.senses && st.senses.voice);

  /** 嘴与耳 */
  const voice = caps && caps.voice ? caps.voice : null;
  if (!voiceOn) {
    aliveNoteText('alive-voice-cap', '', null);
  } else if (!voice) {
    aliveNoteText('alive-voice-cap', '读不到语音能力（旧版主进程？）', 'bad');
  } else if (voice.ok) {
    aliveNoteText(
      'alive-voice-cap',
      `依赖齐了：${voice.hasFfmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗'} · ${voice.hasFfplay ? 'ffplay ✓' : 'ffplay ✗'} · 转写 ✓ · 合成 ✓`,
      'ok'
    );
  } else {
    aliveNoteText('alive-voice-cap', `嘴与耳现在用不了：${voice.problems.map((p) => p.text).join(' ')}`, 'bad');
  }

  /** 主动开口的配额 */
  const quotaEl = $('alive-voice-quota');
  if (quotaEl) {
    const allowed = !!(st && st.voiceSpontaneous);
    const used = Number(st && st.voiceCountToday) || 0;
    const max = Number(st && st.voiceMaxPerDay) || 0;
    const last = Number(st && st.lastVoiceAt) || 0;
    // 间隔也从 status 读（`agent-limits.aliveVoiceMinIntervalMs` 是唯一来源）：
    // 以前这里写死「至少 30 分钟」，改了上限文案就对不上了
    const gapMin = Math.max(0, Math.round((Number(st && st.voiceMinIntervalMs) || 0) / 60000));
    quotaEl.textContent = allowed
      ? `已允许：今天主动开口 ${used}/${max} 次${last ? ` · 上次 ${fmtClock(last)}` : ''}${gapMin ? `（两次之间至少 ${gapMin} 分钟）` : ''}`
      : '现在关着：它不会在没人说话时突然出声或开麦。';
  }

  /** 眼睛 */
  const eyes = caps && caps.eyes ? caps.eyes : null;
  const eyesOn = !!(st && st.senses && st.senses.eyes);
  if (!eyesOn) {
    aliveNoteText('alive-eyes-cap', '', null);
  } else if (!eyes) {
    aliveNoteText('alive-eyes-cap', '读不到摄像头授权状态（旧版主进程？）', 'bad');
  } else if (!eyes.cameraPermission && !eyes.desktopCameraPermission) {
    aliveNoteText(
      'alive-eyes-cap',
      '待授权：「设置 → 权限」里的「手机摄像头」和「本机摄像头」都关着，所以它其实看不到（两道锁）。',
      'bad'
    );
  } else {
    const which = [eyes.cameraPermission ? '手机摄像头' : '', eyes.desktopCameraPermission ? '本机摄像头' : '']
      .filter(Boolean)
      .join(' / ');
    aliveNoteText('alive-eyes-cap', `已授权：${which}`, 'ok');
  }
}

/**
 * 「设定」页：**一个框**，用户随心写（人生目标 / 遇到人怎么反应 / 想聊什么…）。
 *
 * 为什么和「生命」分开：那边是**它现在怎么样**（体征 / 感官 / 权力，全是数字和开关），
 * 这边是你写给它的一段话。这段原文只进后台心跳轮的状态块，不改你在对话里用的系统提示。
 *
 * 两条约定：
 * 1. 用户正在打字时（`document.activeElement` 是那个框）不覆盖它 —— 别把人打到一半的字打回去。
 * 2. **没保存的草稿也不覆盖**：`aliveUi.setupSynced` 记着"框里这一份是不是已经等于磁盘上的那一份"。
 *    不等于 = 用户改过还没落盘 —— 这时任何一次状态刷新（切页签、5s 轮询、在「生命」页拨开关
 *    都会走到 `renderAliveStatus`）都必须让路，否则切走再切回来就是空的（2026-11-15 的丢内容问题）。
 * 3. 页面不显示字数计数器 / 说明文案：上限（`agent-limits.aliveSetupMaxChars`）只有保存时
 *    真的截断了才报一句，平时一个字都不多写。
 */
function renderAliveSetup(status) {
  const st = status && typeof status === 'object' ? status : null;
  // 读不到状态（切开关失败等）时**不动**文本框：宁可留着用户刚打的字，也不要清空
  const el = $('alive-setup');
  if (!st || !el) return;
  if (document.activeElement === el) return;
  const stored = String(st.setup || '');
  // 框里不是"上一次和磁盘对齐的那一份"→ 是还没保存的草稿，留着
  if (String(el.value || '') !== aliveUi.setupSynced) return;
  el.value = stored;
  aliveUi.setupSynced = stored;
}

/** 保存「设定」（走 `alive:set-option` 这条既有写入口，不另开 IPC） */
async function saveAliveSetup() {
  const api = aliveApi();
  const el = $('alive-setup');
  if (!api || typeof api.aliveSetOption !== 'function') {
    aliveNoteText('alive-setup-hint', '当前界面没有生命感的 IPC（旧版主进程？）', 'bad');
    return;
  }
  const typed = el ? String(el.value || '') : '';
  // 与磁盘上那一份逐字相同 = 没有可存的改动（失焦也会走到这里，不必每次失焦都报一句「已保存」）
  if (typed === aliveUi.setupSynced) return;
  // 已有一次保存在飞：记住"回来还得再存一版"，绝不静默丢掉这一次输入
  if (aliveUi.setupSaving) {
    aliveUi.setupPending = true;
    return;
  }
  aliveUi.setupSaving = true;
  try {
    const res = await api.aliveSetOption({ name: 'setup', value: typed });
    if (!res || !res.ok) {
      aliveNoteText('alive-setup-hint', (res && res.error) || '保存失败', 'bad');
      await refreshAliveStatus();
      return;
    }
    const stored = String((res.status && res.status.setup) || '');
    aliveUi.setupSynced = stored;
    if (res.status) renderAliveStatus(res.status);
    // 写入侧会 trim + 截断：把框也对齐成**真正存下来的那一份**，否则框里永远"看起来还没保存"
    if (el && document.activeElement !== el) el.value = stored;
    // 有没有被截断：只比长度（写入侧会 trim + 截断），不猜内容
    const truncated = typed.trim().length > stored.length;
    aliveNoteText(
      'alive-setup-hint',
      truncated ? '已保存（超出字数上限的部分已截掉）' : '已保存',
      truncated ? 'bad' : 'ok'
    );
  } catch (err) {
    aliveNoteText('alive-setup-hint', `保存失败：${(err && err.message) || err}`, 'bad');
  } finally {
    aliveUi.setupSaving = false;
    if (aliveUi.setupPending) {
      aliveUi.setupPending = false;
      saveAliveSetup();
    }
  }
}

/**
 * 「输入停顿就存」：本页两个**手打文本框**（允许动的根目录 / 设定）共用的那一条。
 *
 * 为什么不只挂 `change`（下拉与开关用的那个时机）：它靠"失焦"触发，而打完字按 Esc 关设置框、
 * 直接切窗口、点页签外的空白处都不会发 `change` —— 那一次输入就静默没了
 * （2026-11-15 实测：日志里连 `[alive] 唤醒轮工作区：` 都没出现过，说明请求从没发出去）。
 * 所以三个时机都指向同一个 save：输入停顿 / 失焦 / 回车；按钮与「选择…」也调同一个 save。
 */
function aliveSaveOnIdle(input, save) {
  if (!input) return;
  const flushTimer = () => {
    if (input.__aliveSaveTimer) {
      clearTimeout(input.__aliveSaveTimer);
      input.__aliveSaveTimer = null;
    }
  };
  input.addEventListener('input', () => {
    flushTimer();
    input.__aliveSaveTimer = setTimeout(() => {
      input.__aliveSaveTimer = null;
      save();
    }, ALIVE_TEXT_SAVE_DELAY_MS);
  });
  input.addEventListener('change', () => {
    flushTimer();
    save();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    flushTimer();
    save();
  });
}

/**
 * 保存「允许它动的根目录」（走同一条 `alive:set-option`，主进程侧不动文件系统）。
 *
 * 语义只有一份：存进去的是**框里此刻的文字**，存完把框对齐成**磁盘上真正的那一份**
 * （写入侧会 trim + 截断）。失败时保留草稿不覆盖 —— 宁可下次再存，也不要换回旧值。
 */
async function saveAliveRoot() {
  const el = $('alive-wake-root');
  if (!el) return;
  const typed = el.value.trim();
  // 与磁盘上那一份相同 = 没有可存的改动（失焦与防抖都会走到这里，不必每次都发一次 IPC）
  if (typed === aliveUi.rootSynced) return;
  const res = await setAliveOption('wakeWorkspace', typed);
  if (!res || res.ok !== true) return;
  const stored = String((res.status && res.status.wakeWorkspace) || '');
  aliveUi.rootSynced = stored;
  if (document.activeElement !== el) el.value = stored;
}

function renderAliveNote(text) {
  const body = String(text || '').trim();
  aliveWriteText(['alive-note', 'alive-pane-note'], body || '（还没有写东西）', null);
  // 侧栏那一段的角标：只数非空行（"它写过几行"），不解析内容
  const lines = body ? body.split('\n').filter((line) => line.trim()).length : 0;
  aliveWriteText(['alive-pane-note-meta'], lines ? `${lines} 行` : '', null);
}

async function refreshAliveNote() {
  const api = aliveApi();
  if (!api || typeof api.aliveNote !== 'function') return;
  try {
    const res = await api.aliveNote();
    if (res && res.ok) renderAliveNote(res.text);
  } catch {
    // 抽屉读失败只影响这一块
  }
}

/** 设备下拉：`默认（自动挑）` + 枚举到的设备；value 与设置里的选择对齐 */
function fillDeviceSelect(id, devices, selected, emptyText) {
  const el = $(id);
  if (!el) return;
  const list = Array.isArray(devices) ? devices.filter(Boolean) : [];
  const cur = String(selected || '');
  el.textContent = '';
  const optDefault = document.createElement('option');
  optDefault.value = '';
  optDefault.textContent = list.length ? `默认（自动挑：${list[0]}）` : emptyText || '默认（自动挑）';
  el.appendChild(optDefault);
  for (const name of list) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.appendChild(opt);
  }
  // 选过的设备可能已经拔掉了：仍然显示出来，否则用户会以为"设置丢了"
  if (cur && !list.includes(cur)) {
    const opt = document.createElement('option');
    opt.value = cur;
    opt.textContent = `${cur}（未找到）`;
    el.appendChild(opt);
  }
  el.value = cur;
  if (document.activeElement === el) el.blur();
}

function renderAliveDevices(info) {
  const d = info && typeof info === 'object' ? info : {};
  fillDeviceSelect('alive-mic-device', d.audio, d.micDevice, '没有枚举到麦克风（先确认 ffmpeg）');
  fillDeviceSelect('alive-camera-device', d.video, d.cameraDevice, '没有枚举到摄像头');
}

async function refreshAliveDevices(force) {
  const api = aliveApi();
  if (!api || typeof api.aliveDevices !== 'function') return;
  if (aliveUi.devicesLoading) return;
  if (!force && aliveUi.devicesLoaded) return;
  aliveUi.devicesLoading = true;
  try {
    const res = await api.aliveDevices();
    if (res && res.ok) {
      renderAliveDevices(res);
      aliveUi.devicesLoaded = true;
    } else {
      aliveHint((res && res.error) || '枚举设备失败', 'bad');
    }
  } catch (err) {
    aliveHint(`枚举设备失败：${(err && err.message) || err}`, 'bad');
  } finally {
    aliveUi.devicesLoading = false;
  }
}

/**
 * 写一个设置项（`alive:set-option` 的唯一调用点）。
 *
 * 返回 IPC 结果：调用方（根目录框）要拿 `res.status.wakeWorkspace` 把"框里这份 = 磁盘那份"
 * 对齐，否则它会以为永远还有个没存的草稿。
 */
async function setAliveOption(name, value) {
  const api = aliveApi();
  if (!api || typeof api.aliveSetOption !== 'function') return null;
  try {
    const res = await api.aliveSetOption({ name, value });
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '保存失败', 'bad');
      await refreshAliveStatus();
      return res || null;
    }
    if (res.status) renderAliveStatus(res.status);
    aliveHint('已保存', 'ok');
    return res;
  } catch (err) {
    aliveHint(`保存失败：${(err && err.message) || err}`, 'bad');
    return null;
  }
}

async function setAliveSense(name, enabled) {
  const api = aliveApi();
  if (!api || typeof api.aliveSetSense !== 'function') return;
  try {
    const res = await api.aliveSetSense({ name, enabled: !!enabled });
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '切换失败', 'bad');
      await refreshAliveStatus();
      return;
    }
    if (res.status) renderAliveStatus(res.status);
    else renderAliveSenses(res.senses);
    aliveHint(enabled ? `已打开：${name}` : `已关闭：${name}`, 'ok');
    // 打开感官时把设备清单拉一次：用户下一步就是要挑设备
    if (enabled && (name === 'voice' || name === 'eyes')) await refreshAliveDevices(true);
  } catch (err) {
    aliveHint(`切换失败：${(err && err.message) || err}`, 'bad');
  }
}

/**
 * 同一段文字写到**两个壳**里：设置页（`alive-*`）与侧栏「生命」页（`alive-pane-*`）。
 *
 * 为什么要同一个函数：两处各写一份格式，一周后必然漂移（"设置页说 3 次、侧栏说 2 次"）。
 * 某个壳没打开时对应 id 不存在，跳过即可。
 */
function aliveWriteText(ids, text, kind) {
  const body = String(text || '');
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.textContent = body;
    el.classList.remove('warn', 'ok');
    if (!body) continue;
    if (kind === 'bad') el.classList.add('warn');
    else if (kind === 'ok') el.classList.add('ok');
  }
}

/** 两个壳的根节点（标签切换的作用域；同一套 `data-alive-tab` / `data-alive-pane` 属性） */
const ALIVE_TAB_SHELLS = {
  log: '.settings-page[data-settings="alive-log"]',
  pane: '.side-panel-pane[data-side-pane="alive"]'
};

/**
 * 切一组横向标签（「事件」/「抽屉」）——**只切可见性**。
 *
 * 刻意不做的事：不读数据、不判状态、不排刷新、不记"上次选了哪页"。两个壳
 * （设置 → 拟态 → 日志、侧栏「生命」面板）共用这一份切换逻辑；数据仍由
 * `refreshAliveDecisions` / `refreshAliveNote` 各自填（同一份 IPC、同一份格式）。
 * 选中项就活在 DOM 上（`.active` / `hidden`），刷新只改文本，不会把选择打回去。
 *
 * @param {'log'|'pane'} shell
 * @param {'events'|'note'} tab
 * @returns {'events'|'note'} 实际生效的标签
 */
function applyAliveTab(shell, tab) {
  const next = ALIVE_TABS.includes(tab) ? tab : 'events';
  const root = document.querySelector(ALIVE_TAB_SHELLS[shell] || ALIVE_TAB_SHELLS.log);
  if (!root) return next;
  for (const btn of root.querySelectorAll('[data-alive-tab]')) {
    const on = btn.getAttribute('data-alive-tab') === next;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const pane of root.querySelectorAll('[data-alive-pane]')) {
    pane.hidden = pane.getAttribute('data-alive-pane') !== next;
  }
  // 角标跟着页走：事件说"几条"、抽屉说"几行"，两套口径同时摆出来只会互相打岔
  for (const meta of root.querySelectorAll('[data-alive-meta]')) {
    meta.hidden = meta.getAttribute('data-alive-meta') !== next;
  }
  return next;
}

/** 点标签（事件委托：两个壳共用一条监听，壳没打开时点到也不会有副作用） */
function onAliveTabClick(ev) {
  const target = ev && ev.target;
  if (!target || typeof target.closest !== 'function') return;
  const btn = target.closest('[data-alive-tab]');
  if (!btn) return;
  const shell = btn.closest(ALIVE_TAB_SHELLS.pane) ? 'pane' : btn.closest(ALIVE_TAB_SHELLS.log) ? 'log' : null;
  if (!shell) return;
  applyAliveTab(shell, btn.getAttribute('data-alive-tab'));
}

/** 一行摘要（相位 / 心跳 / 上次心跳时间） */
function aliveStatusHead(st) {
  if (!st || (!st.exists && !st.enabled)) return '未启用（打开上面的开关才会开始跳动）';
  if (!st.exists) return '已启用，尚未产生第一次心跳';
  const phase = ALIVE_PHASE_TEXT[st.phase] || st.phase;
  const runningText = st.running ? '跳动中' : '已停表';
  const lastTick = fmtClock(st.lastTickAt);
  return (
    `${runningText} · 相位 ${phase}（已 ${aliveFmtDuration(Date.now() - Number(st.phaseEnteredAt || Date.now()))}）` +
    ` · 第 ${st.tickCount} 次心跳${lastTick ? `（上次 ${lastTick}）` : ''}`
  );
}

/** 体征数字行（张力 / 疲劳 / 未闭合 / 今日唤醒 / 决策计数 / 成本） */
function aliveStatusDetail(st) {
  if (!st || !st.exists) return '';
  const lastWakeTokens = Number(st.lastWakeTokens || 0);
  const lastWakeMs = Number(st.lastWakeDurationMs || 0);
  const lastWakeText = lastWakeTokens || lastWakeMs
    ? ` · 上次醒来 ${lastWakeTokens ? `${aliveFmtTokens(lastWakeTokens)} token` : ''}${lastWakeTokens && lastWakeMs ? ' / ' : ''}${lastWakeMs ? `${(lastWakeMs / 1000).toFixed(1)}s` : ''}`
    : '';
  return (
    `张力 ${Number(st.tension || 0).toFixed(1)} / 阈值 ${Number(st.wakeThreshold || 0).toFixed(1)}` +
    ` · 疲劳 ${Number(st.fatigue || 0).toFixed(1)}` +
    ` · 未闭合 ${Number(st.loops || 0)} 条` +
    ` · 今日唤醒 ${Number(st.wakeCountToday || 0)}/${Number(st.wakeMaxPerDay || 0)}` +
    ` · 做 ${Number(st.actCount || 0)} / 放下 ${Number(st.deferCount || 0)} / 拒 ${Number(st.refuseCount || 0)}` +
    ` · 今日 token ${aliveFmtTokens(st.tokenToday)}/${Number(st.dailyTokenBudget) > 0 ? aliveFmtTokens(st.dailyTokenBudget) : '不限'}` +
    ` · 累计 ${aliveFmtTokens(st.totalTokens)}` +
    lastWakeText
  );
}

/** 额度解释（到线 / 接近 / 正常时为空） */
function aliveBudgetNote(st) {
  if (!st || !st.exists) return { text: '', kind: null };
  const budget = Number(st.dailyTokenBudget) || 0;
  const usedToday = Number(st.tokenToday) || 0;
  if (budget > 0 && usedToday >= budget) {
    return {
      text:
        `今日 token 额度已用完（${aliveFmtTokens(usedToday)}/${aliveFmtTokens(budget)}）：它今天不会再自发醒来，` +
        '0 点自动重置。要放宽就改 `agent-limits.js` 的 `aliveDailyTokenBudget`（不在设置页开放旋钮）。',
      kind: 'bad'
    };
  }
  if (budget > 0 && usedToday >= budget * 0.8) {
    return {
      text: `今日 token 已用 ${aliveFmtTokens(usedToday)}/${aliveFmtTokens(budget)}：快到额度了，用完后它会停到明天。`,
      kind: null
    };
  }
  return { text: '', kind: null };
}

/** 疲劳解释（到线 / 接近 / 正常时为空） */
function aliveFatigueNote(st) {
  if (!st || !st.exists) return { text: '', kind: null };
  const fatigue = Number(st.fatigue || 0);
  const fatigueHigh = Number(st.fatigueHigh || 0);
  const settle = Number(st.fatigueSettlePerHour || 0);
  if (fatigueHigh > 0 && fatigue >= fatigueHigh) {
    return {
      text:
        `疲劳 ${fatigue.toFixed(1)} 已到顶线（≥${fatigueHigh}：进「压缩」相位，暂停自发唤醒）。` +
        `它只按**自己唤醒轮**用掉的 token 累加，静息每小时回落 ${settle.toFixed(0)}；` +
        '你和它聊天不再算它的疲劳。',
      kind: 'bad'
    };
  }
  if (fatigueHigh > 0 && fatigue >= fatigueHigh * 0.8) {
    return {
      text: `疲劳 ${fatigue.toFixed(1)} 接近顶线 ${fatigueHigh}：再醒几次就会进压缩相位（停一会儿再醒）。`,
      kind: null
    };
  }
  return { text: '', kind: null };
}

/** 唤醒落点说明（有会话时为空） */
function aliveSessionNote(st) {
  if (!st || !st.exists) {
    return st && st.enabled && !st.sessionId
      ? '还没有绑定的会话：第一次唤醒时会自建一个专属会话（标题「生命体征（后台心跳）」），不占用你的对话线。'
      : '';
  }
  return st.sessionId
    ? ''
    : '还没有绑定的会话：第一次唤醒时会自建一个专属会话（标题「生命体征（后台心跳）」），不占用你的对话线。';
}

const ALIVE_STATUS_IDS = {
  head: ['alive-status', 'alive-pane-status'],
  detail: ['alive-detail', 'alive-pane-detail'],
  budget: ['alive-budget-note', 'alive-pane-budget'],
  fatigue: ['alive-fatigue-note', 'alive-pane-fatigue'],
  session: ['alive-session-note', 'alive-pane-session'],
  loops: ['alive-loops', 'alive-pane-loops']
};

/**
 * 主窗口那行「它说 …」/「它醒来写了 …」。
 *
 * 为什么需要：它出声是**说给在场的人听的** —— 人可能不在、可能没听清，那句话就飞了。
 * 所以每次开口在主窗口留一行原文（点「日志」看全部，点 ✕ 收起；下次它再动起来会重新出现）。
 * **只是展示**：不进会话账本、不进模型上下文 —— 它不接管你的对话线。
 *
 * 两件事实、一行展示：说过话显示「它说」，没说过（或那次更旧）显示「它醒来写了」
 * —— 后者补的是"心跳轮不推给界面"：它半夜写的那几万字本来只有它自己看得到。
 *
 * 数据只有一份：`state.json` 的 `lastVoiceText` / `lastVoiceAt` 与 `lastWakeText` /
 * `lastWakeTextAt`（`alive:status` 与 `alive:badge` 都带这四项），所以主窗口这行与
 * 「拟态 → 日志」里那条永远是同一个说法。
 */
function renderAliveSpeech(info) {
  const bar = $('alive-speech-bar');
  const textEl = $('alive-speech-text');
  if (!bar || !textEl) return;
  const said = String((info && info.lastVoiceText) || '').trim();
  const saidAt = Number((info && info.lastVoiceAt) || 0);
  const wrote = String((info && info.lastWakeText) || '').trim();
  const wroteAt = Number((info && info.lastWakeTextAt) || 0);
  const useVoice = !!said && saidAt >= wroteAt;
  const text = useVoice ? said : wrote;
  const at = useVoice ? saidAt : wroteAt;
  const fresh = !!text && at > Number(aliveUi.speechDismissedAt || 0);
  bar.hidden = !fresh;
  if (!fresh) return;
  const when = fmtClock(at);
  const label = useVoice ? '它说' : '它醒来写了';
  textEl.textContent = `${label}${when ? `（${when}）` : ''}：${text}`;
  textEl.title = text;
}

function renderAliveStatus(status) {
  const st = status && typeof status === 'object' ? status : null;
  const enabledEl = $('alive-enabled');
  if (enabledEl && document.activeElement !== enabledEl) {
    enabledEl.checked = !!(st && st.enabled);
  }
  // 主窗口那条「它说…」与这一页同一份事实：打开设置页也顺手刷新一次
  renderAliveSpeech(st);
  renderAliveSenses(st);
  renderAliveCapabilities(st);
  renderAliveSetup(st);

  aliveWriteText(ALIVE_STATUS_IDS.head, aliveStatusHead(st), null);
  aliveWriteText(ALIVE_STATUS_IDS.detail, aliveStatusDetail(st), null);
  const budget = aliveBudgetNote(st);
  aliveWriteText(ALIVE_STATUS_IDS.budget, budget.text, budget.kind);
  const fatigue = aliveFatigueNote(st);
  aliveWriteText(ALIVE_STATUS_IDS.fatigue, fatigue.text, fatigue.kind);
  aliveWriteText(ALIVE_STATUS_IDS.session, aliveSessionNote(st), null);
  aliveWriteText(
    ALIVE_STATUS_IDS.loops,
    st && st.exists && st.suspiciousObedience
      ? '注意：今天醒了多次却一次都没拒绝 —— 从不拒绝的不是活的，是排期表。'
      : '',
    null
  );
}

/** 事件行（设置页与侧栏页共用同一份拼装） */
function aliveEventLines(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  if (!list.length) return '还没有事件。';
  return list
    .slice(-ALIVE_EVENT_LINES)
    .reverse()
    .map((evt) => {
      const kind = String((evt && evt.kind) || '');
      const label = ALIVE_EVENT_TEXT[kind] || kind;
      const parts = [fmtClock(evt && evt.ts), label];
      if (kind === 'DECISION') {
        parts.push(aliveDecisionText(evt));
        if (evt.loopId) parts.push(`关掉 ${evt.loopId}`);
        if (Number(evt.done) > 0) parts.push(`做完收口 ${Number(evt.done)} 条`);
      } else if (kind === 'PHASE') {
        parts.push(`${ALIVE_PHASE_TEXT[evt.from] || evt.from} → ${ALIVE_PHASE_TEXT[evt.to] || evt.to}`);
      } else if (kind === 'WAKE') {
        const busy = Number(evt.load) >= 0.35 ? '（你正在用）' : '';
        parts.push(`张力 ${evt.tension} / 阈值 ${evt.threshold}${busy}`);
      } else if (kind === 'WAKE_END') {
        parts.push(
          [Number(evt.tokens) ? `${aliveFmtTokens(evt.tokens)} token` : '', Number(evt.durationMs) ? `${(Number(evt.durationMs) / 1000).toFixed(1)}s` : '']
            .filter(Boolean)
            .join(' / ') || '—'
        );
      } else if (kind === 'WAKE_NO_DECISION') {
        parts.push('没调用 alive_decide，这一轮白醒了（张力继续累积）');
      } else if (kind === 'WAKE_SKIPPED') {
        parts.push(String(evt.reason || ''));
      } else if (kind === 'WAKE_ERROR') {
        parts.push(String(evt.message || '').slice(0, 80));
      } else if (kind === 'SPEAK') {
        // 原话要能看见：人可能不在、可能没听清 —— 只记"说了 24 字"等于没留证
        const said = String(evt.text || '').trim();
        if (evt.ok && said) parts.push(`说：「${said}」`);
        else if (evt.ok) parts.push(`说了 ${Number(evt.chars) || 0} 字（旧事件只留了字数）`);
        else parts.push(aliveCodeText(evt.errorCode) || '没说出来');
      } else if (kind === 'LISTEN') {
        parts.push(evt.ok ? `听了 ${Number(evt.seconds) || 0} 秒` : aliveCodeText(evt.errorCode) || '没听见');
      } else if (kind === 'EYE') {
        const size = evt.width && evt.height ? `${evt.width}×${evt.height}` : '';
        parts.push(
          evt.ok
            ? `${evt.device || '摄像头'}${size ? ` · ${size}` : ''}`
            : aliveCodeText(evt.errorCode) || '没看到'
        );
      } else if (kind === 'ACTION') {
        // 放开档下它真的动了手：改了哪个文件 / 跑了哪条命令 / 联网看了哪一页，必须能对账
        const tool = String(evt.tool || '');
        const what =
          tool === 'host_exec'
            ? '跑命令'
            : tool === 'web_search' || tool === 'web_fetch'
              ? '联网'
              : tool === 'computer'
                ? '动键鼠'
                : tool.startsWith('browser_')
                  ? '开网页'
                  : '改文件';
        const target = String(evt.target || '').trim();
        const where = target ? `：${target}` : '';
        parts.push(
          evt.ok === false
            ? `${what}失败${where}${evt.errorCode ? ` · ${aliveCodeText(evt.errorCode) || evt.errorCode}` : ''}`
            : `${what}${where}`
        );
      } else if (kind === 'DONE_NO_EVIDENCE') {
        parts.push(
          `说「做完 ${Number(evt.done) || 0} 条」，但这一轮从头到尾它自己没动手、也没自己看过 —— 缺依据（自动睁眼不算）`
        );
      }
      return parts.filter(Boolean).join(' · ');
    })
    .join('\n');
}

function renderAliveDecisions(events) {
  const list = Array.isArray(events) ? events : [];
  aliveWriteText(['alive-decisions', 'alive-pane-events'], aliveEventLines(list), null);
  // 侧栏那一段的角标：口径与 `aliveEventLines` 的 40 行上限一致，别写出一个比列表还大的数
  const shown = Math.min(list.length, ALIVE_EVENT_LINES);
  const newest = list.length ? fmtClock(list[list.length - 1] && list[list.length - 1].ts) : '';
  aliveWriteText(
    ['alive-pane-events-meta'],
    list.length ? `${shown === list.length ? `${list.length} 条` : `最近 ${shown} / 共 ${list.length} 条`}${newest ? ` · 最新 ${newest}` : ''}` : '',
    null
  );
}

async function refreshAliveStatus() {
  const api = aliveApi();
  if (!api) {
    aliveHint('当前界面没有生命感的 IPC（旧版主进程？）', 'bad');
    return;
  }
  if (aliveUi.loading) return;
  aliveUi.loading = true;
  try {
    const res = await api.aliveStatus();
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '读取体征失败', 'bad');
      return;
    }
    renderAliveStatus(res.status);
    aliveHint('');
  } catch (err) {
    aliveHint(`读取体征失败：${(err && err.message) || err}`, 'bad');
  } finally {
    aliveUi.loading = false;
  }
}

async function refreshAliveDecisions() {
  const api = aliveApi();
  if (!api || typeof api.aliveDecisions !== 'function') return;
  try {
    const res = await api.aliveDecisions({ limit: 60 });
    if (res && res.ok) renderAliveDecisions(res.events);
  } catch {
    // 决策日志读失败只影响这一块
  }
}

/** 体征曲线：窗口内抽样后的采样点（数据来自 `alive:history`，写侧只追加） */
async function refreshAliveHistory() {
  const api = aliveApi();
  if (!api || typeof api.aliveHistory !== 'function') return;
  try {
    const res = await api.aliveHistory({ points: 240 });
    if (!res || !res.ok) return;
    // 同一个曲线挂到两个壳（设置页 / 侧栏页）；哪个在就画哪个
    mountAliveTrend($('alive-trend'), res);
    mountAliveTrend($('alive-pane-trend'), res);
    if (Array.isArray(res.samples) && res.samples.length >= 2) {
      const first = res.samples[0];
      const last = res.samples[res.samples.length - 1];
      const summary =
        `窗口 ${aliveFmtDuration(Number(last.ts) - Number(first.ts))}（共 ${Number(res.total) || res.samples.length} 个采样）：` +
        `张力 ${Number(first.tension || 0).toFixed(1)} → ${Number(last.tension || 0).toFixed(1)}` +
        ` · 疲劳 ${Number(first.fatigue || 0).toFixed(1)} → ${Number(last.fatigue || 0).toFixed(1)}` +
        '（悬浮曲线看某一刻）';
      aliveWriteText(['alive-trend-note', 'alive-pane-trend-note'], summary, null);
    }
  } catch {
    // 曲线读失败只影响这一块
  }
}

/** 侧栏「生命」页是否可见（与设置页那个壳共用同一份轮询） */
function aliveSidePaneVisible() {
  const pane = document.querySelector('.side-panel-pane[data-side-pane="alive"]');
  if (!pane || pane.hidden) return false;
  const panel = document.getElementById('artifacts-panel');
  return !!(panel && !panel.hidden);
}

/**
 * 页签可见时才轮询。
 *
 * 为什么需要：体征在 Main 里每 5 分钟变一次，而这一页原来只在「切页签 / 点刷新 / 拨开关」时渲染一次 ——
 * 用户会看到「疲劳 0.0」配着 state.json 里的 100（issue/2026-11-10 的 Bug 1 后半段）。
 * 页签不可见就停，别让后台页面空转。**两个壳（设置页 / 侧栏页）任一可见就继续**。
 */
/**
 * 页面可见性（决定要不要继续轮询）：侧栏「生命」页、设置里的「生命」、设置里的「日志」任一可见就继续。
 *
 * 「日志」是独立页签（2026-11-12 从「生命」里拆出来）：它跟体征页共用同一份
 * `alive:decisions` 轮询，所以这里必须一并认 —— 否则打开日志页会看到一份不动的旧快照。
 */
function aliveSettingsPageVisible() {
  for (const page of ['alive', 'alive-log']) {
    if (typeof isSettingsPageOpen === 'function' && isSettingsPageOpen(page)) return true;
    const el = document.querySelector(`.settings-page[data-settings="${page}"]`);
    if (el && el.classList.contains('active')) return true;
  }
  return false;
}

function alivePageVisible() {
  if (aliveSidePaneVisible()) return true;
  return aliveSettingsPageVisible();
}

function stopAlivePoll() {
  if (aliveUi.pollTimer) {
    clearInterval(aliveUi.pollTimer);
    aliveUi.pollTimer = null;
  }
}

function startAlivePoll() {
  stopAlivePoll();
  aliveUi.pollTick = 0;
  aliveUi.pollTimer = setInterval(() => {
    if (!alivePageVisible()) {
      stopAlivePoll();
      return;
    }
    aliveUi.pollTick += 1;
    refreshAliveStatus();
    if (aliveUi.pollTick % ALIVE_DECISIONS_EVERY === 1) {
      refreshAliveDecisions();
      refreshAliveNote();
      refreshAliveHistory();
    }
  }, ALIVE_POLL_MS);
}

async function setAliveEnabled(enabled) {
  const api = aliveApi();
  if (!api) return;
  if (aliveUi.saving) return;
  aliveUi.saving = true;
  try {
    const res = await api.aliveSetEnabled({ enabled: !!enabled });
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '切换失败', 'bad');
      renderAliveStatus(null);
      return;
    }
    renderAliveStatus(res.status);
    aliveHint(enabled ? '已开始跳动' : '已停表（体征保留，重新打开会接着走）', 'ok');
    await refreshAliveDecisions();
    if (enabled) startAlivePoll();
  } catch (err) {
    aliveHint(`切换失败：${(err && err.message) || err}`, 'bad');
  } finally {
    aliveUi.saving = false;
  }
}

async function resetAliveState() {
  const api = aliveApi();
  if (!api || typeof api.aliveReset !== 'function') return;
  if (aliveUi.saving) return;
  aliveUi.saving = true;
  try {
    const res = await api.aliveReset();
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '清除失败', 'bad');
      return;
    }
    renderAliveStatus(res.status);
    renderAliveDecisions([]);
    aliveHint('体征已清空（下次打开开关会重新出生）', 'ok');
  } catch (err) {
    aliveHint(`清除失败：${(err && err.message) || err}`, 'bad');
  } finally {
    aliveUi.saving = false;
  }
}

function onAliveSettingsTabShown() {
  // 「设定」页只要**一次现读**（人设 / 目标 / 字数上限）：这里没有会变的体征，也不必轮询 ——
  // 用户正在这个页里打字，轮询只会让"要不要覆盖文本框"的判断变复杂。
  const onSetupPage = typeof isSettingsPageOpen === 'function' && isSettingsPageOpen('alive-setup');
  if (onSetupPage) {
    stopAlivePoll();
    refreshAliveStatus();
    return;
  }
  // 「生命」页才需要体征与设备（设备枚举会 spawn 一次 ffmpeg）；「日志」页要事件流 + 抽屉
  const onAlivePage = typeof isSettingsPageOpen === 'function' && isSettingsPageOpen('alive');
  if (onAlivePage) {
    refreshAliveStatus()
      .then(() => refreshAliveDevices(false))
      .then(() => {
        refreshAliveHistory();
      });
  }
  const onLogPage = typeof isSettingsPageOpen === 'function' && isSettingsPageOpen('alive-log');
  if (onLogPage) refreshAliveNote();
  refreshAliveDecisions();
  startAlivePoll();
}

/* ───────────── 侧栏「生命」页 + 心跳律动（第三个「看得见」入口，见 docs/ALIVE-VISIBILITY-PLAN.md）───────────── */

/** 侧栏页显示：首刷 + 启轮询（与设置页同一份渲染、同一份 IPC） */
function onAlivePanelShown() {
  refreshAliveStatus();
  refreshAliveDecisions();
  refreshAliveNote();
  refreshAliveHistory();
  startAlivePoll();
}

/** 侧栏页隐藏：设置页还开着就继续轮询，否则停（别让后台空转） */
function onAlivePanelHidden() {
  if (!alivePageVisible()) stopAlivePoll();
}

/**
 * rail 心跳图标：**和别的 rail 图标一样** —— 不动、不单独上色，只把当前相位写进工具提示。
 *
 * 2026-11-13 两次按用户要求收敛：先去掉律动（"不要动画了"），再去掉相位色（"颜色 和其他图标一样"）。
 * 所以这里不再写任何 dataset（`data-alive-phase` 已无消费者），图标就是排里那一个；
 * 相位事实留在悬停文字里，曲线在「生命」页里本来就有。
 * **不引入"未读计数"**（那要持久化 lastSeenTs，是状态机加法）。
 */
function renderAliveRailPhase(res) {
  const btn = $('alive-rail-btn');
  if (!btn) return;
  const title = '生命 · 它在你不看时做了什么';
  if (!(res && res.ok && res.enabled === true)) {
    btn.title = `${title}（现在停着）`;
    return;
  }
  const label = ALIVE_PHASE_TEXT[String((res && res.phase) || '').toUpperCase()] || '';
  btn.title = label ? `${title}（相位 ${label}）` : title;
}

async function refreshAliveBadge() {
  const api = aliveApi();
  if (!api || typeof api.aliveBadge !== 'function') return;
  try {
    const res = await api.aliveBadge();
    // 主窗口那条「它说…」：徽标是常驻轮询，顺带把这条一起刷（同一个 IPC，不多打一次）
    renderAliveSpeech(res);
    renderAliveRailPhase(res);
  } catch {
    // 徽标失败只影响 rail 图标的相位色
  }
}

function startAliveBadgePoll() {
  if (aliveUi.badgeTimer) return;
  refreshAliveBadge();
  // 30s：体征是 5 分钟尺度，够用且省（这条 IPC 只读 state.json + 事件尾部一行）
  aliveUi.badgeTimer = setInterval(refreshAliveBadge, 30000);
}

/**
 * 后台心跳轮刚跑完（Main 的 `alive:ran`）。
 *
 * 为什么需要：心跳轮在 Main 里跑、不推流，所以你**正开着它的会话**时，新的一轮只落进库里，
 * 界面一动不动 —— 只能切走再切回才看得见（"停在上一次唤醒"的观感就是这么来的）。
 * 这里做的事只有两件：把该会话的缓存作废；如果**正开着它**且没有别的轮在跑，就地重读一次。
 * 不抢滚动位置、不动输入框（重读走的是会话加载那条老路，滚动位置由它自己恢复）。
 */
async function onAliveTurnFinished(payload) {
  const sid = String((payload && payload.sessionId) || '');
  if (!sid) return;
  if (typeof invalidateSessionMessageCache === 'function') invalidateSessionMessageCache(sid);
  if (typeof refreshHistoryList === 'function') {
    Promise.resolve(refreshHistoryList()).catch(() => {});
  }
  refreshAliveBadge();
  if (String(currentSessionId || '') !== sid) return;
  // 这一轮正在由 Renderer 自己驱动（用户在会话里打字）：别插一脚
  if (typeof isSessionSending === 'function' && isSessionSending(sid)) return;
  if (typeof loadChatFromGateway !== 'function') return;
  try {
    await loadChatFromGateway(null, sid, { forceRefresh: true });
  } catch {
    // 刷新失败只影响"看不看得到最新一轮"，不提示、不打断
  }
}

function initAliveSettingsPage() {
  // 后台心跳轮结束的通知（Main → 界面）：正开着它的会话就地补上那一轮，否则只能切走再切回
  const aliveEventApi = aliveApi();
  if (aliveEventApi && typeof aliveEventApi.onAliveRan === 'function') {
    aliveEventApi.onAliveRan((payload) => {
      onAliveTurnFinished(payload);
    });
  }
  const toggle = $('alive-enabled');
  if (toggle) {
    toggle.addEventListener('change', () => {
      setAliveEnabled(toggle.checked);
    });
  }
  for (const key of ALIVE_SENSE_KEYS) {
    const el = aliveSenseInput(key);
    if (!el) continue;
    el.addEventListener('change', () => {
      setAliveSense(key, el.checked);
    });
  }
  const spontaneous = $('alive-sense-voice-spontaneous');
  if (spontaneous) {
    spontaneous.addEventListener('change', () => {
      setAliveOption('voiceSpontaneous', spontaneous.checked);
    });
  }
  const mic = $('alive-mic-device');
  if (mic) {
    mic.addEventListener('change', () => {
      setAliveOption('micDevice', mic.value);
    });
  }
  const camera = $('alive-camera-device');
  if (camera) {
    camera.addEventListener('change', () => {
      setAliveOption('cameraDevice', camera.value);
    });
  }
  // 「醒来时先看一眼」：两个独立开关（默认关），打开只表示"允许取图"，取不到会在状态里写明
  for (const [id, name] of [
    ['alive-wake-look-camera', 'wakeLookCamera'],
    ['alive-wake-look-screen', 'wakeLookScreen']
  ]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      setAliveOption(name, el.checked);
    });
  }
  // 它自己的脑子：唤醒轮用哪个模型（空 = 跟随机型设置）
  const modelRouteSel = $('alive-model-route');
  if (modelRouteSel) {
    modelRouteSel.addEventListener('change', () => {
      setAliveOption('modelRoute', modelRouteSel.value);
    });
  }
  // 它醒来能做什么：权力档 + 允许动的根目录（改完下一轮就生效，不用重启）
  const powerSel = $('alive-wake-power');
  if (powerSel) {
    powerSel.addEventListener('change', () => {
      setAliveOption('wakePower', powerSel.value);
    });
  }
  const rootInput = $('alive-wake-root');
  if (rootInput) {
    // 输入停顿 / 失焦 / 回车都存（只挂失焦时，打完路径按 Esc 关设置框就静默丢了这次输入）
    aliveSaveOnIdle(rootInput, saveAliveRoot);
    // 「选择…」：走既有的 `dialog:pick-folder`（与「频道 → 默认工作空间」同一个通道，不另开 IPC），
    // 选完立刻存 —— 手打路径是最容易打错、也最容易以为"没生效"的那一步。
    const rootPick = $('alive-wake-root-pick');
    if (rootPick) {
      rootPick.addEventListener('click', async () => {
        const api = aliveApi();
        if (!api || typeof api.pickFolder !== 'function') {
          aliveNoteText('alive-wake-root-hint', '选目录不可用（preload 未就绪）', 'bad');
          return;
        }
        let dir = '';
        try {
          dir = await api.pickFolder();
        } catch (err) {
          aliveNoteText('alive-wake-root-hint', `打开目录选择失败：${(err && err.message) || err}`, 'bad');
          return;
        }
        if (!dir) return; // 取消 = 什么都不改
        rootInput.value = dir;
        await saveAliveRoot();
      });
    }
  }
  // 「设定」页：一个框 + 保存（走同一条 `alive:set-option`）。
  // 与根目录框同一个保存时机（`aliveSaveOnIdle`：输入停顿 / 失焦 / 回车），按钮也调同一个 save。
  const setupInput = $('alive-setup');
  if (setupInput) {
    aliveSaveOnIdle(setupInput, saveAliveSetup);
  }
  const setupSave = $('alive-setup-save');
  if (setupSave) {
    setupSave.addEventListener('click', () => {
      saveAliveSetup();
    });
  }
  const devicesRefresh = $('alive-devices-refresh');
  if (devicesRefresh) {
    devicesRefresh.addEventListener('click', () => {
      refreshAliveDevices(true);
    });
  }
  const voiceRefresh = $('alive-voice-refresh');
  if (voiceRefresh) {
    voiceRefresh.addEventListener('click', () => {
      refreshAliveDevices(true);
    });
  }
  const openPerms = $('alive-open-permissions');
  if (openPerms) {
    openPerms.addEventListener('click', () => {
      if (typeof switchSettingsTab === 'function') switchSettingsTab('perms');
    });
  }
  const refresh = $('alive-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      refreshAliveDevices(true).then(() => {
        refreshAliveStatus().then(() => {
          refreshAliveDecisions();
          refreshAliveNote();
          refreshAliveHistory();
        });
      });
    });
  }
  const reset = $('alive-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      resetAliveState();
    });
  }
  // 「现在叫醒它一次」：调试 / 演示用的手动门（跳过张力门限）。
  // 它只负责叫、不负责"替它说话"：点了之后看决策日志，说不说由它自己决定。
  const wakeOnce = $('alive-wake-once');
  if (wakeOnce) {
    wakeOnce.addEventListener('click', async () => {
      const api = aliveApi();
      if (!api || typeof api.aliveWakeOnce !== 'function') {
        aliveHint('当前界面没有生命感的 IPC（旧版主进程？）', 'bad');
        return;
      }
      if (wakeOnce.disabled) return;
      wakeOnce.disabled = true;
      aliveHint('叫醒了，这一轮要跑十几秒到几十秒…', 'ok');
      try {
        const res = await api.aliveWakeOnce();
        if (res && res.ok) {
          aliveHint('这一轮跑完了：看下面日志里它的决定', 'ok');
        } else {
          aliveHint(`没醒：${(res && (res.error || res.reason)) || '未知原因'}`, 'bad');
        }
      } catch (err) {
        aliveHint(`叫醒失败：${(err && err.message) || err}`, 'bad');
      } finally {
        wakeOnce.disabled = false;
      }
      refreshAliveStatus();
      refreshAliveDecisions();
      refreshAliveNote();
      refreshAliveHistory();
    });
  }
  // 「日志」独立页签：手动刷新一次记录区（轮询在页签可见时本来就在跑，这里只是让人能立刻拉一次）。
  // 「事件」与「抽屉」是同一页的两组横向标签 —— 点一次刷新把两块都读一遍，不用先切标签再刷新。
  const logRefresh = $('alive-log-refresh');
  if (logRefresh) {
    logRefresh.addEventListener('click', async () => {
      await Promise.all([refreshAliveDecisions(), refreshAliveNote()]);
      aliveNoteText('alive-log-hint', `已刷新 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    });
  }
  // 「事件 / 抽屉」横向标签：一条委托监听覆盖两个壳（设置 → 日志、侧栏「生命」面板）
  document.addEventListener('click', onAliveTabClick);
  // 主窗口「它说…」条的两个按钮：看全部日志 / 收起这一条
  const speechLog = $('alive-speech-log');
  if (speechLog) {
    speechLog.addEventListener('click', () => {
      if (typeof openSettingsModal === 'function') openSettingsModal('alive-log');
      else if (typeof switchSettingsTab === 'function') switchSettingsTab('alive-log');
    });
  }
  const speechDismiss = $('alive-speech-dismiss');
  if (speechDismiss) {
    speechDismiss.addEventListener('click', () => {
      // 只收起"这一条"：下次它再开口（lastVoiceAt 变大）就重新出现
      aliveUi.speechDismissedAt = Date.now();
      const bar = $('alive-speech-bar');
      if (bar) bar.hidden = true;
    });
  }
  // 设置弹窗被关掉时（页面不再可见）停掉轮询：没有统一的 close 钩子，就靠这一条
  window.addEventListener('beforeunload', () => {
    stopAlivePoll();
    if (aliveUi.badgeTimer) {
      clearInterval(aliveUi.badgeTimer);
      aliveUi.badgeTimer = null;
    }
  });
  // 主界面常驻的"刚有动静"小点
  startAliveBadgePoll();
  initAlivePane();
}

/** 侧栏「生命」页的两个按钮：刷新 / 跳到设置页（开关与感官在那边） */
function initAlivePane() {
  const refresh = $('alive-pane-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      refreshAliveStatus();
      refreshAliveDecisions();
      refreshAliveNote();
      refreshAliveHistory();
      refreshAliveBadge();
    });
  }
  const settings = $('alive-pane-settings');
  if (settings) {
    settings.addEventListener('click', () => {
      if (typeof openSettingsModal === 'function') openSettingsModal('alive');
      else if (typeof switchSettingsTab === 'function') switchSettingsTab('alive');
    });
  }
}

window.onAliveSettingsTabShown = onAliveSettingsTabShown;
window.onAlivePanelShown = onAlivePanelShown;
window.onAlivePanelHidden = onAlivePanelHidden;
initAliveSettingsPage();
