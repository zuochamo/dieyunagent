/* global window, document, $, isSettingsPageOpen, switchSettingsTab */
'use strict';

/**
 * 设置 → 生命（**只读观察窗 + 一个总开关 + 感官开关**）。
 *
 * 这一页只有四件事：
 *   1. 总开关（开 = 起心跳；关 = 停表，体征留着，不是清空）
 *   2. 只读体征：相位 / 张力与阈值 / 疲劳 / 未闭合条数 / 决策计数（**页签可见时轮询刷新**）
 *   3. 感官：三个开关 + 「勾着但不可用」的可见告警 + 设备选择 + 主动开口授权
 *   4. 决策与感官事件日志：`时间 · 事件 · 细节`
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

const aliveUi = {
  loading: false,
  saving: false,
  devicesLoading: false,
  pollTimer: null,
  pollTick: 0,
  devicesLoaded: false
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
  EYE: '睁眼看'
};

const ALIVE_SENSE_KEYS = ['drawer', 'eyes', 'voice'];

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

function aliveFmtTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** token 数按人读的方式缩写（它花的是同一份账单，别让用户自己数零） */
function aliveFmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1000000).toFixed(2)}M`;
}

/* ───────────── 趋势曲线（内联 SVG，不引图表库）───────────── */

const ALIVE_TREND_W = 100;
const ALIVE_TREND_H = 34;
const ALIVE_TREND_PAD = 2;

/** 采样序号 → 横坐标（首尾贴边，中间等距） */
function aliveTrendX(index, count) {
  if (count <= 1) return ALIVE_TREND_PAD;
  return ALIVE_TREND_PAD + (index * (ALIVE_TREND_W - ALIVE_TREND_PAD * 2)) / (count - 1);
}

/** 0–100 的体征值 → 纵坐标（上高下低） */
function aliveTrendY(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return ALIVE_TREND_H - ALIVE_TREND_PAD - (v / 100) * (ALIVE_TREND_H - ALIVE_TREND_PAD * 2);
}

function aliveTrendPath(samples, key) {
  return samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${aliveTrendX(i, samples.length).toFixed(2)},${aliveTrendY(s[key]).toFixed(2)}`)
    .join(' ');
}

/** 相位色带：连续同相位的采样合成一段 rect（背景里一眼看出它什么时候在压缩） */
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
  return bands.map((b) => {
    const x1 = aliveTrendX(b.from, samples.length);
    const x2 = aliveTrendX(Math.min(samples.length - 1, b.to + 1), samples.length);
    const w = Math.max(0.3, x2 - x1);
    const label = ALIVE_PHASE_TEXT[b.phase] || b.phase || '—';
    return (
      `<rect class="alive-trend-band alive-phase-${String(b.phase || '').toLowerCase()}"` +
      ` x="${x1.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${ALIVE_TREND_H}">` +
      `<title>${label}</title></rect>`
    );
  });
}

/**
 * 把 `alive:history` 的采样画成一条曲线（张力 + 疲劳 + 相位色带）。
 *
 * 为什么手写 SVG 而不引图表库：只需要两条折线和几段底色，库的体积与升级成本都不值；
 * renderer 里已有 `<svg>` 的写法（rail 图标、气泡折线）。
 */
