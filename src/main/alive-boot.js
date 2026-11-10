'use strict';

/**
 * 生命感的**装配点**（Main 侧唯一一处）：心跳运行时 + 唤醒轮的 turnRunner。
 *
 * 为什么单独一个 boot 文件：桌面（`src/main-entry.js`）与 headless（`src/headless/boot.js`）
 * 都要「养一个」，而两边的一轮对话、工具桥、压缩、记忆都来自既有单一来源。
 * 装配写在这里 → 两个宿主各一行，不会漂移出一套自己的 Agent 装配。
 *
 * 唤醒轮（后台心跳叫醒的那一轮）与用户轮只差四件事：
 *   1. `internal: true`（不产出面向用户的内容、不沉淀长期记忆）
 *   2. 只读作用域（`toolScope.readOnly` → tool-gate 的 read-only-scope 关卡）
 *   3. 感官逐项授权（`toolScope.senses` → 摄像头等要 `senses.eyes` 才放行）
 *   4. 多几个只属于它的工具（`alive_decide` / `alive_note` / `alive_speak` / `alive_listen`）
 */

const path = require('path');
const { getAgentLimits } = require('../agent/agent-limits');
const { runMainTurn } = require('../agent/main-turn-runner');
const { loadModelSettings, resolveSpeechApiConfig, resolveTtsApiConfig } = require('../model-settings');
const { loadPermissions } = require('../gateway/permissions-store');
const { ALIVE_DECIDE_TOOL } = require('../alive/decide');
const { ALIVE_NOTE_TOOL, ALIVE_READ_NOTE_TOOL, appendNote, readNote, ensureWorkspace } = require('../alive/note');
const {
  ALIVE_SPEAK_TOOL,
  ALIVE_LISTEN_TOOL,
  listen,
  speak,
  listAudioDevices,
  describeVoiceCapability,
  voicePolicy,
  clampListenSeconds,
  resolveMicDevice
} = require('../alive/voice');
const { createAliveRuntime } = require('../alive/runtime');
const { listVideoDevices, pickDevice } = require('../agent/desktop-camera-source');

/** 心跳会话的固定标题：会话列表里一眼可辨「这一条不是和用户聊的」 */
const ALIVE_SESSION_TITLE = '生命体征（后台心跳）';
/** 摄像头工具名（睁眼落痕只在它们身上记） */
const CAMERA_TOOL_NAMES = new Set(['camera_look', 'desktop_camera_look']);

/**
 * @param {{
 *   userData: string,
 *   getGateway: () => any,
 *   getCoreBridge: () => any,
 *   getMcpRuntime: () => any,
 *   getCompactionAgent: () => any,
 *   createToolBridge: () => any,
 *   listMcpServers?: (userDataPath: string) => any[],
 *   model?: string,
 *   route?: string,
 *   log?: any
 * }} deps
 */
