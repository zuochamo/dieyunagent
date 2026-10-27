'use strict';

/**
 * Windows 输入注入（koffi + user32）。
 *
 * 为什么是 koffi：N-API 预编译，Electron 大版本升级不需要走 install-app-deps
 * 重建链（better-sqlite3 那条 nan override 路线的坑不再重演）。
 *
 * 移动与点击分离是刻意的：
 * - 定位统一走 SendInput 绝对移动（MOUSEEVENTF_ABSOLUTE|VIRTUALDESK）——
 *   相对移动会被系统「提高指针精确度」加速扭曲，绝对移动不受影响；
 * - 点击 / 滚轮 / 键盘走 SendInput 事件，作用在当前光标位置。
 * 坐标口径见 coordinate-map.js：这里收发的都是「全局物理像素」。
 *
 * 本模块可在非 Windows 平台安全 require（koffi 惰性加载），调用输入函数才报不支持。
 * 已知边界：UIPI —— 非提权进程无法注入管理员权限窗口（表现为事件被静默丢弃）。
 */

const WIN32 = process.platform === 'win32';

// —— winuser.h 常量 ——
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const WHEEL_DELTA = 120;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** 修饰键按VK 码；按下顺序 win→ctrl→alt→shift，释放反序（组合键惯例）。 */
const MODIFIER_KEYS = {
  win: { vk: 0x5b },
  ctrl: { vk: 0x11 },
  alt: { vk: 0x12 },
  shift: { vk: 0x10 }
};

/** 主键映射：命名 → VK 码（extended=true 需要 KEYEVENTF_EXTENDEDKEY）。 */
const KEY_BY_NAME = (() => {
  const m = Object.create(null);
  for (let i = 0; i < 26; i++) m[String.fromCharCode(97 + i)] = { vk: 0x41 + i };
  for (let i = 0; i < 10; i++) m[String(i)] = { vk: 0x30 + i };
  for (let i = 1; i <= 24; i++) m[`f${i}`] = { vk: 0x6f + i };
  Object.assign(m, {
    enter: { vk: 0x0d },
    return: { vk: 0x0d },
    tab: { vk: 0x09 },
    esc: { vk: 0x1b },
    escape: { vk: 0x1b },
    space: { vk: 0x20 },
    backspace: { vk: 0x08 },
    capslock: { vk: 0x14 },
    numlock: { vk: 0x90 },
    scrolllock: { vk: 0x91 },
    pause: { vk: 0x13 },
    up: { vk: 0x26, extended: true },
    down: { vk: 0x28, extended: true },
    left: { vk: 0x25, extended: true },
    right: { vk: 0x27, extended: true },
    insert: { vk: 0x2b, extended: true },
    delete: { vk: 0x2e, extended: true },
    del: { vk: 0x2e, extended: true },
    home: { vk: 0x24, extended: true },
    end: { vk: 0x23, extended: true },
    pageup: { vk: 0x21, extended: true },
    pagedown: { vk: 0x22, extended: true },
    printscreen: { vk: 0x2c, extended: true },
    apps: { vk: 0x5d, extended: true },
    minus: { vk: 0xbd },
    equal: { vk: 0xbb },
    comma: { vk: 0xbc },
    period: { vk: 0xbe },
    slash: { vk: 0xbf },
    backslash: { vk: 0xdc },
    semicolon: { vk: 0xba },
    quote: { vk: 0xde },
    backquote: { vk: 0xc0 },
    bracketleft: { vk: 0xdb },
    bracketright: { vk: 0xdd }
  });
  return m;
})();

const SUPPORTED_KEY_TOKENS = Object.keys(MODIFIER_KEYS).concat(Object.keys(KEY_BY_NAME).sort());

function unsupportedError() {
  const e = new Error('电脑控制目前仅支持 Windows（叠云所在机器需为 Windows 系统）');
  e.code = 'OS_CONTROL_UNSUPPORTED';
  e.retryable = false;
  return e;
}

/**
 * 解析组合键字符串（"ctrl+shift+s"）。纯函数，供校验层与注入层共用。
 * @returns {{ modifiers: string[], key: string, vk: number, extended: boolean }}
 */
