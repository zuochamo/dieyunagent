'use strict';

/** 索引构建中时，search 最多等待多久（保存后立刻提问常落在这个窗口内） */
const INDEX_WAIT_MAX_MS = 4000;
const INDEX_WAIT_INTERVAL_MS = 300;

function createCodebaseHandlers(d) {
  const {
    resolveCodebaseContext,
    invokeIndexCore,
    startCodebaseIndexForContext,
    startGraphIndexForContext,
    requireRustCore,
    codebaseHasSearchableIndex,
    codebaseIncremental,
    // 「这次建库要不要带向量」的唯一判定（读持久意图 indexSemanticSearch）
    resolveIndexVectors,
    // 把当前 embedding 配置推给远端那条连接上的 core（rpc.js 的同一份实现）
    syncRemoteIndexCoreConfig
  } = d;

  /**
   * 索引正在构建时短暂等待其完成，而不是立刻抛 INDEXING_IN_PROGRESS。
   * 保存文件会触发后台增量索引，此时模型往往紧接着就检索，直接失败体验很差。
   */
  async function waitForIndexIdle(ctxInfo, initial) {
    let st = initial;
    const deadline = Date.now() + INDEX_WAIT_MAX_MS;
    while (st && st.indexing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, INDEX_WAIT_INTERVAL_MS));
      try {
        const next = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000);
        if (!next) break;
        st = next;
        if (!st.indexing) break;
      } catch {
        break;
      }
    }
    return st;
  }

  /**
   * 「找定义」这半条能力靠结构索引的符号表（core 的通道 0，见 `docs/INDEX-VALUE-REVIEW.md` §7.3：
   * 命中单一标识符时用 `graph_symbols` 的定义点把结果顶到最前）。
   *
   * 结构索引的触发点一直只在 `graph.*` 工具里（`ensureCallGraph` 那套），于是新会话
   * （乙案：每个会话一个 worktree、一份 `index.sqlite`）第一次做代码检索时符号表是空的，
   * 实测「找定义」MRR 0.63 —— 比 grep 还差。这里在**被用到**时顺手拉起一次，
   * `calls: false` 只建符号/import、不建调用边（R5：调用边仍按需）。
   *
   * 不阻塞本次检索：这次返回词法结果，建好后下一次检索就带定义优先。建图失败只是少一条
   * 排序信号，不能让已经拿到的检索结果变成报错。
   */
  async function ensureSymbolIndex(ctxInfo) {
    try {
      const gs = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (!gs || gs.indexed || gs.indexing) return;
      await startGraphIndexForContext(ctxInfo, { force: false, skipIfReady: false, calls: false });
    } catch {
      // 结构索引读不到 / 建不起来：本次检索照旧（只是没有定义优先）
    }
  }

  return {
    'codebase.status': async ({ workspaceRoot }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000);
      if (!st || !codebaseIncremental || typeof codebaseIncremental.getRefreshState !== 'function') {
        return st;
      }
      // 附加「刚保存过、增量还没跟上」的信号，供 prep 决定是否等一小会儿
      let refresh = null;
      try {
        refresh = codebaseIncremental.getRefreshState(workspaceRoot);
      } catch {
        refresh = null;
      }
      if (!refresh) return st;
      const savedAgeMs = refresh.lastSavedAt ? Date.now() - refresh.lastSavedAt : 0;
      return {
        ...st,
        refreshPending: !!refresh.pending,
        savedAgeMs: savedAgeMs > 0 ? savedAgeMs : undefined
      };
    },

    'codebase.index.start': async ({ workspaceRoot, force, skipIfReady, vectors }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      // 显式 false 才跳过；缺省 force 走 true（手动重建）
      const r = await startCodebaseIndexForContext(ctxInfo, {
        force: force === undefined ? true : !!force,
        skipIfReady: skipIfReady === undefined ? true : !!skipIfReady,
        // 原样传：`undefined` 表示「听持久意图 indexSemanticSearch」，见 resolveIndexVectorsIntent。
        // 以前这里写 `vectors: !!vectors`，把「没说话」压成了「不要向量」。
        vectors
      });
      const { job, ...rest } = r || {};
      void job;
      return { ok: true, ...rest };
    },

    // 同步版（老 daemon 兼容路径）：**不再把构建跑在 core 的 RPC 通道里**。
    //
    // 以前这里直接 `invokeIndexCore('codebase.index', …, 600s)`：core 的 RPC 是单线程的，
    // 一次全量构建会把同一个 core 上的 `codebase.status`(15s) / `codebase.search`(120s) /
    // `index.configure`(45s) 全部堵到超时（2026-11-09 真机现场：daemon 日志
    // `RPC_TIMEOUT codebase.search id=983 timeoutMs=120000`、configure 45061ms 超时）。
    // 现在统一走「后台起任务 + 客户端等它 settle」——构建在 core 里是异步任务，
    // 期间 status/search 照常秒回；`.start` 不支持时 `startCodebaseIndexForContext`
    // 内部会自己退回同步调用（那条老路径的墙钟仍受 INDEX_JOB_WALL_MS 约束）。
    'codebase.index': async ({ workspaceRoot, force, vectors }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      // 向量同样听持久意图
      const wantVectors = typeof resolveIndexVectors === 'function' ? resolveIndexVectors(vectors) : !!vectors;
      if (ctxInfo.kind === 'remote' && wantVectors && typeof syncRemoteIndexCoreConfig === 'function') {
        // 与 start 路径同一条规则：建向量前把当前 embedding 配置推给这条连接上的 core
        // （以前只有 start 路径推，换模型后走同步路径重建必然拿旧模型名去请求）
        try {
          await syncRemoteIndexCoreConfig();
        } catch {
          // 推不动只是这条路建不出向量，不能让整个调用挂在这里（配置错误由 core 报）
        }
      }
      const started = await startCodebaseIndexForContext(ctxInfo, {
        force: force !== false,
        // 同步版的语义是「现在就建」，不是「已经就绪就跳过」
        skipIfReady: false,
        vectors: wantVectors
      });
      const job = started && started.job;
      if (job && job.promise) {
        // 等构建结束（不占 core 的 RPC：期间它只是被 status 轮询）
        await job.promise.catch(() => {});
      }
      const st = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000).catch(() => null);
      if (!st) {
        return { ok: false, error: '索引状态读取失败', started: !!(started && started.started) };
      }
      // 注意顺序：`...st` 里有 core 自己的 ok，必须让「有 lastError 就算失败」压在它上面
      return { ...st, ok: !st.lastError, alreadyRunning: false };
    },

    'codebase.search': async ({ workspaceRoot, query, limit }) => {
      const q = String(query || '').trim();
      if (!q) {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      let st = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000);
      if (st && st.indexing) {
        st = await waitForIndexIdle(ctxInfo, st);
      }
      if (st && st.indexing) {
        // 首建是分钟级的后台事：告诉模型改用 grep，而不是让它「稍后再试」空转
        const e = new Error('代码库索引正在后台首建，本轮改用 grep / host_exec 直接查（建好后自动可用）');
        e.code = 'INDEXING_IN_PROGRESS';
        e.retryable = false;
        throw e;
      }
      if (!codebaseHasSearchableIndex(st)) {
        // 不在 search 内同步建库：建库要跑 embedding，由面板 / prep 的 index.start 负责
        const e = new Error('本工作区还没有可检索的代码索引，改用 grep / host_exec 直接查');
        e.code = 'INDEX_REQUIRED';
        e.retryable = false;
        throw e;
      }
      const res = await invokeIndexCore(ctxInfo, 'codebase.search', {
        query: q,
        limit
      });
      // 符号表是「找定义」排序的前提，而它的建库触发点一直在 graph 工具里 —— 检索这边
      // 自己保证一次。不 await：本次结果已定，建好后下一次检索才带定义优先。
      void ensureSymbolIndex(ctxInfo);
      // 0 命中 + 库里没有向量 = 通道退化，不是「没有相关代码」。
      // 子串通道对中文自然语言查询几乎必然 0 命中，此时不给提示，
      // 模型只会得出「这仓库里没这段代码」并放弃检索。
      const vectors = Number(st && st.vectorCount) || 0;
      if (res && Array.isArray(res.results) && !res.results.length && !vectors) {
        return {
          ...res,
          hint:
            '本工作区索引未建向量：中文自然语言查询在子串通道上基本不会命中。' +
            '改用 grep / host_exec；要长期用语义检索，到 设置 →「代码索引语义检索（向量）」打开，' +
            '或在侧栏「索引」面板点「建向量」补一次。'
        };
      }
      return res;
    },
  };
}

module.exports = { createCodebaseHandlers };
