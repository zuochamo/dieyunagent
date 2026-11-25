'use strict';

/**
 * 生命感运行时：**一个心跳、一套体征、一份状态文件**。
 *
 * 它不做的事（与原 `--alive` 设计的差别，见 docs/ALIVE.md）：
 * 不占预算、不会死、不衰减记忆、不产遗物、不绑定 incarnation、不隔离记忆。
 * 它只做四件事：按 300s 跳动、漂移体征、推进相位、在张力越线时**问模型要不要动**。
 *
 * 宿主无关：它只要一个 `turnRunner`，理论上桌面与 headless 都能跑。
 *
 * **现状（2026-11-10）**：只有桌面装配了它（`src/main/alive-boot.js` ← `src/main-entry.js`）。
 * headless **没有**装配 —— 服务器上没人看着，让它每 5 分钟自己决定醒不醒，等于把一份
 * 无人监管的模型账单放进 systemd 里。要装配得先定"什么时段/什么负载下允许醒"，
 * 那是另一次设计变更；在那之前别在这句注释里假装它已经跑在两处。
 */

const vitals = require('./vitals');
const tensionEngine = require('./tension');
const waker = require('./waker');
const decide = require('./decide');
const { createAliveStore } = require('./store');
const { onLlmUsage } = require('../agent/llm-usage-recorder');
const agentLimits = require('../agent/agent-limits');

const { clamp } = vitals;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从 `agent-limits` 取数并做一次结构性夹取。
 * 数字的唯一来源是 `agent-limits.js` 的 DEFAULTS（不进 SCHEMA：生命体征不是用户旋钮）；
 * 这里只保证「拿到的一定是能跑的值」——坏值不该让心跳直接崩。
 */
