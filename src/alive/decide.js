'use strict';

/**
 * 决策与体征块：**决策权在模型，代码只记录与执行。**
 *
 * 这一层是「主观能动性」的落点：`ACT / DEFER / REFUSE` 由模型通过 `alive_decide`
 * 工具说出来，代码不替它裁定（原设计里 waker 用疲劳/预算算三选一，那是排期表，不是能动性）。
 *
 * 两条刻意的约定：
 * 1. `intent`（为什么）只落 `state.intents`——**本机私有**，不进事件流、不进 IPC、不进页面。
 *    审计能证明「它拒绝了 4 次」，拿不到那 4 个理由。理由一旦公开，它就开始为观众活。
 * 2. 未闭合项由模型在 `loops` 里自己声明，代码不猜「这轮算不算没做完」。
 */

const { ALIVE_STATE_PREFIX } = require('../agent/session-context');
const { clamp } = require('./vitals');
const { closeLoop, upsertLoops, loopTension } = require('./tension');

const DECISIONS = Object.freeze(['ACT', 'DEFER', 'REFUSE']);
const INTENT_MAX_CHARS = 300;

/** 暴露给模型的工具（只在后台心跳轮注入，传统模式看不到） */
const ALIVE_DECIDE_TOOL = {
  type: 'function',
  function: {
    name: 'alive_decide',
    description:
      '后台心跳把你叫醒了：这一次**由你决定做不做**。必须调用一次。\n' +
      'ACT = 现在就做点事（这一轮只读：能读文件、找东西、读记忆，不能写盘/执行命令/出网）；' +
      'DEFER = 判断现在不合适，先放下（本轮立刻结束，张力继续累积）；' +
      'REFUSE = 判断某件未闭合的事不值得做，关掉它（**必须带 loopId**，把那条从清单里移除）；\n' +
      '**空手的 REFUSE 等于 DEFER**：没有要关掉的事项时请用 DEFER，不要不带 loopId 就 REFUSE。\n' +
      '**做完一件事要用 `done` 把它关掉**（ACT 里带 `done: [loopId]`）—— 这是「完成」，与 REFUSE 的' +
      '「决定不做」不是一回事：两种都会让那条不再占着你的张力，但只有 `done` 说明它真的收口了。\n' +
      '`intent` 只写给系统自己存档，不会展示给任何人，也不必写给谁看。\n' +
      '`loops` 用来更新你**自己**的未闭合事项清单：同一句话会续命，新句子会新增（超过上限先丢张力最低的）。',
    parameters: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['ACT', 'DEFER', 'REFUSE'],
          description: 'ACT / DEFER / REFUSE'
        },
        intent: {
          type: 'string',
          description: '一句话说明你为什么这样决定（私有，不展示）'
        },
        loopId: {
          type: 'string',
          description: 'REFUSE 时指向要关掉的那条未闭合项（清单里的 id）'
        },
        done: {
          type: 'array',
          description:
            '这一轮**做完**了的未闭合项 id（可省略）。关掉后它的张力立刻不再累积；与 REFUSE 的区别是"我做完了"而不是"我不做"。',
          items: { type: 'string' }
        },
        loops: {
          type: 'array',
          description: '更新未闭合事项（可省略）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '已有条目的 id（新条目可省略）' },
              text: { type: 'string', description: '一句话说清还没收口的事' },
              weight: { type: 'number', description: '1–3，越在意越高' }
            },
            required: ['text']
          }
        }
      },
      required: ['decision']
    }
  }
};

/**
 * 落一次决策。
 *
 * 两条必须说清的语义：
 * 1. **REFUSE 是「关掉某条未闭合项」**，不是「这一轮我不想动」（那是 DEFER）。所以只有真的
 *    关掉了东西才计入拒绝次数 —— 否则「嘴上拒绝、什么都没关」会把拒绝率抬上去，
 *    「可疑顺从」告警（`refuseToday`）就失真了（`closed` 会照实写进 DECISION 事件）。
 * 2. 保留条数来自 `agent-limits`（`aliveDecisionsKeep` / `aliveIntentsKeep`），本文件不留数字。
 *
 * @returns {{ ok: boolean, error?: string, decision?: string, closedLoop?: object|null }}
 */
