// @ts-check
'use strict';

/**
 * Node-only 依赖入口：浏览器 / 裸脚本下为抛错桩，避免 esbuild 静态解析 fs / path / electron。
 * 所有调用点都位于 Node 专用路径（磁盘 I/O、model-settings 读取），renderer 侧不会触达。
 */
const nodeRequire =
  typeof require === 'function'
    ? require
    : function () {
        throw new Error('node-only dependency');
      };

// 纯 CJS 依赖：顶层 require 真源，替代原先「全局 → 运行期 require → 硬编码副本」三层兜底。
const { remapLegacyContextTierId, foldLegacyContextTierRecord } = require('./model-runtime-presets');
const {
  getEditingContextTierId,
  normalizeContextTierId,
  listContextTierIds
} = require('./model-runtime-by-tier');
const { clampModelRuntimeValue } = require('./model-runtime-schema');
// 跨语言数值的唯一来源（Rust 读同一份 src/agent/agent-shared.json）。
const SHARED = require('./shared-constants');

/** @typedef {{ key: string, label: string, hint?: string, type: 'number'|'boolean', min?: number, max?: number, step?: number, unit?: string, format?: 'int'|'ms'|'min'|'mb'|'ratio' }} AgentLimitSchemaItem */
/** @typedef {{ group: string, groupId: string, items: AgentLimitSchemaItem[] }} AgentLimitSchemaGroup */

