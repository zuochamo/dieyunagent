'use strict';

/**
 * 生命体征的持久化：**一个状态文件 + 一条只追加的事件流**。
 *
 * 为什么不引 SQLite：本仓 `build.files` 显式排除了 `better-sqlite3`，headless 只打纯 JS
 * 依赖闭包 —— 为拟态功能引入 native sqlite 意味着重做两套打包矩阵 + 跟着 Electron ABI 升级，
 * 维护成本远大于收益。这里的真实体量是「一条状态 + 一串事件」，原子写 + 追加日志足够，
 * 且天然满足「单写者、事件只增不改」。
 *
 * 布局（`<userData>/alive/`，目录名走 `app-paths` 的 userData，不落仓库目录）：
 *   state.json    体征快照（原子写：tmp + rename）
 *   events.jsonl  决策/相位/唤醒事件（只追加；超过上限按最旧裁剪）
 */

const fs = require('fs');
const path = require('path');

const ALIVE_DIR_NAME = 'alive';
const STATE_FILE_NAME = 'state.json';
const EVENTS_FILE_NAME = 'events.jsonl';
const HISTORY_FILE_NAME = 'history.jsonl';
const SETTINGS_FILE_NAME = 'settings.json';
/**
 * events.jsonl 的**物理**上限：超过就裁剪到一半。
 * 逻辑上限（`state.decisions` / `state.intents` 留多少条）在 `agent-limits`
 * （`aliveDecisionsKeep` / `aliveIntentsKeep`），别在这里再写一份。
 */
const EVENTS_FILE_MAX_LINES = 2000;

function aliveRootDir(userDataPath) {
  return path.join(String(userDataPath || ''), ALIVE_DIR_NAME);
}

/**
 * @param {string} userDataPath
 */
function createAliveStore(userDataPath) {
  if (!userDataPath) throw new Error('alive store: userDataPath required');
  const dir = aliveRootDir(userDataPath);
  const stateFile = path.join(dir, STATE_FILE_NAME);
  const eventsFile = path.join(dir, EVENTS_FILE_NAME);
  const historyFile = path.join(dir, HISTORY_FILE_NAME);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * 读状态。损坏的文件不抛错、不静默覆盖：改名留证后返回 null（等于「重新出生」），
   * 因为一个崩坏的 JSON 里可能正是它唯一的历史。
   */
  function read() {
    let raw = '';
    try {
      raw = fs.readFileSync(stateFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      try {
        fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
      } catch {
        // 改名失败也不覆盖：宁可下次继续读失败
      }
      return null;
    }
  }

  function write(state) {
    ensureDir();
    const tmp = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, stateFile);
  }

  function exists() {
    return fs.existsSync(stateFile);
  }

  /** 彻底清空（设置页「关闭生命」= 停表；这是运维动作，不是「让它睡一会」） */
  function clear() {
    for (const f of [stateFile, eventsFile, historyFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // 不存在即已清
      }
    }
  }

  const settingsFile = path.join(dir, SETTINGS_FILE_NAME);

  function readSettings() {
    const d = aliveSettingsDefaults();
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const senses = raw && raw.senses && typeof raw.senses === 'object' ? raw.senses : {};
      return {
        enabled: !!(raw && raw.enabled === true),
        sessionId: raw && raw.sessionId ? String(raw.sessionId) : '',
        senses: {
          drawer: senses.drawer === undefined ? d.senses.drawer : senses.drawer === true,
          eyes: senses.eyes === true,
          voice: senses.voice === true
        },
        /** 主动出声/收音的二级授权（默认关：它不能在没被允许时突然开口） */
        voiceSpontaneous: !!(raw && raw.voiceSpontaneous === true),
        /** 设备选择（空串 = 让探测器挑默认设备；环境变量仍作高级覆盖） */
        micDevice: raw && raw.micDevice ? String(raw.micDevice) : '',
        cameraDevice: raw && raw.cameraDevice ? String(raw.cameraDevice) : ''
      };
    } catch {
      return d;
    }
  }

  function writeSettings(patch) {
    ensureDir();
    const next = Object.assign(readSettings(), patch || {});
    const normalized = {
      enabled: next.enabled === true,
      sessionId: next.sessionId ? String(next.sessionId) : '',
      senses: {
        drawer: next.senses && next.senses.drawer === true,
        eyes: next.senses && next.senses.eyes === true,
        voice: next.senses && next.senses.voice === true
      },
      voiceSpontaneous: next.voiceSpontaneous === true,
      micDevice: next.micDevice ? String(next.micDevice) : '',
      cameraDevice: next.cameraDevice ? String(next.cameraDevice) : ''
    };
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, settingsFile);
    return normalized;
  }

  /**
   * JSONL 的裁剪：超过 `maxLines` 就**留后半**（一次裁一半，不给每行都触发一次重写）。
   *
   * 事件流与体征历史用的是同一个实现 —— 两份裁剪逻辑迟早会在「裁多少 / 裁完写什么」上分叉。
   */
  function trimJsonl(file, maxLines) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      if (lines.length <= maxLines) return;
      const kept = lines.slice(Math.floor(lines.length / 2));
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // ignore
    }
  }

  function appendEvent(evt) {
    ensureDir();
    try {
      fs.appendFileSync(eventsFile, `${JSON.stringify(evt)}\n`, 'utf8');
    } catch {
      // 事件落盘失败不能打断心跳
    }
    trimJsonl(eventsFile, EVENTS_FILE_MAX_LINES);
  }

  /**
   * 追加一条体征采样（`history.jsonl`，只追加）。
   *
   * 为什么每跳一条、不在写侧按时间桶合并：append-only 文件里"改最后一行"要么整份重写、
   * 要么维护偏移量 —— 两者都比多存几十 KB 贵。降采样放在**读侧**（面板只要 ~240 个点）。
   */
  function appendSample(sample, opts) {
    ensureDir();
    try {
      fs.appendFileSync(historyFile, `${JSON.stringify(sample)}\n`, 'utf8');
    } catch {
      return false;
    }
    trimJsonl(historyFile, Math.max(50, Number(opts && opts.maxLines) || 4000));
    return true;
  }

  /**
   * 读体征历史：窗口内、按 `points` 等距抽样（含首尾），坏行跳过。
   * @returns {{ samples: object[], total: number }}
   */
  function readSamples(opts) {
    const o = opts || {};
    const windowMs = Math.max(60 * 1000, Number(o.windowMs) || 7 * 24 * 3600 * 1000);
    const points = Math.max(2, Math.min(2000, Number(o.points) || 240));
    const from = Number(o.nowMs) - windowMs;
    let raw = '';
    try {
      raw = fs.readFileSync(historyFile, 'utf8');
    } catch {
      return { samples: [], total: 0 };
    }
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && Number(v.ts) >= from) rows.push(v);
      } catch {
        // 坏行跳过：一行坏 JSON 不该让整条曲线空掉
      }
    }
    rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    const total = rows.length;
    if (total <= points) return { samples: rows, total };
    const out = [];
    for (let i = 0; i < points; i += 1) {
      out.push(rows[Math.round((i * (total - 1)) / (points - 1))]);
    }
    return { samples: out, total };
  }

  /** 最近 N 条事件（从文件尾部读，不整份加载） */
  function readEvents(limit) {
    const n = Math.max(1, Number(limit) || 50);
    let raw = '';
    try {
      raw = fs.readFileSync(eventsFile, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // 跳过坏行
      }
    }
    return out.reverse();
  }

  return {
    dir,
    stateFile,
    eventsFile,
    historyFile,
    settingsFile,
    ensureDir,
    exists,
    read,
    write,
    clear,
    appendEvent,
    readEvents,
    appendSample,
    readSamples,
    readSettings,
    writeSettings
  };
}

