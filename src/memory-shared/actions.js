'use strict';

/**
 * 「共享记忆」五个动作的**唯一实现**：状态 / 保存 / 测试连接 / 探活 / 立即提炼。
 *
 * 拆这一层的理由：桌面端走 IPC（`src/main/ipc/shared-memory.js`），浏览器版（headless 的
 * `/app/`）走 `/ws`（`src/headless/desktop-turn.js`）。两条传输层只该做转发 —— 判定「算不算连上」、
 * 口诀语义、SQL、模型调用分别只在 `src/memory-shared/service.js` 与
 * `src/agent/knowledge-maintainer.js` 里各有一份。五个动作写一份，两个入口共用，
 * 免得以后改了一边忘另一边（这两条路径的触发条件完全一样：保存完必须当场给结论）。
 *
 * @param {{
 *   getSharedMemory: () => any,
 *   getKnowledgeMaintainer?: () => any,
 *   log?: { info?: Function, warn?: Function }
 * }} ctx
 */
function createSharedMemoryActions(ctx) {
  const getSharedMemory = ctx && ctx.getSharedMemory;
  const getKnowledgeMaintainer = ctx && ctx.getKnowledgeMaintainer;
  const log = (ctx && ctx.log) || {};
  const service = () => (typeof getSharedMemory === 'function' ? getSharedMemory() : null);

  /** 设置页视图 + 探活结论（页面靠 reason/lastError 说清「为什么不可用」） */
  async function status() {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    return { ok: true, ...sm.getStatus() };
  }

  /**
   * 保存设置：口令没填就沿用已存的（`password === undefined`）。
   * 保存后立刻探活一次 —— 「保存完还是不是可用」必须当场给结论，不能让用户等下一轮。
   */
  async function save(patch = {}) {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    try {
      sm.saveSettings(patch || {});
    } catch (err) {
      const msg = (err && (err.message || String(err))) || '保存失败';
      if (typeof log.warn === 'function') log.warn('[dieyun:shared-memory] 保存设置失败：' + msg);
      return { ok: false, error: msg, code: err && err.code };
    }
    const probe = await sm.probe();
    return { ok: true, probe, status: sm.getStatus() };
  }

  /** 用**候选配置**试连，不落盘（设置页「测试连接」） */
  async function test(patch = {}) {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    return sm.testConnection(patch || {});
  }

  /** 重新探活（用户点「重试」/ 启动时数据库还没起来） */
  async function probe() {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    const result = await sm.probe();
    return { ok: true, probe: result, status: sm.getStatus() };
  }

  /** 立即提炼一次（抢不到锁说明别的机器正在提炼，或还在冷却期） */
  async function consolidate() {
    const maintainer = typeof getKnowledgeMaintainer === 'function' ? getKnowledgeMaintainer() : null;
    if (!maintainer || typeof maintainer.consolidateSharedMemory !== 'function') {
      return { ok: false, error: '归纳器未就绪' };
    }
    return maintainer.consolidateSharedMemory('manual');
  }

  return { status, save, test, probe, consolidate };
}

module.exports = { createSharedMemoryActions };
