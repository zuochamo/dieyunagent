'use strict';

/**
 * 远端屏幕通道的命令层（`src/remote/ssh-screen.js`）：探测解析 + 三种注入工具的命令拼装。
 *
 * 这一层是最容易「看起来成功、其实什么都没按下去」的地方（错一个按钮号、错一个键名、
 * 错一个引号），所以逐条钉住：能力探测 → 命令，纯字符串、可离线回归。
 */

const {
  buildProbeScript,
  parseProbeOutput,
  describeProbe,
  buildCaptureCommand,
  buildInputCommand,
  pngSize,
  frameSignature
} = require('../../src/remote/ssh-screen');

const PROBE_LINUX_X11 = [
  'OS=Linux',
  'SESSION=x11',
  'DISPLAY=:0',
  'HAS_scrot=1',
  'HAS_import=1',
  'HAS_xdotool=1',
  'HAS_convert=1',
  'PROBE_OK=1'
].join('\n');

describe('buildProbeScript', () => {
  it('一个脚本问清 DISPLAY / Wayland / 工具，并给出成功标记', () => {
    const s = buildProbeScript();
    expect(s).toContain('uname -s');
    expect(s).toContain('/tmp/.X11-unix');
    expect(s).toContain('wayland-');
    expect(s).toContain('command -v');
    expect(s).toContain('PROBE_OK=1');
  });
});

describe('parseProbeOutput', () => {
  it('Linux X11：优先 ImageMagick import，注入用 xdotool', () => {
    const caps = parseProbeOutput(PROBE_LINUX_X11);
    expect(caps.os).toBe('Linux');
    expect(caps.session).toBe('x11');
    expect(caps.display).toBe(':0');
    expect(caps.capture).toBe('import');
    expect(caps.input).toBe('xdotool');
    expect(caps.convert).toBe(true);
    expect(describeProbe(caps)).toBeNull();
  });

  it('只有 scrot 时用 scrot；两者都没有 → 如实说缺工具', () => {
    const scrotOnly = parseProbeOutput(['OS=Linux', 'DISPLAY=:0', 'HAS_scrot=1', 'HAS_xdotool=1'].join('\n'));
    expect(scrotOnly.capture).toBe('scrot');
    const none = parseProbeOutput(['OS=Linux', 'DISPLAY=:0', 'HAS_xdotool=1'].join('\n'));
    expect(none.capture).toBeNull();
    const problem = describeProbe(none);
    expect(problem.code).toBe('REMOTE_SCREEN_CAPTURE_UNAVAILABLE');
    expect(problem.suggestedFix).toMatch(/scrot|imagemagick/);
  });

  it('Wayland：grim 截图，ydotool 只在装了的时候', () => {
    const caps = parseProbeOutput(
      ['OS=Linux', 'SESSION=wayland', 'WAYLAND=wayland-0', 'HAS_grim=1', 'HAS_ydotool=1'].join('\n')
    );
    expect(caps.capture).toBe('grim');
    expect(caps.input).toBe('ydotool');
    expect(caps.wayland).toBe('wayland-0');
  });

  it('macOS：screencapture 恒在，注入要 cliclick', () => {
    const withCliclick = parseProbeOutput(['OS=Darwin', 'HAS_cliclick=1'].join('\n'));
    expect(withCliclick.capture).toBe('screencapture');
    expect(withCliclick.input).toBe('cliclick');
    const without = parseProbeOutput(['OS=Darwin'].join('\n'));
    expect(without.input).toBeNull();
    expect(describeProbe(without).code).toBe('REMOTE_SCREEN_INPUT_UNAVAILABLE');
  });

  it('Windows 远端 → 明确不支持；OS 探测不到 → 报「探测不全」（别把两者混成一个）', () => {
    const win = parseProbeOutput(['OS=MINGW64_NT-10.0', 'PROBE_OK=1'].join('\n'));
    expect(win.capture).toBeNull();
    expect(describeProbe(win).code).toBe('REMOTE_SCREEN_OS_UNSUPPORTED');
    // OS 行缺失 ≠ Windows：可能是缺 uname / 不是 POSIX shell，诊断要分开
    const noOs = describeProbe(parseProbeOutput(['PROBE_OK=1'].join('\n')));
    expect(noOs.code).toBe('REMOTE_SCREEN_PROBE_INCOMPLETE');
    expect(noOs.fatal).toBe(true);
  });

  it('Wayland 有 DISPLAY（XWayland）时仍优先 grim，且不把 xdotool 当注入手段', () => {
    const caps = parseProbeOutput(
      ['OS=Linux', 'SESSION=wayland', 'DISPLAY=:0', 'WAYLAND=wayland-0', 'HAS_grim=1', 'HAS_xdotool=1'].join('\n')
    );
    // XWayland 下 import 只能截到 X 窗口（原生窗口全黑），所以 grim 优先
    expect(caps.capture).toBe('grim');
    // xdotool 只覆盖 XWayland 应用，拿它注入会「命令成功、界面没动」→ 如实说只能看图
    expect(caps.input).toBeNull();
    expect(describeProbe(caps).code).toBe('REMOTE_SCREEN_INPUT_UNAVAILABLE');
  });

  it('Linux 但没有任何图形会话 → 说清「这台是纯命令行」', () => {
    const caps = parseProbeOutput(['OS=Linux', 'HAS_xdotool=1'].join('\n'));
    expect(describeProbe(caps).code).toBe('REMOTE_SCREEN_NO_DISPLAY');
  });
});