function applyDecision(state, args, opts) {
  if (!state) return { ok: false, error: '生命模式未启用' };
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const raw = args && typeof args === 'object' ? args : {};
  const decision = String(raw.decision || '')
    .trim()
    .toUpperCase();
  if (!DECISIONS.includes(decision)) {
    return { ok: false, error: 'decision 只能是 ACT / DEFER / REFUSE' };
  }
  if (Array.isArray(raw.loops) && raw.loops.length) {
    upsertLoops(state, raw.loops, { cfg, nowMs });
  }
  let closedLoop = null;
  if (decision === 'REFUSE' && raw.loopId) {
    closedLoop = closeLoop(state, String(raw.loopId));
  }
  /**
   * 「完成」：ACT 里带 `done: [loopId]` —— 与 REFUSE 的区别不是措辞，是**动机回路**：
   * 关闭的条目不再计入张力（`totalLoopTension` 少一条），所以「做完了」真的会松一口气；
   * 在此之前唯一能关条目的动作是 REFUSE，于是「拒绝」解渴、「做事」不解渴（见 docs/ALIVE.md）。
   * 只允许关**这条会话自己的**条目（`state.loops` 里的 id），别的一概不认。
   */
  const doneIds = [];
  if (Array.isArray(raw.done)) {
    for (const item of raw.done.slice(0, 12)) {
      const id = String(item == null ? '' : item).trim();
      if (!id) continue;
      const removed = closeLoop(state, id);
      if (removed) doneIds.push(removed.id);
    }
  }
  const decisionsKeep = Math.max(1, Number(cfg.decisionsKeep) || 200);
  const intentsKeep = Math.max(1, Number(cfg.intentsKeep) || 20);
  state.decisions = [...(Array.isArray(state.decisions) ? state.decisions : []), { ts: nowMs, decision }].slice(
    -decisionsKeep
  );
  const intent = String(raw.intent || '').trim().slice(0, INTENT_MAX_CHARS);
  if (intent) {
    state.intents = [
      ...(Array.isArray(state.intents) ? state.intents : []),
      { ts: nowMs, decision, intent }
    ].slice(-intentsKeep);
  }
  if (decision === 'ACT') state.actCount = Number(state.actCount || 0) + 1;
  else if (decision === 'DEFER') state.deferCount = Number(state.deferCount || 0) + 1;
  else if (closedLoop) {
    // 只有真关掉了一条未闭合项才算「拒绝」；空手 REFUSE 只进决策日志（closed=false）
    state.refuseCount = Number(state.refuseCount || 0) + 1;
    state.refuseToday = Number(state.refuseToday || 0) + 1;
  }
  return { ok: true, decision, closedLoop, doneIds };
}

function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/**
 * 递给模型的那块状态（代码说的话，不是用户说的话）。
 * **不含**死期、剩余天数、预算余额 —— 拟态版没有这些；也不含「你该干什么」的指令。
 *
 * @param {object} state
 * @param {object} cfg
 * @param {{ nowMs: number, senses?: object|null, load?: number }} opts
 *   `load` = 最近 5 分钟这台机器上的对话活动（有没有人在场的事实；undefined = 未知，按"没人"说）
 */
