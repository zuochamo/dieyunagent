'use strict';

/**
 * 远端主机的屏幕通道：截图 + 键鼠注入，走 SSH（`ssh.exec`）＋ 远端文件（`remoteFs.readFile`）。
 *
 * 为什么需要：`computer` 只能看跑叠云这台机器的屏幕，于是「帮我看一眼服务器上那个弹窗」
 * 这类事根本没有入口 —— 与「工作空间在远端时碰不到本机」正好是同一枚硬币的另一面。
 *
 * 三条硬口径（改前必读）：
 * 1. **能力靠探测，不靠猜**：远端有没有图形会话、装没装 scrot/grim/xdotool 都先问一遍，
 *    探到什么就只承诺什么；探不到就如实报「缺哪个工具、怎么装」，不假装在等。
 * 2. **像素不走 stdout**：`ssh.exec` 的输出上限是 512KB（exec-limits 的唯一来源），
 *    一张 1080p PNG 的 base64 就 2~3MB —— 截图只落远端临时文件，再用现成的远端文件通道
 *    （SFTP/RPC，`remoteFs.readFile`）取回来。不另造传输。
 * 3. **坐标空间 = 模型最近看到的那张图**：截图可能被本地按视觉预算缩小，注入前必须按同一份
 *    映射换算回远端原生像素（换算用 `computer/coordinate-map.js`，不另写一套比例）。
 *
 * 支持面（有就支持、没有就明说）：
 * - Linux X11：scrot / ImageMagick import / grim（Wayland）+ xdotool 全动作；
 * - Linux Wayland：grim 截图；有 ydotool 时支持移动/点击/输入，其余动作如实不支持；
 * - macOS：screencapture 截图；有 cliclick 时支持移动/点击/拖拽/输入/按键；
 *   需要在「系统设置 → 隐私与安全」里给 ssd（SSH 会话）授予「屏幕录制」与「辅助功能」；
 * - Windows 远端：暂未接入（键鼠注入需要另一套原生调用），明确回 `REMOTE_SCREEN_OS_UNSUPPORTED`。
 */

const crypto = require('crypto');

const { shellQuoteSingle } = require('../ssh/remote-path');
// 远端临时目录的唯一来源（与远端传输允许根同一份）：截图中间产物只落这里
const { REMOTE_SHARED_TMP_ROOT } = require('../gateway/path-policy');

/** 远端临时截图所在目录（传输允许根之一，不往 $HOME / 工作区丢隐藏文件）。 */
const REMOTE_TMP_ROOT = REMOTE_SHARED_TMP_ROOT;

/** 远端临时截图（固定一个名字：computer 动作本来就被串行化，不会互相踩）。 */
const REMOTE_SHOT_NAME = '.dieyun-screen.png';

/** 远端命令的超时：截图/注入都是毫秒级，给足 30s 只为覆盖慢机器。 */
const REMOTE_SCREEN_TIMEOUT_MS = 30000;

const XDOTOOL_KEYS = Object.freeze({
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  win: 'super',
  cmd: 'super',
  command: 'super',
  super: 'super',
  meta: 'super',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
});

const CLICLICK_KEYS = Object.freeze({
  enter: 'return',
  return: 'return',
  esc: 'esc',
  escape: 'esc',
  tab: 'tab',
  space: 'space',
  backspace: 'delete',
  delete: 'fwd-delete',
  up: 'arrow-up',
  down: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
  home: 'home',
  end: 'end',
  pageup: 'page-up',
  pagedown: 'page-down',
  win: 'cmd',
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
});