function resolveAliveConfig(limits) {
  const D = agentLimits.AGENT_LIMITS_DEFAULTS;
  const pick = (key) => (limits && limits[key] !== undefined ? limits[key] : D[key]);
  const cfg = {
    tickIntervalMs: clamp(num(pick('aliveTickIntervalMs'), D.aliveTickIntervalMs), 1000, 30 * 60 * 1000),
    wakeThreshold: num(pick('aliveWakeThreshold'), D.aliveWakeThreshold),
    wakeThresholdMin: num(pick('aliveWakeThresholdMin'), D.aliveWakeThresholdMin),
    wakeThresholdMax: num(pick('aliveWakeThresholdMax'), D.aliveWakeThresholdMax),
    wakeThresholdMuPerHour: num(pick('aliveWakeThresholdMuPerHour'), D.aliveWakeThresholdMuPerHour),
    wakeThresholdNuPerHour: num(pick('aliveWakeThresholdNuPerHour'), D.aliveWakeThresholdNuPerHour),
    wakeRefusalBaseline: num(pick('aliveWakeRefusalBaseline'), D.aliveWakeRefusalBaseline),
    refusalWindowMs: num(pick('aliveWakeRefusalWindowMs'), D.aliveWakeRefusalWindowMs),
    wakeMinIntervalMs: num(pick('aliveWakeMinIntervalMs'), D.aliveWakeMinIntervalMs),
    wakeMaxPerDay: Math.max(1, num(pick('aliveWakeMaxPerDay'), D.aliveWakeMaxPerDay)),
    tensionMean: num(pick('aliveTensionMean'), D.aliveTensionMean),
    tensionGainPerHour: num(pick('aliveTensionGainPerHour'), D.aliveTensionGainPerHour),
    tensionRestorePerHour: num(pick('aliveTensionRestorePerHour'), D.aliveTensionRestorePerHour),
    tensionEps: Math.max(0, num(pick('aliveTensionEps'), D.aliveTensionEps)),
    tensionMax: num(pick('aliveTensionMax'), D.aliveTensionMax),
    tensionIdleRampPerHour: num(pick('aliveTensionIdleRampPerHour'), D.aliveTensionIdleRampPerHour),
    tensionIdleGraceHours: num(pick('aliveTensionIdleGraceHours'), D.aliveTensionIdleGraceHours),
    tensionIdleMax: num(pick('aliveTensionIdleMax'), D.aliveTensionIdleMax),
    loopTensionUnit: num(pick('aliveLoopTensionUnit'), D.aliveLoopTensionUnit),
    loopMax: Math.max(1, num(pick('aliveLoopMax'), D.aliveLoopMax)),
    loopStaleHours: Math.max(1, num(pick('aliveLoopStaleHours'), D.aliveLoopStaleHours)),
    fatiguePerKToken: num(pick('aliveFatiguePerKToken'), D.aliveFatiguePerKToken),
    fatigueSettlePerHour: num(pick('aliveFatigueSettlePerHour'), D.aliveFatigueSettlePerHour),
    fatigueEps: Math.max(0, num(pick('aliveFatigueEps'), D.aliveFatigueEps)),
    voiceMaxPerDay: Math.max(0, num(pick('aliveVoiceMaxPerDay'), D.aliveVoiceMaxPerDay)),
    voiceMinIntervalMs: Math.max(0, num(pick('aliveVoiceMinIntervalMs'), D.aliveVoiceMinIntervalMs)),
    /** 「它说了什么」在事件流（`SPEAK.text`）里留多少字（展示用，不进对话账本） */
    voiceTextMaxChars: Math.max(0, num(pick('aliveVoiceTextMaxChars'), D.aliveVoiceTextMaxChars)),
    /** 「它这一轮醒来写下了什么」压成一行后留多少字（侧栏「生命」页那一行摘要；只展示） */
    wakeTextMaxChars: Math.max(0, num(pick('aliveWakeTextMaxChars'), D.aliveWakeTextMaxChars)),
    /** 每日 token 额度（成本护栏；`<=0` = 不限） */
    dailyTokenBudget: Math.max(0, num(pick('aliveDailyTokenBudget'), D.aliveDailyTokenBudget)),
    /** 体征历史的物理行数上限与默认窗口（`history.jsonl`） */
    historyMaxLines: Math.max(50, num(pick('aliveHistoryMaxLines'), D.aliveHistoryMaxLines)),
    historyWindowMs: Math.max(60 * 1000, num(pick('aliveHistoryWindowMs'), D.aliveHistoryWindowMs)),
    /** 决策日志保留条数（`decide.js` 用；数字只在 agent-limits） */
    decisionsKeep: Math.max(1, num(pick('aliveDecisionsKeep'), D.aliveDecisionsKeep)),
    intentsKeep: Math.max(1, num(pick('aliveIntentsKeep'), D.aliveIntentsKeep)),
    suspiciousWakeMin: Math.max(1, num(pick('aliveSuspiciousWakeMin'), D.aliveSuspiciousWakeMin)),
    phaseInertiaAlert: Math.max(1, num(pick('alivePhaseInertiaAlert'), D.alivePhaseInertiaAlert)),
    phaseInertiaLow: Math.max(1, num(pick('alivePhaseInertiaLow'), D.alivePhaseInertiaLow)),
    phaseInertiaSettle: Math.max(1, num(pick('alivePhaseInertiaSettle'), D.alivePhaseInertiaSettle)),
    phaseInertiaCompress: Math.max(1, num(pick('alivePhaseInertiaCompress'), D.alivePhaseInertiaCompress)),
    phaseLoadWindowMs: Math.max(1000, num(pick('alivePhaseLoadWindowMs'), D.alivePhaseLoadWindowMs)),
    phaseLoadHigh: num(pick('alivePhaseLoadHigh'), D.alivePhaseLoadHigh),
    phaseLoadLow: num(pick('alivePhaseLoadLow'), D.alivePhaseLoadLow),
    phaseFatigueHigh: num(pick('alivePhaseFatigueHigh'), D.alivePhaseFatigueHigh),
    phaseFatigueLow: num(pick('alivePhaseFatigueLow'), D.alivePhaseFatigueLow),
    loadTokensHigh: Math.max(1, num(pick('alivePhaseLoadTokensHigh'), D.alivePhaseLoadTokensHigh)),
    /** 「最近工作」事实块的字数上限（`recap.js` 装配、`decide.js` 截断用同一组数） */
    recapMaxChars: Math.max(0, num(pick('aliveRecapMaxChars'), D.aliveRecapMaxChars)),
    recapPlans: Math.max(0, num(pick('aliveRecapPlans'), D.aliveRecapPlans)),
    /** 事实块里带它自己抽屉的最后几行（它自己的记忆回到眼前） */
    recapNoteLines: Math.max(0, num(pick('aliveRecapNoteLines'), D.aliveRecapNoteLines)),
    /** 拿当前处境召回长期记忆：条数 / 查询串上限 / 超时（超时就当没召回到） */
    recallBySituation: Math.max(0, num(pick('aliveRecallBySituation'), D.aliveRecallBySituation)),
    recallQueryMaxChars: Math.max(0, num(pick('aliveRecallQueryMaxChars'), D.aliveRecallQueryMaxChars)),
    recallTimeoutMs: Math.max(0, num(pick('aliveRecallTimeoutMs'), D.aliveRecallTimeoutMs)),
    /**
     * 唤醒轮权力档的默认值（`read`）与放开后的每轮次数上限。
     * 实际档位在 `alive/settings.json#wakePower`；这里只提供默认值与护栏数字。
     */
    wakePowerDefault: String(pick('aliveWakePowerDefault') || D.aliveWakePowerDefault || 'read'),
    wakeWriteMaxPerWake: Math.max(0, num(pick('aliveWakeWriteMaxPerWake'), D.aliveWakeWriteMaxPerWake)),
    wakeExecMaxPerWake: Math.max(0, num(pick('aliveWakeExecMaxPerWake'), D.aliveWakeExecMaxPerWake)),
    readOnlyWake: pick('aliveReadOnlyWake') !== false
  };
  cfg.wakeThreshold = clamp(cfg.wakeThreshold, cfg.wakeThresholdMin, cfg.wakeThresholdMax);
  return cfg;
}

