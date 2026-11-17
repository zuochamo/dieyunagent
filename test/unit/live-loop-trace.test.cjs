'use strict';

const {
  buildIsolatedCard,
  mergeIsolatedCards,
  mapLoopTraceToUi,
  createLiveLoopTraceTracker,
  createSubagentNamer,
  subagentCardTitle,
  LIVE_TRACE_MIN_INTERVAL_MS
} = require('../../src/agent/live-loop-trace');

describe('live-loop-trace · 子 Agent 卡片', () => {
  it('一个子 Agent = 一个卡片条目，所有轮次与工具都装在 rounds 内', () => {
    const cards = mapLoopTraceToUi(
      [
        {
          round: 1,
          thought: '先看索引入口',
          tools: [{ id: 't1', name: 'grep', args: { pattern: 'flush' } }]
        },
        {
          round: 2,
          fullThought: '再看 rebuild',
          tools: [{ id: 't2', name: 'fs_read_file', args: { filePath: 'src/index/rebuild.js' } }]
        }
      ],
      { subagentId: 'sa-1', label: '调研 1' }
    );

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.isolated).toBe(true);
    expect(card.subagentId).toBe('sa-1');
    expect(card.phase).toBe('子 Agent · 调研 1');
    expect(card.rounds).toHaveLength(2);
    expect(card.rounds[0].tools[0].name).toBe('grep');
    expect(card.rounds[1].tools[0].argsBrief).toBe('src/index/rebuild.js');
    // 工具不再挂在条目顶层（否则卡片外会被重复渲染成一片平铺的「执行工具…」）
    expect(card.tools).toBeUndefined();
    // 条目级 thought 取最新一轮，供折叠标题 / 预览「会动」
    expect(card.thought).toBe('再看 rebuild');
  });

  it('tracker 累积轮次，但始终只产出 1 张卡片', () => {
    const seen = [];
    const tracker = createLiveLoopTraceTracker(
      { subagentId: 'sa-2', label: '调研 2' },
      { onUpdate: (entries) => seen.push(entries) }
    );

    tracker.handlePhase('start', {});
    tracker.handlePhase('llm_request', { round: 0, model: 'gpt-size' });
    tracker.handlePhase('need_delegate', {
      delegates: [{ id: 'a', name: 'grep', arguments: { pattern: 'x' } }]
    });
    tracker.handlePhase('delegate_result', { id: 'a', name: 'grep', result: { stdout: 'ok' } });
    tracker.handlePhase('llm_delta', { round: 1, reasoning: '第二轮推理' });
    tracker.dispose(); // 纯流式增量被合并到下一帧；dispose 保证尾帧送达

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((rows) => rows.length === 1)).toBe(true);
    const card = seen[seen.length - 1][0];
    expect(card.rounds).toHaveLength(2);
    expect(card.rounds[0].tools[0].pending).toBe(false);
    expect(card.rounds[1].fullThought).toBe('第二轮推理');
  });

  it('结构事件立即推、纯流式增量合并节流（避免每个 token 全量重推整张卡片）', () => {
    vi.useFakeTimers();
    try {
      const seen = [];
      const tracker = createLiveLoopTraceTracker(
        { subagentId: 'sa-throttle' },
        { onUpdate: (entries) => seen.push(entries[0]) }
      );

      tracker.handlePhase('start', {});
      expect(seen).toHaveLength(1); // 结构事件不排队

      // 连续流式增量不逐条推，而是合并成 1 帧
      tracker.handlePhase('llm_delta', { round: 0, reasoning: '逐' });
      tracker.handlePhase('llm_delta', { round: 0, reasoning: '逐字' });
      tracker.handlePhase('llm_delta', { round: 0, reasoning: '逐字增长' });
      expect(seen).toHaveLength(1);

      vi.advanceTimersByTime(LIVE_TRACE_MIN_INTERVAL_MS);
      expect(seen).toHaveLength(2);
      expect(seen[1].rounds[0].fullThought).toBe('逐字增长');

      // 收尾：dispose 补发节流中未到达的一帧，之后不再接受 sync
      tracker.handlePhase('llm_delta', { round: 0, reasoning: '逐字增长！' });
      tracker.dispose();
      expect(seen[seen.length - 1].rounds[0].fullThought).toBe('逐字增长！');
      const settled = seen.length;
      tracker.handlePhase('llm_delta', { round: 0, reasoning: '不应再出现' });
      expect(seen).toHaveLength(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('合并实时卡片与收尾卡片：保留实时思考、逐轮合并、收尾后不再 pending', () => {
    const live = buildIsolatedCard(
      { subagentId: 'sa-3' },
      [{ round: 1, thought: '实时思考', tools: [{ id: 't1', name: 'grep', pending: true }] }],
      'sa-3'
    );
    const rust = mapLoopTraceToUi(
      [
        {
          round: 1,
          thought: '最终摘要',
          tools: [{ id: 't1', name: 'grep', args: { pattern: 'x' }, result: { stdout: '3 处' } }]
        }
      ],
      { subagentId: 'sa-3' }
    )[0];

    const merged = mergeIsolatedCards(live, rust);
    expect(merged.rounds).toHaveLength(1);
    // 实时侧的思考文本优先（保留「过程」），收尾侧的最终 summary 补齐
    expect(merged.rounds[0].thought).toBe('实时思考');
    expect(merged.rounds[0].tools[0].pending).toBe(false);
    expect(merged.rounds[0].tools[0].summary).toBe('3 处');
  });
});

describe('live-loop-trace · 子 Agent 卡片标题（类型 + 序号）', () => {
  it('身份分配器在同一轮内单调递增，供 planner 研究子 Agent 与执行器共用', () => {
    const namer = createSubagentNamer();
    expect(namer.next('explore')).toEqual({
      subagentId: 'sa-explore-1',
      subagentIndex: 1,
      subagentKind: 'explore'
    });
    expect(namer.next('build')).toEqual({
      subagentId: 'sa-build-2',
      subagentIndex: 2,
      subagentKind: 'build'
    });
    expect(namer.next('shell')).toEqual({
      subagentId: 'sa-shell-3',
      subagentIndex: 3,
      subagentKind: 'shell'
    });
    expect(namer.count()).toBe(3);
  });

  it('同一批并发派发的 id 互不相同（否则 4 个子 Agent 会合并成 1 张卡片）', () => {
    const namer = createSubagentNamer();
    const ids = [0, 1, 2, 3].map(() => namer.next('explore').subagentId);
    expect(new Set(ids).size).toBe(4);
  });

  it('标题 = 子 Agent 类型 + 序号，写入/调研/命令各有中文标签', () => {
    expect(subagentCardTitle({ subagentKind: 'build', subagentIndex: 3 })).toBe('写入子 Agent #3');
    expect(subagentCardTitle({ subagentKind: 'explore', subagentIndex: 1 })).toBe('调研子 Agent #1');
    expect(subagentCardTitle({ subagentKind: 'shell', subagentIndex: 2 })).toBe('命令子 Agent #2');
    // 没有序号时退回旧标签，避免老调用点标题为空
    expect(subagentCardTitle({ worker: 'A', taskId: 't1' })).toBe('执行器 A · t1');
  });

  it('有 label 时标题带上「在干什么」：多路并发时序号只负责区分，label 才可读', () => {
    expect(subagentCardTitle({ subagentKind: 'build', subagentIndex: 2, label: '审查工具层改动' })).toBe(
      '写入子 Agent #2 · 审查工具层改动'
    );
    expect(subagentCardTitle({ subagentKind: 'explore', subagentIndex: 1, label: '鉴权入口在哪' })).toBe(
      '调研子 Agent #1 · 鉴权入口在哪'
    );
    // 空/空白 label 不产生悬空分隔符
    expect(subagentCardTitle({ subagentKind: 'build', subagentIndex: 4, label: '   ' })).toBe(
      '写入子 Agent #4'
    );
  });

  it('plan 模式写入子 Agent 也产出卡片，标题带类型与序号（含占位卡）', () => {
    const meta = { worker: 'A', taskId: 't1', subagentKind: 'build', subagentIndex: 2, parallel: true };
    const card = buildIsolatedCard(
      meta,
      [{ round: 1, thought: '准备中…', fullThought: '准备中…', tools: [] }],
      'exec-A-t1'
    );
    expect(card.isolated).toBe(true);
    expect(card.phase).toBe('写入子 Agent #2');
    expect(card.subagentKind).toBe('build');
    expect(card.subagentIndex).toBe(2);
    expect(card.parallel).toBe(true);
    expect(card.rounds).toHaveLength(1);
  });

  it('实时卡与收尾卡合并后标题仍为「类型 + 序号」', () => {
    const meta = { worker: 'B', taskId: 't2', subagentKind: 'shell', subagentIndex: 4 };
    const live = buildIsolatedCard(meta, [{ round: 1, thought: '实时', tools: [] }], 'exec-B-t2');
    const rust = mapLoopTraceToUi(
      [{ round: 1, thought: '收尾', tools: [{ id: 't', name: 'fs_run_shell', result: { stdout: 'ok' } }] }],
      meta
    )[0];
    const merged = mergeIsolatedCards(live, rust);
    expect(merged.phase).toBe('命令子 Agent #4');
    expect(merged.subagentKind).toBe('shell');
    expect(merged.subagentIndex).toBe(4);
  });
});