function bootAliveRuntime(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const userData = String(d.userData || '');
  const limits = () => getAgentLimits(userData, 'default');
  /**
   * 视觉可见的提示（桌面 = 托盘/系统通知；headless 没有就静默）。
   *
   * 为什么需要：`alive_listen` 会占用麦克风最长 15 秒。录音这件事**必须当场被看见**，
   * 否则就是"不知情被录"——只在事后的事件流里留痕是不够的。
   */
  const notifyTray = typeof d.notifyTray === 'function' ? d.notifyTray : null;
  function announce(title, body) {
    if (!notifyTray) return;
    try {
      notifyTray(String(title || ''), String(body || ''));
    } catch {
      // 通知失败不该让感官调用失败
    }
  }

  /** 心跳会话：第一次唤醒时建，id 记在 settings.json（附着关系，不是体征） */
  let sessionId = '';

  async function ensureSession(gateway) {
    if (sessionId) {
      const row = await gateway.invokeRpc('memory.session_get', { sessionId });
      if (row && row.id) return sessionId;
      sessionId = '';
    }
    const created = await gateway.invokeRpc('memory.session_create', {
      title: ALIVE_SESSION_TITLE,
      workspacePath: null
    });
    if (!created || !created.id) throw new Error('创建心跳会话失败');
    sessionId = created.id;
    try {
      store.writeSettings({ sessionId });
    } catch {
      // 记不住 id 只影响「下次还是同一个会话」，不影响心跳
    }
    return sessionId;
  }

  /**
   * 感官开关（抽屉 / 眼睛 / 嘴与耳）。运行时每次唤醒都会重新读一次 ——
   * 用户在页面上关掉一个感官，下一轮就真的没有它了（不需要重启）。
   *
   * `micDevice` / `cameraDevice` 也在这一份里：**设备选择属于「这一轮怎么用这个感官」**，
   * 所以要跟着 senses 一起流到工具层（`main-turn-runner` → `tool-bridge`），
   * 而不是在抓帧时再去读一份设置（那样会出现「页面选了 A，实际用了 B」）。
   */
  let storeRef = null;
  function sensesNow() {
    try {
      const s = storeRef ? storeRef.readSettings() : null;
      return {
        drawer: !!(s && s.senses && s.senses.drawer),
        eyes: !!(s && s.senses && s.senses.eyes),
        voice: !!(s && s.senses && s.senses.voice),
        micDevice: (s && s.micDevice) || '',
        cameraDevice: (s && s.cameraDevice) || ''
      };
    } catch {
      return { drawer: false, eyes: false, voice: false, micDevice: '', cameraDevice: '' };
    }
  }

  const runtime = createAliveRuntime({
    userDataPath: userData,
    limits: limits(),
    log,
    getSenses: sensesNow,
    turnRunner: async ({ stateBlock, signal, senses }) => {
      const gateway = d.getGateway && d.getGateway();
      if (!gateway || typeof gateway.invokeRpc !== 'function') throw new Error('Gateway 未就绪');
      const sid = await ensureSession(gateway);
      // 关总开关时会 abort 这一轮：信号一路传到 `runMainTurn`（循环就此停下，不再烧 token）
      if (signal && signal.aborted) return null;
      const caps = senses || sensesNow();
      /** 只给它**真能用**的工具：关掉的能力不注入，省得它反复试、反复被拒 */
      const extraTools = [ALIVE_DECIDE_TOOL];
      if (caps.drawer) extraTools.push(ALIVE_NOTE_TOOL, ALIVE_READ_NOTE_TOOL);
      if (caps.voice) extraTools.push(ALIVE_SPEAK_TOOL, ALIVE_LISTEN_TOOL);

      /** 语音配置按需现取（模型设置改了不用重启） */
      function speechDeps() {
        const settings = loadModelSettings(userData);
        return {
          speechConfig: resolveSpeechApiConfig(settings),
          ttsConfig: resolveTtsApiConfig(settings)
        };
      }

      /** 主动开口的许可（唯一判定点）：二级开关 + 当日上限 + 最小间隔 */
      function voiceAllowed(nowMs) {
        const saved = storeRef ? storeRef.readSettings() : {};
        const st = runtime.getState() || {};
        return voicePolicy({
          allowSpontaneous: !!saved.voiceSpontaneous,
          countToday: Number(st.voiceCountToday) || 0,
          lastVoiceAt: Number(st.lastVoiceAt) || 0,
          maxPerDay: runtime.cfg.voiceMaxPerDay,
          minIntervalMs: runtime.cfg.voiceMinIntervalMs,
          nowMs
        });
      }

      const preTool = async (name, args) => {
        const a = args && typeof args === 'object' ? args : {};
        if (name === 'alive_decide') return runtime.applyDecision(a);
        if (name === 'alive_note') {
          if (!caps.drawer) return { ok: false, errorCode: 'SENSE_DISABLED', error: '抽屉是关着的' };
          const res = appendNote(userData, a.text, { nowMs: Date.now() });
          return res.ok ? { ok: true, wrote: true } : res;
        }
        if (name === 'alive_read_note') {
          if (!caps.drawer) return { ok: false, errorCode: 'SENSE_DISABLED', error: '抽屉是关着的' };
          // 只读它自己那一个文件：没有路径参数，模型指不了别处（边界与写入侧完全同一个）
          const text = readNote(userData);
          return { ok: true, text, chars: text.length };
        }
        if (name === 'alive_speak' || name === 'alive_listen') {
          const isSpeak = name === 'alive_speak';
          if (!caps.voice) return { ok: false, errorCode: 'SENSE_DISABLED', error: isSpeak ? '嘴是关着的' : '耳朵是关着的' };
          const gate = voiceAllowed(Date.now());
          if (!gate.ok) {
            // 「没被允许」也要留痕：否则用户只会看到"它一句话都没说过"，不知道为什么
            runtime.recordEvent({
              kind: isSpeak ? 'SPEAK' : 'LISTEN',
              ok: false,
              errorCode: 'VOICE_NOT_ALLOWED',
              reason: gate.reason
            });
            return { ok: false, errorCode: 'VOICE_NOT_ALLOWED', reason: gate.reason, error: gate.error };
          }
          const saved = storeRef ? storeRef.readSettings() : {};
          const res = isSpeak
            ? await speak({ userData, text: a.text, ...speechDeps() })
            : await (async () => {
                // 录音前先让用户看见（托盘/通知）：麦克风被占用最长 15 秒，不能悄悄发生
                announce('生命感正在听一段', `最多 ${clampListenSeconds(a.seconds)} 秒，只用来转文字，转完立刻删除音频。`);
                return listen({ userData, seconds: a.seconds, device: saved.micDevice, ...speechDeps() });
              })();
          runtime.recordEvent({
            kind: isSpeak ? 'SPEAK' : 'LISTEN',
            ok: res && res.ok === true,
            errorCode: (res && res.errorCode) || undefined,
            chars: res && typeof res.chars === 'number' ? res.chars : undefined,
            seconds: res && Number(res.seconds) ? Number(res.seconds) : undefined
          });
          // 只有真的用上了才计数（被拒、缺件都不扣额度：否则"说不出来"也会把今天的次数耗光）
          if (res && res.ok === true) runtime.noteVoice(Date.now());
          return res;
        }
        return null;
      };

      /**
       * 工具返回之后的观察点：只做「留痕」，不改结果。
       *
       * 为什么需要：`camera_look` / `desktop_camera_look` 是 host 工具（走工具桥），
       * 睁眼这件事没有任何地方能记账，于是页面上「眼睛」永远是勾着但看不见证据。
       * **只记事实，不存画面** —— 现实画面留副本与「不落盘」的硬约束直接冲突。
       */
      const postTool = async (name, _args, result) => {
        if (!CAMERA_TOOL_NAMES.has(String(name || ''))) return null;
        const r = result && typeof result === 'object' ? result : {};
        runtime.recordEvent({
          kind: 'EYE',
          tool: String(name),
          ok: r.ok === true,
          device: r.device ? String(r.device) : undefined,
          width: Number(r.width) || undefined,
          height: Number(r.height) || undefined,
          errorCode: r.errorCode ? String(r.errorCode) : undefined
        });
        return null; // 不改写结果
      };

      await runMainTurn({
        userData,
        gateway,
        coreBridge: d.getCoreBridge && d.getCoreBridge(),
        mcpRuntime: d.getMcpRuntime && d.getMcpRuntime(),
        compactionAgent: d.getCompactionAgent ? d.getCompactionAgent() : null,
        toolBridge: d.createToolBridge(),
        sessionId: sid,
        workspacePath: '',
        // 状态块就是这一轮的「用户输入」——但它带 `[系统] 生命体征` 前缀，
        // 因此 `session-context.isSyntheticLoopUserContent` 会把它排除出「用户任务」
        userText: stateBlock,
        ledgerText: stateBlock,
        runSource: 'alive',
        triggerMeta: { kind: 'alive', trigger: 'internal' },
        sessionTitle: ALIVE_SESSION_TITLE,
        internal: true,
        toolScope: { readOnly: runtime.cfg.readOnlyWake !== false, senses: caps },
        extraTools,
        // 它自己的工具在**调用前**被这里接管：不经过工具桥（它们不是 host 工具）
        preTool,
        // host 工具（摄像头）**调用后**的留痕点：只看事实，不改结果
        postTool,
        model: d.model || '',
        route: d.route || '',
        signal: signal || null,
        listMcpServers: d.listMcpServers,
        // 后台心跳不向任何界面流式输出
        sink: null
      });
    }
  });

  const store = runtime.store;
  storeRef = store;
  // 恢复上一次的心跳会话（有就续用，避免每次重启多一条会话）
  try {
    const saved = store.readSettings();
    if (saved && saved.sessionId) sessionId = saved.sessionId;
  } catch {
    // ignore
  }

  const enabled = () => {
    try {
      return store.readSettings().enabled === true;
    } catch {
      return false;
    }
  };

  /** 总开关：开 = 起心跳；关 = 停表（体征留着，不是清空） */
  function setEnabled(next) {
    const want = next === true;
    const saved = store.writeSettings({ enabled: want });
    if (want) {
      // 抽屉的落地目录在**启用那一刻**就建好：否则「它有抽屉」在磁盘上无从对账
      // （issue/2026-11-10：跑了两跳，alive\workspace 还不存在，用户合理怀疑功能是假的）
      ensureWorkspace(userData);
      runtime.start();
    } else runtime.stop();
    log(`[alive] 总开关：${saved.enabled ? '开' : '关'}`);
    return { enabled: saved.enabled, running: runtime.isRunning() };
  }

  /** 权限页的状态（「眼睛」要两道锁都开才看得见；这里只**读**，不写权限） */
  function cameraPermissions() {
    try {
      const perms = loadPermissions(path.join(userData, 'host-permissions.json'));
      return { camera: perms.camera === true, desktopCamera: perms.desktopCamera === true };
    } catch {
      return { camera: false, desktopCamera: false };
    }
  }

  /**
   * 能力自检（页面据此显示红字告警，而不是让用户对着"已勾选"猜）。
   *
   * 只做「存在性」判断：不 spawn ffmpeg（页面会轮询这个），设备列表走 `listDevices()`。
   */
  function capabilities() {
    const saved = storeRef ? storeRef.readSettings() : {};
    const settings = loadModelSettings(userData);
    const voice = describeVoiceCapability({
      speechConfig: resolveSpeechApiConfig(settings),
      ttsConfig: resolveTtsApiConfig(settings),
      micDevice: saved.micDevice
    });
    const perms = cameraPermissions();
    return {
      voice,
      eyes: {
        /** 生命面板上的「眼睛」开关 */
        senseOn: !!(saved.senses && saved.senses.eyes),
        /** 设置 → 权限 里的两道锁（手机摄像头 / 本机摄像头） */
        cameraPermission: perms.camera,
        desktopCameraPermission: perms.desktopCamera,
        /** 眼睛能不能真的看见：面板开关 + 至少一道权限 */
        ready: !!(saved.senses && saved.senses.eyes) && (perms.camera || perms.desktopCamera),
        cameraDevice: saved.cameraDevice || ''
      }
    };
  }

  function status() {
    const saved = storeRef ? storeRef.readSettings() : {};
    const st = runtime.status();
    return {
      ...st,
      enabled: enabled(),
      tickIntervalMs: runtime.cfg.tickIntervalMs,
      readOnlyWake: runtime.cfg.readOnlyWake !== false,
      senses: sensesNow(),
      /** 心跳会话 id（空 = 还没醒过；第一次唤醒时会自建专属会话，不是"没地方说话"） */
      sessionId: saved.sessionId || '',
      /** 主动出声/收音的二级授权与设备选择（页面控件的唯一数据源） */
      voiceSpontaneous: !!saved.voiceSpontaneous,
      micDevice: saved.micDevice || '',
      cameraDevice: saved.cameraDevice || '',
      capabilities: capabilities()
    };
  }

  /** 开/关一个感官（抽屉 / 眼睛 / 嘴与耳）：立即生效，下一轮心跳就按新值走 */
  function setSense(name, on) {
    const key = String(name || '').trim();
    if (!['drawer', 'eyes', 'voice'].includes(key)) {
      return { ok: false, error: `未知感官：${key || '(空)'}` };
    }
    const cur = store.readSettings();
    const next = { ...(cur.senses || {}), [key]: on === true };
    const saved = store.writeSettings({ senses: next });
    log(`[alive] 感官 ${key}：${next[key] ? '开' : '关'}`);
    return { ok: true, senses: saved.senses };
  }

  /**
   * 感官的其它选项（唯一的写入口）：主动出声授权 / 麦克风 / 摄像头。
   *
   * 为什么不并进 `setSense`：那是三个**能力开关**（有嘴/有眼），这里是**用哪台设备、
   * 允不允许主动**——值类型不同（布尔 vs 字符串），混在一起就得在传输层猜。
   */
  function setOption(name, value) {
    const key = String(name || '').trim();
    if (key === 'voiceSpontaneous') {
      const saved = store.writeSettings({ voiceSpontaneous: value === true });
      log(`[alive] 主动出声/收音：${saved.voiceSpontaneous ? '允许' : '不允许'}`);
      return { ok: true, voiceSpontaneous: saved.voiceSpontaneous };
    }
    if (key === 'micDevice' || key === 'cameraDevice') {
      const device = String(value == null ? '' : value).trim().slice(0, 200);
      const saved = store.writeSettings({ [key]: device });
      log(`[alive] ${key}：${device || '(默认)'}`);
      return { ok: true, [key]: saved[key] };
    }
    return { ok: false, error: `未知选项：${key || '(空)'}` };
  }

  /**
   * 枚举本机可用的麦克风与摄像头（页面下拉用）。
   *
   * 会 spawn 一次 ffmpeg（`-list_devices`），所以**只在点「刷新设备」时调**，
   * 不进 `status()` 的轮询（那是每 5 秒一次的）。
   */
  async function listDevices() {
    const saved = storeRef ? storeRef.readSettings() : {};
    let audio = [];
    let video = [];
    try {
      audio = await listAudioDevices({});
    } catch {
      audio = [];
    }
    try {
      video = await listVideoDevices({});
    } catch {
      video = [];
    }
    return {
      ok: true,
      audio,
      video,
      /** 实际会用哪一颗（设置里选的 → 默认挑非虚拟的那颗），
       *  与 `tool-bridge` 抓帧时的 `pickDevice` 是同一套规则 */
      micDevice: resolveMicDevice(process.env, saved.micDevice),
      cameraDevice: pickDevice(video, process.env.DIEYUN_DESKTOP_CAMERA || saved.cameraDevice)
    };
  }

  /** 抽屉内容（页面只读预览：**只读**，不提供"写"的入口） */
  function note() {
    return { ok: true, text: readNote(userData) };
  }

  /** 进程退出：停表并落盘（不会清掉体征） */
  function stop() {
    try {
      runtime.stop();
    } catch {
      // ignore
    }
  }

  return {
    runtime,
    store,
    status,
    setEnabled,
    enabled,
    setSense,
    setOption,
    listDevices,
    senses: sensesNow,
    note,
    stop,
    /** 清空体征（设置页的「重新开始」）：等同让它重新出生 */
    reset: () => runtime.reset()
  };
}

module.exports = { bootAliveRuntime, ALIVE_SESSION_TITLE };