/** 一次往返问清「远端能不能看屏幕」：OS / 会话类型 / DISPLAY / 有哪些工具。 */
function buildProbeScript() {
  return [
    'echo "OS=$(uname -s 2>/dev/null)"',
    'echo "SESSION=${XDG_SESSION_TYPE:-}"',
    // SSH 会话通常不带 DISPLAY：先从 X socket 反推，再回落到常见值
    'if [ -n "$DISPLAY" ]; then echo "DISPLAY=$DISPLAY"; ' +
      'else for f in /tmp/.X11-unix/X*; do [ -e "$f" ] && echo "DISPLAY=:${f##*/X}" && break; done; fi',
    'if [ -n "$WAYLAND_DISPLAY" ]; then echo "WAYLAND=$WAYLAND_DISPLAY"; ' +
      'else for f in /run/user/*/wayland-*; do [ -e "$f" ] && echo "WAYLAND=${f##*/}" && break; done; fi',
    // macOS：逻辑点宽度（Retina 上截图是物理像素的 2 倍，注入坐标吃的是逻辑点）
    'echo "POINT_W=$(osascript -e \'tell application "Finder" to get bounds of window of desktop\' 2>/dev/null ' +
      '| awk -F", " \'{print $3}\')"',
    'for t in scrot import grim ffmpeg xdotool ydotool cliclick convert; do ' +
      'command -v "$t" >/dev/null 2>&1 && echo "HAS_$t=1"; done',
    'echo "PROBE_OK=1"'
  ].join('\n');
}

/**
 * @param {string} stdout 探测脚本输出
 * @returns {{ os: string, session: string, display: string, wayland: string,
 *   tools: Set<string>, capture: string|null, input: string|null, convert: boolean }}
 */
function parseProbeOutput(stdout) {
  const out = {
    os: '',
    session: '',
    display: '',
    wayland: '',
    tools: new Set(),
    capture: null,
    input: null,
    convert: false,
    /** macOS 逻辑点宽度（Retina 上截图是它的 2 倍；0 = 不知道，按 1 处理） */
    pointWidth: 0
  };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'OS') out.os = value.trim();
    else if (key === 'SESSION') out.session = value.trim().toLowerCase();
    else if (key === 'DISPLAY') out.display = value.trim();
    else if (key === 'WAYLAND') out.wayland = value.trim();
    else if (key === 'POINT_W') out.pointWidth = Math.max(0, Math.round(Number(value) || 0));
    else if (key.startsWith('HAS_')) out.tools.add(key.slice(4).toLowerCase());
  }
  out.convert = out.tools.has('convert');
  const isMac = out.os === 'Darwin';
  const isWin = /^MINGW|^MSYS|^CYGWIN/i.test(out.os) || out.os === '';
  // Wayland 优先于「有 DISPLAY」：装了 XWayland 的桌面也会导出 DISPLAY，
  // 而 `import -window root` 在 XWayland 下只能截到 X 窗口（原生窗口一片黑）。
  const wayland = out.session === 'wayland' || !!out.wayland;
  if (isWin) {
    out.capture = null;
    out.input = null;
  } else if (isMac) {
    out.capture = 'screencapture';
    out.input = out.tools.has('cliclick') ? 'cliclick' : null;
  } else if (wayland) {
    out.capture = out.tools.has('grim')
      ? 'grim'
      : out.tools.has('import')
        ? 'import'
        : out.tools.has('scrot')
          ? 'scrot'
          : null;
    // Wayland 上只有 ydotool 真的能往原生窗口注入；xdotool 只覆盖 XWayland 应用，
    // 拿它当注入手段会「命令成功、界面没动」—— 宁可如实说只能看图。
    out.input = out.tools.has('ydotool') ? 'ydotool' : null;
  } else {
    out.capture = out.tools.has('import')
      ? 'import'
      : out.tools.has('scrot')
        ? 'scrot'
        : out.tools.has('grim')
          ? 'grim'
          : null;
    out.input = out.tools.has('xdotool') ? 'xdotool' : null;
  }
  return out;
}

/**
 * 探测结果 → 一句人话（失败时给模型/用户看，必须能照着装）。
 *
 * `fatal` 区分两件事：**看不了**（截图能力缺失 → 整个工具都没法用）与
 * **动不了**（只能截图 → 看图照旧可用，只有输入动作该失败）。把后者也当致命，
 * 会让装了 grim 但没装 ydotool 的 Wayland 桌面连「看一眼」都做不到。
 *
 * @returns {{ code: string, message: string, suggestedFix: string, fatal: boolean } | null}
 */
