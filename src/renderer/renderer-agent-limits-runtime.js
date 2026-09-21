/* global applyAgentLimitsToRuntime */
'use strict';

/**
 * CTX_LIMITS 的启动期 / 事件驱动刷新。
 *
 * 本文件只回答「**何时**刷」，不持有任何「键 → 键」映射：
 * 映射表与刷新实现（applyAgentLimitsTo / applyAgentLimitsToRuntime）的属主是
 * renderer-context-engine.js —— 那里也是 CTX_LIMITS 的声明处与加载期派生处。
 *
 * 曾经这里另抄了一份 agent-limits → CTX_LIMITS 的 14 键表，与 ctxLimitsFor() 双份维护；
 * 漏一个键的表现是「设置里改了不生效」，且只在某个档位下复现，极难定位。
 *
 * 位置要求（index.html 顺序敏感）：必须在 composer 之后，理由见下方 boot 说明。
 */

/** 推迟到当前脚本/bundle 同步执行完毕再 boot。
 * 打包后 function 会被提升，但 composer 的 const Map 仍在 TDZ；
 * 若此处同步调用 getAgentLimits → resolveContextTierId → resolveComposerModelPickForSend，
 * 会报 Cannot access 'sessionComposerModelPicks' before initialization。
 * 开发模式分文件时 composer 尚未加载，该分支不会踩到。
 */
function bootAgentLimitsRuntime() {
  if (typeof applyAgentLimitsToRuntime !== 'function') return;
  applyAgentLimitsToRuntime();
  const refresh = () => applyAgentLimitsToRuntime();
  window.addEventListener('dieyun:agent-limits-change', refresh);
  window.addEventListener('dieyun:context-tier-change', refresh);
}

queueMicrotask(bootAgentLimitsRuntime);
