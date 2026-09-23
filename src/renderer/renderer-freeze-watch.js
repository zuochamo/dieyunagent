/* global window, document, currentSessionId, messages, chatList */
'use strict';

/**
 * 渲染进程冻结取证（问题 B / B1）。
 *
 * 只做两件事：
 * 1) PerformanceObserver 归因长任务（>500ms），把「卡在哪一步」变成可落盘的证据；
 * 2) 定期心跳，让主进程知道「渲染进程最后一次活着的时刻」—— 这是主进程侧
 *    unresponsive / render-process-gone 落盘时唯一可用的时间基准。
 *
 * 已知盲区（不是缺陷，别在此处加兜底）：完全死锁（无限循环）时回调与定时器都不会返回，
 * 本文件必然拿不到信号；那部分由 src/main/ipc/renderer-freeze.js 承接。
 *
 * 通道：window.diecloud.rendererFreezeBeat / reportRendererFreeze（preload 单向 send）。
 * 移除条件：根因定位并修复后，本文件连同 index.html 引用、renderer.js 的调用、
 * preload 两个方法一并删除。
 */

/** 长任务阈值（ms）：超过即记一条并上报快照 */
const FREEZE_LONG_TASK_MS = 500;
/** 心跳间隔（ms） */
const FREEZE_BEAT_MS = 10000;
/** 心跳实测间隔超出预期此值即判定主线程被长时间占用（ms） */
const FREEZE_BEAT_LAG_MS = 2000;
/** 上报时随附的最近 longtask 条数 */
const FREEZE_LONG_TASK_KEEP = 3;

let freezeLongTaskBuffer = [];
let freezeExpectedBeatAt = 0;

function freezeDiecloudApi() {
  return (window && window.diecloud) || {};
}

/**
 * 冻结瞬间的渲染进程现场。取值全部来自既有单一来源：
 * currentSessionId / messages / chatList（renderer-chat-state.js）与 DOM 本身。
 */
function collectFreezeSnapshot(kind, extra) {
  const snapshot = {
    kind,
    at: Date.now(),
    perfNow: Math.round(performance.now()),
    sessionId: typeof currentSessionId !== 'undefined' && currentSessionId ? String(currentSessionId) : '',
    messages: typeof messages !== 'undefined' ? messages.length : -1,
    bubbles: -1,
    domNodes: -1,
    visibility: typeof document !== 'undefined' ? document.visibilityState : '',
    bodyClass: '',
    longTasks: freezeLongTaskBuffer.slice()
  };
  try {
    snapshot.bubbles = typeof chatList !== 'undefined' && chatList ? chatList.childElementCount : -1;
  } catch {
    // ignore
  }
  try {
    snapshot.domNodes = document.getElementsByTagName('*').length;
    snapshot.bodyClass = (document.body && document.body.className) || '';
  } catch {
    // ignore
  }
  return extra ? Object.assign(snapshot, extra) : snapshot;
}

function reportRendererFreeze(snapshot) {
  try {
    const api = freezeDiecloudApi();
    if (typeof api.reportRendererFreeze === 'function') api.reportRendererFreeze(snapshot);
  } catch {
    // 取证失败不得影响渲染进程正常行为
  }
}

function beatRendererFreeze() {
  try {
    const api = freezeDiecloudApi();
    if (typeof api.rendererFreezeBeat === 'function') api.rendererFreezeBeat();
  } catch {
    // ignore
  }
}

function startRendererFreezeWatch() {
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < FREEZE_LONG_TASK_MS) continue;
          freezeLongTaskBuffer.push({
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            name: entry.name || '',
            attribution: (entry.attribution || [])
              .map((a) => a.name)
              .filter(Boolean)
              .join(',')
          });
          if (freezeLongTaskBuffer.length > FREEZE_LONG_TASK_KEEP) freezeLongTaskBuffer.shift();
          reportRendererFreeze(collectFreezeSnapshot('longtask'));
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    }
  } catch {
    // 不支持 longtask 时只保留心跳
  }

  setInterval(() => {
    // 心跳与可见性无关：主进程的 silentMs 语义是「距最后一次活着」。若隐藏时停发，
    // 最小化 30 分钟再还原后一旦卡顿，silentMs 会把这段合法静默算成卡顿时长。
    beatRendererFreeze();
    // 但 lag 判定只在可见时做：隐藏态定时器会被 Chromium 节流，据此判定是假冻结
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      freezeExpectedBeatAt = 0;
      return;
    }
    const now = performance.now();
    if (freezeExpectedBeatAt && now - freezeExpectedBeatAt > FREEZE_BEAT_MS + FREEZE_BEAT_LAG_MS) {
      reportRendererFreeze(
        collectFreezeSnapshot('beat-lag', {
          lagMs: Math.round(now - freezeExpectedBeatAt - FREEZE_BEAT_MS)
        })
      );
    }
    freezeExpectedBeatAt = now;
  }, FREEZE_BEAT_MS);
}

window.startRendererFreezeWatch = startRendererFreezeWatch;