function buildAliveTrendSvg(payload) {
  const samples = Array.isArray(payload && payload.samples) ? payload.samples : [];
  if (samples.length < 2) return '';
  return (
    `<svg class="alive-trend-svg" viewBox="0 0 ${ALIVE_TREND_W} ${ALIVE_TREND_H}"` +
    ` preserveAspectRatio="none" role="img" aria-label="体征趋势">` +
    aliveTrendBands(samples).join('') +
    `<path class="alive-trend-line alive-trend-tension" d="${aliveTrendPath(samples, 'tension')}" />` +
    `<path class="alive-trend-line alive-trend-fatigue" d="${aliveTrendPath(samples, 'fatigue')}" />` +
    `<circle class="alive-trend-dot alive-trend-tension" cx="${aliveTrendX(samples.length - 1, samples.length).toFixed(2)}" cy="${aliveTrendY(samples[samples.length - 1].tension).toFixed(2)}" r="1.1" />` +
    `<circle class="alive-trend-dot alive-trend-fatigue" cx="${aliveTrendX(samples.length - 1, samples.length).toFixed(2)}" cy="${aliveTrendY(samples[samples.length - 1].fatigue).toFixed(2)}" r="1.1" />` +
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
        `${aliveFmtTime(s.ts)} · ${ALIVE_PHASE_TEXT[s.phase] || s.phase || '—'}` +
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
    quotaEl.textContent = allowed
      ? `已允许：今天主动开口 ${used}/${max} 次${last ? ` · 上次 ${aliveFmtTime(last)}` : ''}（两次之间至少 30 分钟）`
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

function renderAliveNote(text) {
  const el = $('alive-note');
  if (!el) return;
  const body = String(text || '').trim();
  el.textContent = body || '（还没有写东西）';
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

async function setAliveOption(name, value) {
  const api = aliveApi();
  if (!api || typeof api.aliveSetOption !== 'function') return;
  try {
    const res = await api.aliveSetOption({ name, value });
    if (!res || !res.ok) {
      aliveHint((res && res.error) || '保存失败', 'bad');
      await refreshAliveStatus();
      return;
    }
    if (res.status) renderAliveStatus(res.status);
    aliveHint('已保存', 'ok');
  } catch (err) {
    aliveHint(`保存失败：${(err && err.message) || err}`, 'bad');
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

function renderAliveStatus(status) {
  const st = status && typeof status === 'object' ? status : null;
  const enabledEl = $('alive-enabled');
  if (enabledEl && document.activeElement !== enabledEl) {
    enabledEl.checked = !!(st && st.enabled);
  }
  renderAliveSenses(st);
  renderAliveCapabilities(st);

  const statusEl = $('alive-status');
  const detailEl = $('alive-detail');
  const loopsEl = $('alive-loops');

  if (!st || (!st.exists && !st.enabled)) {
    if (statusEl) statusEl.textContent = '未启用（打开上面的开关才会开始跳动）';
    if (detailEl) detailEl.textContent = '';
    if (loopsEl) loopsEl.textContent = '';
    aliveNoteText('alive-fatigue-note', '', null);
    aliveNoteText('alive-budget-note', '', null);
    aliveNoteText('alive-session-note', '', null);
    return;
  }
  if (!st.exists) {
    if (statusEl) statusEl.textContent = '已启用，尚未产生第一次心跳';
    if (detailEl) detailEl.textContent = '';
    if (loopsEl) loopsEl.textContent = '';
    aliveNoteText('alive-fatigue-note', '', null);
    aliveNoteText('alive-budget-note', '', null);
    aliveNoteText(
      'alive-session-note',
      st.sessionId
        ? ''
        : '还没有绑定的会话：第一次唤醒时会自建一个专属会话（标题「生命体征（后台心跳）」），不占用你的对话线。',
      null
    );
    return;
  }
  if (statusEl) {
    const phase = ALIVE_PHASE_TEXT[st.phase] || st.phase;
    const runningText = st.running ? '跳动中' : '已停表';
    const lastTick = aliveFmtTime(st.lastTickAt);
    statusEl.textContent =
      `${runningText} · 相位 ${phase}（已 ${aliveFmtDuration(Date.now() - Number(st.phaseEnteredAt || Date.now()))}）` +
      ` · 第 ${st.tickCount} 次心跳${lastTick ? `（上次 ${lastTick}）` : ''}`;
  }
  if (detailEl) {
    const lastWakeTokens = Number(st.lastWakeTokens || 0);
    const lastWakeMs = Number(st.lastWakeDurationMs || 0);
    const lastWakeText = lastWakeTokens || lastWakeMs
      ? ` · 上次醒来 ${lastWakeTokens ? `${aliveFmtTokens(lastWakeTokens)} token` : ''}${lastWakeTokens && lastWakeMs ? ' / ' : ''}${lastWakeMs ? `${(lastWakeMs / 1000).toFixed(1)}s` : ''}`
      : '';
    detailEl.textContent =
      `张力 ${Number(st.tension || 0).toFixed(1)} / 阈值 ${Number(st.wakeThreshold || 0).toFixed(1)}` +
      ` · 疲劳 ${Number(st.fatigue || 0).toFixed(1)}` +
      ` · 未闭合 ${Number(st.loops || 0)} 条` +
      ` · 今日唤醒 ${Number(st.wakeCountToday || 0)}/${Number(st.wakeMaxPerDay || 0)}` +
      ` · 做 ${Number(st.actCount || 0)} / 放下 ${Number(st.deferCount || 0)} / 拒 ${Number(st.refuseCount || 0)}` +
      ` · 今日 token ${aliveFmtTokens(st.tokenToday)}/${Number(st.dailyTokenBudget) > 0 ? aliveFmtTokens(st.dailyTokenBudget) : '不限'}` +
      ` · 累计 ${aliveFmtTokens(st.totalTokens)}` +
      lastWakeText;
  }

  // 额度用完要给出可读结论（否则用户只看到"它不动了"）
  const budget = Number(st.dailyTokenBudget) || 0;
  const usedToday = Number(st.tokenToday) || 0;
  if (budget > 0 && usedToday >= budget) {
    aliveNoteText(
      'alive-budget-note',
      `今日 token 额度已用完（${aliveFmtTokens(usedToday)}/${aliveFmtTokens(budget)}）：它今天不会再自发醒来，` +
        '0 点自动重置。要放宽就改 `agent-limits.js` 的 `aliveDailyTokenBudget`（不在设置页开放旋钮）。',
      'bad'
    );
  } else if (budget > 0 && usedToday >= budget * 0.8) {
    aliveNoteText(
      'alive-budget-note',
      `今日 token 已用 ${aliveFmtTokens(usedToday)}/${aliveFmtTokens(budget)}：快到额度了，用完后它会停到明天。`,
      null
    );
  } else {
    aliveNoteText('alive-budget-note', '', null);
  }

  // 疲劳的解释线：到线就说清「为什么它现在不怎么醒」，而不是让用户对着两个数字猜
  const fatigue = Number(st.fatigue || 0);
  const fatigueHigh = Number(st.fatigueHigh || 0);
  const settle = Number(st.fatigueSettlePerHour || 0);
  if (fatigueHigh > 0 && fatigue >= fatigueHigh) {
    aliveNoteText(
      'alive-fatigue-note',
      `疲劳 ${fatigue.toFixed(1)} 已到顶线（≥${fatigueHigh}：进「压缩」相位，暂停自发唤醒）。` +
        `它只按**自己唤醒轮**用掉的 token 累加，静息每小时回落 ${settle.toFixed(0)}；` +
        `你和它聊天不再算它的疲劳。`,
      'bad'
    );
  } else if (fatigue >= fatigueHigh * 0.8 && fatigueHigh > 0) {
    aliveNoteText(
      'alive-fatigue-note',
      `疲劳 ${fatigue.toFixed(1)} 接近顶线 ${fatigueHigh}：再醒几次就会进压缩相位（停一会儿再醒）。`,
      null
    );
  } else {
    aliveNoteText('alive-fatigue-note', '', null);
  }

  // 唤醒落点：空 sessionId 不代表"没地方说话"（首次唤醒会自建会话），但要说清楚
  aliveNoteText(
    'alive-session-note',
    st.sessionId
      ? ''
      : '还没有绑定的会话：第一次唤醒时会自建一个专属会话（标题「生命体征（后台心跳）」），不占用你的对话线。',
    null
  );

  if (loopsEl) {
    loopsEl.textContent = st.suspiciousObedience
      ? '注意：今天醒了多次却一次都没拒绝 —— 从不拒绝的不是活的，是排期表。'
      : '';
  }
}

function renderAliveDecisions(events) {
  const box = $('alive-decisions');
  if (!box) return;
  const list = Array.isArray(events) ? events.slice() : [];
  if (!list.length) {
    box.textContent = '还没有事件。';
    return;
  }
  const lines = list
    .slice(-40)
    .reverse()
    .map((evt) => {
      const kind = String((evt && evt.kind) || '');
      const label = ALIVE_EVENT_TEXT[kind] || kind;
      const parts = [aliveFmtTime(evt && evt.ts), label];
      if (kind === 'DECISION') {
        parts.push(aliveDecisionText(evt));
        if (evt.loopId) parts.push(`关掉 ${evt.loopId}`);
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
        parts.push(evt.ok ? `说了 ${Number(evt.chars) || 0} 字` : aliveCodeText(evt.errorCode) || '没说出来');
      } else if (kind === 'LISTEN') {
        parts.push(evt.ok ? `听了 ${Number(evt.seconds) || 0} 秒` : aliveCodeText(evt.errorCode) || '没听见');
      } else if (kind === 'EYE') {
        const size = evt.width && evt.height ? `${evt.width}×${evt.height}` : '';
        parts.push(
          evt.ok
            ? `${evt.device || '摄像头'}${size ? ` · ${size}` : ''}`
            : aliveCodeText(evt.errorCode) || '没看到'
        );
      }
      return parts.filter(Boolean).join(' · ');
    });
  box.textContent = lines.join('\n');
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
    mountAliveTrend($('alive-trend'), res);
    if (Array.isArray(res.samples) && res.samples.length >= 2) {
      const first = res.samples[0];
      const last = res.samples[res.samples.length - 1];
      aliveNoteText(
        'alive-trend-note',
        `窗口 ${aliveFmtDuration(Number(last.ts) - Number(first.ts))}（共 ${Number(res.total) || res.samples.length} 个采样）：` +
          `张力 ${Number(first.tension || 0).toFixed(1)} → ${Number(last.tension || 0).toFixed(1)}` +
          ` · 疲劳 ${Number(first.fatigue || 0).toFixed(1)} → ${Number(last.fatigue || 0).toFixed(1)}` +
          '（悬浮曲线看某一刻）',
        null
      );
    }
  } catch {
    // 曲线读失败只影响这一块
  }
}

/**
 * 页签可见时才轮询。
 *
 * 为什么需要：体征在 Main 里每 5 分钟变一次，而这一页原来只在「切页签 / 点刷新 / 拨开关」时渲染一次 ——
 * 用户会看到「疲劳 0.0」配着 state.json 里的 100（issue/2026-11-10 的 Bug 1 后半段）。
 * 页签不可见就停，别让后台页面空转。
 */
function alivePageVisible() {
  if (typeof isSettingsPageOpen === 'function') return isSettingsPageOpen('alive');
  const el = document.querySelector('.settings-page[data-settings="alive"]');
  return !!(el && el.classList.contains('active'));
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
  refreshAliveStatus()
    .then(() => refreshAliveDevices(false))
    .then(() => {
      refreshAliveDecisions();
      refreshAliveNote();
      refreshAliveHistory();
    });
  startAlivePoll();
}

function initAliveSettingsPage() {
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
  // 设置弹窗被关掉时（页面不再可见）停掉轮询：没有统一的 close 钩子，就靠这一条
  window.addEventListener('beforeunload', stopAlivePoll);
}

window.onAliveSettingsTabShown = onAliveSettingsTabShown;
initAliveSettingsPage();