function parseKeyCombo(keyString) {
  const tokens = String(keyString || '')
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) {
    throw invalidKey(keyString, '组合键为空');
  }
  if (tokens.length > 5) {
    throw invalidKey(keyString, '组合键过长（最多 5 个键）');
  }
  const modifiers = [];
  let main = null;
  for (const t of tokens) {
    if (MODIFIER_KEYS[t]) {
      if (modifiers.includes(t)) throw invalidKey(keyString, `修饰键 ${t} 重复`);
      modifiers.push(t);
      continue;
    }
    if (main) throw invalidKey(keyString, '最多一个非修饰键');
    main = t;
  }
  if (!main) {
    // 纯修饰键（如 "win"）：按下再释放是合法动作（Win 键打开开始菜单）
    const only = modifiers[0];
    return { modifiers: modifiers.slice(1), key: only, vk: MODIFIER_KEYS[only].vk, extended: false };
  }
  const def = KEY_BY_NAME[main];
  if (!def) {
    throw invalidKey(keyString, `不认识的键「${main}」`);
  }
  if (modifiers.includes('ctrl') && modifiers.includes('alt') && (main === 'delete' || main === 'del')) {
    throw invalidKey(keyString, 'Ctrl+Alt+Delete 是系统安全序列，无法用软件注入');
  }
  return { modifiers, key: main, vk: def.vk, extended: !!def.extended };
}

function invalidKey(keyString, why) {
  const e = new Error(`组合键无效：${why}（${JSON.stringify(String(keyString || ''))}）`);
  e.code = 'INVALID_KEY';
  e.retryable = false;
  e.suggestedFix = `支持的键名：${SUPPORTED_KEY_TOKENS.slice(0, 40).join('、')}…；文本请用 action=type`;
  return e;
}

// —— koffi 绑定（惰性单例；非 Windows 调用时报 OS_CONTROL_UNSUPPORTED） ——

let bindings = null;

function getBindings() {
  if (bindings) return bindings;
  if (!WIN32) throw unsupportedError();
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  // 结构体布局已在 Electron 44 / x64 下实测：sizeof(INPUT) === 40
  const MOUSEINPUT = koffi.struct('dieyun_MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  });
  const KEYBDINPUT = koffi.struct('dieyun_KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  });
  const HARDWAREINPUT = koffi.struct('dieyun_HARDWAREINPUT', {
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16'
  });
  const INPUT_UNION = koffi.union('dieyun_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('dieyun_INPUT', { type: 'uint32', u: INPUT_UNION });
  // 结构体只注册类型名（签名里按名引用），不出变量：out 参数传普通对象即可
  koffi.struct('dieyun_POINT', { x: 'long', y: 'long' });

  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, _In_ dieyun_INPUT *pInputs, int cbSize)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
  const GetPhysicalCursorPos = user32.func('bool __stdcall GetPhysicalCursorPos(_Out_ dieyun_POINT *pt)');
  const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t *text, int max)'
  );

  bindings = {
    koffi,
    SendInput,
    GetSystemMetrics,
    GetPhysicalCursorPos,
    GetForegroundWindow,
    GetWindowTextW,
    sizeofInput: koffi.sizeof(INPUT)
  };
  return bindings;
}

function isSupported() {
  return WIN32;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** 全局虚拟桌面物理范围（DPI 感知进程下即物理像素）。 */
function getVirtualScreenMetrics() {
  const b = getBindings();
  return {
    x: b.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: b.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: b.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: b.GetSystemMetrics(SM_CYVIRTUALSCREEN)
  };
}

function mouseEvent(dwFlags, mouseData) {
  const b = getBindings();
  const inputs = [
    {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: mouseData || 0, dwFlags, time: 0, dwExtraInfo: 0 } }
    }
  ];
  return b.SendInput(inputs.length, inputs, b.sizeofInput);
}

/** 绝对移动到全局物理坐标（virtual desk 0-65535 归一化，不受指针加速影响）。 */
function moveMouseToPhysical(x, y) {
  const m = getVirtualScreenMetrics();
  const nx = clampNorm(x - m.x, m.width);
  const ny = clampNorm(y - m.y, m.height);
  const b = getBindings();
  const inputs = [
    {
      type: INPUT_MOUSE,
      u: {
        mi: {
          dx: nx,
          dy: ny,
          mouseData: 0,
          dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
          time: 0,
          dwExtraInfo: 0
        }
      }
    }
  ];
  return b.SendInput(inputs.length, inputs, b.sizeofInput);
}

function clampNorm(v, span) {
  if (!Number.isFinite(v) || span <= 1) return 0;
  return Math.min(65535, Math.max(0, Math.round((v * 65535) / (span - 1))));
}

const BUTTON_FLAGS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
};

function mouseButtonDown(button) {
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  return mouseEvent(flags[0]);
}

function mouseButtonUp(button) {
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  return mouseEvent(flags[1]);
}

/**
 * 拖拽：down → 分步绝对移动（每步都定位，避免依赖 SendInput 相对移动被指针加速扭曲）→ up。
 * @param {{x:number,y:number}} fromPhys 全局物理坐标
 * @param {{x:number,y:number}} toPhys
 */
