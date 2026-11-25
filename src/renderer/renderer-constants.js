/* Shared numeric limits loaded before chat/agent modules */
/* global window, document */
'use strict';

/**
 * 动效时长的唯一来源是 styles.css 里 :root 的 --motion-* token。
 * 需要「等过渡结束」的 JS 一律读这里，不要再写 560 / 1100 这类复制品：
 * 复制品与 CSS 一旦不同步，就会「动画早结束了 JS 还在跑」或「JS 先收手留半截动画」。
 * @param {string} name 形如 '--motion-slow'
 * @returns {number} 毫秒（token 缺失时退回 --motion-slow 的 280ms）
 */
function motionMs(name) {
  try {
    const raw = String(window.getComputedStyle(document.documentElement).getPropertyValue(name)).trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return 280;
    return /ms$/.test(raw) ? n : n * 1000;
  } catch {
    return 280;
  }
}

const TRACE_DESKTOP_THOUGHT_CHARS = 2000;
/** 新轮次 / 工具状态变化 */
const MOBILE_TRACE_PUSH_INTERVAL_MS = 100;
/** 同一轮内流式文字更新（刷屏：更密推送） */
const MOBILE_TRACE_STREAM_INTERVAL_MS = 20;
/**
 * 上游静默提示阈值：开始出字后静默超过该时长，思考区叠加一行「上游 Ns 无数据」。
 * 只是显示阈值（远小于上游超时（core 侧超时自行兜底），用于提前暴露静默），不参与任何判定。
 */
const STREAM_IDLE_HINT_MS = 30000;
/**
 * 「无极阻尼」贴底跟随的时间常数（毫秒）：聊天区（renderer-chat-render.js）与子 Agent 卡片正文
 * （renderer-thinking-trace-dom.js）共用同一手感，两处都不再各写一个 90。
 */
const SCROLL_DAMP_TAU_MS = 90;