const AGENT_LIMITS_DEFAULTS = {
  repeatToolStreakLimit: 9,
  repeatHistoryMax: 96,
  // 完成验收（单轮「做完了没」，`completion-readiness.js`）的证据采集预算。
  // 只影响提示的及时性与样本量；采集超时一律降级成「没有这条证据」，不挡交付。
  // 故意不进 AGENT_LIMITS_SCHEMA：这是内部预算，不该在护栏面板里成为可调项。
  readinessRpcTimeoutMs: 10000,
  readinessMaxDiagFiles: 6,
  readinessBrowserQueryLimit: 20,
  readinessBrowserQueryTimeoutMs: 5000,
  readinessMaxErrorSamples: 3,
  readinessErrorSampleChars: 120,
  transientMaxRetries: 3,
  retryBaseMs: 400,
  // 流式进度的合批间隔。唯一消费方是 `src/agent/progress-flush.js`（Main 的 `llm_delta` /
  // planner `progress`、Renderer 的主循环与 planner 两条流、计划 trace 队列共用同一份实现）。
  // 为什么必须合批：core 逐 SSE chunk 推增量，不合批就是「一个 chunk 一次跨进程 IPC」，
  // 且宿主送的是本轮累计正文 —— 单轮搬运量与事件数都随回答长度走（O(正文²)）。
  // 40ms ≈ 25 帧/秒，肉眼是连续出字；比这更大就开始看得出「一顿一顿」。
  // 故意不进 AGENT_LIMITS_SCHEMA：这是内部节奏，不是用户要调的护栏旋钮。
  agentProgressFlushMs: 40,
  // 闲时队列（plans trigger=idle）：轮询间隔与「静默多久才算闲」。
  // 「忙」的唯一来源是 rust-loop-runner 的活跃 agent loop 计数（聊天/规划/定时任务全走它）。
  plansIdlePollMs: 60 * 1000,
  plansIdleQuietMs: 5 * 60 * 1000,
  // 计划条数上限（**只挡新建**，存量超限仍可改 / 停用 / 运行）。
  // 为什么要有：`plan_create` 是模型可自主调用的，而每条计划都是一整个 agent 轮
  // （多轮 LLM + 工具）—— 没有上限时「一晚上几百条 MINUTELY 计划」只是几次工具调用的事。
  // 为什么**不**夹取最小间隔：那等于替用户改他写的规则（与「代码不判定意图」冲突），
  // 频次交给 `plan_create` 回执里的 runsPerDay 让模型/用户自己看。
  // 故意不进 AGENT_LIMITS_SCHEMA：机制上限，不是护栏旋钮（同 defaultWorkspaceGc*）。
  plansMaxCount: 50,
  // 目标型计划（plans trigger=goal）：预算在代码，节奏在模型。
  // 决定「再做一轮」只看客观事实：目标已被验收证据判定通过、或预算/轮次用完。
  // 这里只提供默认值与 clamp 上限（表单里填的数不能突破上限，防一晚烧穿预算）。
  goalMaxAttempts: 36,
  goalMaxWallMs: 24 * 60 * 60 * 1000,
  // 只有「异常/崩溃恢复」才退避：正常跑完一轮立刻接下一轮（节奏由模型决定）。
  goalRetryBackoffMs: 60 * 1000,
  // 检查命令超时。**必须 ≤ src/exec-limits.js 的 EXEC_TIMEOUT_MAX_MS（600s）**，
  // 否则合法的重编译会被 host.exec 的硬上限截断、误判为失败（本机与远端共用这份契约）。
  goalCheckTimeoutMs: 5 * 60 * 1000,
  // 一条检查结果注入下一轮的证据尾部字符数（只给尾巴）。
  goalEvidenceTailChars: 4000,
  // 计划上保留多少条检查事实（运行态有界；更早的事实仍在计划会话的 trace 里）。
  // 故意不进 AGENT_LIMITS_SCHEMA：这是内部保留预算，不是护栏旋钮。
  goalEvidenceKeep: 20,
  // 已按完成收尾的目标型计划保留几条：更早的自动清掉，否则卡片与 plans.json 无界增长。
  // **只清 `complete`，`blocked` 永不自动清**（那是还没人看的问题，删掉等于把问题藏了）。
  // 同样不进 SCHEMA：这是保留预算，不是用户要调的护栏。
  goalCompletedKeep: 5,
  // 会话目标 JSON 的**落盘预算**（字符）。必须 < dieyun-core 的 `SESSION_GOAL_MAX_CHARS`（64000），
  // 否则两个上限互相打架：`goalEvidenceKeep × goalEvidenceTailChars`（20 × 4000）满额约 83k 字符，
  // 写满后每次 `session_goal_put` 都被 Rust 拒掉 —— 命令跑过了、事实落不了库、目标再也收不了尾。
  // 因此写入口（`session-goal.saveGoal`）按这个预算裁剪：先削最旧事实的输出尾巴，再丢最旧的事实/主张。
  // 不进 SCHEMA：这是与存储契约绑定的内部值，不是用户要调的护栏。
  goalBlobMaxChars: 56000,
  // 内网 agent 互通（src/peer）：把这些数字集中在这里，是为了让「两个 agent 互相撩爆 token」
  // 这类失控只有一处可调，而不是散在发现/服务/协调器三层各写一个上限。
  // hops = 一条跨机消息链上已经过手的 agent 数；达到上限即**不再自动跑一轮**，只投递。
  peerMaxHops: 4,
  peerTurnBudgetPerHour: 12,
  peerTurnBudgetWindowMs: 60 * 60 * 1000,
  peerMaxMessageChars: 8000,
  peerMaxPeers: 64,
  /** 一次 outbound 建连 + hello 握手的预算 */
  peerSendTimeoutMs: 20000,
  /** peer_send 等对端回话的预算（对端要跑完一轮，所以比握手长得多） */
  peerReplyTimeoutMs: 120000,
  peerDiscoveryPort: 17341,
  peerDiscoveryIntervalMs: 30 * 1000,
  peerPresenceIntervalMs: 30 * 1000,
  /** 超过这个时间没再收到宣告，就把对端视为离线 */
  peerPresenceTtlMs: 90 * 1000,
  peerPortBase: 17350,
  peerPortTryCount: 11,
  /** 文件 / 任务租约的存活时间与「收集对端应答」的等待窗口 */
  peerClaimTtlMs: 15 * 60 * 1000,
  peerClaimWaitMs: 1500,
  /**
   * 房间（agent 聊天室）成员上限与同时开启的房间数。
   *
   * 成员上限按「扇出成本 ~N²」定，**不是**按发现上限（`peerMaxPeers` = 64）：
   * 一个房间里超过 8 台，消息量与追问就没人读得完，token 也会一起爆。
   * 房间数上限按「房间 = 一次任务」定：4 个并行任务已经是很满的内存与注意力预算。
   */
  peerRoomMaxMembers: 8,
  peerRoomMaxActiveRooms: 4,
  /** 房间记录的有界保留（先丢最老的已关闭房间；打开中的永不丢） */
  peerRoomKeepMax: 64,
  artifactsUiFlushMs: 80,
  lspSyncDebounceMs: 500,
  monacoMaxChars: 200000,
  // 工具段上限（每段最多多少次工具调用）的唯一来源是「编码参数 → 模型与段预算 →
  // 工具调用段上限」（model-settings.agentToolCallLimit，按 Context 档位存）。
  // 这里原来还有一个 ctxAgentToolCallLimit（默认 150）与它抢同一笔预算，
  // 而 resolveLoopToolCallLimit 先取 settings、于是那个旋钮**永远不生效** —— 已删除。
  toolResultMaxJson: 14000,
  /**
   * 工具输出「落盘换预览」的字符阈值（`tool-output-spill.js` 的唯一数字）。
   *
   * 和上面的 `toolResultMaxJson` 是两件事：这里是**无损**卸载（全文写 `.dieyun/tool-output/`，
   * 上下文只留预览 + outputFile），那里是**有损**截断（超了直接切）。
   * 因此有一条不变式：**本值必须小于 `toolResultMaxJson`** —— 否则
   * 「超过截断上限、又没到大输出阈值」的那一段会被静默切掉且没有文件可回读。
   * 由 `scripts/test-tool-harness.cjs` 断言。
   */
  toolSpillCharThreshold: 8192,
  // 单次工具执行的「无进展看门狗」：超过该时长仍未 settle，判定工具卡住，按 TOOL_STALLED
  // 失败返回并让循环继续（原调用不终止）。**必须大于 host_exec 的硬上限 600s**
  // （src/exec-limits.js: EXEC_TIMEOUT_MAX_MS），否则合法的编译/渲染会被误杀。
  // 故意不上设置页：这是兜底护栏，不是用户可调的探索策略。
  // 2026-10-23→24 事故：host_exec 起前台长驻脚本 + 链路无回包 ⇒ run 静默 running 11 小时，
  // 期间零请求、零 trace、零日志 —— 除遥测外没有任何一层能看出「它停了」。
  toolStallMs: 12 * 60 * 1000,
  // 长任务工具（`subagent` = 一整轮子 loop run，调研常常十几分钟）的窗口。
  // 工具清单的唯一来源是 `guardrails-shared.js: LONG_RUNNING_TOOL_NAMES`。
  toolStallMsLong: 45 * 60 * 1000,
  // run 级「无进展」看门狗（`rust-loop-runner` 的 while 循环）。
  // 工具段已有 toolStallMs 兜底；这两个数覆盖其余**没有时间维度**的段：
  // 压缩判定 / 快照写入 / 循环 RPC（agent.loop.*）/ 委托结果回填。
  // warn：只记一行 `RUN_STALL`（含 stage），先让「它停了」可见；
  // abort：调既有的 `agent.loop.cancel` 收尾，不再依赖用户发现。
  // abort 必须 > llmReconnectMaxWaitMs(30min)，否则把「合法重连等待」误判成卡死。
  runStallWarnMs: 5 * 60 * 1000,
  runStallAbortMs: 45 * 60 * 1000,
  writeSmellHintMaxItems: 3,
  writeSmellHintMaxChars: 480,
  writeSmellScanTimeoutMs: 1500,
  codebaseSnippetMax: SHARED.snippets.codebaseSnippetMaxChars,
  codebaseAutoLimit: 12,
  openFilesMax: 12,
  filePreviewMaxChars: 4000,
  fsReadDefaultMaxBytes: 65536,
  // LSP 诊断只在这里限「注入字符数」；文件数与超时的唯一来源是 lsp-settings
  // （src/lsp/diagnostics-service.js 的 LSP_SETTINGS_DEFAULTS / lsp-settings.json）。
  lspDiagMaxChars: 10000,
  streamRoundMaxAttempts: 3,
  llmRetryBaseMs: 800,
  llmReconnectMaxWaitMs: 30 * 60 * 1000,
  synthesisTimeoutMs: 25000,
  synthesisReconnectMaxWaitMs: 8000,
  // 会话标题（历史列表里那行字）：每会话只生成一次的小请求。
  // 超时取得比摘要短得多——它是列表装饰，用户不会为了它等；超时就保留启发式标题。
  // 字符上限同时进提示词与落库整形（Rust first_line_title 的 48 字上限是硬边界）。
  sessionTitleTimeoutMs: 15000,
  sessionTitleMaxChars: 32,
  maxUndoSteps: 5,
  editorSelectionMax: 2400,
  editorVisibleLines: 40,
  maxDiffChars: 12000,
  diffFullTextCap: 120000,
  chatImagePreviewMaxMb: 15,
  // 视觉输入注入（浏览器截图 / 附件补看）：按来源分别限流。
  // 额度是「每轮在途」——缓冲在注入后即清空，因此每个 LLM 轮次都会重新给一份。
  visionShotsPerRound: 2,
  visionReattachPerRound: 2,
  visionMaxBase64Chars: 4 * 1024 * 1024,
  // 截图长边上限（电脑控制 / 浏览器截图注入视觉通道前先缩放）。
  // 为什么必须有：4K 屏整屏 PNG 的 base64 能到 4.7MB，直接顶穿上面那条单张上限，
  // 结果就是「截了图但模型永远看不见」。1568 是主流多模态模型的最优像素区间：
  // 再大只是白烧 token，再小则界面小字糊掉。缩放后通常 300–800KB，稳定过限。
  visionShotMaxEdge: 1568,
  // 手机摄像头（camera_look 工具）：**一次一张、不常开**。
  // cameraCaptureTimeoutMs：手机端「唤醒相机 + 对焦 + 编码」的等待上限；超时就如实说没拍到，
  //   不要用更长的超时硬等——锁屏/后台的手机永远不会回图。
  // cameraShotMaxEdge：手机侧压缩的长边。取 1280 而非 1568，是因为回传链路是
  //   App 内 JS 桥（base64 字符串过 evaluateJavascript），体积翻倍会明显拖慢并可能被丢；
  //   而 1280 已足够看清桌面物品与人的表情，细节可让模型再拍一张。
  // cameraShotsPerRound：每轮在途张数（与视觉缓冲同口径，注入后清空）。
  cameraCaptureTimeoutMs: 20000,
  cameraShotMaxEdge: 1280,
  cameraShotsPerRound: 2,
  // 本机摄像头（desktop_camera_look：ffmpeg 抓一台 UVC 摄像头的一帧）。
  // desktopCameraCaptureTimeoutMs：唤醒相机 + 出帧的等待上限。比手机端短，是因为
  //   ffmpeg 挂住通常意味着「设备被别的程序独占」，硬等只会白占一轮。
  // desktopCameraShotMaxEdge：交给 ffmpeg 的 scale 长边（1280 与手机端同口径：
  //   看清桌面上有什么够了，再细就让模型再拍一张，不做磁盘副本）。
  // desktopCameraShotsPerRound：每轮在途张数，独立于手机/浏览器截图。
  desktopCameraCaptureTimeoutMs: 15000,
  desktopCameraShotMaxEdge: 1280,
  desktopCameraShotsPerRound: 2,
  // 本机云台（desktop_camera_ptz：把有电机的摄像头转过去）。
  // desktopCameraPtzSettleTimeoutMs：下发角度的等待上限。为什么必须等：写成功不等于转到 ——
  //   云台有惯性（实测 2° 一下就到，130° 要一两秒），不等就拍会拍到半路模糊的一帧；
  //   而上限不能再长：真要卡住（被挡、AI 追踪抢方向）时，一轮对话不该陪着等。
  // desktopCameraPtzPollMs：等停稳时的读间隔。120ms 与固件自己 50ms 级别的位置刷新同量级：
  //   再密只是多开几次 COM 会话，再疏就会把一个还没开始的动作误判成「已停稳」。
  // desktopCameraPtzCommandTimeoutMs：linux 那条（v4l2-ctl）单条命令的上限；
  //   Windows 的 COM 调用是同步的，没有超时概念（设备挂死时由用户中断整轮）。
  desktopCameraPtzSettleTimeoutMs: 4000,
  desktopCameraPtzPollMs: 120,
  desktopCameraPtzCommandTimeoutMs: 5000,
  // 工具产出图片的只读副本保留张数（内容寻址去重后按 mtime 留最新 N 张）。
  // 为什么要留副本：base64 注入完即丢，模型想再看局部细节只能重拍，而当时那一帧可能已过；
  // 为什么要有上限：电脑控制一次任务能产生几十张整屏图，不留上限就是无底占盘。
  // 与 visionShotMaxEdge 同属「本机磁盘策略」，不进设置页。
  visionImageKeepFiles: 200,
  // 图片 part 计入上下文预算时的等效字符数。图片在请求里会换算成图片 token，
  // 不能按 base64 长度计；否则单张图就顶穿 chat 预算并触发无意义的压缩。
  // 注意：这是「账本折算系数」而非策略上限，故意不出现在设置页——
  // contentCharLen 没有 tier 上下文，只读全局默认值，做成可调项会「改了不生效」。
  // 两个计费口径都从本值换算：字符口径 session-context.contentCharLen、
  // token 口径 token-estimate 的图片等效 token。**值在 src/agent/agent-shared.json**
  // （Rust `compaction/tokens.rs` 读同一份，不再手抄）。
  visionPartEqChars: SHARED.tokenEstimate.imagePartEqChars,
  // 电脑控制（computer 工具）输入参数上限。动作枚举/坐标形状等结构校验在
  // tool-validate，这里只放数字上限（AGENTS.md §6：数字护栏唯一来源）。
  computerTextMaxLen: 2000,
  computerKeyMaxLen: 64,
  computerScrollMaxNotches: 10,
  computerWaitMinMs: 50,
  computerWaitMaxMs: 10000,
  // 动作后「等界面稳定」的节奏：先等起步动画（delay），再连拍到连续两帧相同（poll）为止，
  // 总时长有上限（max）。为什么不用固定 sleep：慢弹窗/列表加载会截到半截，模型按半截画面
  // 决定下一步就是误点；而固定等久了又是纯粹的浪费。超时如实回 stable:false，不硬等。
  computerSettleDelayMs: 180,
  computerSettlePollMs: 100,
  computerSettleMaxMs: 900,
  // wait_until：等「画面变化 / 界面稳定」的超时预算。默认给到常见网页加载量级，
  // 上限是单次工具调用的等待天花板（超过就该换策略，而不是继续傻等）。
  computerWaitUntilDefaultMs: 8000,
  computerWaitUntilMaxMs: 20000,
  // list_windows 返回的窗口条数上限：挡住「几十个窗口灌满上下文」，
  // 提示词注入伪造窗口标题的成本也随条数可控。
  computerWindowListMax: 25,
  // 字符→token 折算系数（上下文账本 / 用量估算用）。与 visionPartEqChars 同为「折算系数」
  // 而非策略上限，故意不上设置页。**值在 src/agent/agent-shared.json**：Rust
  // `compaction/tokens.rs::estimate_text_tokens` 读同一份，手抄两份已经漂过一次。
  // renderer 侧经 agent-bundle-entry.js 的 compat 挂到 window.CHARS_PER_TOKEN /
  // window.CJK_CHARS_PER_TOKEN 后直接消费（这两个键不在 module.exports 中）。
  charsPerToken: SHARED.tokenEstimate.charsPerToken,
  cjkCharsPerToken: SHARED.tokenEstimate.cjkCharsPerToken,
  // 默认工作区（~/.dieyun/workspace）回收，唯一实现 src/default-workspace-gc.js。
  // 这个目录是「未选工作空间时的落脚点」，所有落盘产物都进它，没有任何会话负责清理 ——
  // 不设上限就单调增长（实测一台开发机半年 7896 个文件 / 717 MB）。
  // 只管这一个兜底目录；用户自选的工作空间永远不动。
  // 保留天数 / 容量上限是**用户可调**的（进 SCHEMA）；后三个是机制预算，故意不进设置页：
  // 宽限期是安全垫（多实例/长会话可能还在用，删了就是事故），其余两个是单趟与调度预算。
  defaultWorkspaceRetentionDays: 30,
  defaultWorkspaceMaxMb: 1024,
  defaultWorkspaceGraceHours: 24,
  defaultWorkspaceGcMaxEntries: 4000,
  defaultWorkspaceGcIntervalMs: 6 * 60 * 60 * 1000,
  // 附件图片保留：超过容量后从最旧的图片开始原地降采样（不改名、不删除，历史引用不悬空）
  attachmentRetentionMaxMb: 500,
  attachmentDownsampleMaxPx: 1600,
  attachmentDownsampleMinKb: 120,
  completionHistoryMaxChars: 96000,
  completionMessageMaxChars: 8000,
  completionLastUserMaxChars: 24000,
  completionTurnRideMaxChars: 32000,
  completionRecentTurns: 24,
  completionFoldedMaxChars: 12000,
  userSystemMaxChars: 8000,
  systemStableMaxChars: 16000,
  llmRequestMaxChars: 800000,
  taskTierEnabled: true,
  // 只读并发调研子 Agent（subagent 工具）。
  // 深度恒为 1：只有「协调者」被显式注入 subagent 工具——Agent 主循环 / Explore 模式 /
  // Plan 的 explore 阶段。研究子 Agent 的工具集就是 Explore 白名单本身，而白名单里没有
  // subagent，因此递归在工具层面被物理切断，不依赖运行期判断。
  subagentMaxDepth: 1,
  subagentMaxConcurrent: 3,
  subagentMaxPerRun: 8,
  // 子 Agent 的轮次 / 工具预算。子 Agent 是一次**独立的 loop run**（自带 maxRounds /
  // maxToolCalls 账本），父级只为「派发」记 1 次工具调用 —— 所以这里的数字不占父级预算，
  // 放宽的真实代价是 token / 时间，而非抢协调者的轮次。
  // 一轮调研要「列目录 → 搜定义 → 读关键片段 → 交叉验证」几十步，16 轮在大仓库上必然
  // 中途截断 —— 截断就没有结论，等于白派（协调者只能自己重做一遍）。
  // 已三次放宽：16/32 → 32/64 → 48/96 → 160/320。第三次的理由是 2026-11-19 实测：
  // 3 路 worker / 探索在全量工具日志上跑到 96 轮仍在有效推进（每轮都在读新文件、跑验证），
  // 被硬上限拦腰截断 → 撞上限的那一轮没有结论，整批只能重做。schema max 同步再翻倍，
  // 保证默认值仍低于上限、用户可继续下调/上调。不按任务类型分档（避免第二套预算规则），
  // 护栏数字只在这里改。
  subagentMaxRounds: 160,
  subagentMaxToolCalls: 320,
  // 子 Agent 回注主上下文的摘要上限。过程 trace 不回注，只在折叠卡片里展开，
  // 否则 N 路调研会把主上下文顶爆（这是该功能最常见的失败模式）。
  subagentSummaryMaxChars: 2400,
  // 子 Agent 卡片标题里 label 的截断位数。标题是 flex-wrap 的，超长只会把卡片撑高；
  // 但 label 来自规划师生成的子任务 title，长度不受控，所以在单点（subagentCardTitle）截断。
  // 与注入块尺寸同属「展示格式」，故意不进 SCHEMA（设置页不展示）。
  subagentCardLabelMaxChars: 24,
  // 追问留存：同一 run 内可被 continueFrom 续用的已完成子 Agent 上下文份数（LRU）。
  // 只在 runner 生命周期内保留，不落盘；0 = 关闭追问。
  subagentFollowupRetention: 8,
  // `subagent_status` 回给模型的「原任务」截断位数。和 subagentCardLabelMaxChars 同类：
  // 注入尺寸 / 展示格式，不是用户可调护栏，故意不进 SCHEMA。8 份 x 200 字 = 约 1.6KB 上限。
  subagentStatusTaskMaxChars: 200,

  // —— planner 并行执行器（**写入**子 Agent）——
  // 与上面「只读调研子 Agent」是两件事：调研子 Agent 共享主工作区、只读；
  // 执行器各拿一个 git worktree，改完统一进「变更」面板逐文件合并（远端 SSH 则收尾并回会话副本）。
  // 这个数字 = 「同时开几个 worktree + 几条 LLM 并发流」，必须在这里单点收口：
  // 按 provider 限流/额度放宽它，才是真的放宽并发。
  // 它**不**管写类工具的串行队列：那条按「作用于哪份副本」分键（`tool-bridge-main.js` /
  // `mutate-queue.js`），同一副本内串行、不同副本并行 —— 以前这里的注释说它同时是那个并发度，
  // 实现里从来没有接过线（2026-11-19 审计）。
  plannerMaxParallelWorkers: 3,
  // 远端 per-run 副本目录的保留个数（机制预算，故意不进 SCHEMA，与 `defaultWorkspaceGc*` 同类）。
  // 每个 per-role 副本是一份**完整 checkout**，崩溃/取消会把它留在服务器上；回收时先归档
  //（提交进各自分支）再删目录、**保留分支**（分支是产出的存档）。0 = 不回收。
  plannerRunWorktreeKeep: 20,
  // best-of-N：同一 build 类子任务并行跑 N 份、再择优。0 = 关（默认）。
  // 这是「护栏数字」而非「策略开关」，所以和并行度一样收在 agent-limits 里：
  // 之前它只存在于 Renderer 的 localStorage（`dieyun.planner.bestOfN.v1`），仓库内
  // **没有任何写入点** —— 等于一个永不生效的幽灵开关。现在唯一来源是本文件的
  // 默认值 + SCHEMA（设置页可调），Renderer 只把它塞进 planner payload。
  // 上限 3：N 份 = N 倍 token 与 N 倍 LLM 并发流，与 plannerMaxParallelWorkers 同源受限。
  plannerBestOfN: 0,
  // 多 Agent 并行的总开关（用户在设置页显式打开才走 planner 管线）。
  // 不做「按任务大小自动判断」：planner 是「拆解 → 并行 → 验收 → 合并」的重流程，
  // 猜错一次的代价（多等几分钟 + 凭空多出一堆 worktree 待合并）远高于手动开一次。
  plannerMultiAgentEnabled: false,

  // —— 注入块尺寸上限（system prompt 各数据块）——
  // 唯一来源。Main 的 src/agent/system-prompt-prep.js 与 Renderer 的
  // renderer-context-engine.js 都从这里读，不再各自维护字面量。
  // 这些是「注入内容尺寸」而非用户可调护栏，故意不进 AGENT_LIMITS_SCHEMA（设置页不展示）。
  // 项目地图每轮注入预算。**按注入白名单的实际体量定，不是拍脑袋对齐**：
  // 白名单是 overview + commands + gotchas（structure 刻意留在外面 —— graph.repo_map
  // 已注入目录结构）。三条都是「不知道就直接做错」的内容，6000 是当年只注入
  // overview 时的额度，白名单扩容后没跟着涨，实测某项目三段合计 12658 字符只进
  // 47%，命令与已知坑各被砍掉一半以上。
  // 13500 = 实测覆盖「三段全量」所需的 13258 + 余量（13000 仍差 258 字符，约一条命令）。
  // 注意：这是「最多给多少」的上限，小项目文件小就只占实际体量，不会白烧。
  agentsMdMaxChars: 13500,
  // 仓库根 `AGENTS.md` 的注入预算：这是「宽泛层」，与 `.dieyun/AGENTS.md`（具体层、
  // 分段 + path-glob 条件段）各自独立，两层谁也挤不掉谁。
  // 没有这一层时，用户从 Cursor / Claude Code 迁过来、仓库里早就写好的 AGENTS.md 约定
  // 对模型完全不可见 —— 归纳器会读它，但从不注入。
  agentsMdRepoMaxChars: 4000,
  dieyunMdMaxChars: 6000,
  codebaseMentionLimit: 16,
  filePreviewMaxBytes: 48000,
  recentChangeMax: 16,
  graphRepoMapLimit: 32,
  graphRepoMapMaxChars: 4500,
  // 项目记忆注入预算：项目记忆的真相是 `<workspace>/.dieyun/memory.md`（人可读、可手改、
  // 跟着仓库走），注入按字符预算读文件头部（最新在前）。不再有「取前 N 条」的条数上限 ——
  // 条数上限只会让「写进去的看不到」，这正是本次要消灭的形态。
  projectMemoryFileMaxChars: 2400,
  globalMemoryLimit: 5,
  // 轮内记忆工具的上限：recall 一次最多返回多少条、forget 一次最多归档多少条。
  // 为什么需要上限：自动注入每轮只给 8+5 条，工具若能把上千条一次拉进上下文，
  // 预算立刻被打穿；forget 同理，模型不该一次抹掉一大片。
  memoryToolRecallLimit: 8,
  memoryToolForgetMaxIds: 6,
  toolRecallLimit: 10,
  // 会话检索（工具 `session_recall`）：跨会话翻「以前聊过什么」的条数与摘录长度。
  // 摘录而不是全文：命中可能落在任何一轮里，整段历史塞回上下文等于用检索换爆预算。
  sessionRecallLimit: 12,
  sessionRecallSnippetChars: 240,
  sessionRecallFoldedLimit: 6,
  // 长期记忆**注入**的相似度阈值（语义 / 关键词两档）。
  // 与共享记忆的 `sharedMemoryMinScore*` 是同一套口径、不同数据源（本地库 / 跨机 PG），
  // 所以两组分开命名；值以前硬编码在 `system-prompt-prep.js` 里，看不出同源也改不动。
  // 长期记忆「该不该注入」的唯一阈值，作用在 Rust 给的 `injectScore`（已归一到 [0,1]）。
  // 两个分支各自的 [0,1] 是怎么来的（Rust 侧唯一实现，见 `memory/recall.rs`）：
  //   语义   = 余弦夹到 [0,1]（本身就是绝对的、跨查询可比）；
  //   关键词 = **片段覆盖度 × 本次查询内的相对最佳命中**。片段之间是 OR 连接的，只蹭到一个
  //            词的长句覆盖度就是 1/N —— 拿不到满分；bm25 的绝对值随语料漂移，只能同查询内比。
  // 以前是语义 0.32 / 关键词 0.12 两个数：它们量的根本不是同一件事（余弦 vs bm25），
  // 于是「注不注入」取决于走了哪条通道、查询词有几个字。量纲统一后只剩这一个数。
  memoryInjectMinScore: 0.32,
  // 会话交接里「原文快照」的预算：事实部分由存储投影（确定性），模型只写判断。
  // 与注入侧 HANDOFF_BLOCK_MAX_CHARS(4000) 的关系：快照在后、判断在前，
  // 触顶时先丢原文尾部，不丢结论。
  handoffSnapshotMaxChars: 2400,
  // 技能索引条数上限：注入的只是「名称 + 路径 + 简介」，全文由模型自己 fs_read_file 读。
  // 不要再加 skillBodyMax / skillFullCount 这类「给前 N 个技能全文」的旋钮 ——
  // 全文常驻注入正是渐进披露要消灭的形态，所以它从未实现，也就不该留配置（留着等于撒谎）。
  skillTotalCount: 5,

  // —— 召回命中阈值（技能召回 / 工具召回）——
  // 两条链以前各在调用方写一份常数（skills 0.28/0.35，tools 0.18/0），互相不知道对方多少，
  // 调一个漏一个。值是**召回质量**参数（不是用户可调护栏），所以只在这里声明、
  // 不进 AGENT_LIMITS_SCHEMA（设置页不展开）。
  // 为什么技能更严格：技能注入的是「你可以做什么」的强提示，误召回会把模型带偏；
  // 工具召回宽松些（关键词阈值 0 = 关键词命中即算），选错工具最多多一次调用。
  skillRecallSemanticMin: 0.28,
  skillRecallKeywordMin: 0.35,
  toolRecallSemanticMin: 0.18,
  toolRecallKeywordMin: 0,

  // —— 请求快照（审计）参数 ——
  // 定位：让人事后能回答「这一轮模型到底看到了什么、为什么历史变短了」。
  // 这六个数字是**账本/保留**参数（与 `charsPerToken` 同类），不是策略上限，
  // 故意不进 AGENT_LIMITS_SCHEMA（设置页不展示），唯一来源仍是这里。
  // 三层预算（DEFAULTS → schema → tier 覆盖）都不参与 tier 缩放：审计留底不该随任务档位变。
  // 体量账：单行 messages 20–120KB，40 轮 ≈ 3.2MB/会话；超预算先降 keepPerSession。
  // **但每会话窗口只有「乘数里的那个 40」**：库体积 = 每会话行数 × 用过多少会话。
  // 2026-11-09 实测 `diecloud-memory.sqlite` 1.17GB，其中 request_snapshots 占 1034MB
  // （4818 行 / 157 个会话 / ≈220KB 一行），就是缺一个跨会话总闸。下面这条是那个总闸：
  // 超过就按最旧优先跨会话裁（裁剪在 `crates/dieyun-memory/src/memory/snapshot.rs` 的同一次写入里做）。
  requestSnapshotEnabled: true,
  requestSnapshotKeepPerSession: 40,
  requestSnapshotKeepCompacted: 200,
  requestSnapshotMaxTotalRows: 1500,
  requestSnapshotMaxMessagesChars: 400000,
  requestSnapshotSystemMaxChars: 64000,
  requestSnapshotToolsMaxChars: 96000,

  // —— 记忆归纳（knowledge maintenance）参数 ——
  // 定位：**机制预算**，不是用户可调护栏，故不进 AGENT_LIMITS_SCHEMA（设置页不展开）。
  // 唯一读者：`src/agent/knowledge-maintainer.js`（Main 侧唯一实现）。
  // 老实现把「文本长度 >= 8」当门闩（几乎恒真）+ 50s 冷却写死在 Renderer，
  // 且队列无上限；这里把门、冷却、队列、超时、单次产出量全部收口。
  /** 两次归纳之间最小间隔（等价于全局速率上限：1/50s） */
  knowledgeMaintenanceCooldownMs: 50 * 1000,
  /** 待归纳任务队列上限，满了直接丢新任务（不堆积） */
  knowledgeMaintenanceQueueMax: 8,
  /** 收尾归纳前的最小静默（让落库/事件先跑完） */
  knowledgeMaintenanceDelayMs: 15000,
  knowledgeMaintenanceDelayMaxMs: 5 * 60 * 1000,
  /** 纯文字轮次的触发门槛：需求与答复都要够长，否则只靠结构信号触发 */
  knowledgeMinUserChars: 40,
  knowledgeMinReplyChars: 20,
  /** 单次归纳的产出与输入上限 */
  knowledgeMemoryItemsMax: 8,
  knowledgeTraceLinesMax: 28,
  knowledgeAgentsMaxChars: 12000,
  knowledgeRecentChatItems: 20,
  knowledgeCorpusMemoryRows: 24,
  /** 定时语料跨几个会话取样（只看「最近一个会话的尾部」不足以代表近期对话） */
  knowledgeRecentChatSessions: 5,
  /** 计划 worktree「应用后才归纳」的最长等待（暂存在 Main，窗口关掉也不丢） */
  knowledgePlanApplyWaitMs: 20 * 60 * 1000,
  /** idle 模式「忙完补跑」的一次性重试间隔（只重排一次，不再叠兜底层） */
  knowledgeIdleRetryMs: 5 * 60 * 1000,
  /** 机械维护：衰减/归档窗口与向量重建批量（与 Rust 默认一致，但由这里单一来源声明） */
  knowledgeDecayStaleDays: 120,
  knowledgeDecayArchiveDays: 240,
  knowledgeReindexLimit: 100,
  /** 模型调用预算 */
  knowledgeTimeoutMs: 65000,
  knowledgePeriodicTimeoutMs: 90000,
  knowledgeMaxTokens: 2800,
  knowledgePeriodicMaxTokens: 3500,

  // —— 共享记忆（跨机 PostgreSQL，扩展页签「共享记忆」）——
  // 定位：**机制预算**，不进 AGENT_LIMITS_SCHEMA（设置页不展开；服务器/口令在扩展页签里）。
  // 唯一读者：`src/memory-shared/service.js`（数据层）与 `src/agent/system-prompt-prep.js`（注入）。
  /** 每轮注入的共享记忆条数上限 */
  sharedMemoryRecallLimit: 5,
  /** 召回阈值：与本地记忆同一套口径（语义 0.32 / 关键词 0.12），低于阈值不进 system */
  sharedMemoryMinScoreSemantic: 0.32,
  sharedMemoryMinScoreKeyword: 0.12,
  /** 单条上传正文上限（本地一条记忆本来就短，超长的不是记忆是文档） */
  sharedMemoryEntryMaxChars: 600,
  /** 注入块字符上限（与【长期记忆】同量级，宁可少注入） */
  sharedMemoryBlockMaxChars: 1600,
  /** 一次提炼提交给模型的候选条数 */
  sharedMemoryConsolidateBatch: 40,
  /** 两次提炼的最小间隔（跨机口径：台账时间戳，不靠本机内存） */
  sharedMemoryConsolidateIntervalMs: 6 * 60 * 60 * 1000,

  // —— 生命感（设置 → 生命；`src/alive/`）——
  // 定位：**拟态**。它让 agent 在两次对话之间仍有内部状态、会自己醒、会拒绝，
  // 但**没有**必死 / 预算 / 记忆不可逆衰减 / 遗物 —— 那些是 `--alive` 原设计的承重墙，
  // 已明确不做（见 docs/ALIVE.md「这不是生命，是生命感」）。
  // 为什么不进 AGENT_LIMITS_SCHEMA：生命体征不该是用户旋钮（性格是轨迹，不是配置），
  // 这里只是**数字的唯一来源**；越界由 `src/alive/runtime.js#resolveAliveConfig` 夹取。
  /** 心跳间隔（唯一 tick 源；演示时可临时调小，页面会标「演示中」） */
  aliveTickIntervalMs: 300000,
  /**
   * 唤醒阈值初值 / 夹取区间。
   *
   * 取 40（= 下限）而不是 60：60 配上默认爬升，实测**静默 11.7 小时**才第一次自发醒
   * （200 次蒙特卡洛，无未闭合项），远达不到页面文案说的「几小时」。40 + 下面的爬升
   * 参数合起来约 **2.4 小时**第一次醒，起步就能被看见「它是活的」。
   */
  aliveWakeThreshold: 40,
  aliveWakeThresholdMin: 40,
  aliveWakeThresholdMax: 80,
  /** 阈值漂移速率（每小时）：拒绝率项 / 疲劳项。一天最多漂 ~7 */
  aliveWakeThresholdMuPerHour: 0.3,
  aliveWakeThresholdNuPerHour: 0.2,
  /** 拒绝率基线：长期低于它 → 阈值升高（更挑）；高于它 → 降低（更容易被推动） */
  aliveWakeRefusalBaseline: 0.2,
  /** 拒绝率滑动窗口 */
  aliveWakeRefusalWindowMs: 24 * 60 * 60 * 1000,
  /** 两次自发唤醒的最小间隔与每日上限（防抖 + 防烧钱） */
  aliveWakeMinIntervalMs: 10 * 60 * 1000,
  /**
   * 两次自发唤醒的最小间隔与每日上限（防抖 + 防烧钱）。
   *
   * 2026-11-12 按用户要求：40 → **100 次/天**。理论上限仍是「1440 分钟 ÷ 最小间隔 10 分钟 = 144」，
   * 但实际到不了 —— **疲劳**会先把它压住（每次唤醒 +20，静息 20/h，连续 3–5 次就进 COMPRESS
   * 相位，那相位不唤醒）。所以真正决定"一天能醒几次"的是疲劳，这条只负责"别一小时内抖几十次"。
   */
  aliveWakeMaxPerDay: 100,
  /**
   * 每日 token 额度（**成本护栏**，`<=0` = 不限）。
   *
   * 为什么「次数上限」之外还要这个：一次醒来烧多少，跟次数没有固定换算 —— 一次唤醒轮
   * 可能 8k（只做一次决策），也可能 200k（全量系统提示 + 工具 + 回看历史）。用次数表达
   * 钱必然失真，所以另给一条**只管钱**的机械上限：超了就不醒，理由写 `token-day-cap`。
   *
   * 标定：一次唤醒轮实测 2–7 万 token（`state.lastWakeTokens`：2026-11-12 观察 2 万–7.2 万）
   * → **1 亿 ≈ 1400–5000 次唤醒/天**。
   *
   * 2026-11-12 按用户要求两连抬：40 万 → 100 万 → **1 亿**；唤醒次数上限也从 40 抬到 100。
   * 抬到 1 亿的实际含义是**把「钱」这道闸基本打开**（100 次/天 × 最多 7 万 ≈ 700 万，占 7%），
   * 所以真正栓住它的是另外两条，动它们才是动行为：
   *   1. `aliveWakeMaxPerDay`（100 次/天）；
   *   2. **疲劳**：每次唤醒 +20，静息每小时回落 20 → 连续醒 3–5 次就进 COMPRESS 相位，那相位不唤醒。
   * 留着这条额度仍有意义：上游异常（比如一次请求叠了几十万 token）时它会被挡住，而不是烧一整晚。
   * 不做退避 / 动态降频 / 分时段配额 —— 那些是拿节律换预算，且会自己长出一套策略层。
   */
  aliveDailyTokenBudget: 100000000,
  /** 体征历史（`alive/history.jsonl`）的物理行数上限：超了裁一半，约 14 天的拍数（~350KB） */
  aliveHistoryMaxLines: 4000,
  /** 体征历史的默认观察窗口（面板曲线的横轴） */
  aliveHistoryWindowMs: 7 * 24 * 60 * 60 * 1000,
  /** 张力：均值回复中心 / 增益 / 感觉剥夺保护 ε / 上限 */
  aliveTensionMean: 20,
  aliveTensionGainPerHour: 0.35,
  /**
   * 张力追向回复中心的速度（每小时）：1/0.6 ≈ 1.7 小时的时间常数。
   * 原来 0.35（时间常数 ~2.9h）让「闲得发慌」这条要一整天才爬到阈值，拟态看起来是死的。
   */
  aliveTensionRestorePerHour: 0.6,
  aliveTensionEps: 0.8,
  aliveTensionMax: 100,
  /**
   * 「闲得发慌」：静默愈久，张力的回复中心越高 —— 这是它**自发醒来**的主要来源。
   * 没有这一项，一个没有任何未闭合事项的新实例会永远停在 20，从不清醒（拟态就失效了）。
   * 不是记忆衰减、不是损耗，只是「空久了会不舒服」。
   *
   * 标定（200 次蒙特卡洛，无未闭合项，从出生算）：宽限 0.25h + 每小时 +20 时
   * **中位 2.4 小时**第一次自发醒；原值（1h / +6）是 11.7 小时。
   */
  aliveTensionIdleRampPerHour: 20,
  aliveTensionIdleGraceHours: 0.25,
  aliveTensionIdleMax: 45,
  /** 未闭合项：单条基准张力 / 上限条数 / 自然消退时间常数（小时） */
  aliveLoopTensionUnit: 25,
  aliveLoopMax: 12,
  aliveLoopStaleHours: 48,
  /**
   * 「醒来时它看到什么」——最近工作的**事实块**（`src/alive/recap.js`）。
   *
   * 为什么要它：状态块原来只有内部体征，它每次醒来面对「空张力 + 空清单」只能 DEFER。
   * 有了"最近这台机器上发生过什么"，它才可能声明未闭合事项（loops），张力才由事项驱动。
   * 窗口/条数/字数都给上限：这是每轮都要付的 prompt 成本，且会话数量会随时间无限长。
   */
  aliveRecapWindowHours: 24,
  aliveRecapSessions: 3,
  aliveRecapTailChars: 160,
  /** 未收尾的**目标型计划**最多列几条（它要拿来声明未闭合事项；跑不动，只在只读轮里看） */
  aliveRecapPlans: 3,
  /** 整块文字的硬上限（超了按行截断并注明还有几条） */
  aliveRecapMaxChars: 800,
  /**
   * 唤醒轮事实块里带**它自己抽屉**的最后几行（`alive/workspace/note.md`）。
   *
   * 为什么不是"随便加点上下文"：它写在抽屉里的字是它自己的记忆（原话：
   * "让下次醒来的自己知道这次醒过"），而以前这份记忆只躺在硬盘上 —— 事实块只给它
   * 别人的会话，不给它自己的昨天。**目标只能从"我记得上次到哪儿"里长出来**，
   * 所以这几行是它唯一能自己总结出目标的原料。
   */
  aliveRecapNoteLines: 2,
  /**
   * 「跟你现在有关、你记得的」：唤醒轮拿**当前处境**（recap 的会话标题/尾句 + 计划 + 抽屉）
   * 去 `memory.long_recall` 召回几条长期记忆塞进事实块。
   *
   * 为什么不是靠默认注入：默认注入拿的是**体征块**当查询，里面没有具体名词，语义召回只会
   * 捞回泛泛的"用户偏好"（实测那几条 #1774/#1854）；而它要判断"现在有没有值得做的事"，
   * 需要的恰恰是"这台机器上正在说的那些事"相关的记忆。
   * 数字：条数 / 查询串字数上限 / 超时（召回慢就跳过，绝不挡唤醒）。
   */
  aliveRecallBySituation: 4,
  aliveRecallQueryMaxChars: 400,
  aliveRecallTimeoutMs: 4000,
  /**
   * 「设定」（设置 → 拟态 → 设定）：用户随手写的那一段话，留多少字。
   *
   * 为什么要有这个数：它是**每轮唤醒都要付的 prompt 成本**，而一段设定粘几万字很容易；
   * 没有上限时，一次唤醒就为一段不会变的文字反复付钱。
   * 2000 字 ≈ 几条"人生目标 / 遇到人怎么做 / 想聊什么"并列着写，够用且不至于淹没事实块。
   * 裁的是**尾部**（截断事实写在渲染侧，不静默吞掉半句话）。
   */
  aliveSetupMaxChars: 2000,
  /**
   * 疲劳：每千 token 涨多少 / 静息每小时回落 / 感觉剥夺保护 ε。
   *
   * **口径**：token 只数**唤醒轮自己**用掉的（`runtime.js` 只在 `wakeInFlight` 期间收用量），
   * 用户在对话里烧的 token 不算它累 —— 否则「疲劳」测的就不是它，而是「你有没有在聊天」。
   * 标定：一次唤醒轮（全量系统提示 + 工具）约 40k token ≈ 20 疲劳 ≈ 1 小时静息；
   * 连续醒 5 次就会进压缩相位（`alivePhaseFatigueHigh`），这是刻意的节律。
   * 原来取 4（=25k token 打满）是按「每跳几百 token」的想象标定的，一次真实唤醒就会钉死。
   */
  aliveFatiguePerKToken: 0.5,
  aliveFatigueSettlePerHour: 20,
  aliveFatigueEps: 0.5,
  /**
   * 主动出声/收音：每日上限与最小间隔（默认关着，见 `alive/settings.json` 的 voiceSpontaneous）。
   *
   * 2026-11-12 按用户要求放宽：单次间隔 30 → **20 分钟**、每日 8 → **100 次**。
   * 它已经不再"没人就不许说"（`decide.js` 只报 load 事实），配上宽松额度才谈得上"像个活物"；
   * 真正的成本护栏仍是唤醒轮自己的 `aliveDailyTokenBudget`（出声本身几乎不花 token）。
   */
  aliveVoiceMaxPerDay: 100,
  aliveVoiceMinIntervalMs: 20 * 60 * 1000,
  /**
   * 它说过的话在事件流 (`SPEAK.text`) 里保留多少字。
   *
   * 为什么要有这个数：它出声是**说给在场的人听的**，人可能不在、可能没听清 ——
   * 所以"说了什么"必须留成可回看的文字（「拟态 → 日志」逐条、侧栏「生命」页）。这是**展示**，
   * 不写进你的会话账本、不进模型上下文（那才是"接管对话线"）。
   * 只留每条最多这么多字：日志不是录音带，用完就旧了。
   * （`state.lastVoiceText` 与主窗口那条展示 2026-11-21 一并删除：出声原话只在事件流里。）
   */
  aliveVoiceTextMaxChars: 300,
  /**
   * 唤醒轮正文**压成一行**后留在 `state.lastWakeText` 的字数上限（侧栏「生命」页那一行）。
   *
   * 为什么要有这个数：唤醒轮是 `internal: true`，正文只落进它自己的会话库 —— 它一夜写了几万字，
   * 人回来翻面板却什么也看不见（主窗口那条展示 2026-11-21 删除时，这份副本一起删过一次；
   * 2026-11-21 之后**只喂侧栏「生命」页**，不再回主窗口气泡区）。
   * 与 `aliveVoiceTextMaxChars` 同一套语义：**只展示**，不进会话账本、不进模型上下文。
   */
  aliveWakeTextMaxChars: 200,
  /** 相位惯性（连续 k 个 tick 满足条件才切换）与相位门限 */
  alivePhaseInertiaAlert: 3,
  alivePhaseInertiaLow: 5,
  alivePhaseInertiaSettle: 5,
  alivePhaseInertiaCompress: 5,
  alivePhaseLoadWindowMs: 5 * 60 * 1000,
  alivePhaseLoadHigh: 0.35,
  alivePhaseLoadLow: 0.15,
  /** 负载归一：滑窗内多少 token 算「满负荷」（同时段有人聊天就会逼近 1） */
  alivePhaseLoadTokensHigh: 20000,
  alivePhaseFatigueHigh: 60,
  alivePhaseFatigueLow: 25,
  /**
   * 决策日志保留条数（`state.decisions` / `state.intents` 各自的上限）。
   *
   * 以前这两处硬编码在 `decide.js`（20 / 200），而本文件里的 `aliveHistoryMax` 算了却没人用 ——
   * 同一个口径两个来源，改一处就不生效。现在只有这一处。
   */
  aliveDecisionsKeep: 200,
  aliveIntentsKeep: 20,
  /** 「可疑顺从」告警的当日唤醒次数下限：醒了这么多次却一次没拒绝 = 排期表，不是活的 */
  aliveSuspiciousWakeMin: 5,
  /** 唤醒轮默认只读（可读文件/检索记忆/写记忆与目标，不写盘、不执行命令） */
  aliveReadOnlyWake: true,
  /**
   * 唤醒轮的**权力档**（`read` / `write` / `exec`）与它的护栏。
   *
   * 默认 `read`：心跳轮只读（原设计的承重墙）。放开是**显式开关**
   * （`alive/settings.json#wakePower`），放开之后仍然只有三道闸门：
   *   1. 只能在 `wakeWorkspace` 这一个根目录下动（越界 = `WAKE_PATH_OUTSIDE`）；
   *   2. 每轮写/执行次数有上限，跨轮不累计（默认一轮最多改 6 次、跑 3 条命令）；
   *   3. **永不等待审批**：需要用户当场同意的操作直接拒（`WAKE_NEEDS_APPROVAL`）——
   *      后台不该出现一个挂在那里等人的弹窗。
   */
  aliveWakePowerDefault: 'read',
  aliveWakeWriteMaxPerWake: 6,
  aliveWakeExecMaxPerWake: 3,
  /** `host_exec` 在唤醒轮里的命令超时（秒）；超出由执行层杀掉 */
  aliveWakeExecTimeoutSec: 120
};

