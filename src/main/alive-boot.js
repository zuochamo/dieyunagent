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
const fs = require('fs');
const { getAgentLimits } = require('../agent/agent-limits');
const { isReusableSessionRow } = require('../agent/session-workspace-bind');
const { runMainTurn } = require('../agent/main-turn-runner');
const { loadModelSettings, resolveSpeechApiConfig, resolveTtsApiConfig, resolveTextApiConfig } = require('../model-settings');
const { resolveApiConfigForRoute } = require('../agent/model-api-config');
const { loadPermissions } = require('../gateway/permissions-store');
const { ALIVE_DECIDE_TOOL } = require('../alive/decide');
const { ALIVE_NOTE_TOOL, ALIVE_READ_NOTE_TOOL, appendNote, readNote, ensureWorkspace } = require('../alive/note');
const { PET_SET_TOOL, PET_ACT_TOOL, runPetSet, runPetAct } = require('../alive/pet-tools');
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
const { normalizeWakePower, WAKE_POWERS } = require('../alive/store');
const { collectRecap, clip, buildRecallQuery } = require('../alive/recap');
const { captureWakeShots } = require('../alive/eyes');
const { listVideoDevices, pickDevice } = require('../agent/desktop-camera-source');

/** 心跳会话的固定标题：会话列表里一眼可辨「这一条不是和用户聊的」 */
const ALIVE_SESSION_TITLE = '生命体征（后台心跳）';
/** 摄像头工具名（睁眼落痕只在它们身上记） */
const CAMERA_TOOL_NAMES = new Set(['camera_look', 'desktop_camera_look']);
/** 会改变世界的工具（放开档下每次调用都要留 `ACTION` 事件，否则半夜改了什么无人可查）；出网也算：看过哪些页面事后得能对账 */
const ACTION_TOOL_NAMES = new Set(['fs_write_file', 'fs_edit', 'host_exec', 'web_search', 'web_fetch']);
/**
 * 浏览器 / 键鼠：**只记"动了页面/动了手"的那几个**（`navigate` / `evaluate` / `computer`）。
 * 每次 `click` / `scroll` 都记会把决策日志刷成流水（日志只留 40 行），反而看不见真事。
 */
const ACTION_PLAYBACK_TOOL_NAMES = new Set(['browser_navigate', 'browser_evaluate', 'computer']);

/** 给一次 RPC 加硬超时（取事实失败一律按"没有"继续，绝不挡唤醒） */
function withTimeout(promise, ms, label) {
  const limit = Number(ms) || 0;
  if (!(limit > 0)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), limit);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 拿**当前处境**召回几条长期记忆（不是拿体征块去碰运气，见 `recap.buildRecallQuery`）。
 *
 * 为什么值得多花这一次 embedding：它要判断"现在有没有值得做的事"，需要的是跟眼下这些事
 * 有关的记忆；默认注入那 5 条是按体征块召回的"用户偏好"，与此刻无关。
 * 口径与默认注入保持一致：`secret` / `private` 永不进 prompt；召不到就空着。
 */
async function recallMemoryForSituation(opts) {
  const o = opts || {};
  const gateway = o.gateway;
  const cfg = o.cfg || {};
  const max = Math.max(0, Number(cfg.recallBySituation) || 0);
  if (!max || !gateway || typeof gateway.invokeRpc !== 'function') return [];
  const query = buildRecallQuery(o.recap, o.note, cfg.recallQueryMaxChars);
  if (!query) return [];
  try {
    const res = await withTimeout(
      gateway.invokeRpc('memory.long_recall', { query, limit: max }),
      cfg.recallTimeoutMs,
      'memory.long_recall'
    );
    const rows = res && Array.isArray(res.results) ? res.results : [];
    return rows
      .filter((r) => {
        const kind = String((r && r.kind) || '').toLowerCase();
        return kind !== 'secret' && kind !== 'private';
      })
      .slice(0, max)
      .map((r) => ({
        id: Number(r && r.id) || 0,
        kind: String((r && r.kind) || ''),
        score: Number(r && r.score) || 0,
        text: clip(String((r && r.content) || ''), Math.max(20, Number(o.tailChars) || 160))
      }))
      .filter((m) => m.text);
  } catch (err) {
    if (typeof o.log === 'function') o.log(`[alive] 记忆召回失败（当没有）：${(err && err.message) || err}`);
    return [];
  }
}

