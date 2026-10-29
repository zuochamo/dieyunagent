'use strict';
/**
 * 远端 Agent 生命周期的可测部分（P2：Unix socket 形态）。
 *
 * 历史三个洞都在「状态只是布尔」上，P2 之后判据换成了**socket 能不能从这条 SSH 连接上开出来**：
 *  - `active` 挂着但 daemon 已死 → 探活失败就重建，不再返回一个连不上的地址
 *  - `stop()` 无视在途部署 → 部署照旧提交，把刚断开的状态又点亮
 *  - 部署失败后自己不回收远端 daemon → 索引库被孤儿进程占住
 *
 * 这里锁住的是能脱离真实 SSH 验证的部分：探活、日志/socket 路径、失败状态自洽。
 */
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  probeAgentSocket,
  readRemoteMarkerState,
  buildStaleCoreCleanupScript,
  createRemoteGatewayManager,
  remoteLogDir,
  remoteLogPathFor,
  remoteLogDisplayPath,
  remoteRunDir,
  remoteSocketPathFor
} = require('../../src/ssh/remote-gateway-manager');

const HOME = '/home/dieyunx';
const SOCK = `${HOME}/.dieyun/remote-agent/run/agent.sock`;

function fakeSshWith(forward) {
  return {
    assertConnected() {},
    status: () => ({ connected: true }),
    getClient: () => ({ openssh_forwardOutStreamLocal: forward }),
    exec: async () => ({ stdout: `${HOME}\n`, code: 0, stderr: '' }),
    execScript: async () => ({ stdout: '', code: 0, stderr: '' })
  };
}

describe('probeAgentSocket（复用的唯一前置条件）', () => {
  it('能开出 direct-streamlocal 通道 → true，且通道被立刻释放', async () => {
    const streams = [];
    const ssh = fakeSshWith((socketPath, cb) => {
      assert.equal(socketPath, SOCK, '必须探的是这个 socket');
      const s = new PassThrough();
      streams.push(s);
      cb(null, s);
    });
    assert.equal(await probeAgentSocket(ssh, SOCK, 500), true);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].destroyed, true, '探活不能留下半开通道');
  });

  it('通道开不出来（daemon 不在 / socket 陈旧）→ false', async () => {
    const ssh = fakeSshWith((_socketPath, cb) => cb(new Error('no such file or directory')));
    assert.equal(await probeAgentSocket(ssh, SOCK, 500), false);
  });

  it('SSH 没有 client / 连接已断 → false（不许抛）', async () => {
    assert.equal(await probeAgentSocket(null, SOCK, 200), false);
    assert.equal(await probeAgentSocket({}, SOCK, 200), false);
    assert.equal(await probeAgentSocket({ getClient: () => null }, SOCK, 200), false);
    assert.equal(
      await probeAgentSocket({ getClient: () => ({}) }, SOCK, 200),
      false,
      'client 不支持 streamlocal（老 ssh2）时不许崩'
    );
  });

  it('对端不说话也要在预算内收尾（不许把 ensure 挂死）', async () => {
    const ssh = fakeSshWith(() => {
      /* 永不回调 */
    });
    const t0 = Date.now();
    assert.equal(await probeAgentSocket(ssh, SOCK, 120), false);
    assert.ok(Date.now() - t0 < 2000, '超时预算必须生效');
  });
});

describe('日志与 socket 路径的单一来源', () => {
  it('每主机一份日志：不再按项目 / 端口分文件', () => {
    assert.equal(remoteLogDir(HOME), `${HOME}/.dieyun/remote-agent/logs`);
    assert.equal(remoteLogPathFor(HOME), `${HOME}/.dieyun/remote-agent/logs/agent.log`);
    assert.equal(remoteLogDisplayPath(), '~/.dieyun/remote-agent/logs/agent.log');
  });

  it('socket 落在 run 目录下，且长度不触 AF_UNIX 上限（108）', () => {
    assert.equal(remoteRunDir(HOME), `${HOME}/.dieyun/remote-agent/run`);
    assert.equal(remoteSocketPathFor(HOME), SOCK);
    // 真实 HOME 可能更长；给足余量的前提是路径里没有按项目哈希展开的目录
    assert.ok(remoteSocketPathFor('/home/some-long-user-name/dev').length < 108);
  });
});

