'use strict';

/**
 * 浏览器版切工作空间（`desktop.set_workspace`）的回归。
 * 现场（2026-11-05）：网页里点「工作空间 → 本地」没反应 —— 浏览器 shim 没有
 * `setLocalWorkspace`，渲染层静默 return。补上通道后，这条路径必须自己证明
 * 「路径存在且是目录」：桌面端路径来自系统目录框，浏览器里是人手填的。
 * 一个错路径落进 Gateway 工作区根，报错会推迟成后面「文件工具莫名失败」。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createDesktopTurn, parseAptUpgradeSimulation, parseAptPolicy, APT_ENV } = require('../src/headless/desktop-turn');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ws-'));
const dirA = path.join(tmpRoot, 'project-a');
const dirB = path.join(tmpRoot, 'project-b');
fs.mkdirSync(dirA);
fs.mkdirSync(dirB);
const fileA = path.join(tmpRoot, 'not-a-dir.txt');
fs.writeFileSync(fileA, 'x');

/** 记录调用、返回与 Gateway 同形。*/
const calls = [];
const gateway = {
  invokeRpc: async () => ({}),
  setLocalWorkspace(p) {
    calls.push(p);
    return p
      ? { kind: 'local', workspacePath: String(p), displayPath: String(p), sshConnected: false }
      : { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
  },
  getWorkspace() {
    const p = calls.length ? calls[calls.length - 1] : null;
    return p
      ? { kind: 'local', workspacePath: p, displayPath: p, sshConnected: false }
      : { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
  },
  // 权限档位：真实实现里归一/落盘/作废旧批准都在 Gateway（这里只记录收到了什么）
  permissions: { sandboxMode: 'workspace-write', unrestrictedPaths: false },
  permissionWrites: [],
  getPermissions() {
    return { ...this.permissions };
  },
  getSandboxMode() {
    return this.permissions.sandboxMode;
  },
  setPermissions(next) {
    this.permissionWrites.push(next);
    this.permissions = {
      ...this.permissions,
      ...next,
      sandboxMode: next && next.unrestrictedPaths === true ? 'danger-full-access' : next.sandboxMode || this.permissions.sandboxMode
    };
    return { ...this.permissions };
  }
};

const turn = createDesktopTurn({
  gateway,
  getCoreBridge: () => ({ isReady: () => false }),
  createToolBridge: () => ({ executeAgentTool: async () => ({}) }),
  getCompactionAgent: () => null,
  userData: tmpRoot,
  log: () => {}
});

async function main() {
  // 1) 正常切换：解析成绝对路径后交给 Gateway，并把生效形状回给页面。
  const ok = await turn.handleCall('desktop.set_workspace', { path: dirA }, () => {}, null);
  assert.strictEqual(ok.kind, 'local', 'kind');
  assert.strictEqual(ok.workspacePath, path.resolve(dirA), 'workspacePath = 绝对路径');
  assert.strictEqual(calls[calls.length - 1], path.resolve(dirA), 'Gateway 收到的是绝对路径');

  // 2) 相对路径按服务端 cwd 归一（浏览器可能给 "sub"），至少要拿到绝对路径。
  const relName = `tmp-rel-ws-${Date.now().toString(36)}`;
  const relAbs = path.join(process.cwd(), relName);
  fs.mkdirSync(relAbs);
  try {
    await turn.handleCall('desktop.set_workspace', { path: relName }, () => {}, null);
    assert.strictEqual(calls[calls.length - 1], relAbs, '相对路径必须归一成绝对路径');
  } finally {
    fs.rmSync(relAbs, { recursive: true, force: true });
  }

  // 3) ~ 展开
  await turn.handleCall('desktop.set_workspace', { path: '~' }, () => {}, null);
  assert.strictEqual(calls[calls.length - 1], path.resolve(os.homedir()), '~ 应展开成家目录');

  // 4) 不存在的目录：必须当场报错，不能落进工作区根
  const before = calls.length;
  await assert.rejects(
    () => turn.handleCall('desktop.set_workspace', { path: path.join(tmpRoot, 'nope') }, () => {}, null),
    /目录不存在或无法访问/,
    '不存在的目录应报错'
  );
  assert.strictEqual(calls.length, before, '校验失败不能调用 Gateway');

  // 5) 文件不是目录
  await assert.rejects(
    () => turn.handleCall('desktop.set_workspace', { path: fileA }, () => {}, null),
    /不是目录/,
    '文件应被拒绝'
  );
  assert.strictEqual(calls.length, before, '校验失败不能调用 Gateway');

  // 6) 空串 = 回到默认（Gateway 收到 null）。
  const cleared = await turn.handleCall('desktop.set_workspace', { path: '' }, () => {}, null);
  assert.strictEqual(calls[calls.length - 1], null, '空串应传 null 给 Gateway');
  assert.strictEqual(cleared.workspacePath, null, '默认工作空间没有绝对路径');

  // 7) 目录浏览（桌面端没有系统目录框时的入口）：只列子目录、排序、给 parent、不列点开头的
  fs.mkdirSync(path.join(dirA, 'b-sub'));
  fs.mkdirSync(path.join(dirA, 'a-sub'));
  fs.mkdirSync(path.join(dirA, '.git'));
  fs.writeFileSync(path.join(dirA, 'file.txt'), 'x');
  const listing = await turn.handleCall('desktop.list_dirs', { path: dirA }, () => {}, null);
  assert.strictEqual(listing.path, path.resolve(dirA), '返回当前路径');
  assert.strictEqual(listing.parent, path.resolve(tmpRoot), '返回上级目录');
  assert.deepStrictEqual(
    listing.entries.map((e) => e.name),
    ['a-sub', 'b-sub'],
    '只列子目录（排除文件与点开头目录），且按名字排序'
  );
  assert.strictEqual(listing.hiddenCount, 1, '点开头目录单独计数');
  assert.ok(listing.entries.every((e) => path.isAbsolute(e.path)), '每个条目都给绝对路径');
  assert.strictEqual(listing.truncated, false, '未超上限');

  // 8) 浏览同样要过「存在且读得动」的校验
  await assert.rejects(
    () => turn.handleCall('desktop.list_dirs', { path: path.join(tmpRoot, 'nope') }, () => {}, null),
    /目录不存在或无法访问/
  );
  await assert.rejects(
    () => turn.handleCall('desktop.list_dirs', { path: fileA }, () => {}, null),
    /不是目录/
  );
  // 空串 = 从服务账号家目录开始（不报错，能把人放在一个能走的位置）。
  const home = await turn.handleCall('desktop.list_dirs', { path: '' }, () => {}, null);
  assert.strictEqual(home.path, os.homedir(), '空路径从家目录开始');

  // 9) 目录存在，**没有读权限**：必须当场拒绝并说清是谁没权限。
  //    （现场：/run/media/<别人>/，只给了通行权 x，stat 成功、列目录 EACCES；
  //     换过去之后才在索引/文件树上暴露成「路径权限打不开」）
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const xonly = path.join(tmpRoot, 'x-only');
    fs.mkdirSync(xonly);
    fs.chmodSync(xonly, 0o300); // wx：能进，不能读
    const beforeRead = calls.length;
    await assert.rejects(
      () => turn.handleCall('desktop.set_workspace', { path: xonly }, () => {}, null),
      /没有读权限/,
      'x-only 目录应报读权限错误'
    );
    assert.strictEqual(calls.length, beforeRead, '读权限不足不能调用 Gateway');
    fs.chmodSync(xonly, 0o700);
  }

  // 10) 路径权限 / 沙箱档位：浏览器版也必须能改（原来只有桌面端能改，网页里点开关弹「不支持」）
  const perms0 = await turn.handleCall('desktop.get_permissions', {}, () => {}, null);
  assert.strictEqual(perms0.sandboxMode, 'workspace-write', '读到的档位');
  const saved = await turn.handleCall(
    'desktop.set_permissions',
    { permissions: { ...perms0, unrestrictedPaths: true } },
    () => {},
    null
  );
  assert.strictEqual(saved.unrestrictedPaths, true, '完全放开要生效');
  assert.strictEqual(saved.sandboxMode, 'danger-full-access', '放开路径 = 完全放开档位');
  assert.strictEqual(gateway.permissionWrites.length, 1, 'Gateway 收到一次写入（归一在它那里）');
  const narrowed = await turn.handleCall(
    'desktop.set_permissions',
    { permissions: { ...saved, unrestrictedPaths: false, sandboxMode: 'read-only' } },
    () => {},
    null
  );
  assert.strictEqual(narrowed.sandboxMode, 'read-only', '能收回成只读');
  assert.strictEqual(narrowed.unrestrictedPaths, false, '收回后不再是放开');

  // 11) 共享记忆：网页版与桌面 IPC 共用同一份动作实现（src/memory-shared/actions.js）。
  //     —— 未装配要如实报「未装配」，装配了就要真的转发到 service。
  const fakeSm = {
    saved: [],
    probes: 0,
    getStatus() {
      return { configured: true, active: true, reason: 'ok', recallLimit: 5 };
    },
    saveSettings(patch) {
      this.saved.push(patch);
      return this.getStatus();
    },
    async testConnection(patch) {
      return { ok: true, serverVersion: '18.0', host: patch.host || 'h' };
    },
    async probe() {
      this.probes += 1;
      return { ok: true, serverVersion: '18.0' };
    }
  };
  let maintainerCalls = 0;
  const turn2 = createDesktopTurn({
    gateway,
    getCoreBridge: () => ({ isReady: () => false }),
    createToolBridge: () => ({ executeAgentTool: async () => ({}) }),
    getCompactionAgent: () => null,
    userData: tmpRoot,
    getSharedMemory: () => fakeSm,
    getKnowledgeMaintainer: () => ({
      consolidateSharedMemory: async (reason) => {
        maintainerCalls += 1;
        return { ok: true, reason, consolidated: 2 };
      }
    }),
    log: () => {}
  });

  const status = await turn2.handleCall('desktop.shm_status', {}, () => {}, null);
  assert.strictEqual(status.ok, true, 'shm_status ok');
  assert.strictEqual(status.configured, true, 'shm_status 带状态');
  const savedRes = await turn2.handleCall('desktop.shm_save', { patch: { password: 'x' } }, () => {}, null);
  assert.strictEqual(savedRes.ok, true, 'shm_save ok');
  assert.strictEqual(fakeSm.saved.length, 1, 'saveSettings 被调用');
  assert.strictEqual(fakeSm.probes, 1, '保存后必须当场探活一次');
  const tested = await turn2.handleCall('desktop.shm_test', { patch: { host: 'db' } }, () => {}, null);
  assert.strictEqual(tested.serverVersion, '18.0', 'shm_test 转发到 testConnection');
  await turn2.handleCall('desktop.shm_probe', {}, () => {}, null);
  assert.strictEqual(fakeSm.probes, 2, 'shm_probe 重新探活');
  const consolidated = await turn2.handleCall('desktop.shm_consolidate', {}, () => {}, null);
  assert.strictEqual(consolidated.consolidated, 2, 'shm_consolidate 走归纳器');
  assert.strictEqual(maintainerCalls, 1, '归纳器被调用一次');

  // 未装配（headless 没启这条链路时）必须明确说未装配，不能假装成功。
  const turn3 = createDesktopTurn({
    gateway,
    getCoreBridge: () => ({ isReady: () => false }),
    createToolBridge: () => ({ executeAgentTool: async () => ({}) }),
    getCompactionAgent: () => null,
    userData: tmpRoot,
    log: () => {}
  });
  const noSm = await turn3.handleCall('desktop.shm_status', {}, () => {}, null);
  assert.strictEqual(noSm.ok, false, '未装配 -> ok:false');
  assert.strictEqual(noSm.error, '共享记忆未装配', '未装配要说清');
  const noConsolidate = await turn3.handleCall('desktop.shm_consolidate', {}, () => {}, null);
  assert.strictEqual(noConsolidate.ok, false, '没有归纳器也不能假装成功');

  // 12) 「检查更新」在服务器版的语义：跑只读 apt 模拟升级并解析结论（不需要 root）。
  //     两种真实输出都要认得出，认不出时必须 ok:false 而不是假装「已是最新」。
  assert.deepStrictEqual(
    parseAptUpgradeSimulation('dieyun-headless is already the newest version (0.1.75).\n0 upgraded', 'dieyun-headless'),
    { ok: true, upgradable: false, currentVersion: '0.1.75', nextVersion: '' },
    '已是最新'
  );
  assert.deepStrictEqual(
    parseAptUpgradeSimulation('Inst dieyun-headless [0.1.75] (0.1.76 headless:headless [amd64])', 'dieyun-headless'),
    { ok: true, upgradable: true, currentVersion: '0.1.75', nextVersion: '0.1.76' },
    '有新版本'
  );
  assert.strictEqual(
    parseAptUpgradeSimulation('E: Unable to locate package dieyun-headless', 'dieyun-headless').ok,
    false,
    '认不出的输出不能当成已是最新'
  );
  // 同版本对齐（手工 dpkg 装过、apt 想跟归档对齐）：apt 会吐一行 Inst，但**不是**新版本。
  assert.deepStrictEqual(
    parseAptUpgradeSimulation('Inst dieyun-headless [0.1.75] (0.1.75 headless:headless [amd64])', 'dieyun-headless'),
    { ok: true, upgradable: false, currentVersion: '0.1.75', nextVersion: '' },
    '同版本 Inst 不能谎报有新版本'
  );
  // 2026-11-08 真机现场（zh_CN 环境）：apt 的结论句被翻译成中文，英文正则认不出 ——
  // 于是「已是最新」被误报成「检查更新失败：升级了 0 个软件包…」。
  // 防线不是再写一份中文正则，而是**跑 apt 时固定 C locale**：这里钉住那个常量。
  assert.strictEqual(APT_ENV.LC_ALL, 'C', 'apt 必须用 C locale 跑（否则中文环境里解析不出结论）');
  assert.strictEqual(APT_ENV.LANG, 'C', 'apt 必须用 C locale 跑');
  // 认不出的输出带原因，而不是只给一句 apt 摘要
  assert.strictEqual(
    parseAptUpgradeSimulation('E: Unable to locate package dieyun-headless', 'dieyun-headless').reason,
    'NO_PACKAGE',
    '找不到包要说清是 NO_PACKAGE'
  );
  assert.strictEqual(
    parseAptUpgradeSimulation('Package dieyun-headless is not installed, so not removed', 'dieyun-headless').reason,
    'NOT_INSTALLED',
    '不是 dpkg 装的要说清是 NOT_INSTALLED'
  );

  // 13) 「已是最新」≠「有源可查」：只 dpkg 装过、没配 apt 源时，版本表里只有 dpkg/status。
  //     真机（192.168.31.127）就是这种机器：界面若只说「已是最新」，人会以为官方没发新版。
  assert.deepStrictEqual(
    parseAptPolicy(
      [
        'dieyun-headless:',
        '  Installed: 0.1.75',
        '  Candidate: 0.1.75',
        '  Version table:',
        ' *** 0.1.75 100',
        '        100 /var/lib/dpkg/status'
      ].join('\n')
    ),
    { installed: '0.1.75', candidate: '0.1.75', fromRepo: false, known: true },
    '只有 dpkg/status 来源 = 没配源'
  );
  assert.deepStrictEqual(
    parseAptPolicy(
      [
        'dieyun-headless:',
        '  Installed: 0.1.75',
        '  Candidate: 0.1.76',
        '  Version table:',
        ' *** 0.1.76 500',
        '        500 http://192.168.31.62/headless-apt ./ Packages',
        '        100 /var/lib/dpkg/status'
      ].join('\n')
    ),
    { installed: '0.1.75', candidate: '0.1.76', fromRepo: true, known: true },
    '配了源要认得出来'
  );

  // 14) 未知方法仍然报错（别把没实现的方法悄悄吃掉）
  await assert.rejects(() => turn.handleCall('desktop.nope', {}, () => {}, null), /未知方法/);

  // 15) 供应商「检测」（网页版）：出网由服务端做，语义与桌面 `models:fetch-list` 同一份。
  //     现场（2026-11-08）：网页里点「检测」只提示「当前环境不支持模型检测」——
  //     shim 里没有 fetchBuiltinModels，渲染层走降级分支。补上通道后这里钉住两件事：
  //     填错要当场说清、真能拉到列表要如实回模型。
  const noUrl = await turn.handleCall('desktop.fetch_models', { payload: { baseUrl: '' } }, () => {}, null);
  assert.strictEqual(noUrl.ok, false, '没填接口地址要 ok:false');
  assert.ok(/接口地址/.test(noUrl.error), `错误要指出没填接口地址：${noUrl.error}`);

  const modelsSrv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => modelsSrv.listen(0, '127.0.0.1', resolve));
  const modelsPort = modelsSrv.address().port;
  try {
    const listed = await turn.handleCall(
      'desktop.fetch_models',
      { payload: { baseUrl: `http://127.0.0.1:${modelsPort}/v1`, apiKey: 'k', validate: false } },
      () => {},
      null
    );
    assert.strictEqual(listed.ok, true, `能拉到列表就 ok:true ${listed.error || ''}`);
    assert.deepStrictEqual(listed.models.map((m) => m.id), ['model-a', 'model-b'], '模型 id 排序');
    assert.strictEqual(listed.listed, 2, '带列表条数（渲染层显示「检测到 N 个可用模型」）');
  } finally {
    modelsSrv.close();
  }

  // 16) 保存模型设置（网页版）：写的必须是**服务器上**那份 model-settings.json，
  //     并且与桌面 `model:sync-settings` 同一份收尾（core 重读配置 + 推语音设置给手机端）。
  //     现场：网页里改完供应商一点保存，界面说存好了，服务器端下一轮仍用旧配置。
  const savedSettings = {
    textModel: 'model-a',
    modelSuppliers: [
      { id: 'sup-1', name: '内网网关', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'k-123', enabledModels: { 'model-a': true } }
    ]
  };
  const bridgeBroadcasts = [];
  let coreSyncs = 0;
  const saveTurn = createDesktopTurn({
    gateway: {
      ...gateway,
      _syncRustCoreConfig() {
        coreSyncs += 1;
      },
      syncRemoteIndexCoreConfig() {
        coreSyncs += 1;
      }
    },
    getCoreBridge: () => ({ isReady: () => false }),
    createToolBridge: () => ({ executeAgentTool: async () => ({}) }),
    getCompactionAgent: () => null,
    userData: tmpRoot,
    getMobileBridge: () => ({ broadcast: (p) => bridgeBroadcasts.push(p) }),
    getAgentService: () => ({ getSpeechSettings: () => ({ tts: { voice: 'v1' } }) }),
    log: () => {}
  });
  const modelSavedRes = await saveTurn.handleCall('desktop.save_model_settings', { settings: savedSettings }, () => {}, null);
  assert.strictEqual(modelSavedRes.ok, true, '保存要 ok');
  assert.strictEqual(modelSavedRes.saved, true, '要如实报「已落盘」');
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'model-settings.json'), 'utf8'));
  assert.strictEqual(onDisk.textModel, 'model-a', '落盘的是服务器上的 model-settings.json');
  assert.strictEqual(onDisk.modelSuppliers[0].apiKey, 'k-123', '供应方 key 一起落盘（与桌面同一份格式）');
  assert.strictEqual(coreSyncs, 2, 'core 与远端索引都要重读配置');
  assert.strictEqual(bridgeBroadcasts.length, 1, '语音设置推给手机端一次');
  assert.strictEqual(bridgeBroadcasts[0].type, 'settings.speech', '推送类型');
  assert.deepStrictEqual(bridgeBroadcasts[0].tts, { voice: 'v1' }, '载荷来自 AgentService.getSpeechSettings()');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('test-headless-desktop-turn.cjs ok');
}

main().catch((err) => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});
