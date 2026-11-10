'use strict';
// @ts-check

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
  // 闲时队列（plans trigger=idle）：轮询间隔与「静默多久才算闲」。
  // 「忙」的唯一来源是 rust-loop-runner 的活跃 agent loop 计数（聊天/规划/定时任务全走它）。
  plansIdlePollMs: 60 * 1000,
  plansIdleQuietMs: 5 * 60 * 1000,
  // 目标型计划（plans trigger=goal）：预算在代码，节奏在模型。
  // 决定「再做一轮」只看客观事实：目标已被验收证据判定通过、或预算/轮次用完。
  // 这里只提供默认值与 clamp 上限（表单里填的数不能突破上限，防一晚烧穿预算）。
  goalMaxAttempts: 12,
  goalMaxWallMs: 8 * 60 * 60 * 1000,
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
  codebaseSnippetMax: 2400,
  codebaseAutoLimit: 12,
  // 「一次交互查询最多能等多久 embedding 往返」。超过它就**不发请求**，直接走关键词/子串通道。
  //
  // 为什么需要这个数：端点一慢（自建 4B 模型实测 34–44s/请求且服务端串行），
  // 每轮召回都发一个注定被调用方放弃的请求 —— 被放弃的 HTTP 仍在端点队列里排队，
  // 下一轮再排一条，队列永不排空，同一队列里的 codebase.search 跟着一起超时。
  // 现场见 docs/VECTOR-SEARCH.md §1.4（`agent:prep-system-prompt` 因 codebase.search 超时整轮失败）。
  //
  // **不是旋钮**：它不是「调大就能多等」的性能参数 —— 调大只会让每轮等更久，
  // 端点本身的往返时间不会变。Rust 侧 `crates/dieyun-core/src/embedding/mod.rs`
  // 的 `INTERACTIVE_EMBED_BUDGET_MS` 与本值成对（跨语言没法共享常量，同 SLOW_RPC_LOG_MS 先例）。
  interactiveEmbedBudgetMs: 10000,
  openFilesMax: 12,
  filePreviewMaxChars: 4000,
  fsReadDefaultMaxBytes: 65536,
  // LSP 诊断只在这里限「注入字符数」；文件数与超时的唯一来源是 lsp-settings
  // （src/lsp/diagnostics-service.js 的 LSP_SETTINGS_DEFAULTS / lsp-settings.json）。
  lspDiagMaxChars: 10000,
  streamRoundMaxAttempts: 3,
  llmRetryBaseMs: 800,
  llmReconnectMaxWaitMs: 30 * 60 * 1000,
  llmFirstTokenTimeoutMs: 180000,
  // 流式「包间隔」容忍时长：开始出字后，静默超过该时长即 ETIMEDOUT idle 并交给重连层。
  // 与首包超时同属看门狗（同值 180s），且都只认有效 SSE data 行（keep-alive 空包不续命）。
  // 取 180s 是「不误杀」优先：一旦开始出字，正常包间隔是亚秒~几秒级，这里有几十倍余量；
  // 若上游确实是断流，最多也让用户等 3 分钟而不是原来的 10 分钟。
  llmStreamIdleTimeoutMs: 180000,
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
  // token 口径 token-estimate.IMAGE_PART_EQUIV_TOKENS（Rust 同值见 compaction/tokens.rs）。
  visionPartEqChars: 6000,
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
  // 而非策略上限，故意不上设置页。Rust 侧同值见
  // crates/dieyun-core/src/compaction/tokens.rs::estimate_text_tokens。
  // renderer 侧经 agent-bundle-entry.js 的 compat 挂到 window.CHARS_PER_TOKEN /
  // window.CJK_CHARS_PER_TOKEN 后直接消费（这两个键不在 module.exports 中）。
  charsPerToken: 3.2,
  cjkCharsPerToken: 1.5,
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
  // 已两次放宽：16/32 → 32/64 → 48/96（等于旧 schema 上限）；schema max 同步翻倍，
  // 保证默认值仍低于上限、用户可继续下调/上调。不按任务类型分档（避免第二套预算规则），
  // 护栏数字只在这里改。
  subagentMaxRounds: 48,
  subagentMaxToolCalls: 96,
  // 子 Agent 回注主上下文的摘要上限。过程 trace 不回注，只在折叠卡片里展开，
  // 否则 N 路调研会把主上下文顶爆（这是该功能最常见的失败模式）。
  subagentSummaryMaxChars: 2400,
  // 追问留存：同一 run 内可被 continueFrom 续用的已完成子 Agent 上下文份数（LRU）。
  // 只在 runner 生命周期内保留，不落盘；0 = 关闭追问。
  subagentFollowupRetention: 8,

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
  // 超过就按最旧优先跨会话裁（裁剪在 `crates/dieyun-core/src/memory/snapshot.rs` 的同一次写入里做）。
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
  /** 唤醒阈值初值 / 夹取区间 */
  aliveWakeThreshold: 60,
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
  aliveWakeMaxPerDay: 40,
  /** 张力：均值回复中心 / 增益 / 感觉剥夺保护 ε / 上限 */
  aliveTensionMean: 20,
  aliveTensionGainPerHour: 0.35,
  aliveTensionRestorePerHour: 0.35,
  aliveTensionEps: 0.8,
  aliveTensionMax: 100,
  /**
   * 「闲得发慌」：静默愈久，张力的回复中心越高 —— 这是它**自发醒来**的主要来源。
   * 没有这一项，一个没有任何未闭合事项的新实例会永远停在 20，从不清醒（拟态就失效了）。
   * 不是记忆衰减、不是损耗，只是「空久了会不舒服」。
   */
  aliveTensionIdleRampPerHour: 6,
  aliveTensionIdleGraceHours: 1,
  aliveTensionIdleMax: 45,
  /** 未闭合项：单条基准张力 / 上限条数 / 自然消退时间常数（小时） */
  aliveLoopTensionUnit: 25,
  aliveLoopMax: 12,
  aliveLoopStaleHours: 48,
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
  /** 主动出声/收音：每日上限与最小间隔（默认关着，见 `alive/settings.json` 的 voiceSpontaneous） */
  aliveVoiceMaxPerDay: 8,
  aliveVoiceMinIntervalMs: 30 * 60 * 1000,
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
  /** 决策日志保留条数（state.events 只追加、按此裁剪；页面只显示最近 N 条） */
  aliveHistoryMax: 200,
  /** 唤醒轮默认只读（可读文件/检索记忆/写记忆与目标，不写盘、不执行命令） */
  aliveReadOnlyWake: true
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
    group: '子 Agent（只读并发调研）',
    groupId: 'subagent',
    items: [
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
        max: 96,
        step: 1,
        unit: '轮'
      },
      {
        key: 'subagentMaxToolCalls',
        label: '子 Agent 工具上限',
        hint: '单个子 Agent 的工具调用总次数上限；独立记账，不占父级工具预算',
        type: 'number',
        min: 4,
        max: 192,
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
        max: 24 * 60 * 60 * 1000,
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
        key: 'llmFirstTokenTimeoutMs',
        label: '流式首包超时',
        hint: 'headers 后无有效 SSE data 则超时重试；可用环境变量 LLM_FIRST_TOKEN_TIMEOUT_MS 覆盖进程默认',
        type: 'number',
        min: 30000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'llmStreamIdleTimeoutMs',
        label: '流式包间隔超时',
        hint: '开始出字后，相邻两包之间超过该时长无有效 SSE data 即判定上游断流并自动重连（keep-alive 空包不算）；调小可更快发现断流',
        type: 'number',
        min: 30000,
        max: 600000,
        step: 10000,
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

function foldLimitsTierRecord(raw) {
  return foldLegacyContextTierRecord(raw, (tid) => listKnownTierIds().includes(tid));
}

function isAgentLimitsByTierShape(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const tierIds = listKnownTierIds();
  return Object.keys(raw).some((k) => tierIds.includes(remapLimitsTierId(k)));
}

function extractLimitOverridesFromNormalized(values) {
  return limitsByTierModule().extractLimitOverrides(values);
}

function syncLimitsToMainProcess() {
  if (typeof window === 'undefined') return;
  /** @type {any} */
  const w = window;
  if (!w.diecloud || !w.diecloud.syncAgentLimits) return;
  w.diecloud.syncAgentLimits(limitsByTierModule().getAllLimitsByTier()).catch(() => {});
}

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

function loadLimitsByTierFromDisk(userDataPath) {
  if (!userDataPath) return {};
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
  return {};
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
  if (!userDataPath) return {};
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

function resolveFirstTokenTimeoutMs(userDataPath, tierId) {
  try {
    const n = Number(getAgentLimit('llmFirstTokenTimeoutMs', userDataPath, tierId));
    if (Number.isFinite(n) && n >= 10000) return n;
  } catch {
    // ignore
  }
  return undefined;
}

/** 流式包间隔容忍时长；未配置时返回 undefined，由 llm-proxy 的模块兜底值生效。 */
function resolveStreamIdleTimeoutMs(userDataPath, tierId) {
  try {
    const n = Number(getAgentLimit('llmStreamIdleTimeoutMs', userDataPath, tierId));
    if (Number.isFinite(n) && n >= 10000) return n;
  } catch {
    // ignore
  }
  return undefined;
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
    firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(userDataPath, tierId),
    streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(userDataPath, tierId),
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
  resolveLoopToolCallLimit,
  resolveAgentMaxRounds,
  resolveFirstTokenTimeoutMs,
  resolveStreamIdleTimeoutMs,
  resolveAgentLoopSpec,
  isAgentLimitsByTierShape
};

module.exports = agentLimitsApi;