describe('buildStaleCoreCleanupScript（只收孤儿 core）', () => {
  const script = buildStaleCoreCleanupScript("'/srv/p/.dieyun/index.sqlite'");

  it('不许出现盲杀写法', () => {
    assert.equal(/fuser\s+-k/.test(script), false, 'fuser -k 会把别的实例的 core 一起杀掉');
    assert.equal(
      /lsof -ti[^\n]*\);\s*do kill/.test(script) && !/ppid/.test(script),
      false,
      '拿到 pid 就直接 kill 属于盲杀'
    );
  });

  it('必须逐个校验：是 dieyun-core 且父进程已是 init', () => {
    assert.equal(script.includes('/proc/$pid/cmdline'), true);
    assert.equal(script.includes('*dieyun-core*'), true);
    assert.equal(script.includes('/proc/$pid/stat'), true);
    assert.equal(script.includes('"$ppid" = "1"'), true);
  });

  it('没有 /proc 的平台直接不动（宁可不收，也不盲杀）', () => {
    assert.equal(script.includes('test -d /proc'), true);
  });

  it('路径按 shell 引用传入，不参与字符串拼接', () => {
    assert.equal(script.split('\n')[0], "DB='/srv/p/.dieyun/index.sqlite'");
  });
});

describe('端口时代的机制必须彻底消失（防止回归）', () => {
  const mod = require('../../src/ssh/remote-gateway-manager');

  it('不再导出 pid 文件 / 端口探活 / 按端口命名日志', () => {
    assert.equal(mod.buildStopAgentPidScript, undefined, 'pid 文件不再是单例机制');
    assert.equal(mod.probeTunnelAlive, undefined, '探活改成 socket，不再探本地端口');
    assert.equal(mod.remoteLogFileName, undefined, '日志不再按项目/端口分文件');
  });

  it('getStatus 只报 socketPath，不报端口', () => {
    const manager = createRemoteGatewayManager({});
    const st = manager.getStatus();
    assert.equal(st.socketPath, '');
    assert.equal('localPort' in st, false);
    assert.equal('remotePort' in st, false);
  });

  it('daemon 本身也没有 TCP / token 形态了', () => {
    const hostMod = require('../../src/remote/minimal-gateway-host');
    assert.equal(hostMod.DEFAULT_REMOTE_PORT, undefined, '端口默认值不该再存在');
    const host = new hostMod.MinimalRemoteGatewayHost({ socketPath: '/tmp/dy-test.sock', workspaceRoot: '/srv/p' });
    const info = host.getInfo();
    assert.deepEqual(Object.keys(info).sort(), ['remoteGateway', 'socketPath', 'workspaceRoot']);
    assert.equal('token' in info, false);
    assert.equal('url' in info, false);
    // 没有 socketPath 就直接拒绝启动：不许悄悄退回监听 127.0.0.1
    const bare = new hostMod.MinimalRemoteGatewayHost({ workspaceRoot: '/srv/p' });
    assert.throws(() => bare.start(), (e) => e.code === 'REMOTE_AGENT_NO_SOCKET');
  });

  it('run-cli 不再接受 --port / --token（旧参数静默无效最危险）', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/remote/run-cli.js'), 'utf8');
    assert.equal(/--port/.test(src), false, 'run-cli 不该再有 --port');
    assert.equal(/--token/.test(src), false, 'run-cli 不该再有 --token');
    assert.equal(/DIEYUN_REMOTE_TOKEN/.test(src), false, 'token 环境变量也该消失');
  });
});

describe('manager 的失败状态必须自洽', () => {
  function makeManager() {
    const logs = [];
    const manager = createRemoteGatewayManager({ log: (m) => logs.push(String(m)) });
    return { manager, logs };
  }

  const fakeSsh = fakeSshWith((_p, cb) => cb(new Error('not running')));

  it('没有部署成功过就不许对外给 info', () => {
    const { manager } = makeManager();
    assert.equal(manager.getInfo(), null);
    assert.equal(manager.isActive(), false);
    assert.equal(manager.getStatus().info, null);
  });

  it('部署失败：不提交状态、错误留档、deploying 归零、下次仍会重试', async () => {
    const { manager, logs } = makeManager();
    const ctx = {
      sshManager: fakeSsh,
      packRoot: 'Z:\\definitely-missing-pack-dir',
      appVersion: '0.0.0-test',
      workspaceRemotePath: '/srv/p'
    };
    await assert.rejects(() => manager.ensureRemoteGateway(ctx), /安装包/);
    assert.equal(manager.isActive(), false);
    assert.equal(manager.getInfo(), null, '失败后不许留着上一次的 info');
    assert.equal(manager.getStatus().deploying, false);
    assert.equal(manager.getStatus().lastErrorCode, 'REMOTE_GATEWAY_PACK_MISSING');
    // 第二次调用必须重新尝试（而不是把失败当成「已就绪」返回）
    await assert.rejects(() => manager.ensureRemoteGateway(ctx), /安装包/);
    assert.ok(logs.some((l) => l.includes('注入失败')));
  });

  it('stop() 之后状态彻底清空（含纪元作废，后续不会复用旧结果）', async () => {
    const { manager } = makeManager();
    await manager.stop(fakeSsh, { killRemote: true });
    const st = manager.getStatus();
    assert.equal(st.active, false, 'stop 后 active 不许漂成 true');
    assert.equal(st.info, null);
    assert.equal(st.workspaceRoot, '');
    assert.equal(st.socketPath, '');
  });
});