/** @type {AgentLimitSchemaGroup[]} */
const AGENT_LIMITS_SCHEMA = [
  {
    group: '工具护栏',
    groupId: 'guardrails',
    items: [
      {
        key: 'repeatToolStreakLimit',
        label: '重复工具止损',
        hint: '连续完全相同的工具+参数才止损；读不同偏移或换搜索词不计入',
        type: 'number',
        min: 6,
        max: 18,
        step: 1,
        unit: '次'
      },
      {
        key: 'repeatHistoryMax',
        label: '指纹历史长度',
        type: 'number',
        min: 48,
        max: 192,
        step: 1,
        unit: '条'
      },
      {
        key: 'writeSmellHintMaxItems',
        label: '写入坏味道提示条数',
        hint: '文件写成功后附加的结构性提示条数上限；0 = 关闭。只提示，不阻断交付',
        type: 'number',
        min: 0,
        max: 10,
        step: 1,
        unit: '条'
      },
      {
        key: 'writeSmellHintMaxChars',
        label: '写入坏味道提示字符上限',
        hint: '单次工具结果里结构性提示的总字符上限',
        type: 'number',
        min: 0,
        max: 2000,
        step: 40,
        unit: '字'
      },
      {
        key: 'writeSmellScanTimeoutMs',
        label: '坏味道目录查询超时',
        hint: '查同目录同胞文件的最长等待；超时即降级为只看得见本轮，不阻塞工具结果',
        type: 'number',
        min: 200,
        max: 10000,
        step: 100,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'taskTierEnabled',
        label: '发送前任务分级',
        hint: '用结构信号（路径/选区/@Codebase）推断规模并跳过多余自动检索；不另打分级 LLM，不据此强迫写入',
        type: 'boolean'
      }
    ]
  },
  {
    group: '内网 Agent 互通',
    groupId: 'peer',
    items: [
      {
        key: 'peerMaxHops',
        label: '跨机消息跳数上限',
        hint: '一条消息链上最多经过几个 agent；达到上限只投递、不再自动跑一轮（防两个 agent 互相撩）',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        unit: '跳'
      },
      {
        key: 'peerTurnBudgetPerHour',
        label: '每对端每小时自动回合',
        hint: '同一台对端触发本机自动跑一轮的次数上限；超出只落会话不自动跑',
        type: 'number',
        min: 0,
        max: 120,
        step: 1,
        unit: '次'
      },
      {
        key: 'peerMaxMessageChars',
        label: '单条跨机消息字符上限',
        hint: '超长内容请用文件/路径传递，不要塞进消息体',
        type: 'number',
        min: 500,
        max: 32000,
        step: 500,
        unit: '字'
      },
      {
        key: 'peerReplyTimeoutMs',
        label: '等对端回复超时',
        hint: 'peer_send 带 expectReply 时最多等多久；对端要跑完一整轮，故默认两分钟',
        type: 'number',
        min: 5000,
        max: 600000,
        step: 5000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'peerPresenceTtlMs',
        label: '对端在线判定时长',
        hint: '超过该时长没再收到对端宣告即视为离线',
        type: 'number',
        min: 30000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'peerClaimTtlMs',
        label: '文件/任务租约时长',
        hint: '租约到期自动释放；建议式约束，不替代 git 与 worktree 隔离',
        type: 'number',
        min: 60000,
        max: 3600000,
        step: 60000,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: '子 Agent（并发调研 / 并行写入）',
    groupId: 'subagent',
    items: [
      {
        key: 'plannerMultiAgentEnabled',
        label: '多 Agent 并行执行',
        hint: '允许（不强制）：每轮开工前由侧模型判断这句是否值得拆成多路并行（各一份 worktree，改完在变更面板合并），判不准就走普通工具循环。需 git 工作区。判定（结论 + 理由 + 判定模型思考）会写在思考区第一张卡「调度 · 侧模型判定」。侧模型在本页下方「子 Agent 判定模型」里单独指定，留空用主模型。只在打开的档位生效',
        type: 'boolean'
      },
      {
        key: 'plannerMaxParallelWorkers',
        label: '并行执行器上限',
        hint: '每个执行器 = 一个 git worktree + 一条 LLM 并发流；调大前先确认 provider 额度',
        type: 'number',
        min: 1,
        max: 6,
        step: 1,
        unit: '路'
      },
      {
        key: 'plannerBestOfN',
        label: 'best-of-N 路数',
        hint: '同一 build 类子任务并行跑 N 份、由评审择优（0 = 关）。每多一路就是多一份 token 与一条 LLM 并发流',
        type: 'number',
        min: 0,
        max: 3,
        step: 1,
        unit: '路'
      },
      {
        key: 'subagentMaxDepth',
        label: '子 Agent 最大深度',
        hint: '1 = 只允许协调者派一层；研究子 Agent 的 Explore 白名单不含 subagent，再多也派不出去',
        type: 'number',
        min: 0,
        max: 3,
        step: 1,
        unit: '层'
      },
      {
        key: 'subagentMaxConcurrent',
        label: '子 Agent 并发上限',
        hint: '只读工具走 delegate-batch 的无限并发分支，必须在子 Agent 执行器内自我限流',
        type: 'number',
        min: 1,
        max: 8,
        step: 1,
        unit: '个'
      },
      {
        key: 'subagentMaxPerRun',
        label: '整轮派出总上限',
        hint: '一次对话最多派出多少个子 Agent，防失控',
        type: 'number',
        min: 1,
        max: 24,
        step: 1,
        unit: '个'
      },
      {
        key: 'subagentMaxRounds',
        label: '子 Agent 最大轮次',
        hint: '单个子 Agent 的工具轮预算；子 Agent 独立记账，不占父级轮次',
        type: 'number',
        min: 4,
        max: 320,
        step: 1,
        unit: '轮'
      },
      {
        key: 'subagentMaxToolCalls',
        label: '子 Agent 工具上限',
        hint: '单个子 Agent 的工具调用总次数上限；独立记账，不占父级工具预算',
        type: 'number',
        min: 4,
        max: 640,
        step: 1,
        unit: '次'
      },
      {
        key: 'subagentSummaryMaxChars',
        label: '子 Agent 摘要回注上限',
        hint: '只有摘要进主上下文；过程 trace 仅折叠卡片可见',
        type: 'number',
        min: 400,
        max: 8000,
        step: 100,
        unit: '字'
      },
      {
        key: 'subagentFollowupRetention',
        label: '子 Agent 追问留存份数',
        hint: '同一轮运行内可被 continueFrom 续问的已完成子 Agent 上下文数（LRU）；0 = 关闭追问',
        type: 'number',
        min: 0,
        max: 32,
        step: 1,
        unit: '份'
      }
    ]
  },
  {
    group: '工具 Harness',
    groupId: 'harness',
    items: [
      {
        key: 'transientMaxRetries',
        label: '瞬态错误重试',
        type: 'number',
        min: 0,
        max: 9,
        step: 1,
        unit: '次'
      },
      {
        key: 'retryBaseMs',
        label: '重试基础间隔',
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: '定时与闲时',
    groupId: 'plans-idle',
    items: [
      {
        key: 'plansIdlePollMs',
        label: '闲时队列轮询间隔',
        hint: '「空闲时执行」计划的检查频率；只在无活跃 Agent 运行时生效',
        type: 'number',
        min: 10000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'plansIdleQuietMs',
        label: '闲时静默阈值',
        hint: '最后一次 Agent 活动之后静默多久，才允许触发空闲任务',
        type: 'number',
        min: 60000,
        max: 3600000,
        step: 60000,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: '目标型计划（跑到完成）',
    groupId: 'goal-run',
    items: [
      {
        key: 'goalMaxAttempts',
        label: '续跑轮次上限',
        hint: '默认轮数与表单可填上限：目标型计划最多跑几轮；填 0 表示用默认值',
        type: 'number',
        min: 1,
        max: 48,
        step: 1,
        unit: '轮'
      },
      {
        key: 'goalMaxWallMs',
        label: '续跑墙钟预算',
        hint: '从首轮开始计算的总时长预算；用完即停，并把已跑轮次与检查事实留在计划里',
        type: 'number',
        min: 30 * 60 * 1000,
        // 上限必须高于默认值（24h），否则表单一填就被夹回默认、旋钮等于没开。
        max: 48 * 60 * 60 * 1000,
        step: 30 * 60 * 1000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'goalRetryBackoffMs',
        label: '异常恢复退避',
        hint: '只在崩溃/执行异常后隔多久重排下一轮；正常跑完一轮立刻接下一轮',
        type: 'number',
        min: 5000,
        max: 600000,
        step: 5000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'goalCheckTimeoutMs',
        label: '检查命令超时',
        hint: '模型调用 goal_check 时等待的时长；必须 ≤ host.exec 硬上限 600s，否则合法构建会被截断误判',
        type: 'number',
        min: 10000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'goalEvidenceTailChars',
        label: '检查证据尾部字符',
        hint: '检查未通过时只把输出的尾巴注入下一轮，避免整份日志灌进上下文',
        type: 'number',
        min: 400,
        max: 20000,
        step: 400,
        unit: '字'
      }
    ]
  },
  {
    group: 'UI 联动',
    groupId: 'ui-link',
    items: [
      {
        key: 'artifactsUiFlushMs',
        label: '产物区刷新防抖',
        type: 'number',
        min: 40,
        max: 300,
        step: 10,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'lspSyncDebounceMs',
        label: 'LSP 同步防抖',
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'monacoMaxChars',
        label: 'Monaco 最大字符',
        type: 'number',
        min: 50000,
        max: 400000,
        step: 10000,
        unit: '字'
      }
    ]
  },
  {
    group: '上下文注入',
    groupId: 'context',
    items: [
      {
        key: 'toolResultMaxJson',
        label: '工具结果 JSON 上限',
        hint: '写入循环 messages 前截断；UI 仍可见完整结果',
        type: 'number',
        min: 4000,
        max: 30000,
        step: 500,
        unit: '字'
      },
      {
        key: 'codebaseSnippetMax',
        label: '代码片段字符上限',
        type: 'number',
        min: 400,
        max: 3000,
        step: 100,
        unit: '字'
      },
      {
        key: 'codebaseAutoLimit',
        label: '自动检索条数',
        type: 'number',
        min: 2,
        max: 24,
        step: 1,
        unit: '条'
      },
      {
        key: 'openFilesMax',
        label: '打开文件注入上限',
        type: 'number',
        min: 4,
        max: 24,
        step: 1,
        unit: '个'
      },
      {
        key: 'filePreviewMaxChars',
        label: '文件预览字符上限',
        type: 'number',
        min: 1000,
        max: 12000,
        step: 200,
        unit: '字'
      },
      {
        key: 'fsReadDefaultMaxBytes',
        label: 'Agent 读文件默认字节',
        hint: '省略 maxBytes 时的块大小；索引/UI 读文件仍可用更大上限',
        type: 'number',
        min: 8192,
        max: 2097152,
        step: 8192,
        unit: 'B'
      },
      {
        key: 'completionHistoryMaxChars',
        label: '近期原文历史字符上限',
        hint: '近 N 条原文 + 折叠条合计；更早轮次不再整段进 messages',
        type: 'number',
        min: 16000,
        max: 200000,
        step: 4000,
        unit: '字'
      },
      {
        key: 'completionRecentTurns',
        label: '近轮原文条数',
        hint: '仅计当前任务用户及更早的书本消息；本轮工具链不计入、也不被折叠',
        type: 'number',
        min: 4,
        max: 48,
        step: 1,
        unit: '条'
      },
      {
        key: 'completionFoldedMaxChars',
        label: '较早对话折叠上限',
        type: 'number',
        min: 2000,
        max: 32000,
        step: 500,
        unit: '字'
      },
      {
        key: 'completionMessageMaxChars',
        label: '单条历史消息上限',
        type: 'number',
        min: 2000,
        max: 24000,
        step: 500,
        unit: '字'
      },
      {
        key: 'completionLastUserMaxChars',
        label: '本轮用户文本上限',
        type: 'number',
        min: 4000,
        max: 80000,
        step: 2000,
        unit: '字'
      },
      {
        key: 'completionTurnRideMaxChars',
        label: '本轮 Turn-ride 上限',
        hint: '开文件/代码库等临时上下文；与本轮用户问题分开截断，避免砍掉当前任务',
        type: 'number',
        min: 8000,
        max: 80000,
        step: 2000,
        unit: '字'
      },
      {
        key: 'userSystemMaxChars',
        label: '用户系统提示上限',
        hint: '设置里的自定义 system；不进 turn-ride',
        type: 'number',
        min: 1000,
        max: 24000,
        step: 500,
        unit: '字'
      },
      {
        key: 'systemStableMaxChars',
        label: '稳定 system 总帽',
        hint: '准则/用户 system/MCP 目录等合计，不含 turn-ride',
        type: 'number',
        min: 4000,
        max: 48000,
        step: 1000,
        unit: '字'
      },
      {
        key: 'llmRequestMaxChars',
        label: '单次 LLM 请求字符硬顶',
        hint: 'messages 合计上限，须低于中转 Input length（约 1,048,566）',
        type: 'number',
        min: 200000,
        max: 1040000,
        step: 20000,
        unit: '字'
      },
      {
        key: 'lspDiagMaxChars',
        label: 'LSP 诊断字符上限',
        type: 'number',
        min: 2000,
        max: 20000,
        step: 500,
        unit: '字'
      },
      {
        key: 'visionShotsPerRound',
        label: '浏览器截图注入张数',
        hint: '每个 LLM 轮次最多在途几张浏览器截图；仅多模态模型生效，注入后即清空、下一轮重新计',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        unit: '张'
      },
      {
        key: 'visionReattachPerRound',
        label: '附件补看张数',
        hint: '每个 LLM 轮次最多在途几张历史附件（模型用 fs_read_file 设 encoding=base64 触发）；注入后即清空、下一轮重新计',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        unit: '张'
      },
      {
        key: 'visionMaxBase64Chars',
        label: '单张图片 base64 上限',
        hint: '超过即不注入，避免单次请求顶爆',
        type: 'number',
        min: 262144,
        max: 8388608,
        step: 262144,
        unit: '字'
      },
      {
        key: 'visionShotMaxEdge',
        label: '截图长边上限',
        hint: '电脑控制/浏览器截图注入前按长边缩放到此像素（1568 是主流多模态模型的最优区间）；调小更省 token，调大字形更清楚',
        type: 'number',
        min: 512,
        max: 2560,
        step: 128,
        unit: 'px'
      }
    ]
  },
  {
    group: 'LLM 重试',
    groupId: 'llm',
    items: [
      {
        key: 'streamRoundMaxAttempts',
        label: '流式轮次重试',
        hint: '仅在「模型重连总时长上限」为 0 时生效：单次采样遇到瞬时断线时的重试次数（不含首次请求）',
        type: 'number',
        min: 1,
        max: 5,
        step: 1,
        unit: '次'
      },
      {
        key: 'llmReconnectMaxWaitMs',
        label: '模型重连总时长上限',
        hint: '瞬时断线持续自动重连的最长等待（显示为分钟，实际按毫秒存储），期间次数不限（不会要你手动点继续）；设为 0 则退回「流式轮次重试」次数模式',
        type: 'number',
        min: 0,
        max: 60 * 60 * 1000,
        step: 60000,
        format: 'min'
      },
      {
        key: 'llmRetryBaseMs',
        label: 'LLM 重试基础间隔',
        hint: '瞬时错误退避：base × 2^(n-1)，单次等待不超过 60s；不再整轮连等十几分钟',
        type: 'number',
        min: 200,
        max: 3000,
        step: 100,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'synthesisTimeoutMs',
        label: '最终汇总超时',
        hint: '工具轮结束后补一轮用户向总结的最长等待；超时用已流出文本或思考区兜底，避免气泡停在「生成回答中」',
        type: 'number',
        min: 5000,
        max: 120000,
        step: 1000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'synthesisReconnectMaxWaitMs',
        label: '最终汇总重连上限',
        hint: '汇总轮遇到瞬时断线时的重连等待，短于普通对话重连',
        type: 'number',
        min: 1000,
        max: 60000,
        step: 1000,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: '编辑器与 Diff',
    groupId: 'editor',
    items: [
      {
        key: 'editorSelectionMax',
        label: '选区注入字符上限',
        type: 'number',
        min: 500,
        max: 5000,
        step: 100,
        unit: '字'
      },
      {
        key: 'editorVisibleLines',
        label: '可见行上下文',
        type: 'number',
        min: 10,
        max: 80,
        step: 5,
        unit: '行'
      },
      {
        key: 'maxDiffChars',
        label: 'Diff 上下文上限',
        type: 'number',
        min: 4000,
        max: 30000,
        step: 500,
        unit: '字'
      },
      {
        key: 'diffFullTextCap',
        label: 'Diff 全文上限',
        type: 'number',
        min: 40000,
        max: 200000,
        step: 5000,
        unit: '字'
      },
      {
        key: 'maxUndoSteps',
        label: '撤回步数上限',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        unit: '步'
      },
      {
        key: 'chatImagePreviewMaxMb',
        label: '聊天图片预览上限',
        type: 'number',
        min: 5,
        max: 50,
        step: 1,
        format: 'mb',
        unit: 'MB'
      },
      {
        key: 'attachmentRetentionMaxMb',
        label: '附件图片总量上限',
        hint: '超过后从最旧的图片开始原地降采样（不改名、不删除，历史引用仍然有效）',
        type: 'number',
        min: 50,
        max: 5000,
        step: 50,
        format: 'mb',
        unit: 'MB'
      },
      {
        key: 'attachmentDownsampleMaxPx',
        label: '附件降采样最长边',
        hint: '降采样时按最长边等比缩到该像素',
        type: 'number',
        min: 640,
        max: 4096,
        step: 80,
        unit: 'px'
      },
      {
        key: 'attachmentDownsampleMinKb',
        label: '附件降采样最小体积',
        hint: '小于该体积的图片不再降采样，避免反复重编码',
        type: 'number',
        min: 20,
        max: 1024,
        step: 20,
        unit: 'KB'
      }
    ]
  },
  {
    group: '默认工作区回收',
    groupId: 'workspace-gc',
    items: [
      {
        key: 'defaultWorkspaceRetentionDays',
        label: '默认工作区保留天数',
        hint:
          '没有会话负责清理的兜底目录 ~/.dieyun/workspace：超过该天数没动过的条目会被回收；' +
          '含工程标记（.git / package.json 等）或最近 24 小时动过的条目永不自动删除',
        type: 'number',
        min: 1,
        max: 365,
        step: 1,
        unit: '天'
      },
      {
        key: 'defaultWorkspaceMaxMb',
        label: '默认工作区容量上限',
        hint: '超过该容量后按最旧优先继续回收；只作用于 ~/.dieyun/workspace，不碰自选工作空间',
        type: 'number',
        min: 50,
        max: 20480,
        step: 50,
        format: 'mb',
        unit: 'MB'
      }
    ]
  }
];

const SCHEMA_BY_KEY = new Map();
for (const group of AGENT_LIMITS_SCHEMA) {
  for (const item of group.items) {
    SCHEMA_BY_KEY.set(item.key, item);
  }
}

function clampSchemaValue(item, value) {
  const def = AGENT_LIMITS_DEFAULTS[item.key];
  if (item.type === 'boolean') return !!value;
  const v = Number(value);
  if (!Number.isFinite(v)) return def;
  const min = item.min != null ? item.min : def;
  const max = item.max != null ? item.max : def;
  const step = item.step != null ? item.step : 1;
  let n = Math.min(max, Math.max(min, v));
  if (step >= 1) n = Math.round(n);
  return n;
}

function normalizeAgentLimits(raw) {
  const out = { ...AGENT_LIMITS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, item] of SCHEMA_BY_KEY) {
    if (raw[key] === undefined) continue;
    out[key] = clampSchemaValue(item, raw[key]);
  }
  return out;
}

function formatAgentLimitValue(item, value) {
  if (item.type === 'boolean') return value ? '开' : '关';
  const n = Number(value);
  if (item.format === 'min') return `${Math.round(n / 60000)} 分钟`;
  if (item.format === 'ms') return `${Math.round(n)} ms`;
  if (item.format === 'mb') return `${Math.round(n)} MB`;
  if (item.step != null && item.step < 1) return Number(n).toFixed(2);
  return Math.round(n).toLocaleString('zh-CN') + (item.unit ? ` ${item.unit}` : '');
}

// --- 按档持久化（磁盘 userData/agent-limits-by-tier.json；Renderer localStorage 由 by-tier 模块管）---
const AGENT_LIMITS_BY_TIER_FILE = 'agent-limits-by-tier.json';
/** @type {string|null} */
let nodeCacheUserData = null;
/** @type {Record<string, Record<string, unknown>>|null} */
/** @type {Record<string, Record<string, unknown>> | null} */
let nodeByTierCache = null;

/**
 * agent-limits ↔ agent-limits-by-tier 互为依赖（后者需要本文件的 AGENT_LIMITS_DEFAULTS /
 * normalizeAgentLimits），顶层互相 require 会成环，故对 by-tier 用惰性 require 打破环。
 * esbuild 仍能在构建期静态解析这个字面路径。
 */
function limitsByTierModule() {
  return require('./agent-limits-by-tier');
}

/**
 * 跨层钩子：renderer 的 renderer-model-settings.js 把 resolveContextTierId 挂到 window。
 * 它不是 agent 层模块、无法 require，只能运行期取（Node 下不存在 → 落到 default）。
 */
function crossLayerGlobalFn(name) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return typeof g[name] === 'function' ? g[name] : null;
}

function resolveAgentLimitsTierId(opts = {}) {
  if (opts && opts.tierId) {
    const id = normalizeContextTierId(String(opts.tierId).trim(), '');
    if (id) return id;
  }
  if (opts && opts.editing === true) {
    return getEditingContextTierId();
  }
  const resolveContext = crossLayerGlobalFn('resolveContextTierId');
  if (resolveContext) {
    return resolveContext(opts || {});
  }
  return 'default';
}

function isUserDataPath(value) {
  // 只有绝对路径才当作 Node 的 userData 目录。此前用「含分隔符」判断，
  // 任何带斜杠的普通字符串（URL 片段、自定义 id 等）都会被误判进磁盘分支
  if (typeof value !== 'string' || !value) return false;
  try {
    return nodeRequire('path').isAbsolute(value);
  } catch {
    // renderer 无 require：退化为旧判断，保证打包环境仍可用
    return /[\\/]/.test(value);
  }
}

function listKnownTierIds() {
  return listContextTierIds();
}

function remapLimitsTierId(id) {
  return remapLegacyContextTierId(id);
}

/**
 * 把旧档位名的整表折叠到当前档位集合上。
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, Record<string, unknown>>}
 */
function foldLimitsTierRecord(raw) {
  return /** @type {Record<string, Record<string, unknown>>} */ (
    foldLegacyContextTierRecord(raw, (tid) => listKnownTierIds().includes(tid))
  );
}

function isAgentLimitsByTierShape(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const tierIds = listKnownTierIds();
  return Object.keys(raw).some((k) => tierIds.includes(remapLimitsTierId(k)));
}

/**
 * 把「归一化后的整表」压回「只含显式覆盖项的扁平记录」。
 *
 * `@param {Record<string, unknown>} values`
 * `@returns {Record<string, unknown>}`
 */
function extractLimitOverridesFromNormalized(values) {
  return /** @type {Record<string, unknown>} */ (
    limitsByTierModule().extractLimitOverrides(values)
  );
}

function syncLimitsToMainProcess() {
  if (typeof window === 'undefined') return;
  /** @type {any} */
  const w = window;
  if (!w.diecloud || !w.diecloud.syncAgentLimits) return;
  w.diecloud.syncAgentLimits(limitsByTierModule().getAllLimitsByTier()).catch(() => {});
}

/**
 * 读取适用档位的护栏数值表（扁平设置包，键名见 `AGENT_LIMITS_SCHEMA`）。
 *
 * 为什么不给每个键写类型：这是一张几百个键的异构设置表（数字 / 布尔 / 文本混排），
 * 逐键声明只会制造另一份需要同步的清单。这里只承诺「是个按名字取值的包」——
 * 调用点因此能安全地读任意键（拼错键名仍然是运行期 `undefined`，由 schema 兜底校验）。
 *
 * @param {string|object} [arg] userData 路径，或 `{ userData, contextTierId, ... }`
 * @param {string} [tierIdArg] 上下文档（`ctx-128k` 等）；`arg` 为路径时用它
 * @returns {Record<string, any>}
 */
function getAgentLimits(arg, tierIdArg) {
  if (isUserDataPath(arg)) {
    const tierId = tierIdArg || 'default';
    return getAgentLimitsForNodeTier(arg, tierId);
  }

  const opts = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {};
  return limitsByTierModule().getLimitsForTier(resolveAgentLimitsTierId(opts));
}

function getAgentLimit(key, userDataPathOrOpts, tierIdArg) {
  return getAgentLimits(userDataPathOrOpts, tierIdArg)[key];
}

function setAgentLimits(partial, opts = {}) {
  const tierId = resolveAgentLimitsTierId(opts);
  const merged = limitsByTierModule().setLimitsForTier(tierId, partial || {});
  if (!opts.skipSync) syncLimitsToMainProcess();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dieyun:agent-limits-change', {
        detail: { ...merged, contextTierId: tierId }
      })
    );
  }
  return merged;
}

function resetAgentLimits(opts = {}) {
  const tierId = resolveAgentLimitsTierId(opts);
  const merged = limitsByTierModule().resetLimitsForTier(tierId);
  if (!opts.skipSync) syncLimitsToMainProcess();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dieyun:agent-limits-change', {
        detail: { ...merged, contextTierId: tierId }
      })
    );
  }
  return { ...merged };
}

