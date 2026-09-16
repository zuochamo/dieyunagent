'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const si = require('systeminformation');
const io = require('socket.io-client');
const { parseMonitorServerUrl } = require('./app-config');

const WORKPLACE_MONITOR_FILE = 'workplace-monitor.json';
const PUBLIC_IP_TTL_MS = 30 * 60 * 1000;

function isValidPublicIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 127) return false;
  return true;
}

/** systeminformation 字段为 currentLoad（非 currentload） */
function readCpuPercent(load) {
  const v = load && (load.currentLoad ?? load.currentload);
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(100, v)));
}

/**
 * Workplace monitor sockets, keystroke hook, public IP, local status timer.
 * @param {object} deps
 */
function createWorkplaceMonitor(deps) {
  const {
    app,
    log,
    createStatusOutbox,
    getComputerId,
    getAppVersion,
    getMonitorServerCandidates,
    getStats,
    resetDailyStats,
    bumpActivityStats,
    getTray,
    pushStatus
  } = deps;

  const monitorSockets = new Map();
  let monitorStatusInterval = null;
  let workplaceMonitorEnabled = true;
  let keystrokeHookStarted = false;
  let workplaceMonitorPushTimer = null;
  let monitorStatusOutbox = null;
  let publicIpCache = { ip: '', at: 0 };
  let publicIpRefreshPromise = null;

  function workplaceMonitorSettingsPath() {
    return path.join(app.getPath('userData'), WORKPLACE_MONITOR_FILE);
  }

  function loadWorkplaceMonitorSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(workplaceMonitorSettingsPath(), 'utf8'));
      return { enabled: raw.enabled !== false };
    } catch {
      return { enabled: true };
    }
  }

  function saveWorkplaceMonitorSettings(settings) {
    const file = workplaceMonitorSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled: settings.enabled !== false }, null, 2),
      'utf8'
    );
  }

  function isWorkplaceMonitorEnabled() {
    return workplaceMonitorEnabled;
  }

  function applyWorkplaceMonitorEnabled(enabled) {
    workplaceMonitorEnabled = !!enabled;
    saveWorkplaceMonitorSettings({ enabled: workplaceMonitorEnabled });
    if (workplaceMonitorEnabled) {
      startKeystrokeMonitor();
      ensureWorkplaceMonitorConnection();
    } else {
      stopKeystrokeMonitor();
      disconnectWorkplaceMonitor();
    }
  }

  function ensureWorkplaceMonitorConnection() {
    if (!isWorkplaceMonitorEnabled()) return;
    connectMonitorSockets();
  }

  function isMonitorRegistered() {
    for (const entry of monitorSockets.values()) {
      if (entry.registered && entry.socket.connected) return true;
    }
    return false;
  }

  function getMonitorStatusOutbox() {
    if (!monitorStatusOutbox) {
      let persistPath = null;
      try {
        persistPath = path.join(app.getPath('userData'), 'monitor-status-outbox.json');
      } catch {
        persistPath = null;
      }
      monitorStatusOutbox = createStatusOutbox({ persistPath });
    }
    return monitorStatusOutbox;
  }

  function emitToAllMonitors(event, payload) {
    let sent = 0;
    for (const entry of monitorSockets.values()) {
      if (entry.socket.connected && entry.registered) {
        entry.socket.emit(event, payload);
        sent += 1;
      }
    }
    return sent;
  }

  function disconnectWorkplaceMonitor() {
    if (workplaceMonitorPushTimer) {
      clearInterval(workplaceMonitorPushTimer);
      workplaceMonitorPushTimer = null;
    }
    if (monitorStatusInterval) {
      clearInterval(monitorStatusInterval);
      monitorStatusInterval = null;
    }
    for (const entry of monitorSockets.values()) {
      try {
        entry.socket.removeAllListeners();
        entry.socket.disconnect();
      } catch {
        // ignore
      }
    }
    monitorSockets.clear();
  }

  /** 监控服务端（像素办公 / :3003）期望的字段名 */
  function buildMonitorPayload({
    mac = '',
    clientIp = '127.0.0.1',
    publicIp = '',
    cpu = 0,
    memory = 0,
    uptime
  } = {}) {
    resetDailyStats();
    const stats = getStats();
    const payload = {
      computerId: getComputerId(),
      mac,
      hostname: os.hostname(),
      clientIp,
      cpu,
      memory,
      uptime: uptime != null ? uptime : Math.round(os.uptime()),
      keystrokes: stats.keystrokesToday,
      keystrokesToday: stats.keystrokesToday,
      mouseClicks: stats.mouseClicksToday,
      clientVersion: getAppVersion(),
      tokensToday: stats.tokensToday,
      tokensTotal: stats.tokensTotal,
      promptTokensToday: stats.promptTokensToday,
      completionTokensToday: stats.completionTokensToday,
      cachedTokensToday: stats.cachedTokensToday,
      cachedTokensTotal: stats.cachedTokensTotal,
      cacheHitPromptTokensToday: stats.cacheHitPromptTokensToday,
      cacheHitPromptTokensMonth: stats.cacheHitPromptTokensMonth,
      promptTokensMonth: stats.promptTokensMonth,
      completionTokensMonth: stats.completionTokensMonth,
      cachedTokensMonth: stats.cachedTokensMonth,
      modelUsageToday: stats.modelUsageToday,
      modelUsageMonth: stats.modelUsageMonth,
      statsMonth: stats.lastResetMonth
    };
    const pub = String(publicIp || '').trim();
    if (pub) payload.publicIp = pub;
    return payload;
  }

  async function resolvePublicIp(force = false) {
    const now = Date.now();
    if (!force && publicIpCache.ip && now - publicIpCache.at < PUBLIC_IP_TTL_MS) {
      return publicIpCache.ip;
    }
    if (publicIpRefreshPromise && !force) {
      try {
        return await publicIpRefreshPromise;
      } catch {
        return publicIpCache.ip || '';
      }
    }

    publicIpRefreshPromise = (async () => {
      const providers = [
        async () => {
          const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
          const j = await r.json();
          return j?.ip;
        },
        async () => {
          const r = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
          const j = await r.json();
          return j?.ip;
        },
        async () => {
          const r = await fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(6000) });
          return (await r.text()).trim().split(/\s+/)[0];
        }
      ];
      for (const fn of providers) {
        try {
          const ip = String((await fn()) || '').trim();
          if (isValidPublicIpv4(ip)) {
            publicIpCache = { ip, at: Date.now() };
            log.info('公网 IP:', ip);
            return ip;
          }
        } catch {
          // try next provider
        }
      }
      return publicIpCache.ip || '';
    })();

    try {
      return await publicIpRefreshPromise;
    } finally {
      publicIpRefreshPromise = null;
    }
  }

  async function getSystemInfo() {
    try {
      const [cpu, mem, network, publicIp] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkInterfaces(),
        resolvePublicIp()
      ]);

      const activeInterface = network
        .filter((n) => n.family === 'IPv4' && !n.internal && n.ip4 && n.mac)[0];

      const ipv4 = activeInterface ? activeInterface.ip4 : '127.0.0.1';
      const mac = activeInterface ? activeInterface.mac : '';

      return buildMonitorPayload({
        mac,
        clientIp: ipv4,
        publicIp,
        cpu: readCpuPercent(cpu),
        memory: Math.round((mem.used / mem.total) * 100)
      });
    } catch (err) {
      log.error('获取系统信息失败:', err);
      const publicIp = await resolvePublicIp().catch(() => '');
      return buildMonitorPayload({ mac: '', clientIp: '127.0.0.1', publicIp, cpu: 0, memory: 0 });
    }
  }

  function onUiohookKeydown() {
    resetDailyStats();
    bumpActivityStats({ keystrokesToday: 1 });
  }

  function onUiohookMousedown() {
    resetDailyStats();
    bumpActivityStats({ mouseClicksToday: 1 });
  }

  function detachUiohookListeners(uIOhook) {
    try {
      uIOhook.off('keydown', onUiohookKeydown);
      uIOhook.off('mousedown', onUiohookMousedown);
    } catch {
      // ignore
    }
  }

  function startKeystrokeMonitor() {
    if (!isWorkplaceMonitorEnabled() || keystrokeHookStarted) return;
    try {
      const { uIOhook } = require('uiohook-napi');
      // 先解绑再绑定，避免重复 start 累积监听
      detachUiohookListeners(uIOhook);
      uIOhook.on('keydown', onUiohookKeydown);
      uIOhook.on('mousedown', onUiohookMousedown);

      uIOhook.start();
      keystrokeHookStarted = true;
      log.info('键盘/鼠标监控已启动 (uiohook-napi)');
    } catch (err) {
      log.error('键盘监控启动失败:', err);
    }
  }

  function stopKeystrokeMonitor() {
    if (!keystrokeHookStarted) return;
    try {
      const { uIOhook } = require('uiohook-napi');
      detachUiohookListeners(uIOhook);
      uIOhook.stop();
      keystrokeHookStarted = false;
      log.info('键盘/鼠标监控已停止');
    } catch (err) {
      log.warn('键盘监控停止失败:', err.message || err);
      keystrokeHookStarted = false;
    }
  }

  function startMonitorStatusInterval() {
    if (monitorStatusInterval) return;
    monitorStatusInterval = setInterval(async () => {
      if (!isWorkplaceMonitorEnabled() || !monitorSockets.size) return;
      try {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const info = await getSystemInfo();
        const payload = buildMonitorPayload({
          mac: info.mac,
          clientIp: info.clientIp,
          cpu: readCpuPercent(cpu),
          memory: Math.round((mem.used / mem.total) * 100),
          uptime: Math.round(os.uptime())
        });
        const outbox = getMonitorStatusOutbox();
        const connected = isMonitorRegistered();
        outbox.update(payload, { connected });
        if (connected) {
          emitToAllMonitors('status-update', payload);
        }
        const tray = getTray && getTray();
        if (tray) {
          tray.setToolTip(
            `叠云Agent · ${getComputerId()}\nCPU ${readCpuPercent(cpu)}% · 内存 ${Math.round((mem.used / mem.total) * 100)}%\n今日按键 ${info.keystrokesToday}`
          );
        }
      } catch (err) {
        log.error('状态更新失败:', err.message);
      }
    }, 5000);
  }

  function connectOneMonitorSocket(serverUrl, { primary = false } = {}) {
    if (monitorSockets.has(serverUrl)) return;
    log.info('正在连接监控服务器:', serverUrl);
    const { url: monitorUrl, path: monitorSocketPath } = parseMonitorServerUrl(serverUrl);
    const sock = io(monitorUrl, {
      path: monitorSocketPath,
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity
    });
    const entry = { socket: sock, registered: false, primary: !!primary };
    monitorSockets.set(serverUrl, entry);

    sock.on('connect', async () => {
      log.info('已连接到监控服务器:', serverUrl);
      entry.registered = false;
      try {
        const info = await getSystemInfo();
        sock.emit('register', info);
        entry.registered = true;
        log.info('已向监控服务器注册:', serverUrl, info.hostname, `(${getComputerId()})`);
        const snap = getMonitorStatusOutbox().peek();
        if (snap) sock.emit('status-update', snap);
        getMonitorStatusOutbox().markFlushed();
      } catch (err) {
        log.warn('监控注册失败:', serverUrl, err.message || err);
      }
    });

    sock.on('disconnect', () => {
      log.warn('与监控服务器断开:', serverUrl);
      entry.registered = false;
      getMonitorStatusOutbox().markDisconnected();
    });

    sock.on('connect_error', (err) => {
      log.error('监控连接失败:', serverUrl, err.message);
    });

    startMonitorStatusInterval();
  }

  function connectMonitorSockets() {
    if (!isWorkplaceMonitorEnabled()) return;
    const servers = getMonitorServerCandidates();
    servers.forEach((serverUrl, index) => {
      connectOneMonitorSocket(serverUrl, { primary: index === 0 });
    });
  }

  function startLocalStatusPushTimer() {
    if (workplaceMonitorPushTimer) return;
    workplaceMonitorPushTimer = setInterval(() => {
      if (typeof pushStatus === 'function') pushStatus();
    }, 1000);
  }

  async function primeCpuSampler() {
    try {
      await si.currentLoad();
      await si.currentLoad();
    } catch (err) {
      log.warn('CPU 采样预热失败:', err.message);
    }
  }

  function applyLoadedSettings() {
    const workplaceSettings = loadWorkplaceMonitorSettings();
    workplaceMonitorEnabled = workplaceSettings.enabled !== false;
    if (workplaceMonitorEnabled) {
      startKeystrokeMonitor();
    }
  }

  function dispose() {
    try {
      const { uIOhook } = require('uiohook-napi');
      detachUiohookListeners(uIOhook);
      uIOhook.stop();
    } catch {
      // ignore
    }
    keystrokeHookStarted = false;
    disconnectWorkplaceMonitor();
  }

  return {
    isWorkplaceMonitorEnabled,
    applyWorkplaceMonitorEnabled,
    isMonitorRegistered,
    ensureWorkplaceMonitorConnection,
    disconnectWorkplaceMonitor,
    startKeystrokeMonitor,
    stopKeystrokeMonitor,
    startLocalStatusPushTimer,
    primeCpuSampler,
    resolvePublicIp,
    applyLoadedSettings,
    dispose
  };
}

module.exports = { createWorkplaceMonitor, isValidPublicIpv4, readCpuPercent };