function describeProbe(caps) {
  const rawOs = String(caps.os || '');
  const os = rawOs || '未知系统';
  if (!caps.capture) {
    if (rawOs === '') {
      return {
        code: 'REMOTE_SCREEN_PROBE_INCOMPLETE',
        message: `远端屏幕探测没拿到系统信息（OS 为空）：可能缺 uname，或远端不是 POSIX shell`,
        suggestedFix:
          '确认远端能跑 `uname -s`；Windows 远端暂未接入（用 VNC/RDP 或 target=local）。不要原样重试。',
        fatal: true
      };
    }
    if (/^MINGW|^MSYS|^CYGWIN/.test(rawOs)) {
      return {
        code: 'REMOTE_SCREEN_OS_UNSUPPORTED',
        message: `远端是 Windows（${os}）：屏幕通道暂未接入`,
        suggestedFix:
          '远端 Windows 的键鼠注入还没接。要操作那台机器请用 VNC/RDP；要看本机屏幕用 target=local（默认）。',
        fatal: true
      };
    }
    if (os === 'Linux' && !caps.display && !caps.wayland) {
      return {
        code: 'REMOTE_SCREEN_NO_DISPLAY',
        message: '远端主机没有图形会话（找不到 X/Wayland 显示）',
        suggestedFix:
          '这台机器是纯命令行服务器，没有桌面可看。请在它上面启动桌面会话（或改用 VNC/RDP）；命令行操作照旧用 host_exec。',
        fatal: true
      };
    }
    return {
      code: 'REMOTE_SCREEN_CAPTURE_UNAVAILABLE',
      message: `远端没有可用的截图工具（OS=${os}，DISPLAY=${caps.display || '-'}）`,
      suggestedFix:
        'Linux X11 装 scrot 或 imagemagick（`sudo apt install scrot` / `sudo apt install imagemagick`），Wayland 装 grim；macOS 需要在「系统设置 → 隐私与安全 → 屏幕录制」里给 sshd/终端授权。装好后重新调用即可。',
      fatal: true
    };
  }
  if (!caps.input) {
    return {
      code: 'REMOTE_SCREEN_INPUT_UNAVAILABLE',
      message: '远端只能截图，没有可用的键鼠注入工具（只能看，不能动）',
      suggestedFix:
        'Linux X11 装 xdotool（`sudo apt install xdotool`），Wayland 装 ydotool，macOS 装 cliclick（brew install cliclick）并授权「辅助功能」。现在仍可用 target=remote + action=screenshot 看画面。',
      fatal: false
    };
  }
  return null;
}

/**
 * 截图命令（写到远端临时文件，不占 stdout）。
 * @param {{ capture: string, display: string, convert: boolean }} caps
 * @param {string} outPath 远端绝对路径
 * @param {{ x:number, y:number, width:number, height:number }|null} [region] 原生像素矩形
 * @returns {{ cmd: string } | { error: string, code: string, suggestedFix?: string }}
 */
