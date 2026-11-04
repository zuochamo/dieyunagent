'use strict';

/**
 * 扩展页签「共享记忆」的 IPC。
 *
 * 这里**只做转发与形状归一**：服务器/口令的读写、探活、提炼都在
 * `src/memory-shared/service.js` 与 `agent/knowledge-maintainer.js` 里各有一份唯一实现。
 * 不在这里拼 SQL、不在这里调模型、不在这里判断「算不算连上」。
 *
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getSharedMemory: () => any,
 *   getKnowledgeMaintainer?: () => any,
 *   log?: { info?: Function, warn?: Function }
 * }} ctx
 */
function registerSharedMemoryIpc(ctx) {
  const { ipcMain, getSharedMemory, getKnowledgeMaintainer, log } = ctx;
  const service = () => (typeof getSharedMemory === 'function' ? getSharedMemory() : null);

  ipcMain.handle('shared-memory:status', async () => {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    return { ok: true, ...sm.getStatus() };
  });

  /**
   * 保存设置：口令没填就沿用已存的（`password === undefined`）。
   * 保存后立刻探活一次 —— 「保存完还是不是可用」必须当场给结论，不能让用户等下一轮。
   */
  ipcMain.handle('shared-memory:save', async (_evt, patch = {}) => {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    try {
      sm.saveSettings(patch || {});
    } catch (err) {
      const msg = (err && (err.message || String(err))) || '保存失败';
      if (log && typeof log.warn === 'function') log.warn('[dieyun:shared-memory] 保存设置失败：' + msg);
      return { ok: false, error: msg, code: err && err.code };
    }
    const probe = await sm.probe();
    return { ok: true, probe, status: sm.getStatus() };
  });

  /** 用**候选配置**试连，不落盘（设置页「测试连接」） */
  ipcMain.handle('shared-memory:test', async (_evt, patch = {}) => {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    return sm.testConnection(patch || {});
  });

  /** 重新探活（用户点「重试」/ 启动后数据库才起来） */
  ipcMain.handle('shared-memory:probe', async () => {
    const sm = service();
    if (!sm) return { ok: false, error: '共享记忆未装配' };
    const probe = await sm.probe();
    return { ok: true, probe, status: sm.getStatus() };
  });

  /** 立即提炼一次（抢不到锁说明别的机器正在提炼，或还在冷却期） */
  ipcMain.handle('shared-memory:consolidate', async () => {
    const maintainer = typeof getKnowledgeMaintainer === 'function' ? getKnowledgeMaintainer() : null;
    if (!maintainer || typeof maintainer.consolidateSharedMemory !== 'function') {
      return { ok: false, error: '归纳器未就绪' };
    }
    return maintainer.consolidateSharedMemory('manual');
  });
}

module.exports = { registerSharedMemoryIpc };