describe('buildCaptureCommand', () => {
  const caps = parseProbeOutput(PROBE_LINUX_X11);

  it('整屏：import 走 DISPLAY，写到远端临时文件（不占 stdout）', () => {
    const out = buildCaptureCommand(caps, '/home/me/.dieyun-screen.png', null);
    expect(out.cmd).toBe(`DISPLAY=:0 import -window root -silent '/home/me/.dieyun-screen.png'`);
  });

  it('region：先截整屏再 convert 裁剪，然后删中间文件', () => {
    const out = buildCaptureCommand(caps, '/home/me/s.png', { x: 10, y: 20, width: 300, height: 200 });
    expect(out.cmd).toContain('import -window root');
    expect(out.cmd).toContain('-crop 300x200+10+20');
    expect(out.cmd).toContain("rm -f '/home/me/s.png.raw.png'");
  });

  it('grim 的原生 -g 裁区域：不需要 ImageMagick，也不多截一张整屏', () => {
    const wl = parseProbeOutput(
      ['OS=Linux', 'SESSION=wayland', 'WAYLAND=wayland-0', 'HAS_grim=1', 'HAS_ydotool=1'].join('\n')
    );
    const out = buildCaptureCommand(wl, '/tmp/s.png', { x: 5, y: 6, width: 70, height: 80 });
    expect(out.error).toBeUndefined();
    expect(out.cmd).toContain('grim -g "5,6 70x80"');
    expect(out.cmd).not.toContain('convert');
    expect(out.cmd).toContain("'/tmp/s.png'");
  });

  it('region 但没有 ImageMagick（import/scrot）→ 明确拒绝（不偷偷给整屏）', () => {
    const noConvert = parseProbeOutput(['OS=Linux', 'DISPLAY=:0', 'HAS_scrot=1', 'HAS_xdotool=1'].join('\n'));
    const out = buildCaptureCommand(noConvert, '/tmp/s.png', { x: 0, y: 0, width: 10, height: 10 });
    expect(out.code).toBe('REMOTE_SCREEN_REGION_UNSUPPORTED');
    expect(out.suggestedFix).toMatch(/imagemagick/);
  });

  it('macOS 用 screencapture，不拼 DISPLAY', () => {
    const mac = parseProbeOutput(['OS=Darwin', 'HAS_cliclick=1'].join('\n'));
    const out = buildCaptureCommand(mac, '/tmp/s.png', null);
    expect(out.cmd).toBe("screencapture -x '/tmp/s.png'");
  });

  it('macOS region 用原生 -R（没有 ImageMagick 也能裁）', () => {
    const mac = parseProbeOutput(['OS=Darwin', 'HAS_cliclick=1'].join('\n'));
    const out = buildCaptureCommand(mac, '/tmp/s.png', { x: 1, y: 2, width: 30, height: 40 });
    expect(out.cmd).toBe("screencapture -x -R 1,2,30,40 '/tmp/s.png'");
  });

  it('Wayland 的 grim 带 WAYLAND_DISPLAY', () => {
    const wl = parseProbeOutput(['OS=Linux', 'SESSION=wayland', 'WAYLAND=wayland-1', 'HAS_grim=1', 'HAS_ydotool=1'].join('\n'));
    const out = buildCaptureCommand(wl, '/tmp/s.png', null);
    expect(out.cmd).toContain('WAYLAND_DISPLAY=wayland-1 grim');
  });

  it('没有截图工具 → 带安装指引的错误', () => {
    const none = parseProbeOutput(['OS=Linux', 'DISPLAY=:0'].join('\n'));
    const out = buildCaptureCommand(none, '/tmp/s.png', null);
    expect(out.code).toBe('REMOTE_SCREEN_CAPTURE_UNAVAILABLE');
  });
});

