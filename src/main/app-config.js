'use strict';

const os = require('os');

function parseCliArg(prefix, argv = process.argv) {
  const hit = argv.find((a) => a.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length);
}

function normalizeMonitorUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  return u.endsWith('/') ? u : `${u}/`;
}

/** 工位监控上报目标（内网 Socket.IO） */
function getMonitorServerCandidates(opts = {}) {
  const argv = opts.argv || process.argv;
  const deployCfg = opts.deployCfg;
  const cli = parseCliArg('--server=', argv);
  if (cli) return [normalizeMonitorUrl(cli)];
  const primary = normalizeMonitorUrl(deployCfg && deployCfg.monitor && deployCfg.monitor.serverUrl);
  return primary ? [primary] : [];
}

/** 工位监控 URL → Socket.IO 连接参数（支持 /monitor/ 等路径前缀） */
function parseMonitorServerUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { url: s, path: '/socket.io' };
  try {
    const parsed = new URL(s.endsWith('/') ? s : `${s}/`);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const base = `${parsed.protocol}//${parsed.host}`;
    const socketPath = pathname ? `${pathname}/socket.io` : '/socket.io';
    return { url: base, path: socketPath };
  } catch {
    return { url: s, path: '/socket.io' };
  }
}

/** 与 server.js 中 COMPUTERS.id 对齐：主机名含 dieyun + 数字时默认用 DIEYUN{n} */
function defaultComputerIdFromHostname(hostname = os.hostname()) {
  const h = String(hostname || '');
  const m = h.match(/dieyun\s*(\d+)/i);
  if (m) return 'DIEYUN' + m[1];
  const compact = h.toLowerCase().replace(/-/g, '');
  const m2 = compact.match(/^dieyun(\d+)$/);
  if (m2) return 'DIEYUN' + m2[1];
  return 'pc-' + compact.substring(0, 8);
}

function loadAppConfig(opts = {}) {
  const deployCfg = opts.deployCfg;
  const argv = opts.argv || process.argv;
  const env = opts.env || process.env;
  return {
    SERVER_URL: parseCliArg('--server=', argv) || (deployCfg && deployCfg.monitor && deployCfg.monitor.serverUrl) || '',
    COMPUTER_ID: parseCliArg('--id=', argv) || env.COMPUTER_ID || defaultComputerIdFromHostname(opts.hostname),
    UPDATE_URL: (deployCfg && deployCfg.updates && deployCfg.updates.primaryUrl) || '',
    UPDATE_URL_FALLBACK: (deployCfg && deployCfg.updates && deployCfg.updates.fallbackUrl) || '',
    UPDATE_CHECK_DELAY_SEC: Number(env.UPDATE_CHECK_DELAY_SEC) || 0,
    UPDATE_CHECK_INTERVAL_MIN: Number(env.UPDATE_CHECK_INTERVAL_MIN) || 20,
    UPDATE_RETRY_MIN: Number(env.UPDATE_RETRY_MIN) || 15
  };
}

module.exports = {
  parseCliArg,
  normalizeMonitorUrl,
  getMonitorServerCandidates,
  parseMonitorServerUrl,
  defaultComputerIdFromHostname,
  loadAppConfig
};