/**
 * 「读不到就绪标记」不等于「没装过」。
 *
 * 以前 remoteMarkerState 把传输失败也当成空标记 → needUpload=true → `rm -rf` 已装好的目录 +
 * 重传整包（几十 MB + 内置 Node）。一次网络抖动就能触发，而且对象是完全健康的安装。
 */
describe('就绪标记读取：缺文件 vs 读不到', () => {
  const MARKER = '/home/u/.dieyun/remote-agent/1.0.0/.pack-ok';

  it('标记不存在（脚本 || true，退出码 0、stdout 空）→ 首次注入', async () => {
    const ssh = { execScript: async () => ({ code: 0, stdout: '', stderr: '' }) };
    assert.deepEqual(await readRemoteMarkerState(ssh, MARKER), { remoteVersion: '', remoteHash: '' });
  });

  it('读到标记 → 版本与内容 hash', async () => {
    const hash = 'a'.repeat(64);
    const ssh = {
      execScript: async () => ({ code: 0, stdout: `VERSION=1.2.3\nCONTENT_HASH=${hash}\n`, stderr: '' })
    };
    assert.deepEqual(await readRemoteMarkerState(ssh, MARKER), {
      remoteVersion: '1.2.3',
      remoteHash: hash
    });
  });

  it('传输失败/超时 → 抛 REMOTE_GATEWAY_MARKER_UNREADABLE，绝不当作首次注入', async () => {
    const ssh = {
      execScript: async () => {
        throw Object.assign(new Error('远程命令超时（8000ms）'), { code: 'SSH_EXEC_TIMEOUT' });
      }
    };
    await assert.rejects(
      () => readRemoteMarkerState(ssh, MARKER),
      (e) => {
        assert.equal(e.code, 'REMOTE_GATEWAY_MARKER_UNREADABLE');
        assert.equal(e.retryable, true);
        assert.match(e.message, /标记/);
        assert.equal(e.cause.code, 'SSH_EXEC_TIMEOUT');
        return true;
      }
    );
  });

  it('标记路径按 shell 引用传入（路径里有空格也不拼坏）', async () => {
    const seen = [];
    const ssh = {
      execScript: async (script) => {
        seen.push(script);
        return { code: 0, stdout: '', stderr: '' };
      }
    };
    await readRemoteMarkerState(ssh, "/home/u/my dir/.pack-ok");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes("'/home/u/my dir/.pack-ok'"));
  });
});

/**
 * 部署决策的三条不变式（在 ensure 的 async 深处，没有注入点，用源码形状锁住）。
 */
describe('部署决策不变式', () => {
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const src = readFileSync(path.join(__dirname, '..', '..', 'src', 'ssh', 'remote-gateway-manager.js'), 'utf8');

  it('清理陈旧 daemon 必须带上 workspace（否则孤儿 core 占着索引库）', () => {
    assert.ok(
      !/stopAgentDaemon\(sshManager,\s*sockPath,\s*''\)/.test(src),
      '清理陈旧 daemon 时不许传空 workspace'
    );
    const hits = src.match(/stopAgentDaemon\(sshManager, sockPath, workspaceRemotePath\)/g) || [];
    assert.equal(hits.length, 2, '陈旧清理与「注入后重启」两条路都要带 workspace');
  });

  it('部署失败不许把 active 盲置为 false（会留下半真半假状态）', () => {
    const at = src.indexOf('Remote Agent 注入失败');
    assert.ok(at > 0);
    const around = src.slice(Math.max(0, at - 900), at);
    assert.ok(!/^\s*active = false;$/m.test(around), 'catch 里不许再写 active = false');
    assert.match(around, /lastErrorCode = e\.code/, '错误留档要保留');
  });

  it('复用 daemon 前必须看这次是否注入过新内容', () => {
    assert.match(src, /if \(alive && deployed\.uploaded\)/, '注入了新内容就要重启 daemon');
    assert.match(src, /let deployed = await deployPack\(/, 'deployPack 必须回报是否上传');
    const dp = src.indexOf('return { uploaded: needUpload === true };');
    assert.ok(dp > 0, 'deployPack 必须返回 uploaded');
  });

  it('清目录与写 marker 都要看退出码（只有 ln 看是不行的）', () => {
    assert.match(src, /REMOTE_GATEWAY_CLEANUP_FAILED/);
    assert.match(src, /REMOTE_GATEWAY_MARKER_WRITE_FAILED/);
    assert.ok(!/rm -rf \$\{shellQuoteSingle\(remoteBase\)\} && mkdir -p/.test(src), '旧的一行 && 链必须去掉');
  });
});