describe('buildInputCommand（xdotool）', () => {
  const caps = parseProbeOutput(PROBE_LINUX_X11);

  it('move / click（含重复次数与修饰键）/ double_click', () => {
    expect(buildInputCommand(caps, 'move', { coordinate: [10, 20] }).cmd).toBe(
      'DISPLAY=:0 xdotool mousemove 10 20'
    );
    expect(
      buildInputCommand(caps, 'click', { coordinate: [5, 6], modifiers: ['shift'] }).cmd
    ).toBe('DISPLAY=:0 xdotool keydown shift mousemove 5 6 click --repeat 1 1 keyup shift');
    expect(buildInputCommand(caps, 'double_click', { coordinate: [1, 2] }).cmd).toContain(
      'click --repeat 2 1'
    );
    expect(buildInputCommand(caps, 'right_click', {}).cmd).toContain('click --repeat 1 3');
    expect(buildInputCommand(caps, 'middle_click', {}).cmd).toContain('click --repeat 1 2');
  });

  it('drag：按下 → 移动 → 抬起，修饰键包在外面', () => {
    const out = buildInputCommand(caps, 'drag', { coordinate: [1, 2], to: [30, 40], modifiers: ['ctrl'] });
    expect(out.cmd).toBe(
      'DISPLAY=:0 xdotool keydown ctrl mousemove 1 2 mousedown 1 mousemove 30 40 mouseup 1 keyup ctrl'
    );
  });

  it('scroll：up=按钮 4 / down=按钮 5，格数落进命令', () => {
    expect(buildInputCommand(caps, 'scroll', { coordinate: [3, 4], amount: 2 }).cmd).toContain(
      'mousemove 3 4 click --repeat 2 5'
    );
    expect(buildInputCommand(caps, 'scroll', { direction: 'up', amount: 1 }).cmd).toContain(
      'click --repeat 1 4'
    );
  });

  it('type：文本里的引号/美元符不会被 shell 吃掉', () => {
    const out = buildInputCommand(caps, 'type', { text: `it's $HOME \`x\`` });
    // 单引号包裹：内部单引号按 `'\''` 闭合-转义；$ 与反引号在单引号里没有语义
    expect(out.cmd).toBe("DISPLAY=:0 xdotool type --delay 12 -- 'it'\\''s $HOME `x`'");
  });

  it('key：常用别名翻成 xdotool 的键名', () => {
    expect(buildInputCommand(caps, 'key', { key: 'ctrl+c' }).cmd).toBe('DISPLAY=:0 xdotool key -- ctrl+c');
    expect(buildInputCommand(caps, 'key', { key: 'enter' }).cmd).toBe('DISPLAY=:0 xdotool key -- Return');
    expect(buildInputCommand(caps, 'key', { key: 'win+e' }).cmd).toBe('DISPLAY=:0 xdotool key -- super+e');
  });

  it('缺参数与不支持的动作都要明说，不拼半截命令', () => {
    expect(buildInputCommand(caps, 'move', {}).code).toBe('MISSING_ARG');
    expect(buildInputCommand(caps, 'type', { text: '' }).code).toBe('MISSING_ARG');
    expect(buildInputCommand(caps, 'drag', { coordinate: [1, 2] }).code).toBe('MISSING_ARG');
    const win = buildInputCommand(caps, 'list_windows', {});
    expect(win.code).toBe('REMOTE_SCREEN_ACTION_UNSUPPORTED');
    expect(win.suggestedFix).toContain('不要原样重试');
  });

  it('坐标走 viewPointToNative 映射（模型看到的是缩小图时也能点对）', () => {
    const out = buildInputCommand(
      caps,
      'move',
      { coordinate: [100, 50] },
      { viewPointToNative: (c) => ({ x: c[0] * 2, y: c[1] * 2 }) }
    );
    expect(out.cmd).toContain('mousemove 200 100');
  });
});

