'use strict';

const { createPeerStore } = require('./store');

/**
 * 内网 agent 互通的**唯一装配点**（桌面 Main 与 headless 共用）。
 *
 * 互通要接两样东西，缺一样就整条链路少半截：
 *   1. 一扇网络门 —— `createPeerCoordinator`（监听 / UDP 发现 / 信任清单 / 房间）；
 *   2. 一条回合回传线 —— peer 来信触发的那一轮，progress / 终态事件要喂回 coordinator，
 *      对端的「答复」才回得去（`noteTurnProgress` / `noteTurnCompleted`）。
 *
 * 为什么抽到这里而不是在各入口各接一次：漏了回传线，对端会一直等到超时（看起来像
 * 「对方没理我」）；漏了网络门，模型那边 `peer_*` 永远 PEER_UNAVAILABLE（看起来像
 * 「没有这个能力」）。两种症状都指向装配，而不是协议 —— 那就只该有一份装配。
 *
 * **开关只有三份，都在 `<userData>/peer/settings.json`**（`src/peer/store.js` 是唯一读写点）：
 * `enabled` / `autoTurn`（默认都开）、`autoTrust`（默认关 = 由人确认；无人值守的机器由
 * `unattended: true` 在首次启动落成开，见 `seedUnattendedTrust`）。信任清单是同目录 `trusted-peers.json`。
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspace: () => { workspacePath?: string },
 *   rpc: (method: string, params?: object) => Promise<any>,
 *   submitTask: (task: object) => Promise<any>,
 *   agentService?: any,           // 有 `on('event')` 就接回合回传线
 *   limits: () => object,
 *   onEvent?: (event: object) => void,
 *   unattended?: boolean,         // true = 这台机器没有人去点「确认对方」（headless / systemd）
 *   log?: any
 * }} deps
 * @returns {object | null} coordinator（初始化失败返回 null，绝不拖垮调用方）
 */
function bootPeerRuntime(deps = {}) {
  const { agentService = null, unattended = false, log = null, ...coordinatorDeps } = deps;
  const say = (level, msg) => {
    const fn = log && typeof log[level] === 'function' ? log[level] : null;
    if (fn) fn.call(log, msg);
  };

  if (unattended) seedUnattendedTrust(coordinatorDeps.userDataPath, say);

  let coordinator = null;
  try {
    coordinator = createCoordinator({
      ...coordinatorDeps,
      log: (m) => say('info', m)
    });
  } catch (err) {
    say('error', `内网 agent 互通初始化失败：${(err && err.message) || err}`);
    return null;
  }

  // 跨机回合的回传：进度攒正文（终态 summary 只有 400 字），结束把完整正文回给对方。
  // 订阅跟着 coordinator 走 —— 桌面与 headless 都是「Main 侧跑一轮」，事件形状同一个。
  if (agentService && typeof agentService.on === 'function') {
    agentService.on('event', (event) => {
      if (!event || !coordinator) return;
      if (event.type === 'task.progress') {
        coordinator.noteTurnProgress(event.requestId, event);
      } else if (
        event.type === 'task.completed' ||
        event.type === 'task.failed' ||
        event.type === 'task.stopped'
      ) {
        // 不 await：终态事件的处理不该挡住 AgentService 自己的收尾
        void coordinator.noteTurnCompleted(event.requestId, event);
      }
    });
  }

  // `start()` 是 async（listen 失败会 reject）：不 await 的话端口被占会变成未处理拒绝。
  coordinator
    .start()
    .then((s) => {
      if (s && s.port) say('info', `内网 agent 互通已启动: ${s.name} @ :${s.port}`);
    })
    .catch((e) => say('warn', `内网 agent 互通启动失败：${(e && e.message) || e}`));

  return coordinator;
}

function createCoordinator(deps) {
  // 延迟 require：`./index` 会把 server / discovery 一起拉进来，
  // 而 headless 某些路径（如纯 CLI 查询）不需要真去开端口。
  const { createPeerCoordinator } = require('./index');
  return createPeerCoordinator(deps);
}

/**
 * 无人值守机器（headless / systemd 服务）没有「确认对方」的按钮。
 *
 * 不处理会怎样：每台同事的 agent 都被静默扣在「待确认」里（`NOT_TRUSTED`），
 * 现场既没人会点确认，也没人知道有这件事 —— 服务器就成了互通里的哑巴。
 *
 * 所以这里做**一件事**：首次启动把 `autoTrust` 落成 `true`（只补缺失的字段，
 * 人改过的值永远优先），并把当前授权姿态打进日志 —— 让运维一眼看到这台机器有多宽。
 * 明确 `deny` 在任何模式下都拦；想更严：`autoTrust:false`（要人确认，但服务器上没人点）
 * 或 `autoTurn:false`（照收不自动跑）；想完全静默：`enabled:false`。
 *
 * @param {string} userDataPath
 * @param {(level: 'info' | 'warn' | 'error', msg: string) => void} say
 */
function seedUnattendedTrust(userDataPath, say) {
  if (!userDataPath) return;
  try {
    const store = createPeerStore(userDataPath);
    const before = store.settings();
    if (!before.autoTrust) store.ensureSettings({ autoTrust: true });
    const now = store.settings();
    const file = store.files && store.files.settings ? store.files.settings : '(未落盘)';
    if (now.autoTrust) {
      say(
        'warn',
        '内网互通：本机没有「确认对方」界面，授权默认值 autoTrust=true —— ' +
          '同网段内未表态的对端可直接让本机跑一轮（明确 deny 仍拦）。' +
          `要收回到人工确认：把 ${file} 的 autoTrust 改成 false；要完全静默：enabled:false。`
      );
    } else {
      say('info', `内网互通：授权采用人工确认（autoTrust=false，清单见 ${file} 同目录 trusted-peers.json）`);
    }
  } catch (err) {
    say('warn', `内网互通：授权默认值写入失败（沿用文件现状）：${(err && err.message) || err}`);
  }
}

module.exports = { bootPeerRuntime };
