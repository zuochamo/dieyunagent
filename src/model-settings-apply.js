'use strict';

/**
 * 「模型设置变了」之后的统一收尾 —— **单一来源**。
 *
 * 两个入口：桌面端 `model:sync-settings`（Renderer → preload → Main IPC）与服务器版
 * `desktop.save_model_settings`（网页 → `/ws` → `headless/desktop-turn.js`）。
 *
 * 为什么必须收在一处：落盘只是第一步，后面两件收尾件件都要跟着做，少做一件就会出现
 * 「界面上已经改好了、真正发请求的 core 还拿着旧 key」这种最难查的分叉：
 *   1. 落盘到 `<userData>/model-settings.json`（读写规则在 `model-settings.js`）；
 *   2. 把语音设置推给手机端（载荷唯一来源 `AgentService.getSpeechSettings()`，
 *      见 `src/main/ipc/settings.js` 的历史注释）；
 *   3. 让 core / 远端索引重读配置（Gateway 的 `_syncRustCoreConfig` /
 *      `syncRemoteIndexCoreConfig`）。
 *
 * 依赖全部由调用方注入（`userData` / `gateway` / `mobileBridge` / `agentService`）：
 * 本模块不 require electron、不自己找 Gateway，headless 与桌面才可能共用同一份。
 */

const { loadModelSettings, saveModelSettings } = require('./model-settings');

/**
 * @param {{
 *   userData: string,
 *   settings?: object|null,          // 缺省 / 非对象 = 只做收尾，不落盘
 *   gateway?: any,                   // LocalGateway（有同步方法就调，没有就跳过）
 *   mobileBridge?: any,              // 手机端桥（有 broadcast 才推语音设置）
 *   agentService?: any,              // 语音设置的唯一载荷来源
 *   log?: (msg: string) => void
 * }} opts
 * @returns {{ ok: boolean, saved: boolean, settings?: object }}
 */
function applyModelSettings(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const settings = o.settings && typeof o.settings === 'object' ? o.settings : null;

  if (settings) {
    try {
      saveModelSettings(o.userData, settings);
    } catch (err) {
      // 落盘失败必须如实回给界面（桌面版以前是静默吞掉的：用户以为存了）
      log(`模型设置落盘失败：${(err && err.message) || err}`);
      return { ok: false, saved: false };
    }
    // 语音设置立即推给手机端：与手机端拉取时是同一个函数，不另拼字段
    pumpSpeechSettings(o.mobileBridge, o.agentService);
  }

  const gateway = o.gateway || null;
  if (gateway) {
    if (typeof gateway._syncRustCoreConfig === 'function') void gateway._syncRustCoreConfig();
    if (typeof gateway.syncRemoteIndexCoreConfig === 'function') void gateway.syncRemoteIndexCoreConfig();
  }

  if (!settings) return { ok: true, saved: false };
  return { ok: true, saved: true, settings: loadModelSettings(o.userData) };
}

/**
 * @param {any} mobileBridge
 * @param {any} agentService
 */
function pumpSpeechSettings(mobileBridge, agentService) {
  if (!mobileBridge || typeof mobileBridge.broadcast !== 'function') return;
  if (!agentService || typeof agentService.getSpeechSettings !== 'function') return;
  const payload = agentService.getSpeechSettings();
  if (!payload) return;
  mobileBridge.broadcast({ type: 'settings.speech', at: Date.now(), ...payload });
}

module.exports = { applyModelSettings };
