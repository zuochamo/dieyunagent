'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseMonitorServerUrl,
  defaultComputerIdFromHostname,
  getMonitorServerCandidates,
  loadAppConfig,
  normalizeMonitorUrl
} = require('../src/main/app-config');
const { createActivityStats, normalizeModelUsageKey } = require('../src/main/activity-stats');
const { isValidPublicIpv4 } = require('../src/main/workplace-monitor');
const { resolveRendererIndexHtml } = require('../src/main/window-tray');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(normalizeMonitorUrl('http://a') === 'http://a/', 'slash');
assert(parseMonitorServerUrl('http://host/monitor/').path === '/monitor/socket.io', 'prefix path');
assert(parseMonitorServerUrl('http://host:3003').url === 'http://host:3003', 'host url');
assert(defaultComputerIdFromHostname('DESKTOP-DIEYUN 3') === 'DIEYUN3', 'dieyun spaced');
assert(defaultComputerIdFromHostname('dieyun12') === 'DIEYUN12', 'dieyun compact');
assert(defaultComputerIdFromHostname('WORKPC').startsWith('pc-'), 'fallback pc-');

const candidates = getMonitorServerCandidates({
  argv: ['--server=http://lan:3003'],
  deployCfg: { monitor: { serverUrl: 'http://ignored' } }
});
assert(candidates[0] === 'http://lan:3003/', 'cli server wins');

const cfg = loadAppConfig({
  deployCfg: { monitor: { serverUrl: '' }, updates: { primaryUrl: 'http://u', fallbackUrl: '' } },
  argv: ['--id=BOX1'],
  env: {},
  hostname: 'x'
});
assert(cfg.COMPUTER_ID === 'BOX1', 'cli id');
assert(cfg.UPDATE_URL === 'http://u', 'update url');

assert(isValidPublicIpv4('1.2.3.4') === true, 'public');
assert(isValidPublicIpv4('10.0.0.1') === false, 'rfc1918');
assert(isValidPublicIpv4('192.168.1.1') === false, 'rfc1918-192');
assert(isValidPublicIpv4('127.0.0.1') === false, 'loopback');

assert(normalizeModelUsageKey('  m  ') === 'm', 'model key trim');
assert(normalizeModelUsageKey('') === '未知模型', 'unknown model');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-stats-'));
const logs = [];
const statsApi = createActivityStats({
  getUserDataPath: () => dir,
  log: { info: (m) => logs.push(m), warn: () => {} },
  onChanged: () => logs.push('changed')
});
statsApi.loadActivityStats();
statsApi.bumpActivityStats({ tokensToday: 5, modelUsage: { 'gpt-x': 5 } });
assert(statsApi.getStats().tokensToday === 5, 'bump tokens');
assert(statsApi.getStats().modelUsageToday['gpt-x'] === 5, 'model usage');
assert(logs.includes('changed'), 'onChanged');
statsApi.dispose();

const html = resolveRendererIndexHtml({
  rendererDir: '/app/renderer',
  isPackaged: true,
  env: {},
  existsSync: (p) => p.replace(/\\/g, '/').endsWith('index.bundled.html') || p.replace(/\\/g, '/').endsWith('dist/bundle.js')
});
assert(html.replace(/\\/g, '/').endsWith('renderer/index.bundled.html'), 'prefer bundle when packaged');

const legacy = resolveRendererIndexHtml({
  rendererDir: '/app/renderer',
  isPackaged: true,
  env: { DIEYUN_LEGACY_RENDERER_SCRIPTS: '1' },
  existsSync: () => true
});
assert(legacy.replace(/\\/g, '/').endsWith('renderer/index.html'), 'legacy force');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-main-shell.cjs ok');