function buildCaptureCommand(caps, outPath, region) {
  const out = shellQuoteSingle(outPath);
  const tmp = shellQuoteSingle(`${outPath}.raw.png`);
  if (!caps || !caps.capture) {
    return {
      error: '远端没有可用的截图工具',
      code: 'REMOTE_SCREEN_CAPTURE_UNAVAILABLE',
      suggestedFix: '装 scrot / imagemagick（X11）或 grim（Wayland）后重试。'
    };
  }
  const needsRegion = !!(region && region.width > 0 && region.height > 0);
  // 有的截图工具原生支持区域，不需要 ImageMagick：
  // macOS 的 screencapture 用 -R，Wayland 的 grim 用 -g（否则装了 grim 没装 convert 的用户会被误拒）
  const nativeRegion = caps.capture === 'screencapture' || caps.capture === 'grim';
  if (needsRegion && !caps.convert && !nativeRegion) {
    return {
      error: '远端不支持指定区域截图（缺 ImageMagick 的 convert）',
      code: 'REMOTE_SCREEN_REGION_UNSUPPORTED',
      suggestedFix: '装 imagemagick（`sudo apt install imagemagick`）后可用 region；或直接截整屏（不传 region）。'
    };
  }
  // 原生支持区域的就直接写目标文件；其余先截整屏到临时文件再 convert 裁。
  const target = needsRegion && !nativeRegion ? tmp : out;
  const prefix = caps.display && caps.capture !== 'screencapture' ? `DISPLAY=${caps.display} ` : '';
  const grimGeom = needsRegion ? `-g "${region.x},${region.y} ${region.width}x${region.height}" ` : '';
  let capture;
  if (caps.capture === 'import') capture = `${prefix}import -window root -silent ${target}`;
  else if (caps.capture === 'scrot') capture = `${prefix}scrot -o ${target}`;
  else if (caps.capture === 'grim') {
    // Grim 只认 Wayland；region 用 -g "x,y WxH"
    capture = caps.wayland ? `WAYLAND_DISPLAY=${caps.wayland} grim ${grimGeom}${target}` : `grim ${grimGeom}${target}`;
  } else if (caps.capture === 'screencapture') {
    // macOS 自带 `-R x,y,w,h`：不依赖 ImageMagick 也能裁区域
    capture = needsRegion
      ? `screencapture -x -R ${region.x},${region.y},${region.width},${region.height} ${out}`
      : `screencapture -x ${target}`;
  } else capture = `screencapture -x ${target}`;
  if (!needsRegion || nativeRegion) return { cmd: capture };
  return {
    // 收尾用 `;` 而不是 `&&`：convert 失败时中间那个 .raw.png 也要清掉，否则远端会慢慢堆垃圾
    cmd: `${capture} && ${prefix}convert ${tmp} -crop ${region.width}x${region.height}+${region.x}+${region.y} +repage ${out}; rm -f ${tmp}`
  };
}

