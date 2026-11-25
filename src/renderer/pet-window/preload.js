'use strict';

/**
 * 点点悬浮窗专用 preload：只暴露页面真正需要的四个调用。
 *
 * 为什么不共用主窗口的 src/preload.js：那一份带整个 diecloud.* 桥（gateway / peer / 频道…），
 * 悬浮窗一个都用不上，还把攻击面与心智负担一起带进来。这里的方法与 `src/main/ipc/pet.js`
 * 一一对应，不多不少。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  /** 页面就绪：回当前设置；Main 侧同时首次 show（showInactive，不抢焦点） */
  ready: () => ipcRenderer.invoke('pet:ready'),
  /** 拖动开始：报按下的屏幕坐标（DIP），Main 记下「指针相对窗口」的抓取偏移 */
  dragStart: (sx, sy) => ipcRenderer.send('pet:drag-start', { sx, sy }),
  /** 拖动中：报指针当前屏幕坐标（绝对值定位，窗口追指针，无增量反馈回路） */
  dragMoveTo: (sx, sy) => ipcRenderer.send('pet:drag-move-to', { sx, sy }),
  /** 拖动结束：Main 落盘位置（moved=false = 单击，只清拖动状态不写盘） */
  dragEnd: (moved) => ipcRenderer.send('pet:drag-end', { moved: moved !== false }),
  /** 穿透切换：true = 指针不在身上，点击透给桌面 */
  setMousePass: (pass) => ipcRenderer.send('pet:mouse-mode', { pass: pass !== false }),
  /** 回报当前形态（球/猫）：形态是它自己的运行状态，Main 猜不出来，而心跳轮的事实块要说真话 */
  reportState: (state) => ipcRenderer.send('pet:state', state || {}),
  /** 设置变化（设置页改了开关/形态/大小/动效/点色） */
  onApply: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, settings) => handler(settings || {});
    ipcRenderer.on('pet:apply', wrapped);
    return () => ipcRenderer.removeListener('pet:apply', wrapped);
  },
  /** 生命感推送（体征快照 / 心跳事件 / pet_act 瞬时动作），绑定生命感后 Main 侧转发 */
  onAlive: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, payload) => handler(payload || {});
    ipcRenderer.on('pet:alive', wrapped);
    return () => ipcRenderer.removeListener('pet:alive', wrapped);
  }
});
