'use strict';

/**
 * 远端屏幕通道的 handler 层：`computer.action` 的 `target=remote`。
 *
 * 锁的是「哪台机器 + 有没有真去看」：
 * - `target=remote` 时必须真的走 SSH（探测 → 截图 → 经远端文件通道读回），绝不悄悄落到本机实现；
 * - 探测结果按 SSH 目标缓存（一个会话里只探一次）；
 * - 能力缺失 / 动作不支持 / 没有 SSH 会话，都要给出**能照着做**的错误，而不是空手返回；
 * - 远端输入动作同样过沙箱档位（与本地一条判定）。
 *
 * 缩放（远端原生 → 视觉预算）走 Electron 的 nativeImage，在单元环境里不可用，
 * 所以这里只覆盖「预算内直通」的情形；比例换算本身由 coordinate-map 的单测与
 * `buildInputCommand(viewPointToNative)` 覆盖。
 */

const { createComputerHandlers } = require('../../src/gateway/handlers/computer');

const PROBE_X11 = [
  'OS=Linux',
  'SESSION=x11',
  'DISPLAY=:0',
  'HAS_scrot=1',
  'HAS_xdotool=1',
  'PROBE_OK=1'
].join('\n');

function fakePng(width, height, fill = 1) {
  const buf = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function setup({
  probe = PROBE_X11,
  target = { kind: 'ssh', host: 'srv', port: 22, username: 'me', remotePath: '/srv/app' },
  remoteFs = true
} = {}) {
  const execs = [];
  const pngs = [];
  const ssh = {
    getHomeDir: () => '/home/me',
    exec: async (cmd) => {
      execs.push(cmd);
      if (cmd.includes('PROBE_OK=1')) return { code: 0, stdout: probe, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
  };
  const fsAdapter = {
    transport: 'rpc',
    root: '/srv/app',
    resolve: (p) => p,
    readFile: async (p) => {
      const next = pngs.length ? pngs.shift() : fakePng(1920, 1080, 1);
      return { data: next.toString('base64'), encoding: 'base64', path: p };
    }
  };
  const localCalls = [];
  const guards = [];
  const handlers = createComputerHandlers({
    computer: {
      action: (args) => {
        localCalls.push(args);
        return { ok: true, action: args.action, local: true };
      }
    },
    assertOsControlEnabled: () => {},
    sandbox: {
      context: () => ({ mode: 'danger-full-access' }),
      guard: async (decision) => {
        guards.push(decision);
        return null;
      }
    },
    getActiveCallSessionId: () => 's1',
    getRemoteFs: () => (remoteFs ? fsAdapter : null),
    requireSshForCall: () => ssh,
    resolveCallWorkspaceTarget: () => target,
    ctx: {}
  });
  return { handlers, execs, pngs, localCalls, guards, ssh };
}

describe('computer.action target=remote', () => {
  it('截图真的走远端：探测一次、命令落到远端、图片经远端文件通道读回', async () => {
    const { handlers, execs, localCalls } = setup();
    const out = await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(localCalls).toHaveLength(0);
    expect(out).toMatchObject({ ok: true, remote: true, width: 1920, height: 1080, mime: 'image/png' });
    expect(out.base64).toEqual(expect.any(String));
    expect(out.host).toBe('me@srv:22#s1'); // 目标 + 会话（坐标空间/指纹按会话分开）
    expect(execs.some((c) => c.includes('PROBE_OK=1'))).toBe(true);
    // 探测只报了 scrot：就用 scrot 截，别去试没装的 import
    expect(execs.some((c) => c.includes('scrot'))).toBe(true);
  });

  it('探测结果按目标缓存：连续两张截图只探一次', async () => {
    const { handlers, execs } = setup();
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(execs.filter((c) => c.includes('PROBE_OK=1'))).toHaveLength(1);
    // 截图命令是 `scrot -o -z '<path>'`；探测脚本里也出现 scrot 字样，所以按参数匹配
    expect(execs.filter((c) => c.includes('scrot -o')).length).toBe(2);
  });

  it('changed：同帧报 false、换了画面报 true（模型据此判断这一步有没有反应）', async () => {
    const { handlers, pngs } = setup();
    pngs.push(fakePng(800, 600, 1), fakePng(800, 600, 2), fakePng(800, 600, 2));
    const first = await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(first.changed).toBeUndefined(); // 没有上一帧可比时不说
    const second = await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(second.changed).toBe(true);
    const third = await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(third.changed).toBe(false);
  });

  it('输入动作：远端执行 xdotool，并自动回一张新画面（applied=true）', async () => {
    const { handlers, execs, guards } = setup();
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    const out = await handlers['computer.action']({
      action: 'click',
      coordinate: [100, 200],
      target: 'remote'
    });
    expect(guards.length).toBe(2); // 截图 + 点击都过档位判定（只读动作与输入动作各一次）
    expect(execs.some((c) => c.includes('xdotool mousemove 100 200 click'))).toBe(true);
    expect(out).toMatchObject({ ok: true, applied: true, remote: true, action: 'click' });
    expect(out.base64).toEqual(expect.any(String));
  });

  it('远端没有窗口枚举通道：list_windows 明确不支持', async () => {
    const { handlers } = setup();
    await expect(
      handlers['computer.action']({ action: 'list_windows', target: 'remote' })
    ).rejects.toMatchObject({ code: 'REMOTE_SCREEN_ACTION_UNSUPPORTED' });
  });

  it('region：先整屏建立坐标空间，再按那块区域裁（convert 在位时）', async () => {
    const probe = [
      'OS=Linux',
      'DISPLAY=:0',
      'HAS_import=1',
      'HAS_xdotool=1',
      'HAS_convert=1',
      'PROBE_OK=1'
    ].join('\n');
    const { handlers, execs } = setup({ probe });
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    await handlers['computer.action']({
      action: 'screenshot',
      region: [10, 20, 100, 50],
      target: 'remote'
    });
    expect(execs.some((c) => c.includes('-crop 100x50+10+20'))).toBe(true);
  });

  it('还没截过整屏就要 region → 明确要求先看整屏（不瞎猜坐标）', async () => {
    const probe = ['OS=Linux', 'DISPLAY=:0', 'HAS_import=1', 'HAS_xdotool=1', 'HAS_convert=1', 'PROBE_OK=1'].join('\n');
    const { handlers } = setup({ probe });
    await expect(
      handlers['computer.action']({ action: 'screenshot', region: [0, 0, 10, 10], target: 'remote' })
    ).rejects.toMatchObject({ code: 'REMOTE_SCREEN_REGION_NO_VIEW' });
  });

  it('没有 SSH 工作空间 → 说清该怎么做，不落到本机实现', async () => {
    const { handlers, localCalls } = setup({ target: null });
    await expect(
      handlers['computer.action']({ action: 'screenshot', target: 'remote' })
    ).rejects.toMatchObject({ code: 'REMOTE_SCREEN_REQUIRES_SSH' });
    expect(localCalls).toHaveLength(0);
  });

  it('探测脚本跑不通（非 POSIX shell 等）→ 带远端原始输出', async () => {
    const { handlers } = setup({ probe: "'uname' is not recognized as an internal command" });
    await expect(
      handlers['computer.action']({ action: 'screenshot', target: 'remote' })
    ).rejects.toMatchObject({ code: 'REMOTE_SCREEN_PROBE_FAILED' });
  });

  it('远端没有截图工具 → 告诉用户装什么', async () => {
    const { handlers } = setup({
      probe: ['OS=Linux', 'DISPLAY=:0', 'HAS_xdotool=1', 'PROBE_OK=1'].join('\n')
    });
    await expect(
      handlers['computer.action']({ action: 'screenshot', target: 'remote' })
    ).rejects.toMatchObject({
      code: 'REMOTE_SCREEN_CAPTURE_UNAVAILABLE',
      suggestedFix: expect.stringMatching(/scrot|imagemagick/)
    });
  });

  it('target 拼错 → INVALID_ARG（不默认成任何一台机器）', async () => {
    const { handlers } = setup();
    await expect(
      handlers['computer.action']({ action: 'screenshot', target: 'srver' })
    ).rejects.toMatchObject({ code: 'INVALID_ARG' });
  });

  it('macOS Retina：模型看到的是物理像素，注入按逻辑点换算', async () => {
    const probe = ['OS=Darwin', 'POINT_W=1440', 'HAS_cliclick=1', 'PROBE_OK=1'].join('\n');
    const { handlers, execs, pngs } = setup({ probe });
    // 2 倍屏：截图 2880 宽，逻辑点 1440
    pngs.push(fakePng(2880, 1800, 1), fakePng(2880, 1800, 1), fakePng(2880, 1800, 1));
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    await handlers['computer.action']({ action: 'click', coordinate: [200, 100], target: 'remote' });
    // 物理 200,100 → 逻辑点 100,50
    expect(execs.some((c) => c.includes('cliclick c:100,50'))).toBe(true);
  });

  it('缺省（不带 target）仍然是本机，远端一次都不碰', async () => {
    const { handlers, execs, localCalls } = setup();
    await handlers['computer.action']({ action: 'screenshot' });
    expect(localCalls).toHaveLength(1);
    expect(execs).toHaveLength(0);
  });

  it('只能截图（缺注入工具）不是致命：screenshot 照常可用，并把限制写进 note', async () => {
    const { handlers } = setup({
      probe: ['OS=Linux', 'SESSION=wayland', 'WAYLAND=wayland-0', 'HAS_grim=1', 'PROBE_OK=1'].join('\n')
    });
    const out = await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    expect(out.ok).toBe(true);
    expect(out.note).toContain('只能看');
    await expect(
      handlers['computer.action']({ action: 'click', coordinate: [1, 1], target: 'remote' })
    ).rejects.toMatchObject({ code: 'REMOTE_SCREEN_INPUT_UNAVAILABLE' });
  });

  it('region 之后动作回显仍是同一块区域（否则模型按 region 像素继续点会落错）', async () => {
    const probe = [
      'OS=Linux',
      'DISPLAY=:0',
      'HAS_import=1',
      'HAS_xdotool=1',
      'HAS_convert=1',
      'PROBE_OK=1'
    ].join('\n');
    const { handlers, execs, pngs } = setup({ probe });
    pngs.push(fakePng(1000, 800, 1), fakePng(100, 50, 2), fakePng(100, 50, 3));
    await handlers['computer.action']({ action: 'screenshot', target: 'remote' });
    const regionShot = await handlers['computer.action']({
      action: 'screenshot',
      region: [10, 20, 100, 50],
      target: 'remote'
    });
    expect(regionShot.width).toBe(100);
    const clicked = await handlers['computer.action']({
      action: 'click',
      coordinate: [5, 5],
      target: 'remote'
    });
    // 动作后的那张图仍是 region 尺寸（坐标空间没被重置成整屏）
    expect(clicked.width).toBe(100);
    expect(clicked.height).toBe(50);
    // 而且坐标落在 region 内 → 原生像素 = region 原点 + 相对坐标
    expect(execs.some((c) => c.includes('xdotool mousemove 15 25 click'))).toBe(true);
  });
});