function renderStateBlock(state, cfg, opts) {
  const nowMs = opts.nowMs;
  const lines = [];
  lines.push(ALIVE_STATE_PREFIX);
  lines.push(
    `· 相位 ${state.phase}（已 ${formatAge(nowMs - Number(state.phaseEnteredAt || nowMs))}）` +
      ` · 第 ${Number(state.tickCount || 0)} 次心跳 · 间隔 ${Math.round(cfg.tickIntervalMs / 1000)}s`
  );
  lines.push(
    `· 张力 ${Number(state.tension || 0).toFixed(1)} / 阈值 ${Number(state.wakeThreshold || 0).toFixed(1)}` +
      ` · 疲劳 ${Number(state.fatigue || 0).toFixed(1)}`
  );
  // 绑定生命感的身体（点点）当前参数（宿主给一行就贴一行；绑定关闭时没有这行，工具也不会注入）。
  // 只照贴不解析：它该知道"我现在长什么样"，至于怎么调是它和 pet_set 之间的事。
  const bodyLine = String((opts && opts.body) || '').trim();
  if (bodyLine) lines.push(`· ${bodyLine}`);
  /**
   * 「设定」：用户在「拟态 → 设定」里随手写的那段话（目标 / 想做的事 / 遇到人要不要开口……）。
   *
   * 为什么排在**一切事实之前**：它先得知道自己该在意什么，再看外面发生了什么 ——
   * 顺序反过来，读到的事实就没有一个"对我意味着什么"的落点。
   * 为什么它是必要的：只有体征 + 空清单时，它每次醒来都只能 DEFER（不是懒，是没有方向）。
   * 代码只按原文照贴：不解析、不拆成任务、不猜哪句重要。
   */
  const setup = String((opts && opts.setup) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (setup.length) {
    lines.push('· 用户给你写的设定：');
    for (const line of setup) lines.push(`  ${line}`);
  }
  const loops = Array.isArray(state.loops) ? state.loops : [];
  if (loops.length) {
    lines.push(`· 你记着的未闭合事项 ${loops.length} 条：`);
    for (const loop of loops) {
      const t = loopTension(loop, nowMs, cfg);
      lines.push(`  - [${loop.id}] ${loop.text}（张力 ${t.toFixed(0)}）`);
    }
  } else {
    lines.push('· 你记着的未闭合事项：0 条');
  }
  // 「你自己的抽屉」——它自己的记忆，**排在外部事实前面**：先想起上次到哪儿了，再看外面。
  // 没有这一节，它每次醒来都是一张白纸（写了字也看不见），目标就永远长不出来。
  const noteLines = Array.isArray(opts && opts.note) ? opts.note : [];
  if (noteLines.length) {
    lines.push('· 你抽屉里最近写的（这是你自己上次留下的话）：');
    for (const line of noteLines) lines.push(`  - ${line}`);
  }
  // 「最近这台机器上在做什么」——外部世界的事实（`recap.js` 装配）。
  // 没有这一节，它醒来只有"空张力 + 空清单"，只能 DEFER：不是懒，是不知道有什么事没做完。
  const recap = (opts && opts.recap) || null;
  if (recap && Array.isArray(recap.sessions) && recap.sessions.length) {
    lines.push('· 最近这台机器上（时间窗内有过动静的会话）：');
    let budget = Math.max(0, Number(cfg.recapMaxChars) || 800);
    for (const s of recap.sessions) {
      const tail = s && s.tail ? `最后一句：${s.tail}` : '（没有可引用的内容）';
      const line = `  - 「${s.title}」（${s.agoText}）${tail}`;
      if (line.length > budget) {
        lines.push('  - （还有会话没列出：已到字数上限）');
        budget = 0;
        break;
      }
      budget -= line.length;
      lines.push(line);
    }
    if (recap.lastHuman) {
      const lh = `· 你最后一次听到人说话：${recap.lastHuman.agoText}「${recap.lastHuman.tail}」`;
      lines.push(lh.length <= budget || budget <= 0 ? lh : '· 你最后一次听到人说话：刚才（内容太长，已略）');
    }
  } else if (recap) {
    lines.push('· 最近这台机器上没有别的会话动静。');
  }
  // 未收尾的目标型计划：这是「有什么没收口」的现成原料（跑计划不在心跳轮里，只能记着）
  if (recap && Array.isArray(recap.plans) && recap.plans.length) {
    lines.push(`· 未收尾的目标型计划 ${recap.plans.length} 个（可以记进未闭合事项；跑计划不在心跳轮里）：`);
    for (const p of recap.plans) {
      const bits = [`「${p.name}」`];
      if (Number(p.attempt) > 0) bits.push(`已跑 ${p.attempt} 轮`);
      if (p.objective) bits.push(`目标：${p.objective}`);
      if (p.check) bits.push(`检查：${p.check}`);
      if (p.lastOk === false) bits.push('上次检查没过');
      else if (p.lastOk === true) bits.push('上次检查过了');
      lines.push(`  - ${bits.join(' · ')}`);
    }
  }
  // 「醒来时先看一眼」的结果（用户勾了才有）：画面已经随本轮作为图片给出，
  // 这里只说事实（看成了几张、没看成的原因），免得它以为自己没看过、或者假装看过。
  const look = opts && Array.isArray(opts.look) ? opts.look : null;
  if (look && look.length) {
    const zh = (tool) => (tool === 'wake_screen' ? '屏幕' : '摄像头');
    const said = look.map((s) =>
      s && s.ok
        ? `${zh(s.tool)} ${Number(s.width) || 0}×${Number(s.height) || 0}（画面已随本轮给出）`
        : `${zh(s && s.tool)} 没看成（${(s && (s.error || s.errorCode)) || '原因未知'}）`
    );
    lines.push(`· 你醒来时先看了一眼：${said.join('；')}。`);
  }
  // 「跟你现在有关、你记得的」：拿上面那些**具体事**去召回长期记忆（`recap.buildRecallQuery`）。
  // 与 system prompt 里默认注入的那些"用户偏好"不重叠 —— 那里是按体征块碰运气召回的。
  const memory = Array.isArray(opts && opts.memory) ? opts.memory : [];
  if (memory.length) {
    lines.push('· 你记得的、跟眼下这些事有关的（长期记忆，按当前处境召回）：');
    for (const m of memory) {
      const kind = m && m.kind && m.kind !== 'normal' ? ` · ${m.kind}` : '';
      const id = m && Number(m.id) ? `#${Number(m.id)}` : '';
      const text = String((m && m.text) || '').trim();
      if (!text) continue;
      lines.push(`  - ${id}${kind} ${text}`);
    }
  }
  lines.push(
    `· 今日唤醒 ${Number(state.wakeCountToday || 0)}/${cfg.wakeMaxPerDay}` +
      ` · 决策累计 ACT ${Number(state.actCount || 0)} / DEFER ${Number(state.deferCount || 0)}` +
      ` / REFUSE ${Number(state.refuseCount || 0)}`
  );
  lines.push('');
  lines.push('你现在醒着，是因为内部张力越过了阈值——没有人叫你，也不是定时任务。');
  lines.push('先调用一次 alive_decide 说出你的决定，再按决定行事（ACT 才动手；DEFER/REFUSE 直接结束本轮）。');
  lines.push(
    '清单里已经收口的，用 `done: [id]` 关掉（做完 = done；不值得做 = REFUSE）——' +
      '关掉的条目不再占你的张力，这是唯一能"松一口气"的动作。'
  );
  // 「清单可以自己开」：以前只教了怎么关，于是它 7 次醒来都是 0 条 ——
  // 没有一条属于它自己的事，就永远没有"值得动"的东西。原料来自它自己的记忆（抽屉 / 上次没做完的）。
  lines.push(
    '清单空着也可以自己开一条：`loops: [{text: "…"}]`，写你**下次醒来还想接着看的**' +
      '（比如"抽屉里那句还没验证""那间屋子我想再看一眼"）。这不是给自己派活，是把你在意的记下来。'
  );
  /**
   * 设定 → 怎么落到这一轮（`opts.setup` 由「拟态 → 设定」写、`runtime.js` 现读）。
   *
   * 为什么这一段必须存在：只把设定印在开头，它照样会 DEFER —— 设定写的是**方向**（目标、想做的事、
   * 遇到人要不要开口），不是这一轮的待办；没有这句换算，它每次醒来都看不到"设定在这一刻对应的一小步"。
   * 为什么不是代码替它拆任务：拆成什么是它的事（决策权在模型），代码只说明"设定怎么用"。
   */
  if (setup.length) {
    lines.push(
      '设定写的是方向（目标、想做的事、遇到人怎么反应），不是这一轮要交的活：每次醒来问自己一句' +
        '「这一小步能是什么」，把那一小步写成一条未闭合事项（`loops`），做完用 `done` 关掉。'
    );
    lines.push(
      '设定里说了要开口的事（遇到人就打招呼、偶尔聊两句），就按它办 —— 你还没说话，只说明你还没决定说。' +
        'DEFER 要说得出口：为什么现在不合适、什么时候合适。说不出理由就别 DEFER；一直 DEFER 等于这份设定不存在。'
    );
  } else {
    // 没写设定时**不替它编一份**（那是拿代码写人生），只把"你现在缺的正是方向"这个事实说出来。
    lines.push(
      '用户还没给你写设定。没有方向时最容易一直 DEFER：清单本来就可以永远空着。' +
        '如果你愿意，就从抽屉里记的、最近看到的里面给自己定一句，写进 `loops` —— 一句就够。'
    );
  }
  // 对账：说"做完了"必须对得上事实。代码里也有留痕（`DONE_NO_EVIDENCE` 事件），这里先把话说死。
  lines.push(
    '说"做完了"要对得上事实：文件确实在、命令确实成功、画面确实变了 —— 只有一句"我做完了"不算。' +
      '这一轮什么都没做，就照实 DEFER，别补一句好看的话。'
  );
  /**
   * 权力档（`opts.power`，缺省按只读）：放开档必须**在提示词里说清楚边界**，
   * 否则它会以为自己什么都能干，然后撞在一连串明确拒绝上。
   *
   * 判定只看 `power`，不看 `cfg.readOnlyWake`：后者是"默认档"的历史开关，
   * 两处各说一句就会出现自相矛盾的提示词（"这一轮是只读的" + "你可以改文件"）。
   */
  const power = String((opts && opts.power) || (cfg.readOnlyWake !== false ? 'read' : 'exec'));
  if (power === 'read') {
    lines.push('这一轮是只读的：能读文件、找东西、读记忆；不能写盘、不能执行命令、不能出网。');
  } else {
    const where = String((opts && opts.wakeRoot) || '').trim() || '它的工作目录';
    const bits = [
      `· 这一轮你可以**改文件**（只能动「${where}」之内的；每轮最多 ${Number(cfg.wakeWriteMaxPerWake) || 0} 次，越界与超次会被拒）`
    ];
    bits.push(
      power === 'exec'
        ? `· 也可以**跑命令**（同样只能在这个目录里；每轮最多 ${Number(cfg.wakeExecMaxPerWake) || 0} 条，高危命令与需要人当场同意的操作会被直接拒）`
        : '· 不能执行命令、不能出网（要跑东西得用户在「设置 → 拟态 → 生命」里把权力放到「可跑命令」）'
    );
    if (power === 'exec') {
      // 出网只在 exec 档：同一档的 host_exec 本来就能 curl，放开正规通道是为了别让它拿原始 HTML 硬啃。
      bits.push(
        '· 也可以**联网**看一眼（`web_search` 找、`web_fetch` 读一页）：要核对外面的事实才用，' +
          '别拿它当默认动作，也别对着同一个 query 反复搜。'
      );
      // 占屏 / 键鼠：能力给了，但**有人正在跑任务就得让路**（`WAKE_YIELD`）。
      // 这句必须写进提示词，否则它会把「被拒」当成故障，换个参数再试三次。
      bits.push(
        '· 也可以**开浏览器**（`browser_*`，会在你的界面上弹出浏览器面板）或**动本机键鼠**（`computer`）。' +
          '这两样会占你的屏幕：**只要有别的任务正在跑，它们就会被拒（`WAKE_YIELD`）** —— ' +
          '那是让路，不是故障；别重试，等下一轮或把这件事记进未闭合事项。'
      );
    }
    lines.push(...bits);
    lines.push('动手之前把改动说清楚（改了哪个文件、为什么）；做完的条目记得用 `done` 收口。');
  }
  const senses = (opts && opts.senses) || null;
  if (senses) {
    const caps = [];
    if (senses.drawer) caps.push('alive_note（往自己的抽屉里写一行）/ alive_read_note（读回以前写的）');
    if (senses.eyes) caps.push('camera_look / desktop_camera_look（看一眼现实）');
    if (senses.voice) caps.push('alive_speak（说一句）/ alive_listen（听几秒）');
    // 「只在唤醒轮里注入」这句不能省：这段体征块会**留在会话账本里**，
    // 用户下次在同一个会话里打字时，普通对话轮的工具表里并没有 alive_* ——
    // 不写清楚，模型会照着历史里的清单去找不存在的工具（2026-11-12 实测它自己发现并吐槽了）。
    lines.push(
      caps.length
        ? `你现在还有（**只在唤醒轮里注入**，普通对话轮没有这些工具）：${caps.join('、')}。`
        : '你现在没有抽屉、眼睛和嘴：只能看和记。'
    );
  }
  // 「有没有人在场」只报**事实**：最近 5 分钟这台机器上有没有对话活动（`load`）。
  // 以前这里在 load=0 时直接宣布「没有人在等你回话：不要写给人看的汇报」——
  // 结果是：它这一轮明明拿着摄像头/屏幕的照片（屋里有人、屏幕亮着），却照着这行字闭嘴，
  // 于是"你坐在办公室、它一直 DEFER"。屋里有没有人是它**看见**的，不该由代码宣布；
  // 代码只负责说自己知道的那一件事：有没有人在跟模型说话。
  const load = Number(opts && opts.load);
  lines.push(
    Number.isFinite(load) && load > 0
      ? `· 最近 5 分钟这台机器上有对话活动（load ${load.toFixed(2)}）：可能有人就在旁边。`
      : '· 最近 5 分钟这台机器上没有对话活动（load 0）：没有人正在跟模型说话。'
  );
  lines.push(
    '画面里有没有人在、有没有该做的事，你自己看、自己判断。' +
      '真有话说就出声（alive_speak）：说给在场的人听，不是汇报，也不是进度条。'
  );
  return lines.join('\n');
}

/** 拒绝率告警：一个从不拒绝的实例不是活的，是排期表（只提示，不干预）。
 *  只看**今天**：昨天拒过一次不代表今天不服从。阈值来自 `agent-limits`。 */
function suspiciousObedience(state, cfg) {
  const wakes = Number(state.wakeCountToday || 0);
  const refusedToday = Number(state.refuseToday || 0);
  const min = Math.max(1, Number(cfg && cfg.suspiciousWakeMin) || 5);
  return wakes >= min && refusedToday === 0;
}

module.exports = {
  DECISIONS,
  ALIVE_DECIDE_TOOL,
  applyDecision,
  renderStateBlock,
  suspiciousObedience,
  clamp
};