async function dragMouse(fromPhys, toPhys, button, opts = {}) {
  const steps = Math.max(2, Math.floor(opts.steps || 12));
  const stepDelayMs = Math.max(1, opts.stepDelayMs || 15);
  mouseButtonDown(button);
  await sleep(60);
  moveMouseToPhysical(fromPhys.x, fromPhys.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    moveMouseToPhysical(
      Math.round(fromPhys.x + (toPhys.x - fromPhys.x) * t),
      Math.round(fromPhys.y + (toPhys.y - fromPhys.y) * t)
    );
    await sleep(stepDelayMs);
  }
  await sleep(60);
  mouseButtonUp(button);
  return true;
}

/** 在当前光标位置按一下。down 与 up 必须都投递——down 失败就跳过 up 会把按键卡死。 */
function clickMouseButton(button) {
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  const down = mouseEvent(flags[0]);
  const up = mouseEvent(flags[1]);
  return down && up;
}

/** 滚轮：direction=up|down，notches 格数（1 格 = WHEEL_DELTA）。 */
function scrollWheel(direction, notches) {
  const dir = direction === 'up' ? -1 : 1;
  return mouseEvent(MOUSEEVENTF_WHEEL, dir * WHEEL_DELTA * Math.max(1, Math.floor(notches)));
}

function keyInput(vk, extended, up) {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: 0,
        dwFlags: (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0),
        time: 0,
        dwExtraInfo: 0
      }
    }
  };
}

/** 按下并释放一个组合键（一次 SendInput 批量投递）。 */
function pressKeyCombo(parsed) {
  const b = getBindings();
  const inputs = [];
  const mods = parsed.modifiers || [];
  for (const name of mods) inputs.push(keyInput(MODIFIER_KEYS[name].vk, false, false));
  if (parsed.key && Number.isFinite(parsed.vk)) inputs.push(keyInput(parsed.vk, parsed.extended, false));
  if (parsed.key && Number.isFinite(parsed.vk)) inputs.push(keyInput(parsed.vk, parsed.extended, true));
  for (const name of mods.slice().reverse()) inputs.push(keyInput(MODIFIER_KEYS[name].vk, false, true));
  if (!inputs.length) return 0;
  return b.SendInput(inputs.length, inputs, b.sizeofInput);
}

/** UNICODE 扫描码输入（单字符 down+up；wVk=0，wScan=UTF-16 码元）。 */
function charInputs(codeUnit) {
  return [
    { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: codeUnit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } },
    {
      type: INPUT_KEYBOARD,
      u: { ki: { wVk: 0, wScan: codeUnit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } }
    }
  ];
}

/**
 * 输入文本（支持中文）。\n 按回车键发送（很多应用不认 UNICODE 0x0A），\t 按 Tab，
 * \r 忽略。分块投递，避免超长文本一次性塞爆输入队列。
 * @returns {Promise<number>} 实际投递的字符数（模型用来核对「打进去了多少」）
 */
async function typeText(text) {
  const b = getBindings();
  const chars = Array.from(String(text));
  let buffer = [];
  let typed = 0;
  const flush = () => {
    if (!buffer.length) return;
    b.SendInput(buffer.length, buffer, b.sizeofInput);
    buffer = [];
  };
  for (const ch of chars) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      flush();
      pressKeyCombo(parseKeyCombo('enter'));
      typed += 1;
      await sleep(10);
      continue;
    }
    if (ch === '\t') {
      flush();
      pressKeyCombo(parseKeyCombo('tab'));
      typed += 1;
      await sleep(10);
      continue;
    }
    for (const unit of textUnitCodes(ch)) buffer.push(...charInputs(unit));
    typed += 1;
    if (buffer.length >= 100) {
      flush();
      await sleep(5);
    }
  }
  flush();
  return typed;
}

function textUnitCodes(ch) {
  const units = [];
  for (let i = 0; i < ch.length; i++) units.push(ch.charCodeAt(i) & 0xffff);
  return units;
}

/** 全局物理坐标下的光标位置。 */
function getPhysicalCursorPos() {
  const b = getBindings();
  const pt = { x: 0, y: 0 };
  b.GetPhysicalCursorPos(pt);
  return { x: pt.x, y: pt.y };
}

function foregroundWindowTitle() {
  const b = getBindings();
  const hwnd = b.GetForegroundWindow();
  if (!hwnd) return '';
  const buf = new Uint16Array(256);
  const n = b.GetWindowTextW(hwnd, buf, 256);
  let title = '';
  for (let i = 0; i < n && buf[i]; i++) title += String.fromCharCode(buf[i]);
  return title.trim();
}

module.exports = {
  isSupported,
  unsupportedError,
  SUPPORTED_KEY_TOKENS,
  parseKeyCombo,
  getVirtualScreenMetrics,
  moveMouseToPhysical,
  mouseButtonDown,
  mouseButtonUp,
  dragMouse,
  clickMouseButton,
  scrollWheel,
  pressKeyCombo,
  typeText,
  getPhysicalCursorPos,
  foregroundWindowTitle,
  sleep
};