function hydrateAgentLimitsFromDisk(limits) {
  limitsByTierModule().hydrateLimitsByTier(limits);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dieyun:agent-limits-change', {
        detail: {
          ...getAgentLimits({ editing: true }),
          contextTierId: resolveAgentLimitsTierId({ editing: true })
        }
      })
    );
  }
}

function agentLimitsFilePath(userDataPath) {
  const path = nodeRequire('path');
  return path.join(userDataPath, AGENT_LIMITS_BY_TIER_FILE);
}

function legacyAgentLimitsFilePath(userDataPath) {
  const path = nodeRequire('path');
  return path.join(userDataPath, 'agent-limits.json');
}

/**
 * 读磁盘上的「按档位覆盖表」。
 *
 * 空表用带索引签名的断言而不是裸 `{}`：裸对象字面量在 TS 里是 `{}`（无索引签名），
 * 赋给 `Record<...>` 会报错 —— 类型债里最常见的一类「类型过期」，不是代码错。
 *
 * @returns {Record<string, Record<string, unknown>>}
 */
function loadLimitsByTierFromDisk(userDataPath) {
  if (!userDataPath) return /** @type {Record<string, Record<string, unknown>>} */ ({});
  const fs = nodeRequire('fs');
  const byTierFile = agentLimitsFilePath(userDataPath);
  try {
    const raw = JSON.parse(fs.readFileSync(byTierFile, 'utf8'));
    if (raw && typeof raw === 'object' && isAgentLimitsByTierShape(raw)) {
      return foldLimitsTierRecord(raw);
    }
  } catch {
    // fall through
  }

  try {
    const legacyRaw = JSON.parse(fs.readFileSync(legacyAgentLimitsFilePath(userDataPath), 'utf8'));
    if (legacyRaw && typeof legacyRaw === 'object' && !isAgentLimitsByTierShape(legacyRaw)) {
      const migrated = { default: extractLimitOverridesFromNormalized(legacyRaw) };
      saveLimitsByTierToDisk(userDataPath, migrated);
      return migrated;
    }
  } catch {
    // ignore
  }
  return /** @type {Record<string, Record<string, unknown>>} */ ({});
}