/** 一条体征采样（`history.jsonl` 的一行）：面板曲线的唯一数据形状 */
function sampleOf(state, nowMs) {
  return {
    ts: Number(nowMs) || Date.now(),
    phase: String(state.phase || ''),
    tension: Number(Number(state.tension || 0).toFixed(2)),
    fatigue: Number(Number(state.fatigue || 0).toFixed(2)),
    tokenToday: Number(state.tokenToday || 0),
    wakeCountToday: Number(state.wakeCountToday || 0)
  };
}

/**
 * 压成一行并截断：唤醒轮正文在侧栏「生命」页只占**一行摘要**，全文是它自己会话库的事。
 *
 * 为什么要压：正文常是多段带缩进的文字，原样塞进那一行会把面板撑成日志。
 */
function oneLine(text, maxChars) {
  return String(text == null ? '' : text)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, Math.max(0, Number(maxChars) || 0));
}

/** usage → token 数（形状归一还在 `llm-usage-stats`，这里只兜住缺字段） */
function usageTokens(usage) {  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.total_tokens != null ? usage.total_tokens : usage.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  const prompt = Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0;
  const completion =
    Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0;
  return Math.max(0, prompt) + Math.max(0, completion);
}

/**
 * @param {{ userDataPath: string, limits?: object, log?: any,
 *           now?: () => number, rng?: () => number,
 *           turnRunner?: ((ctx: object) => Promise<any>)|null }} opts
 */
