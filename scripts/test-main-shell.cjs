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
const {
  createRendererFreezeReporter,
  collectRendererProcessMetrics,
  formatRendererFreezeReport,
  RENDERER_FREEZE_PREFIX
} = require('../src/main/ipc/renderer-freeze');

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

// 渲染进程冻结取证（问题 B）：进程指标匹配 + 单行取证格式 + 心跳不落盘
const fakeMetricsApp = {
  getAppMetrics: () => [
    {
      pid: 111,
      type: 'Tab',
      cpu: { percentCPUUsage: 12.34 },
      memory: { workingSetSize: 2048 * 1024, privateBytes: 4096 * 1024 }
    }
  ]
};
const fakeWebContents = { isDestroyed: () => false, getOSProcessId: () => 111 };
const freezeMetrics = collectRendererProcessMetrics(fakeMetricsApp, fakeWebContents);
assert(freezeMetrics.pid === 111, 'freeze metrics pid');
assert(freezeMetrics.cpuPercent === 12.3, 'freeze metrics cpu rounded');
assert(freezeMetrics.workingSetMB === 2048, 'freeze metrics working set (KB -> MB)');
assert(freezeMetrics.privateMB === 4096, 'freeze metrics private bytes');
assert(
  collectRendererProcessMetrics(
    {
      getAppMetrics: () => {
        throw new Error('no metrics');
      }
    },
    null
  ).pid === 0,
  'freeze metrics tolerates missing app metrics'
);
assert(
  collectRendererProcessMetrics(fakeMetricsApp, { isDestroyed: () => true }).pid === 0,
  'freeze metrics skips destroyed webContents'
);

const freezeLine = formatRendererFreezeReport('unresponsive', { note: 'blocked' }, freezeMetrics, 12345);
assert(freezeLine.startsWith(RENDERER_FREEZE_PREFIX), 'freeze prefix');
assert(freezeLine.includes('silentMs=12345'), 'freeze silentMs');
assert(freezeLine.includes('"note":"blocked"'), 'freeze payload kept');
assert(
  formatRendererFreezeReport('unresponsive', {}, freezeMetrics, null).includes('silentMs=n/a'),
  'freeze silentMs null'
);
assert(
  formatRendererFreezeReport('snapshot', { pad: 'x'.repeat(9000) }, freezeMetrics, 1).length < 9000,
  'freeze payload capped'
);
const circular = {};
circular.self = circular;
assert(
  formatRendererFreezeReport('snapshot', circular, freezeMetrics, 1).includes('unserializable'),
  'freeze circular payload safe'
);

const freezeLogs = [];
const reporter = createRendererFreezeReporter({
  app: fakeMetricsApp,
  log: { error: (m) => freezeLogs.push(m) },
  getMainWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents })
});
assert(reporter.getLastBeatAt() === 0, 'freeze beat initial');
reporter.markRendererBeat();
assert(reporter.getLastBeatAt() > 0, 'freeze beat marked');
assert(freezeLogs.length === 0, 'freeze beat must not log');
const firstReport = reporter.reportRendererFreeze('snapshot', { kind: 'longtask' });
assert(freezeLogs.length === 1 && freezeLogs[0] === firstReport, 'freeze report logs exactly one line');
assert(/silentMs=\d+/.test(firstReport), 'freeze report derives silentMs from beat');
reporter.resetRendererBeat();
assert(reporter.getLastBeatAt() === 0, 'freeze beat reset after reload');
assert(
  reporter.reportRendererFreeze('snapshot', {}).includes('silentMs=n/a'),
  'freeze report without beat baseline'
);
const freezeChannels = [];
assert(reporter.registerIpc({ on: (ch) => freezeChannels.push(ch) }) === true, 'freeze registerIpc ok');
assert(
  freezeChannels.join(',') === 'renderer:freeze-beat,renderer:freeze-report',
  'freeze IPC channels'
);
assert(reporter.registerIpc(null) === false, 'freeze registerIpc tolerates missing ipcMain');

// 来源过滤：非主窗口渲染进程的上报必须丢弃（取证日志是证据，不能被污染）
const guardLogs = [];
const guardReporter = createRendererFreezeReporter({
  app: fakeMetricsApp,
  log: { error: (m) => guardLogs.push(m) },
  getMainWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents })
});
const guardHandlers = {};
guardReporter.registerIpc({ on: (ch, fn) => { guardHandlers[ch] = fn; } });
guardHandlers['renderer:freeze-report']({ sender: { id: 999 } }, { kind: 'forged' });
assert(guardLogs.length === 0, 'freeze report from foreign sender rejected');
guardHandlers['renderer:freeze-beat']({ sender: { id: 999 } });
assert(guardReporter.getLastBeatAt() === 0, 'freeze beat from foreign sender rejected');
guardHandlers['renderer:freeze-report']({ sender: fakeWebContents }, { kind: 'genuine' });
assert(
  guardLogs.length === 1 && guardLogs[0].includes('"kind":"genuine"'),
  'freeze report from main window accepted'
);
guardHandlers['renderer:freeze-beat']({ sender: fakeWebContents });
assert(guardReporter.getLastBeatAt() > 0, 'freeze beat from main window accepted');

console.log('test-main-shell.cjs ok');
