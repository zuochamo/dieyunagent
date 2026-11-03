'use strict';

const { isCodebaseSourcePath } = require('./source-files');
const { createIncrementalScheduler } = require('./incremental-scheduler');

/**
 * Debounced background codebase.index (force=false, mtime 增量) after saves / workspace open.
 *
 * **只处理本地工作区**：增量跑的是本地 dieyun-core，输入必须是本地目录。远程工作区的索引
 * 由远端 agent 自己维护，本地这一侧连 `fs.watch` 都不该挂（判定在工厂的
 * `resolveWorkspaceRoot`，见那里的注释）。
 *
 * 机制全部来自 `index/incremental-scheduler.js`；本文件只声明**代码索引这一侧的差异**。
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} opts
 */
function createCodebaseIncrementalScheduler(opts) {
  return createIncrementalScheduler({
    ...opts,
    tag: 'codebase',
    // 代码索引增量默认关：整库建一次就不便宜，用户明确打开才维护新鲜度。
    isAutoEnabled: (settings) => settings.codebaseAutoIncremental === true,
    isSourcePath: isCodebaseSourcePath,
    trackSavedAt: true,
    async decide({ workspaceRoot, invokeRustCore, log, logSkipThrottled }) {
      const st = await invokeRustCore('codebase.status', { workspaceRoot }, 15000);
      if (!st) {
        log('[codebase] incremental index skipped: status unavailable');
        return null;
      }
      if (!st.indexed) {
        logSkipThrottled(
          `[codebase] incremental index idle: 尚未建立初始索引，增量不代建（${workspaceRoot}）` +
            '——恢复方式是先在「代码索引」面板建立一次（或在「设置 → 权限」打开自动增量）'
        );
        return null;
      }
      if (!(Number(st.vectorCount) > 0)) {
        logSkipThrottled(
          `[codebase] incremental index idle: 该工作区没有向量，先不维护新鲜度（${workspaceRoot}）` +
            '——需要语义检索时在面板建一次向量，之后增量才会接管'
        );
        return null;
      }
      // 索引正在跑时不再排队重试：保存是高频事件，重试风暴比「这次不增量」更贵。
      // 下一次保存/打开工作区自然会再触发一次。
      if (st.indexing) {
        logSkipThrottled(
          `[codebase] incremental index skipped: 索引正在运行，本次保存不排队（${workspaceRoot}）`
        );
        return null;
      }

      // `vectors: true` 是**沿用这个工作区已有的向量意图**（上面已经确认过 `vectorCount > 0`
      // 才走到这里）：增量会按文件删掉旧 chunk，连它们的向量一起没了；不跟着补，改过的文件
      // 从此只能靠子串召回，向量覆盖率只会一路往下掉 —— 而这行日志承诺的正是「增量接管」。
      // 端点后来被关掉时退回不带向量（增量照跑，向量留原样），否则每次保存都会撞
      // EMBEDDING_NOT_CONFIGURED，连 chunk 新鲜度也一起丢掉。
      const wantVectors = st.embeddingEnabled !== false;
      return {
        action: 'run',
        method: 'codebase.index.start',
        params: { workspaceRoot, force: false, skipIfReady: false, vectors: wantVectors },
        timeoutMs: 60000
      };
    }
  });
}

module.exports = {
  createCodebaseIncrementalScheduler
};