function createAliveRuntime(opts) {
  const d = opts || {};
  const store = createAliveStore(d.userDataPath);
  const cfg = resolveAliveConfig(d.limits);
  const log = d.log || (() => {});
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const rng = typeof d.rng === 'function' ? d.rng : Math.random;

  /** @type {object|null} */
  let state = null;
  let timer = null;
  let ticking = false;
  let wakeInFlight = false;
  let unsubscribe = null;
  let pendingTokens = 0;
  /** 当前这一轮唤醒自己烧掉的 token（与 `pendingTokens` 同源，只用于成本回执） */
  let wakeTokens = 0;
  /** 这一轮唤醒模型有没有通过 `alive_decide` 表态（false = 记一条 `WAKE_NO_DECISION`） */
  let decisionThisWake = false;
  /**
   * 这一轮有没有**对得上事实**的动作：成功的 `ACTION`，或**它自己调的**睁眼。
   * 自动睁眼（`EYE` 带 `auto: true`）不算 —— 那是这一轮的输入，不是它做了什么。
   *
   * 对账在**轮末**（`runWakeTurn` 的 finally）做：这一轮用 `done` 关掉了条目，
   * 而整轮下来没有上面这类事实 → 记一条 `DONE_NO_EVIDENCE`。只留痕、不驳回
   * （可能这条昨天就验证过了，代码没有资格替它判断哪条算数）。
   */
  let evidenceThisWake = false;
  /** 这一轮用 `done` 关掉了几条（轮末对账用；每轮开头清零） */
  let doneThisWake = 0;
  /** 上一次记过「被上限拦住」的键（`dayKey:reason`）：同一上限每天只记一条事件 */
  let lastCapKey = '';
  /**
   * 停机代次：stop()/reset() 各 +1。
   *
   * 为什么需要它：唤醒轮是一次**几分钟的异步调用**，而「关开关」是同步动作。
   * 没有这个令牌时，关掉开关（或点「重新开始」清空）之后，那一轮回来后仍会 `store.write(state)`，
   * 于是：关掉的开关又写回一份状态、清空的状态被旧值复活。
   */
  let generation = 0;
  /** 当前唤醒轮的中止开关：关总开关 / 重新开始时直接中止那一轮（不再烧 token） */
  /** @type {AbortController|null} */
  let wakeAbort = null;
  /** @type {Array<{ ts: number, tokens: number }>} */
  let samples = [];
  /** 可换（单测 / 演示要换一套「这一轮怎么跑」）；`const` 会让 `setTurnRunner` 一调就抛 */
  let turnRunner = typeof d.turnRunner === 'function' ? d.turnRunner : null;
  /** 宿主提供的「这一轮的外部事实」装配（最近工作 + 醒来时先看一眼）；缺省 = 只有内部体征 */
  const collectFacts = typeof d.collectFacts === 'function' ? d.collectFacts : null;
  /** 感官开关的取值入口（由宿主提供；缺省 = 全关，宁可不给能力） */
  const getSenses =
    typeof d.getSenses === 'function'
      ? d.getSenses
      : () => ({ drawer: false, eyes: false, voice: false });

  function pushEvent(evt) {
    store.appendEvent(Object.assign({ ts: now() }, evt));
  }

  function loadState() {
    const raw = store.read();
    if (!raw) return null;
    if (Number(raw.version) !== vitals.STATE_VERSION) {
      const err = new Error(
        `生命状态版本不认识（文件 v${raw.version}，本程序 v${vitals.STATE_VERSION}）：不迁移、不猜`
      );
      err.code = 'ALIVE_STATE_VERSION';
      throw err;
    }
    return raw;
  }

  function ensureState() {
    if (state) return state;
    const loaded = loadState();
    const nowMs = now();
    if (loaded) {
      // 停机期间时间仍在走：让第一次漂移按真实间隔结算（上限 24h，避免一次睡一周就跳满）
      state = loaded;
    } else {
      state = vitals.createInitialState(cfg, nowMs);
      store.write(state);
      pushEvent({ kind: 'BIRTH', phase: state.phase, threshold: state.wakeThreshold });
      log(`[alive] 出生：${store.stateFile}`);
    }
    return state;
  }

  function computeLoad(nowMs) {
    const from = nowMs - cfg.phaseLoadWindowMs;
    while (samples.length && samples[0].ts < from) samples.shift();
    const tokens = samples.reduce((n, s) => n + s.tokens, 0);
    return clamp(tokens / cfg.loadTokensHigh, 0, 1);
  }

  async function runWakeTurn() {
    if (typeof turnRunner !== 'function') {
      pushEvent({ kind: 'WAKE_SKIPPED', reason: 'no-turn-runner' });
      return;
    }
    if (wakeInFlight) {
      pushEvent({ kind: 'WAKE_SKIPPED', reason: 'already-running' });
      return;
    }
    wakeInFlight = true;
    const gen = generation;
    wakeAbort = new AbortController();
    const nowMs = now();
    /** 这一轮自己烧掉的 token（只数 `wakeInFlight` 期间的用量，与疲劳同一口径） */
    wakeTokens = 0;
    /** 这一轮有没有通过 `alive_decide` 表过态（没表态 = 观测缺口，记一条事件） */
    decisionThisWake = false;
    /** 这一轮有没有**对得上事实**的动作（成功的 ACTION / 它自己调的睁眼；自动睁眼不算）：说"做完了"要靠它 */
    evidenceThisWake = false;
    /** 这一轮用 `done` 关掉了几条（**按整轮**对账：见 finally 里的 DONE_NO_EVIDENCE；`alive_decide` 只在唤醒轮注入，轮外没人能改它） */
    doneThisWake = 0;
    let senses = { drawer: false, eyes: false, voice: false };
    try {
      senses = getSenses() || senses;
    } catch {
      // 读不到能力就当没有
    }
    /**
     * 「设定」（设置 → 拟态 → 设定）：用户随手写的一段话，**每次唤醒现读** ——
     * 用户在设置页改完，下一轮就按新的走（与感官、模型路由同一套"现读"语义）。
     * 字数上限在 `store.readSettings`（唯一读盘口）已经夹过，这里只取原文。
     */
    let setup = '';
    try {
      setup = String((store.readSettings() || {}).setup || '');
    } catch {
      // 读不到就当没写：设定缺了不挡唤醒
    }
    // `load`（最近 5 分钟这台机器上有没有对话活动）也递进去：它是「有没有人在场」的**结构事实**，
    // 决定提示词里那句「没人在等你」成不成立（不再由代码替它假设没人）。
    //
    // `collectFacts`（宿主可选）：拿到「最近这台机器上在做什么」与「醒来时先看一眼」的画面。
    // 画面必须在跑这一轮**之前**取（它是输入，不是它能选择去调的工具），所以装配点在宿主，
    // 渲染仍只在 `decide.renderStateBlock` 一处。取事实失败一律按「什么也没有」继续，不挡唤醒。
    let facts = null;
    if (typeof collectFacts === 'function') {
      try {
        facts = await collectFacts({ nowMs, senses, state, cfg });
      } catch (err) {
        log(`[alive] 取事实失败：${(err && err.message) || err}`);
        facts = null;
      }
    }
    const stateBlock = decide.renderStateBlock(state, cfg, {
      nowMs,
      senses,
      /** 用户写的那段设定：排在一切事实之前（先知道"我该在意什么"） */
      setup,
      load: computeLoad(nowMs),
      /** 绑定生命感的身体（点点）当前参数：它要操控自己得先知道现在长什么样 */
      body: typeof d.getPetBodyLine === 'function' ? d.getPetBodyLine() : null,
      recap: facts && facts.recap,
      /** 它自己抽屉的最后几行：先想起上次到哪儿了，再看外面（目标的唯一原料） */
      note: facts && Array.isArray(facts.note) ? facts.note : null,
      /** 拿当前处境召回的长期记忆：不是默认注入那几条"偏好"，而是跟眼下这些事相关的 */
      memory: facts && Array.isArray(facts.memory) ? facts.memory : null,
      look: facts && facts.look,
      /** 这一轮的权力档与允许动的根（`collectFacts` 从 `alive/settings.json` 现读） */
      power: facts && facts.power,
      wakeRoot: facts && facts.wakeRoot
    });
    /**
     * 这一轮醒来的**正文**：`turnRunner` 返回的 `content`（`internal: true` 的那一轮不会自己推给界面，
     * 全文只落进它自己的会话库）。这里只留压成一行的一份给侧栏「生命」页，见 `state.lastWakeText`。
     */
    // 「思考中」信号（绑定生命感的身体表现用）：直发不走事件文件 —— 推理开始/结束是瞬时的，
    // 写进 events.jsonl 只会把事件量翻倍（逐跳写事件是明确反模式）。
    if (typeof d.onThinking === 'function') {
      try {
        d.onThinking(true);
      } catch {
        // 表现层失败不挡唤醒
      }
    }
    let wakeText = '';
    try {
      const turn = await turnRunner({
        stateBlock,
        state,
        cfg,
        senses,
        imageParts: (facts && Array.isArray(facts.imageParts) && facts.imageParts) || [],
        signal: wakeAbort.signal
      });
      wakeText = String((turn && turn.content) || '');
    } catch (err) {
      pushEvent({
        kind: 'WAKE_ERROR',
        message: String((err && err.message) || err).slice(0, 300)
      });
      log(`[alive] 唤醒轮失败：${(err && err.message) || err}`);
    } finally {
      if (typeof d.onThinking === 'function') {
        try {
          d.onThinking(false);
        } catch {
          // ignore
        }
      }
      wakeInFlight = false;
      wakeAbort = null;
      // 期间被关掉/清空过：这一轮的结果作废，不写盘、不记事件（否则会把停表或清空覆盖掉）
      if (gen !== generation) return;
      const durationMs = Math.max(0, now() - nowMs);
      state.lastWakeTokens = wakeTokens;
      state.lastWakeDurationMs = durationMs;
      /**
       * 这一轮醒来**写下了什么**（结论一行）：人回到侧栏「生命」页才看得见它在你不看时做了什么。
       *
       * 仍然是**展示**语义 —— 不进会话账本、不进模型上下文（那才是接管对话线）；全文在它自己的会话库。
       * 空正文（DEFER 那种没写东西的一轮）不覆盖上一行：那一行说的是"最近一次写下的话"。
       */
      const wrote = oneLine(wakeText, cfg.wakeTextMaxChars);
      if (wrote) {
        state.lastWakeText = wrote;
        state.lastWakeTextAt = now();
      }
      // 成本护栏的记账与 WAKE_END.tokens 是**同一个数**（不另算一遍）；跨天由 tick 的 rollDay 归零
      state.tokenToday = Number(state.tokenToday || 0) + wakeTokens;
      pushEvent({
        kind: 'WAKE_END',
        phase: state.phase,
        tension: Number(Number(state.tension).toFixed(1)),
        // 成本可见：一次醒来花了多少 token / 多久（"心跳贵不贵"这个问题以前只能翻 state.json）
        tokens: wakeTokens,
        durationMs
      });
      if (!decisionThisWake) {
        // 只观测：模型没表态时这轮就白醒了（张力继续累积），但页面/日志要能看出这件事
        pushEvent({ kind: 'WAKE_NO_DECISION', tokens: wakeTokens, durationMs });
      }
      /**
       * 说「做完了」却对不上事实：**按整轮判**，不按「决定那一刻」判。
       *
       * 为什么改（2026-11-14 实测）：它常在轮初就先把条目 `done` 交掉、再去跑命令复核
       * （06:38 那轮：`done` 在 06:38:55，4 个成功动作在 06:38:59–06:39:21）。按时刻判，
       * 这种「先划掉、再验证」的正常顺序会被记成缺依据 —— 那是假警报，假警报一多这条对账就没人看了。
       * 只留痕、不驳回：这条可能昨天就验证过了，代码没有资格替它判断哪条算数。
       */
      if (doneThisWake > 0 && !evidenceThisWake) {
        pushEvent({ kind: 'DONE_NO_EVIDENCE', done: doneThisWake });
      }
      store.write(state);
    }
  }

  /** 一次心跳（`tickOnce` 是测试/演示的入口，定时器只是它的调用者） */
  async function tickOnce() {
    if (ticking) return { skipped: 'busy' };
    ticking = true;
    try {
      const st = ensureState();
      const nowMs = now();
      const tokens = pendingTokens;
      pendingTokens = 0;
      const dtH = clamp((nowMs - Number(st.lastTickAt || nowMs)) / 3600000, 0, 24);
      const loopTension = tensionEngine.totalLoopTension(st.loops, nowMs, cfg);
      vitals.stepVitals(st, { nowMs, tokens, loopTension, cfg, rng });
      const pruned = tensionEngine.pruneLoops(st, { nowMs, cfg });
      tensionEngine.driftThreshold(st, { nowMs, dtH, cfg });
      tensionEngine.pruneDecisions(st, { nowMs, cfg });
      const load = computeLoad(nowMs);
      const phaseRes = vitals.stepPhase(st, { nowMs, load, cfg });
      if (phaseRes.changed) {
        pushEvent({ kind: 'PHASE', from: phaseRes.from, to: phaseRes.to, load: Number(load.toFixed(2)) });
      }
      const decision = waker.evaluate({ state: st, cfg, nowMs });
      if (decision.wake) {
        waker.markWoken(st, nowMs);
        pushEvent({
          kind: 'WAKE',
          trigger: 'internal',
          tension: Number(Number(st.tension).toFixed(1)),
          threshold: Number(Number(st.wakeThreshold).toFixed(1)),
          phase: st.phase,
          // 当时这台机器忙不忙：`load` 高 = 有人正在用（它是在你说话时醒的），
          // 这条以前只影响相位标签，后果（抢 token / 延迟）完全看不见
          load: Number(load.toFixed(2))
        });
        store.write(st);
        // 唤醒轮内部会再次写盘；先落一次「已唤醒」再跑，避免异常时丢掉这次唤醒
        await runWakeTurn();
      } else {
        // 只有**被上限拦住**才记事件（'below-threshold' 是常态，记下来就变成逐跳写 TICK 了；
        // 'cooldown' / 'compressing' 从 lastWakeAt 与相位上本来就看得出来）。
        // 同一类型的上限每天只记一次：否则超额度后每跳一行，把决策日志挤干净。
        const capKey = decision.reason === 'token-day-cap' || decision.reason === 'daily-cap'
          ? `${st.dayKey}:${decision.reason}`
          : '';
        if (capKey && capKey !== lastCapKey) {
          lastCapKey = capKey;
          const evt = {
            kind: 'WAKE_SKIPPED',
            reason: decision.reason,
            tension: Number(Number(st.tension).toFixed(1)),
            threshold: Number(Number(st.wakeThreshold).toFixed(1))
          };
          if (decision.reason === 'token-day-cap') {
            evt.tokenToday = Number(st.tokenToday || 0);
            evt.budget = cfg.dailyTokenBudget;
          }
          pushEvent(evt);
        }
        store.write(st);
      }
      // 体征采样（`history.jsonl`）：每跳一条，供面板画曲线。
      // 心跳本身不调模型，一行 ~90 字节；裁剪与事件流共用同一套 trimJsonl。
      store.appendSample(sampleOf(st, nowMs), { maxLines: cfg.historyMaxLines });
      return {
        skipped: null,
        wake: decision.wake,
        reason: decision.reason,
        pruned,
        phase: st.phase,
        tension: st.tension,
        fatigue: st.fatigue,
        threshold: st.wakeThreshold
      };
    } finally {
      ticking = false;
    }
  }

  /**
   * 人按了一下「现在叫醒它一次」：**跳过张力门限**直接跑一轮（演示 / 排障入口）。
   *
   * 为什么留这条路：它只有「张力越线」一个门，而越线是几小时一次 ——
   * 你要验证"嘴和眼配好了没有""它到底会不会开口"，没有这道手动门就只能等。
   * 三条硬约定，缺一条就别加这个入口：
   *   1. 事件**如实**记 `trigger: 'manual'`：账本里不能把人的手写成"它自己醒的"；
   *   2. 不伪造体征：`markWoken` 只记这次唤醒（次数 / 时间），张力原样保留，不假装越线；
   *   3. 每日 token 额度仍然拦（那是钱）；已经在跑就直接跳过，不排队。
   */
  async function wakeNow() {
    const st = ensureState();
    if (wakeInFlight) return { ok: false, reason: 'already-running' };
    const budget = Number(cfg.dailyTokenBudget) || 0;
    if (budget > 0 && Number(st.tokenToday || 0) >= budget) {
      pushEvent({ kind: 'WAKE_SKIPPED', reason: 'token-day-cap' });
      return { ok: false, reason: 'token-day-cap' };
    }
    const nowMs = now();
    waker.markWoken(st, nowMs);
    pushEvent({
      kind: 'WAKE',
      trigger: 'manual',
      tension: Number(Number(st.tension).toFixed(1)),
      threshold: Number(Number(st.wakeThreshold).toFixed(1)),
      phase: st.phase,
      load: Number(computeLoad(nowMs).toFixed(2))
    });
    store.write(st);
    await runWakeTurn();
    return { ok: true };
  }

  function start() {
    if (timer) return false;
    ensureState();
    if (!unsubscribe) {
      unsubscribe = onLlmUsage((usage) => {
        const tokens = usageTokens(usage);
        if (tokens <= 0) return;
        // 负载（相位用）看的是「这台机器现在忙不忙」：用户聊天也算忙 → 全局旁听。
        samples.push({ ts: now(), tokens });
        const from = now() - cfg.phaseLoadWindowMs;
        samples = samples.filter((s) => s.ts >= from);
        // 疲劳（它自己累不累）**只数唤醒轮用掉的 token**。
        // 用户在主对话里烧的 token 不是它的账 —— 否则「疲劳」测的是「你有没有在聊天」，
        // 一次长对话就能把它钉在 100 并长期压进 COMPRESS 相位（见 issue/2026-11-10）。
        if (!wakeInFlight) return;
        pendingTokens += tokens;
        wakeTokens += tokens;
      });
    }
    timer = setInterval(() => {
      tickOnce().catch((err) => log(`[alive] tick 失败：${(err && err.message) || err}`));
    }, cfg.tickIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`[alive] 心跳已启动（${Math.round(cfg.tickIntervalMs / 1000)}s）`);
    return true;
  }

  function stop() {
    generation += 1;
    // 中止在跑的那一轮：关开关之后不该继续烧 token、也不该继续写会话
    if (wakeAbort) {
      try {
        wakeAbort.abort();
      } catch {
        // ignore
      }
      wakeAbort = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
      unsubscribe = null;
    }
    // 停机也落一次：否则「上次 tick」永远停在上一个心跳，重开会结算一大段时间
    if (state) {
      try {
        store.write(state);
      } catch {
        // ignore
      }
    }
    return true;
  }

  /**
   * 记一条事件。**事件流的唯一出口**：感官（说/听/看）这类由调用方测得的事实，
   * 也必须从这里落盘，而不是各自 `store.appendEvent`（否则口径会分叉）。
   */
  function recordEvent(evt) {
    if (!evt || !evt.kind) return false;
    // 事实依据只认**它自己做的**两件事：成功动手（ACTION）与它自己调用的睁眼（EYE）。
    // **自动睁眼不算**（`auto: true`，来自 `alive-boot#collectFacts` 的「醒来时先看一眼」）：
    // 那是这一轮的**输入**，不是它做了什么 —— 把它算成依据等于每轮免检。
    // 2026-11-13 实测的后果：眼睛一开，`DONE_NO_EVIDENCE` 就再也记不出来过，这条对账是关着的。
    if (evt.ok === true && (evt.kind === 'ACTION' || (evt.kind === 'EYE' && evt.auto !== true))) {
      evidenceThisWake = true;
    }
    pushEvent(evt);
    // 绑定生命感的身体（点点）订阅这一出口：宿主转发给悬浮窗做涟漪/暗淡等即时表现。
    // 只转发不落盘，失败不影响事件流本身。
    if (typeof d.onAliveEvent === 'function') {
      try {
        d.onAliveEvent({
          kind: evt.kind,
          ok: evt.ok,
          phase: state ? state.phase : '',
          fatigue: state ? state.fatigue : 0,
          load: computeLoad(now())
        });
      } catch {
        // 表现层失败不记账
      }
    }
    return true;
  }

  /**
   * 主动出声/收音的记账（**成功之后**才调；跨天重置由 tick 的 `rollDay` 负责）。
   *
   * 只记两件与频率上限有关的事实：当日次数与上次时间（`voicePolicy` 读它）。
   * 「说了什么」不再往 state 里留副本：原话在事件流 `SPEAK.text` 里（`alive-boot` 写，
   * 长度受 `aliveVoiceTextMaxChars` 约束），人要看就翻「拟态 → 日志」。
   */
  function noteVoice(atMs) {
    if (!state) return false;
    state.voiceCountToday = Number(state.voiceCountToday || 0) + 1;
    state.lastVoiceAt = Number.isFinite(Number(atMs)) ? Number(atMs) : now();
    try {
      store.write(state);
    } catch {
      // 记不上只影响频率上限的精度，不影响这一轮已经发生的事
    }
    return true;
  }

  /** 模型通过 `alive_decide` 工具落到这里（唯一写决策的入口） */
  function applyDecision(args) {
    if (!state) {
      try {
        ensureState();
      } catch (err) {
        return { ok: false, error: (err && err.message) || '生命状态不可读' };
      }
    }
    const res = decide.applyDecision(state, args, { cfg, nowMs: now() });
    if (res.ok) {
      // 这一轮"表过态了"：`WAKE_END` 之后才不会被记成 WAKE_NO_DECISION
      decisionThisWake = true;
      pushEvent({
        kind: 'DECISION',
        decision: res.decision,
        loopId: args && args.loopId ? String(args.loopId) : null,
        closed: !!res.closedLoop,
        /** 「做完收口」了几条（ACT + done）：与 REFUSE 的 closed 分开记，别混成"拒绝" */
        done: Array.isArray(res.doneIds) && res.doneIds.length ? res.doneIds.length : 0
      });
      // 说做完却没有事实依据：**只在轮末判**（见 `runWakeTurn` 的 finally），这里只记数
      if (Array.isArray(res.doneIds) && res.doneIds.length) doneThisWake += res.doneIds.length;
      store.write(state);
    }
    return res;
  }

  function status() {
    let st = state;
    if (!st) {
      if (!store.exists()) return { enabled: false, running: false, exists: false };
      try {
        st = loadState();
      } catch (err) {
        // 坏版本 / 坏文件不该让整页崩：如实报一行原因，页面显示「不可读」
        return {
          enabled: true,
          running: !!timer,
          exists: true,
          unreadable: (err && err.message) || String(err)
        };
      }
    }
    if (!st) return { enabled: false, running: false, exists: false };
    return {
      enabled: true,
      running: !!timer,
      exists: true,
      bornAt: st.bornAt,
      lastTickAt: st.lastTickAt,
      lastWakeAt: st.lastWakeAt,
      tickCount: st.tickCount,
      phase: st.phase,
      phaseEnteredAt: st.phaseEnteredAt,
      tension: st.tension,
      wakeThreshold: st.wakeThreshold,
      fatigue: st.fatigue,
      /** 今日唤醒轮花掉的 token 与额度（成本护栏的可读回执） */
      tokenToday: Number(st.tokenToday || 0),
      dailyTokenBudget: cfg.dailyTokenBudget,
      /** 疲劳的解释线：到这里就进压缩相位（页面据此给出可读解释，而不是两个矛盾的数字） */
      fatigueHigh: cfg.phaseFatigueHigh,
      /** 静息回落速度（每小时）：解释"为什么等一会儿就能再醒" */
      fatigueSettlePerHour: cfg.fatigueSettlePerHour,
      /** 主动出声/收音：当日次数、上次时间与上限（页面对账用） */
      voiceCountToday: Number(st.voiceCountToday || 0),
      lastVoiceAt: Number(st.lastVoiceAt || 0),
      voiceMaxPerDay: cfg.voiceMaxPerDay,
      /** 两次主动开口的最小间隔（页面文案也读它：别在 Renderer 再抄一个"30 分钟"） */
      voiceMinIntervalMs: cfg.voiceMinIntervalMs,
      /** 上一次醒来的成本（token / 耗时）：成本可见，别让"心跳贵不贵"只能猜 */
      lastWakeTokens: Number(st.lastWakeTokens || 0),
      lastWakeDurationMs: Number(st.lastWakeDurationMs || 0),
      /**
       * 它**这一轮醒来写下了什么**（正文压成一行）与时间：唤醒轮不推界面、也不进对话账本，
       * 没有这一项的话，它一晚上写的几万字只有它自己看得到（侧栏「生命」页那一行据此显示）。
       */
      lastWakeText: String(st.lastWakeText || ''),
      lastWakeTextAt: Number(st.lastWakeTextAt || 0),
      loops: (st.loops || []).length,
      wakeCountToday: st.wakeCountToday,
      wakeMaxPerDay: cfg.wakeMaxPerDay,
      actCount: st.actCount,
      deferCount: st.deferCount,
      refuseCount: st.refuseCount,
      /** 当日拒绝数（跨天重置）：`suspiciousObedience` 只该看今天，不看历史累计 */
      refuseToday: st.refuseToday,
      tickIntervalMs: cfg.tickIntervalMs,
      totalTokens: st.totalTokens,
      suspiciousObedience: decide.suspiciousObedience(st, cfg)
    };
  }

  function decisions(limit) {
    return store.readEvents(limit || 30);
  }

  /**
   * 体征历史（面板曲线）。
   *
   * 数据来源只有 `history.jsonl`（每跳一条、只追加），抽样在**读侧**做：
   * 面板要 ~240 个点，而文件里可能有几千行 —— 把降采样放读侧，写侧就能保持纯 append。
   */
  function history(opts) {
    const o = opts || {};
    const windowMs = Math.max(60 * 1000, Number(o.windowMs) || cfg.historyWindowMs);
    const res = store.readSamples({ windowMs, points: o.points, nowMs: now() });
    return { samples: res.samples, total: res.total, windowMs };
  }

  /** 彻底重置（设置页「清除体征状态」：等同让它重新出生，历史事件一并清空） */
  function reset() {
    stop();
    store.clear();
    state = null;
    pendingTokens = 0;
    samples = [];
    return true;
  }

  function setTurnRunner(fn) {
    turnRunner = typeof fn === 'function' ? fn : null;
    return true;
  }

  function senses() {
    try {
      return getSenses() || { drawer: false, eyes: false, voice: false };
    } catch {
      return { drawer: false, eyes: false, voice: false };
    }
  }

  return {
    cfg,
    store,
    start,
    stop,
    reset,
    tickOnce,
    wakeNow,
    applyDecision,
    recordEvent,
    noteVoice,
    setTurnRunner,
    senses,
    status,
    decisions,
    history,
    getState: () => state,
    getTickIntervalMs: () => cfg.tickIntervalMs,
    isRunning: () => !!timer
  };
}

module.exports = {
  createAliveRuntime,
  resolveAliveConfig,
  usageTokens
};