describe('buildInputCommand（Wayland / macOS）', () => {
  it('ydotool：move / click / type 支持，key 与 scroll 如实不支持', () => {
    const wl = parseProbeOutput(['OS=Linux', 'SESSION=wayland', 'WAYLAND=wayland-0', 'HAS_grim=1', 'HAS_ydotool=1'].join('\n'));
    expect(buildInputCommand(wl, 'move', { coordinate: [7, 8] }).cmd).toBe('ydotool mousemove -a 7 8');
    expect(buildInputCommand(wl, 'click', { coordinate: [1, 1] }).cmd).toContain('ydotool click 0xC0');
    expect(buildInputCommand(wl, 'right_click', {}).cmd).toContain('ydotool click 0xC1');
    expect(buildInputCommand(wl, 'type', { text: 'hi' }).cmd).toBe("ydotool type -- 'hi'");
    expect(buildInputCommand(wl, 'key', { key: 'ctrl+c' }).code).toBe('REMOTE_SCREEN_ACTION_UNSUPPORTED');
    expect(buildInputCommand(wl, 'scroll', {}).code).toBe('REMOTE_SCREEN_ACTION_UNSUPPORTED');
  });

  it('cliclick：move / click / drag / type / key 组合键', () => {
    const mac = parseProbeOutput(['OS=Darwin', 'HAS_cliclick=1'].join('\n'));
    expect(buildInputCommand(mac, 'move', { coordinate: [3, 4] }).cmd).toBe('cliclick m:3,4');
    expect(buildInputCommand(mac, 'click', { coordinate: [3, 4] }).cmd).toBe('cliclick c:3,4');
    expect(buildInputCommand(mac, 'double_click', { coordinate: [3, 4] }).cmd).toBe(
      'cliclick c:3,4 c:3,4'
    );
    expect(buildInputCommand(mac, 'right_click', { coordinate: [3, 4] }).cmd).toBe('cliclick rc:3,4');
    expect(buildInputCommand(mac, 'drag', { coordinate: [1, 1], to: [9, 9] }).cmd).toBe(
      'cliclick m:1,1 dd:1,1 dm:9,9 du:9,9'
    );
    expect(buildInputCommand(mac, 'type', { text: 'hi' }).cmd).toBe("cliclick 't:hi'");
    // cliclick 自己按空白切命令：文本里的空格必须转义，否则后半段被当成第二条命令
    expect(buildInputCommand(mac, 'type', { text: 'a b' }).cmd).toBe("cliclick 't:a\\ b'");
    expect(buildInputCommand(mac, 'key', { key: 'ctrl+c' }).cmd).toBe('cliclick kd:ctrl kp:c ku:ctrl');
    expect(buildInputCommand(mac, 'middle_click', {}).code).toBe('REMOTE_SCREEN_ACTION_UNSUPPORTED');
  });
});

describe('pngSize / frameSignature', () => {
  function fakePng(width, height) {
    const buf = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  it('从 IHDR 读尺寸；不是 PNG 返回 null', () => {
    expect(pngSize(fakePng(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(pngSize(Buffer.from('not a png at all, but long enough...'))).toBeNull();
    expect(pngSize(Buffer.alloc(4))).toBeNull();
  });

  it('同图同指纹、异图异指纹（判断「有没有可见反应」）', () => {
    const a = frameSignature('AAA');
    expect(a).toBe(frameSignature('AAA'));
    expect(a).not.toBe(frameSignature('BBB'));
    expect(frameSignature('')).toBeNull();
  });
});