function xdotoolKeys(spec) {
  const parts = String(spec || '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => XDOTOOL_KEYS[p.toLowerCase()] || p);
}

/**
 * 组合键要**保留 `+` 语义**：`xdotool key ctrl+c` 是「按住 ctrl 敲 c」，
 * 而 `xdotool key ctrl c` 是「先按 ctrl、再按 c」—— 后者在编辑器里等于什么都没做。
 */
function xdotoolCombo(spec) {
  const keys = xdotoolKeys(spec);
  return keys.length ? keys.join('+') : '';
}

function clickButton(action, button) {
  const name = String(button || '').toLowerCase();
  if (action === 'right_click' || name === 'right') return 3;
  if (action === 'middle_click' || name === 'middle') return 2;
  return 1;
}

function modifierNames(caps, mods) {
  const list = (Array.isArray(mods) ? mods : []).map((m) => String(m).toLowerCase()).filter(Boolean);
  if (caps.input === 'cliclick') {
    return list.map((m) => CLICLICK_KEYS[m] || m).filter(Boolean);
  }
  return list.map((m) => XDOTOOL_KEYS[m] || m).filter(Boolean);
}

/**
 * 键鼠注入命令。
 * @param {ReturnType<typeof parseProbeOutput>} caps
 * @param {string} action
 * @param {object} params `{ coordinate, to, button, text, key, direction, amount, clickCount }`
 * @param {{ viewPointToNative?: (p:number[])=>[number,number] }} [opts] 视图坐标 → 远端原生像素
 * @returns {{ cmd: string } | { error: string, code: string, suggestedFix?: string }}
 */
function buildInputCommand(caps, action, params = {}, opts = {}) {
  const toNative = typeof opts.viewPointToNative === 'function' ? opts.viewPointToNative : null;
  const pt = (c) => {
    if (!Array.isArray(c) || c.length < 2) return null;
    if (!toNative) return [Math.round(Number(c[0])), Math.round(Number(c[1]))];
    const mapped = toNative(c);
    return [Math.round(mapped.x), Math.round(mapped.y)];
  };
  if (!caps || !caps.input) {
    return {
      error: '远端没有可用的键鼠注入工具（只能截图）',
      code: 'REMOTE_SCREEN_INPUT_UNAVAILABLE',
      suggestedFix: '装 xdotool（X11）/ ydotool（Wayland）/ cliclick（macOS）后重试；现在仍可用 action=screenshot 看画面。'
    };
  }
  const unsupported = (what) => ({
    error: `远端屏幕通道暂不支持「${what}」（当前注入工具：${caps.input}）`,
    code: 'REMOTE_SCREEN_ACTION_UNSUPPORTED',
    suggestedFix: '改用 action=screenshot 看画面后手动告知用户，或在本机用 target=local；不要原样重试同一动作。'
  });
  const prefix = caps.display && caps.input === 'xdotool' ? `DISPLAY=${caps.display} ` : '';
  const mods = modifierNames(caps, params.modifiers);

  if (caps.input === 'xdotool') {
    if (action === 'move') {
      const p = pt(params.coordinate);
      if (!p) return { error: 'move 需要 coordinate', code: 'MISSING_ARG' };
      return { cmd: `${prefix}xdotool mousemove ${p[0]} ${p[1]}` };
    }
    if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'middle_click') {
      const btn = clickButton(action, params.button);
      const times = action === 'double_click' ? 2 : Math.max(1, Number(params.clickCount) || 1);
      const p = pt(params.coordinate);
      const chain = [];
      if (mods.length) chain.push('keydown', mods.join(' '));
      if (p) chain.push('mousemove', String(p[0]), String(p[1]));
      chain.push('click', '--repeat', String(times), String(btn));
      if (mods.length) chain.push('keyup', [...mods].reverse().join(' '));
      return { cmd: `${prefix}xdotool ${chain.join(' ')}` };
    }
    if (action === 'drag') {
      const from = pt(params.coordinate);
      const to = pt(params.to);
      if (!from || !to) return { error: 'drag 需要 coordinate 与 to', code: 'MISSING_ARG' };
      const btn = clickButton('click', params.button);
      const chain = [];
      if (mods.length) chain.push('keydown', mods.join(' '));
      chain.push('mousemove', String(from[0]), String(from[1]), 'mousedown', String(btn));
      chain.push('mousemove', String(to[0]), String(to[1]), 'mouseup', String(btn));
      if (mods.length) chain.push('keyup', [...mods].reverse().join(' '));
      return { cmd: `${prefix}xdotool ${chain.join(' ')}` };
    }
    if (action === 'scroll') {
      const notches = Math.max(1, Math.min(10, Number(params.amount) || 3));
      const button = String(params.direction || 'down').toLowerCase() === 'up' ? 4 : 5;
      const p = pt(params.coordinate);
      const chain = [];
      if (p) chain.push('mousemove', String(p[0]), String(p[1]));
      chain.push('click', '--repeat', String(notches), String(button));
      return { cmd: `${prefix}xdotool ${chain.join(' ')}` };
    }
    if (action === 'type') {
      const text = String(params.text == null ? '' : params.text);
      if (!text) return { error: 'type 需要 text', code: 'MISSING_ARG' };
      // `--` 之后是字面量：文本里的 - 开头不会被当成选项
      return { cmd: `${prefix}xdotool type --delay 12 -- ${shellQuoteSingle(text)}` };
    }
    if (action === 'key') {
      const combo = xdotoolCombo(params.key);
      if (!combo) return { error: 'key 需要 key', code: 'MISSING_ARG' };
      return { cmd: `${prefix}xdotool key -- ${combo}` };
    }
    return unsupported(action);
  }

  if (caps.input === 'ydotool') {
    if (action === 'move') {
      const p = pt(params.coordinate);
      if (!p) return { error: 'move 需要 coordinate', code: 'MISSING_ARG' };
      return { cmd: `ydotool mousemove -a ${p[0]} ${p[1]}` };
    }
    if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'middle_click') {
      const btn = clickButton(action, params.button);
      const code = btn === 3 ? '0xC1' : btn === 2 ? '0xC2' : '0xC0';
      const times = action === 'double_click' ? 2 : Math.max(1, Number(params.clickCount) || 1);
      const p = pt(params.coordinate);
      const move = p ? `ydotool mousemove -a ${p[0]} ${p[1]} && ` : '';
      return { cmd: `${move}for i in $(seq ${times}); do ydotool click ${code}; done` };
    }
    if (action === 'type') {
      const text = String(params.text == null ? '' : params.text);
      if (!text) return { error: 'type 需要 text', code: 'MISSING_ARG' };
      // `--` 之后是字面量：以 `-` 开头的文本不会被 ydotool 当成选项
      return { cmd: `ydotool type -- ${shellQuoteSingle(text)}` };
    }
    return unsupported(action);
  }

  if (caps.input === 'cliclick') {
    const at = (p) => `${p[0]},${p[1]}`;
    if (action === 'move') {
      const p = pt(params.coordinate);
      if (!p) return { error: 'move 需要 coordinate', code: 'MISSING_ARG' };
      return { cmd: `cliclick m:${at(p)}` };
    }
    if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'middle_click') {
      if (action === 'middle_click') return unsupported('中键点击');
      const btn = clickButton(action, params.button);
      const times = action === 'double_click' ? 2 : Math.max(1, Number(params.clickCount) || 1);
      const p = pt(params.coordinate);
      const verb = btn === 3 ? 'rc:' : 'c:';
      const all = p ? Array.from({ length: times }, () => `${verb}${at(p)}`).join(' ') : `${verb}.`;
      const hold = mods.length ? [...mods.map((m) => `kd:${m}`), all, ...mods.map((m) => `ku:${m}`)].join(' ') : all;
      return { cmd: `cliclick ${hold}` };
    }
    if (action === 'drag') {
      const from = pt(params.coordinate);
      const to = pt(params.to);
      if (!from || !to) return { error: 'drag 需要 coordinate 与 to', code: 'MISSING_ARG' };
      const hold = mods.length ? [...mods.map((m) => `kd:${m}`)] : [];
      const steps = [`m:${at(from)}`, `dd:${at(from)}`, `dm:${at(to)}`, `du:${at(to)}`];
      if (mods.length) steps.push(...mods.map((m) => `ku:${m}`));
      return { cmd: `cliclick ${[...hold, ...steps].join(' ')}` };
    }
    if (action === 'type') {
      const text = String(params.text == null ? '' : params.text);
      if (!text) return { error: 'type 需要 text', code: 'MISSING_ARG' };
      // cliclick 自己按空白切命令：文本里的空格/反斜杠必须转义，否则后半段会被当成第二条命令
      const escaped = text.replace(/([\\\s])/g, '\\$1');
      return { cmd: `cliclick ${shellQuoteSingle(`t:${escaped}`)}` };
    }
    if (action === 'key') {
      const parts = String(params.key || '')
        .split('+')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length) return { error: 'key 需要 key', code: 'MISSING_ARG' };
      const named = parts.map((p) => CLICLICK_KEYS[p.toLowerCase()] || p);
      const last = named[named.length - 1];
      const held = named.slice(0, -1);
      const seq = [...held.map((m) => `kd:${m}`), `kp:${last}`, ...[...held].reverse().map((m) => `ku:${m}`)];
      return { cmd: `cliclick ${seq.join(' ')}` };
    }
    return unsupported(action);
  }

  return unsupported(action);
}

/** PNG 尺寸（IHDR）：远端取回后不靠额外命令，也不必信 tool 输出。 */
function pngSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 24) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/** 帧指纹：判断「这一下有没有可见反应」用（同屏同内容 = 同 hash）。 */
function frameSignature(base64) {
  const s = String(base64 || '');
  if (!s) return null;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

module.exports = {
  REMOTE_SHOT_NAME,
  REMOTE_TMP_ROOT,
  REMOTE_SCREEN_TIMEOUT_MS,
  buildProbeScript,
  parseProbeOutput,
  describeProbe,
  buildCaptureCommand,
  buildInputCommand,
  pngSize,
  frameSignature
};
