'use strict';

const { isGraphSourcePath } = require('../index/source-files');
const { createIncrementalScheduler } = require('../index/incremental-scheduler');

/**
 * 代码索引正在跑时，结构索引稍后重试；结构索引自己在跑时也稍后重试。
 * （次数不限：每次保存都会重新排一个窗口，重试只是避免「这次正好撞上」直接丢掉。）
 */
const RETRY_DELAY_MS = 2000;
const CODEBASE_BUSY_RETRY_MS = 5000;

/**
 * Debounced background graph.index (force=false) after saves / workspace open.
 *
 * 机制（去抖窗口 / 节流 / 远程工作区判定 / 定时器回收）全部来自
 * `index/incremental-scheduler.js`；本文件只声明**结构索引这一侧的差异**：
 * 开关默认开、只认结构索引关心的文件、先让路给正在跑的代码索引。
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} opts
 */
function createGraphIncrementalScheduler(opts) {
  return createIncrementalScheduler({
    ...opts,
    tag: 'graph',
    // 结构索引默认跟随保存增量，除非用户在设置里关掉。
    isAutoEnabled: (settings) => settings.graphAutoIncremental !== false,
    isSourcePath: isGraphSourcePath,
    async decide({ workspaceRoot, invokeRustCore, logSkipThrottled }) {
      // 代码索引在跑时整条 dieyun-core 都忙着，等一下再试；否则增量会和它抢同一个库。
      try {
        const cb = await invokeRustCore('codebase.status', { workspaceRoot }, 15000);
        if (cb && cb.indexing) return { action: 'retry', delayMs: CODEBASE_BUSY_RETRY_MS };
      } catch {
        // 拿不到代码索引状态不影响结构索引自己的判定
      }

      const st = await invokeRustCore('graph.status', { workspaceRoot }, 30000);
      if (!st || !st.indexed) {
        logSkipThrottled(
          `[graph] incremental index idle: 尚未建立结构索引，增量不代建（${workspaceRoot}）`
        );
        return null;
      }
      if (st.indexing) return { action: 'retry', delayMs: RETRY_DELAY_MS };

      return {
        action: 'run',
        method: 'graph.index.start',
        params: { workspaceRoot, force: false, skipIfReady: false },
        timeoutMs: 60000
      };
    }
  });
}

module.exports = {
  createGraphIncrementalScheduler
};