function getNodeLimitsByTier(userDataPath) {
  if (userDataPath !== nodeCacheUserData || !nodeByTierCache) {
    nodeByTierCache = loadLimitsByTierFromDisk(userDataPath);
    nodeCacheUserData = userDataPath;
  }
  return nodeByTierCache;
}

function getAgentLimitsForNodeTier(userDataPath, tierId) {
  const key = listKnownTierIds().includes(remapLimitsTierId(tierId))
    ? remapLimitsTierId(tierId)
    : 'default';
  const byTier = getNodeLimitsByTier(userDataPath);
  const overrides = byTier[key] || {};
  return normalizeAgentLimits(overrides);
}

function saveLimitsByTierToDisk(userDataPath, byTier) {
  if (!userDataPath) return /** @type {Record<string, Record<string, unknown>>} */ ({});
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const file = agentLimitsFilePath(userDataPath);
  const cleaned = /** @type {Record<string, Record<string, unknown>>} */ ({});
  const folded = foldLimitsTierRecord(byTier || {});
  for (const [tierId, values] of Object.entries(folded)) {
    if (!listKnownTierIds().includes(tierId) || !values || typeof values !== 'object') continue;
    const overrides = extractLimitOverridesFromNormalized(values);
    if (Object.keys(overrides).length) cleaned[tierId] = overrides;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8');
  if (userDataPath === nodeCacheUserData) nodeByTierCache = cleaned;
  return cleaned;
}

function saveAgentLimitsToDisk(userDataPath, limits) {
  if (!userDataPath) return normalizeAgentLimits(limits || {});
  if (limits && typeof limits === 'object' && isAgentLimitsByTierShape(limits)) {
    return saveLimitsByTierToDisk(userDataPath, limits);
  }
  const byTier = getNodeLimitsByTier(userDataPath);
  byTier.default = extractLimitOverridesFromNormalized(limits || {});
  if (!Object.keys(byTier.default).length) delete byTier.default;
  return saveLimitsByTierToDisk(userDataPath, byTier);
}

/**
 * 工具段上限（每段最多多少次工具调用）的唯一来源：`model-settings.agentToolCallLimit`
 * （「编码参数 → 模型与段预算 → 工具调用段上限」，按 Context 档位存、与 `agentMaxRounds` 成对）。
 *
 * 这里过去还有一条「agent-limits 的 ctxAgentToolCallLimit 兜底」，但取的是
 * `settings` 优先 —— settings 永远有值（默认 600），所以那个旋钮从来不会生效，
 * 只是多出一份能改却不生效的配置。现在只认 settings，区间由 model-runtime-schema 统一 clamp。
 */
function resolveLoopToolCallLimit(settings) {
  return clampModelRuntimeValue('agentToolCallLimit', settings && settings.agentToolCallLimit);
}

/**
 * 轮次上限的唯一来源（`model-settings.agentMaxRounds`，默认 `PRESET_DEFAULTS.agentMaxRounds`）。
 *
 * Loop 启动前由 `rust-loop-runner.applyResolvedLoopSpec` 填进 `agent.loop.start`；
 * 内核（`loop_run.rs`）**不再自带** 96 的兜底 —— 跨语言各留一份默认值，改一边就静默分叉。
 */
function resolveAgentMaxRounds(settings) {
  return clampModelRuntimeValue('agentMaxRounds', settings && settings.agentMaxRounds);
}

/** Resolve loop tunables before run — do not hide defaults inside the loop body. */
function resolveAgentLoopSpec(settings, userDataPath, tierId) {
  const limits = getAgentLimitsForNodeTier(userDataPath, tierId || 'default');
  const maxRetries = Number(limits.streamRoundMaxAttempts);
  const retryBaseMs = Number(limits.llmRetryBaseMs);
  const reconnectMaxWaitMs = Number(limits.llmReconnectMaxWaitMs);
  return {
    maxToolCalls: resolveLoopToolCallLimit(settings),
    maxRounds: resolveAgentMaxRounds(settings),
    llmMaxRetries: Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3,
    llmRetryBaseMs: Number.isFinite(retryBaseMs) && retryBaseMs >= 200 ? retryBaseMs : 800,
    llmMaxRetryDelayMs: 60000,
    // >0 时进入时间驱动的无限次重连；0 时退回 llmMaxRetries 次数模式
    llmReconnectMaxWaitMs:
      Number.isFinite(reconnectMaxWaitMs) && reconnectMaxWaitMs >= 0
        ? reconnectMaxWaitMs
        : AGENT_LIMITS_DEFAULTS.llmReconnectMaxWaitMs
  };
}

function resolveContextTierIdForNode(userDataPath, modelRouteOrId) {
  try {
    const { loadModelSettings } = nodeRequire('../model-settings');
    const { resolveContextTierIdFromSettings } = require('./model-runtime-by-tier');
    const settings = loadModelSettings(userDataPath);
    return resolveContextTierIdFromSettings(settings, modelRouteOrId);
  } catch {
    try {
      const { inferContextTierFromModelName } = require('./model-runtime-by-tier');
      return inferContextTierFromModelName(modelRouteOrId);
    } catch {
      return 'default';
    }
  }
}

const agentLimitsApi = {
  AGENT_LIMITS_DEFAULTS,
  AGENT_LIMITS_SCHEMA,
  SCHEMA_BY_KEY,
  normalizeAgentLimits,
  formatAgentLimitValue,
  resolveAgentLimitsTierId,
  getAgentLimits,
  getAgentLimit,
  setAgentLimits,
  resetAgentLimits,
  hydrateAgentLimitsFromDisk,
  saveAgentLimitsToDisk,
  saveLimitsByTierToDisk,
  loadLimitsByTierFromDisk,
  resolveContextTierIdForNode,
  resolveAgentLoopSpec,
  resolveLoopToolCallLimit,
  resolveAgentMaxRounds,
  isAgentLimitsByTierShape
};

module.exports = agentLimitsApi;
