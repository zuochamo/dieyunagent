'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createActivityStats } = require('../../src/main/activity-stats');

const silentLog = { info: () => {}, warn: () => {} };

function tempUserDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'activity-stats-'));
}

function seedStats(dir, onChanged) {
  const stats = createActivityStats({ getUserDataPath: () => dir, log: silentLog, onChanged });
  stats.bumpActivityStats({
    keystrokesToday: 5,
    mouseClicksToday: 3,
    tokensToday: 100,
    promptTokensToday: 80,
    completionTokensToday: 20,
    cacheHitPromptTokensToday: 50,
    cachedTokensToday: 50,
    modelUsage: { 'glm-4': 100 }
  });
  return stats;
}

describe('clearAllStats', () => {
  it('把所有累计口径归零，并同步落盘 + 通知一次', () => {
    const dir = tempUserDir();
    let changed = 0;
    const stats = seedStats(dir, () => {
      changed += 1;
    });
    expect(stats.getStats().keystrokesToday).toBe(5);
    expect(stats.getStats().modelUsageToday).toEqual({ 'glm-4': 100 });

    changed = 0;
    expect(stats.clearAllStats().ok).toBe(true);
    expect(stats.getStats()).toMatchObject({
      keystrokesToday: 0,
      mouseClicksToday: 0,
      tokensToday: 0,
      tokensTotal: 0,
      promptTokensToday: 0,
      completionTokensToday: 0,
      cachedTokensToday: 0,
      cacheHitPromptTokensToday: 0,
      modelUsageToday: {},
      modelUsageMonth: {}
    });
    expect(changed).toBe(1);

    // 同步落盘：不等 1.5s 防抖，否则用户清空后立刻刷新会看到旧数字
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'activity-stats.json'), 'utf8'));
    expect(onDisk.keystrokesToday).toBe(0);
    expect(onDisk.tokensToday).toBe(0);
    expect(onDisk.modelUsageToday).toEqual({});

    stats.dispose();
  });

  it('清空后不误判为跨天重置：日期基准已刷新为今天', () => {
    const dir = tempUserDir();
    const stats = seedStats(dir);
    const before = stats.getStats().lastResetDate;

    stats.clearAllStats();
    expect(stats.getStats().lastResetDate).toBe(before);
    expect(stats.getStats().lastResetDate).toBe(new Date().toDateString());

    // 清空是重置而非禁用：之后的记录照常累计
    stats.bumpActivityStats({ keystrokesToday: 2 });
    expect(stats.getStats().keystrokesToday).toBe(2);

    stats.dispose();
  });
});