/**
 * 设置（**只有开关**）：`{ enabled: boolean }`。
 *
 * 为什么单独一个文件、而不是塞进 state.json：开关是**运维意图**，体征是**内部状态**。
 * 混在一起会出现「关掉开关时顺手把体征写坏了」，也会让「它有没有表态」和「我要不要养它」
 * 这两件事共用一个写者。开关关掉 = 停表（状态留着），不是清空。
 */
function aliveSettingsDefaults() {
  return {
    enabled: false,
    sessionId: '',
    /**
     * 感官开关：**默认全关**（除抽屉）。
     * - drawer：它自己的 note.md（只追加、只写自己目录）
     * - eyes：摄像头（还要「设置 → 权限」里把摄像头打开，是两道锁）
     * - voice：说一句 / 听几秒（需要语音槽位配置 + ffmpeg/ffplay + 麦克风设备名）
     */
    senses: { drawer: true, eyes: false, voice: false },
    /**
     * 二级授权：**允许它主动出声/收音**（默认关）。
     *
     * 为什么要在 `senses.voice` 之上再加一道：勾选「嘴与耳」只是「这台机器有嘴有耳」，
     * 不等于「允许它在没人说话的时候突然开口/收音」。半夜说话、被动录音都会越过这条线，
     * 所以真正调用 `alive_speak` / `alive_listen` 还要这一个开关 + `aliveVoiceMaxPerDay` 频率上限。
     */
    voiceSpontaneous: false,
    /** 麦克风/摄像头设备名（空 = 探测后挑默认；`DIEYUN_MIC_DEVICE` / `DIEYUN_DESKTOP_CAMERA` 仍作高级覆盖） */
    micDevice: '',
    cameraDevice: ''
  };
}

module.exports = { createAliveStore, aliveRootDir, aliveSettingsDefaults, ALIVE_DIR_NAME };