/**
 * 把「它刚醒过一轮」告诉界面。
 *
 * 为什么需要：后台心跳轮在 Main 里跑，**不向任何窗口推流**（`sink: null`）。于是你正开着
 * 它的会话时，新的一轮只落在库里，界面一动不动 —— 只能切走再切回来才看得到。
 * 这里只发一个"这一轮结束了"的事实，怎么刷（要不要就地重读）由 Renderer 决定。
 * 没有窗口（headless / 测试）静默跳过：`electron` 只在真的需要时才 require。
 */
function notifyWindows(channel, payload) {
  try {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win && !win.isDestroyed() && win.webContents) win.webContents.send(channel, payload);
      } catch {
        // 单个窗口失败不影响别的窗口
      }
    }
  } catch {
    // 没有 electron（headless / 单测）：无事可做
  }
}

/**
 * @param {{
 *   userData: string,
 *   getGateway: () => any,
 *   getCoreBridge: () => any,
 *   getMcpRuntime: () => any,
 *   getCompactionAgent: () => any,
 *   getPlansStore?: () => any,
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
      /**
       * `archived` = 用户在侧栏把它收起来了（归档是用户的决定，这里不改那个位）。
       * **但还往里写就等于把它的记录丢进看不见的地方** —— 2026-11-13 实测：会话一归档，
       * 心跳轮照常跑、正文照常落库，而侧栏翻不到这条会话，"它在你不看时做了什么"
       * 于是只剩事件流。所以另开一条，并把新 id 写回 settings（下面那份逻辑）。
       */
      if (isReusableSessionRow(row)) return sessionId;
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

  /**
   * 唤醒轮实际会用哪个模型（页面显示用）：只解析名字 + 会不会看图，不在这里判可用性
   * （严格解析留给真正发请求的那一层：`resolveTurnModel`）。
   */
  function modelFacts(route) {
    const settings = loadModelSettings(userData);
    let label = '';
    try {
      const cfg = String(route || '').trim()
        ? resolveApiConfigForRoute(settings, String(route).trim())
        : resolveTextApiConfig(settings);
      label = String((cfg && cfg.model) || '').trim();
    } catch {
      label = '';
    }
    return { modelLabel: label, modelVision: modelSeesImages(settings, route) };
  }

  /**
   * 这一轮用的文本模型会不会看图（结构判断：只看它在模型设置里被标成什么类型）。
   *
   * 为什么需要：唤醒轮没有 Renderer 会话，图片只能随请求发出去；模型不吃图就是 400，
   * 那一轮直接 WAKE_ERROR —— 与其让它白醒，不如只给文字并在状态块里说明"没看成"。
   * 说不准（找不到声明）就按"不会看"处理：错在保守一侧。
   *
   * @param {object} settings model-settings
   * @param {string} [route] 唤醒轮绑定的路由（`custom:<id>` / `builtin:...`；空 = 默认文本模型）
   */
  function modelSeesImages(settings, route) {
    let name = '';
    try {
      const cfg = String(route || '').trim()
        ? resolveApiConfigForRoute(settings || {}, String(route).trim())
        : resolveTextApiConfig(settings || {});
      name = String((cfg && cfg.model) || '').trim();
    } catch {
      return false;
    }
    if (!name) return false;
    const custom = (Array.isArray(settings.customModels) ? settings.customModels : []).find(
      (m) => m && String(m.name || '').trim() === name
    );
    if (custom) {
      const kind = String(custom.modalitySetting || custom.kind || '').trim();
      return kind === 'vision';
    }
    for (const supplier of Array.isArray(settings.modelSuppliers) ? settings.modelSuppliers : []) {
      const mod = supplier && supplier.modelModalities ? supplier.modelModalities : {};
      const hit = mod && Object.prototype.hasOwnProperty.call(mod, name) ? String(mod[name]).trim() : '';
      if (hit) return hit === 'vision';
    }
    return false;
  }

  /**
   * 这一轮能做什么、能改哪里（**唯一解析点**，每次唤醒现读 `alive/settings.json`）。
   *
   * 根目录的语义：用户没填 = 它自己的抽屉 `<userData>/alive/workspace`（默认为最保守：
   * 放手让它「真做事」不等于放手让它改你的项目 —— 要改项目得显式填那个目录）。
   * 填了但目录不存在 → 照样返回该路径，闸门会因为目标不可写而拒绝（不静默换成抽屉）。
   */
  function wakeScopeNow() {
    let saved = {};
    try {
      saved = storeRef ? storeRef.readSettings() : {};
    } catch {
      saved = {};
    }
    const power = normalizeWakePower(saved.wakePower);
    const custom = String(saved.wakeWorkspace || '').trim();
    const root = custom ? path.resolve(custom) : path.join(userData, 'alive', 'workspace');
    return { power, root, wakeWorkspace: custom };
  }

  const runtime = createAliveRuntime({
    userDataPath: userData,
    limits: limits(),
    log,
    getSenses: sensesNow,
    /** 绑定生命感的身体（点点）：事件转发给悬浮窗 + 状态块里报一行身体参数（主进程装配，headless 没有 → 两件都缺席） */
    onAliveEvent: typeof d.onAliveEvent === 'function' ? d.onAliveEvent : null,
    onThinking: typeof d.onThinking === 'function' ? d.onThinking : null,
    getPetBodyLine: typeof d.getPetBodyLine === 'function' ? d.getPetBodyLine : null,
    /**
     * 唤醒轮**之前**要拿到的外部事实（只有一个装配点）：
     *   - `recap`：最近这台机器上在做什么 + 未收尾的目标型计划（`src/alive/recap.js`）
     *   - `look` / `imageParts`：「醒来时先看一眼」的画面（`src/alive/eyes.js`）
     *   - `power` / `wakeRoot`：这一轮的权力档与允许动的根（提示词按事实说，而不是按假设说）
     *
     * 为什么放在这里而不是让它自己调工具：画面是**这一轮的输入**。用户勾了开关才取；
     * 每个失败都留事件，并如实写进状态块（不假装看过）。
     */
    collectFacts: async ({ nowMs, cfg: aliveCfg } = {}) => {
      const gateway = d.getGateway && d.getGateway();
      if (!gateway || typeof gateway.invokeRpc !== 'function') return null;
      const saved = storeRef ? storeRef.readSettings() : {};
      const wants = { camera: saved.wakeLookCamera === true, screen: saved.wakeLookScreen === true };
      /** @type {Array<object>} */
      let look = [];
      /** @type {Array<object>} */
      let imageParts = [];
      if (wants.camera || wants.screen) {
        const settings = loadModelSettings(userData);
        if (!modelSeesImages(settings, saved.modelRoute)) {
          // 文本模型没声明能看图：宁可不给图，也不要让这一轮 400（那一轮就白醒了）
          const why = '这一轮用的文本模型没声明能看图（设置 → 模型：把那个模型的类型标成「全模态」）';
          if (wants.camera) look.push({ tool: 'wake_camera', ok: false, errorCode: 'MODEL_NOT_VISION', error: why });
          if (wants.screen) look.push({ tool: 'wake_screen', ok: false, errorCode: 'MODEL_NOT_VISION', error: why });
        } else {
          const L = limits();
          const res = await captureWakeShots({
            wants,
            senses: sensesNow(),
            permissions: loadPermissions(path.join(userData, 'host-permissions.json')),
            cameraDevice: saved.cameraDevice,
            maxEdge: L.visionShotMaxEdge
          });
          imageParts = res.parts;
          look = res.seen;
          for (const shot of look) {
            runtime.recordEvent({
              kind: 'EYE',
              tool: String(shot.tool || ''),
              ok: shot.ok === true,
              /**
               * `auto: true` = 这一眼是**代码替它拍的输入**（「醒来时先看一眼」），不是它自己调的。
               * 对账口径靠这个字段区分：自动睁眼不算"做完的证据"（见 `runtime.js#recordEvent`），
               * 否则眼睛一开，`DONE_NO_EVIDENCE` 就再也不会出现。
               */
              auto: true,
              device: shot.device ? String(shot.device) : undefined,
              width: Number(shot.width) || undefined,
              height: Number(shot.height) || undefined,
              errorCode: shot.errorCode ? String(shot.errorCode) : undefined
            });
          }
        }
      }
      const L = limits();
      const recap = await collectRecap({
        invokeRpc: (method, params) => gateway.invokeRpc(method, params),
        selfSessionId: sessionId,
        nowMs: Number(nowMs) || Date.now(),
        /** 未收尾的目标型计划：读现成的存储（`plans/store.js`），不另建一份计划视图 */
        listPlans: () => {
          const plansStore = typeof d.getPlansStore === 'function' ? d.getPlansStore() : null;
          return plansStore && typeof plansStore.list === 'function' ? plansStore.list() : [];
        },
        limits: {
          recapWindowHours: L.aliveRecapWindowHours,
          recapSessions: L.aliveRecapSessions,
          recapTailChars: L.aliveRecapTailChars,
          recapPlans: L.aliveRecapPlans
        }
      });
      const scope = wakeScopeNow();
      /**
       * 它自己抽屉的最后几行 —— **它自己的记忆回到眼前**。
       *
       * 为什么由代码取、而不是指望它自己想起来调 `alive_read_note`：它每次醒来都是一张白纸，
       * 想不起来；抽屉里那句"让下次醒来的自己知道这次醒过"就永远没人看。
       * 这几行是「目标只能从记忆里长出来」的唯一原料，读本地文件、几十个字、不花 token。
       * 读不到（没开抽屉 / 目录还没建）一律按"没有"继续，不挡唤醒。
       */
      let note = [];
      const noteLines = Math.max(0, Number(L.aliveRecapNoteLines) || 0);
      if (noteLines > 0 && sensesNow().drawer) {
        try {
          note = String(readNote(userData) || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-noteLines)
            // 抽屉里每条本来就是 `- …`（`note.js` 写的）：状态块自己再加前缀，别叠成 "- -"
            .map((line) => clip(line.replace(/^[-*•]\s*/, ''), L.aliveRecapTailChars));
        } catch {
          note = [];
        }
      }
      // 「跟你现在有关、你记得的」：拿上面这些**具体事**去召回长期记忆。
      // 放在最后一步：它依赖 recap 与抽屉内容（查询就是从那两样拼出来的）。
      const memory = await recallMemoryForSituation({
        gateway,
        recap,
        note,
        cfg: aliveCfg || {},
        tailChars: L.aliveRecapTailChars,
        log
      });
      return { recap, look, imageParts, note, memory, power: scope.power, wakeRoot: scope.root };
    },
    turnRunner: async ({ stateBlock, signal, senses, imageParts }) => {
      const gateway = d.getGateway && d.getGateway();
      if (!gateway || typeof gateway.invokeRpc !== 'function') throw new Error('Gateway 未就绪');
      const sid = await ensureSession(gateway);
      // 关总开关时会 abort 这一轮：信号一路传到 `runMainTurn`（循环就此停下，不再烧 token）
      if (signal && signal.aborted) return null;
      const caps = senses || sensesNow();
      /**
       * 本机权限（不是感官开关）：`browser_*` 要 `browserAutomation`、`computer` 要 `osControl`。
       * 关掉的不注入工具表 —— 否则模型每轮试一次、每轮被拒。判定仍然是那两道既有闸
       * （`rpc.js` 的 assertBrowserAutomation / assertOsControl），这里只是**别发用不了的工具**。
       */
      const perms = cameraPermissions();
      const hostCaps = {
        browserAutomation: perms.browserAutomation === true,
        osControl: perms.osControl === true
      };
      /** 只给它**真能用**的工具：关掉的能力不注入，省得它反复试、反复被拒 */
      const extraTools = [ALIVE_DECIDE_TOOL];
      if (caps.drawer) extraTools.push(ALIVE_NOTE_TOOL, ALIVE_READ_NOTE_TOOL);
      if (caps.voice) extraTools.push(ALIVE_SPEAK_TOOL, ALIVE_LISTEN_TOOL);
      // 身体（点点）：绑定了生命感才有这两件（设置 → 宠物 → 绑定生命感）
      const petBridge = typeof d.getPetBridge === 'function' ? d.getPetBridge() : null;
      if (petBridge && petBridge.enabled()) extraTools.push(PET_SET_TOOL, PET_ACT_TOOL);

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
        // 身体（点点）：参数检查与执行和聊天轮是**同一份**（`alive/pet-tools.js` 的 runPetSet / runPetAct）
        if (name === 'pet_set') return runPetSet(petBridge, a);
        if (name === 'pet_act') return runPetAct(petBridge, a);
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
          const said = isSpeak && res && res.ok === true ? String(res.text || '').trim() : '';
          runtime.recordEvent({
            kind: isSpeak ? 'SPEAK' : 'LISTEN',
            ok: res && res.ok === true,
            errorCode: (res && res.errorCode) || undefined,
            chars: res && typeof res.chars === 'number' ? res.chars : undefined,
            seconds: res && Number(res.seconds) ? Number(res.seconds) : undefined,
            // 「说了什么」进事件流（逐条可回看，见「拟态 → 日志」）。
            // 这是展示用的事实，不进对话账本 —— 它不接管你的对话线。
            text: said ? said.slice(0, Math.max(0, Number(runtime.cfg.voiceTextMaxChars) || 0)) : undefined
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
        const tool = String(name || '');
        if (CAMERA_TOOL_NAMES.has(tool)) {
          const r = result && typeof result === 'object' ? result : {};
          runtime.recordEvent({
            kind: 'EYE',
            tool,
            ok: r.ok === true,
            device: r.device ? String(r.device) : undefined,
            width: Number(r.width) || undefined,
            height: Number(r.height) || undefined,
            errorCode: r.errorCode ? String(r.errorCode) : undefined
          });
          return null; // 不改写结果
        }
        // 放开档下它真的动了手：**改了什么/跑了什么必须留痕**，否则用户半夜丢了文件无从对账。
        // 只记工具名 + 目标/命令头部 + 成败，不记文件内容（那可能是用户的代码）。
        if (ACTION_TOOL_NAMES.has(tool) || ACTION_PLAYBACK_TOOL_NAMES.has(tool)) {
          const r = result && typeof result === 'object' ? result : {};
          runtime.recordEvent({
            kind: 'ACTION',
            tool,
            ok: r.ok !== false,
            target:
              tool === 'host_exec'
                ? String((_args && _args.command) || '').slice(0, 160) || undefined
                : String(
                    (_args && (_args.filePath || _args.url || _args.query || _args.action)) || ''
                  ).slice(0, 200) || undefined,
            errorCode: r.errorCode ? String(r.errorCode) : undefined
          });
        }
        return null;
      };

      // 这一轮的权力档与允许动的根：**每次唤醒现读**，改完下一轮就生效（不用重启）
      const scope = wakeScopeNow();
      const L = limits();
      const wakeBudget = {
        writes: 0,
        execs: 0,
        maxWrites: Math.max(0, Number(L.aliveWakeWriteMaxPerWake) || 0),
        maxExecs: Math.max(0, Number(L.aliveWakeExecMaxPerWake) || 0),
        /** 单条命令的硬超时（秒 → 毫秒）：关卡会把 `host_exec.timeoutMs` 夹到这个值 */
        timeoutMs: Math.max(0, Number(L.aliveWakeExecTimeoutSec) || 0) * 1000
      };

      const turn = await runMainTurn({
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
        /** 「醒来时先看一眼」的画面（默认空）：由 `collectFacts` 在跑这一轮之前取好 */
        imageParts: Array.isArray(imageParts) ? imageParts : [],
        toolScope: {
          readOnly: scope.power === 'read',
          wakePower: scope.power,
          wakeRoot: scope.root,
          wakeBudget,
          senses: caps,
          /** 本机能力开关（浏览器自动化 / 电脑控制）：工具表据此收窄，判定仍在既有闸上 */
          caps: hostCaps
        },
        extraTools,
        // 它自己的工具在**调用前**被这里接管：不经过工具桥（它们不是 host 工具）
        preTool,
        // host 工具**调用后**的留痕点：睁眼（EYE）与动手（ACTION）都只看事实，不改结果
        postTool,
        model: d.model || '',
        /** 它自己的脑子：`alive/settings.json` 里选的路由（空 = 跟随机型设置）；每次唤醒现读，改完不用重启 */
        route: (() => {
          try {
            return (storeRef ? storeRef.readSettings().modelRoute : '') || d.route || '';
          } catch {
            return d.route || '';
          }
        })(),
        signal: signal || null,
        listMcpServers: d.listMcpServers,
        // 后台心跳不向任何界面流式输出
        sink: null
      });
      // 这一轮已经落库：告诉界面（正开着它的会话就别让人切走再切回才看见）
      notifyWindows('alive:ran', { sessionId: sid, ts: Date.now() });
      // 这一轮的正文只落它自己的会话库（`sink: null`，不推给界面）；
      // runtime 只留压成一行的一份给侧栏「生命」页（`state.lastWakeText`）
      return turn;
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
      return {
        camera: perms.camera === true,
        desktopCamera: perms.desktopCamera === true,
        /** 屏幕截图与 `computer` 工具同一份授权（不另立一套"看屏幕"权限） */
        osControl: perms.osControl === true,
        /** 浏览器自动化（`browser_*`）：默认开，关掉就是关掉 */
        browserAutomation: perms.browserAutomation !== false
      };
    } catch {
      return { camera: false, desktopCamera: false, osControl: false, browserAutomation: false };
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
    const scope = wakeScopeNow();
    return {
      voice,
      /** 「醒来时先看一眼」：两个开关 + 各自还需要的那道权限（页面据此显示"还差什么"） */
      look: {
        camera: !!saved.wakeLookCamera,
        screen: !!saved.wakeLookScreen,
        cameraReady: perms.desktopCamera === true && !!(saved.senses && saved.senses.eyes),
        screenReady: perms.osControl === true,
        desktopCameraPermission: perms.desktopCamera === true,
        osControlPermission: perms.osControl === true
      },
      /** 它醒来能做什么（执行权不是权限页那种"两道锁"，而是一个显式档位 + 根目录 + 每轮次数） */
      power: {
        level: scope.power,
        root: scope.root,
        rootExists: fs.existsSync(scope.root),
        customRoot: !!scope.wakeWorkspace
      },
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
      /** 「醒来时先看一眼」（默认关；画面不落盘，见 `src/alive/eyes.js`） */
      wakeLookCamera: !!saved.wakeLookCamera,
      wakeLookScreen: !!saved.wakeLookScreen,
      /** 它自己的脑子（空 = 跟随机型设置的默认文本模型） */
      modelRoute: saved.modelRoute || '',
      ...modelFacts(saved.modelRoute),
      /**
       * 「设定」：用户随手写的那段话（设置页「拟态 → 设定」的一个文本框）。
       * 一并把字数上限带上（页面只在保存被截断时提示，不显示计数器）。
       */
      setup: saved.setup || '',
      setupMaxChars: Math.max(0, Number(limits().aliveSetupMaxChars) || 0),
      /** 它醒来能做什么（默认只读）与允许动的根 */
      wakePower: normalizeWakePower(saved.wakePower),
      wakePowerOptions: WAKE_POWERS.slice(),
      wakeWorkspace: saved.wakeWorkspace || '',
      wakeRoot: wakeScopeNow().root,
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
    // 「醒来时先看一眼」：摄像头一帧 / 屏幕一帧。默认关；打开只是"允许取图"，
    // 真正取的时候还要过 `permissions.desktopCamera` / `permissions.osControl`。
    if (key === 'wakeLookCamera' || key === 'wakeLookScreen') {
      const saved = store.writeSettings({ [key]: value === true });
      log(`[alive] ${key}：${saved[key] ? '开' : '关'}`);
      return { ok: true, [key]: saved[key] };
    }
    /**
     * 「设定」：一段自由文本，整块进唤醒轮的状态块。
     *
     * 为什么不另开一条 IPC：它与模型路由、权力档是同一类东西（`alive/settings.json` 里的一项），
     * 值类型只是"长文本"。截断与字数上限在 `store.writeSettings`（唯一写盘口，数字来自
     * `agent-limits`），这里不判第二遍。
     */
    if (key === 'setup') {
      const saved = store.writeSettings({ setup: String(value == null ? '' : value) });
      const stored = String(saved.setup || '');
      log(`[alive] 设定：${stored ? `${stored.length} 字` : '(清空)'}`);
      return { ok: true, setup: stored, setupMaxChars: Math.max(0, Number(limits().aliveSetupMaxChars) || 0) };
    }
    // 它自己的脑子：只接受路由记号（`custom:<id>` / `builtin:<sid>:<model>`），空 = 跟随机型设置。
    // 不校验"这个模型还在不在"：模型被删后保留原值，下一次唤醒会由 `resolveTurnModel`（strict）
    // 明确报错并记 WAKE_ERROR —— 静默换成别的模型比跑错更难查；页面会把"当前不可选"写出来。
    if (key === 'modelRoute') {
      const route = String(value == null ? '' : value).trim().slice(0, 160);
      const saved = store.writeSettings({ modelRoute: route });
      log(`[alive] 唤醒轮模型：${saved.modelRoute || '(跟随默认)'}`);
      return { ok: true, modelRoute: saved.modelRoute, ...modelFacts(saved.modelRoute) };
    }
    // 它醒来能做什么：read / write / exec。这是**执行权的开关**（默认只读），
    // 真正拦在 tool-gate 的 wake-power-scope 关卡里（根目录 / 每轮次数 / 不等待审批）。
    if (key === 'wakePower') {
      const want = String(value == null ? '' : value).trim();
      if (!WAKE_POWERS.includes(want)) {
        return { ok: false, error: `wakePower 只能是 ${WAKE_POWERS.join(' / ')}` };
      }
      const saved = store.writeSettings({ wakePower: want });
      log(`[alive] 唤醒轮权力：${saved.wakePower}`);
      return { ok: true, wakePower: saved.wakePower, wakeRoot: wakeScopeNow().root };
    }
    // 允许它动的根目录（空 = 它自己的抽屉）。不动文件系统：填错路径只会让闸门拒绝，
    // 不会偷偷改成默认目录（静默换目录比拒绝更难查）。
    if (key === 'wakeWorkspace') {
      const dir = String(value == null ? '' : value).trim().slice(0, 500);
      const saved = store.writeSettings({ wakeWorkspace: dir });
      const scope = wakeScopeNow();
      log(`[alive] 唤醒轮工作区：${scope.wakeWorkspace || '(自身抽屉)'} → ${scope.root}`);
      return { ok: true, wakeWorkspace: saved.wakeWorkspace, wakeRoot: scope.root, rootExists: fs.existsSync(scope.root) };
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
    reset: () => runtime.reset(),
    /** 设置页的「现在叫醒它一次」：跳过张力门限跑一轮（事件如实记 trigger=manual） */
    wakeOnce: () => runtime.wakeNow()
  };
}

module.exports = { bootAliveRuntime, ALIVE_SESSION_TITLE };
