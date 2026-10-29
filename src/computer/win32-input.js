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
 *
 * 已知边界：UIPI —— 非提权进程无法注入管理员权限窗口，表现为 SendInput 返回 0
 * （事件被静默丢弃）。**所有注入都走 `sendInputs`，返回值必须等于期望事件数**，
 * 不等就抛 INPUT_DROPPED：静默的成功比诚实的失败更贵（模型会凭信念继续点）。
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

// —— 窗口枚举 / 前台切换常量 ——
const GW_HWNDNEXT = 2;
const GW_CHILD = 5;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const SW_RESTORE = 9;
const VK_MENU = 0x12;

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

/** 修饰键名（唯一来源 = MODIFIER_KEYS），供 schema / 校验 / 文档引用。 */
const MODIFIER_NAMES = Object.freeze(Object.keys(MODIFIER_KEYS));

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

/**
 * 归一化并校验「动作期间按住的修饰键」列表（纯函数，供注入层与校验层共用）。
 *
 * 为什么不静默忽略拼错的名字：`shift` 写成 `shfit` 时，静默跳过 = 按普通点击执行，
 * 结果是「选区没了 / 多选没选上」，比直接报错难查得多。
 * @param {string[]|undefined} modifiers
 * @returns {string[]} 去重后的合法修饰键（顺序保留）
 */
function normalizeModifiers(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers : [];
  const out = [];
  for (const raw of list) {
    const name = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    if (!name) continue;
    if (!MODIFIER_KEYS[name]) {
      const e = new Error(`不支持的修饰键「${name}」`);
      e.code = 'INVALID_ARG';
      e.retryable = false;
      e.suggestedFix = `modifiers 只支持：${MODIFIER_NAMES.join(' / ')}`;
      throw e;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
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
  koffi.struct('dieyun_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, _In_ dieyun_INPUT *pInputs, int cbSize)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
  const GetPhysicalCursorPos = user32.func('bool __stdcall GetPhysicalCursorPos(_Out_ dieyun_POINT *pt)');
  const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t *text, int max)'
  );
  // 窗口枚举 / 前台切换（list_windows、activate_window）
  const GetDesktopWindow = user32.func('uintptr_t __stdcall GetDesktopWindow()');
  const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)');
  const IsWindow = user32.func('bool __stdcall IsWindow(uintptr_t hWnd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ dieyun_RECT *rect)');
  const GetWindowLongW = user32.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)');

  bindings = {
    koffi,
    SendInput,
    GetSystemMetrics,
    GetPhysicalCursorPos,
    GetForegroundWindow,
    GetWindowTextW,
    GetDesktopWindow,
    GetWindow,
    IsWindow,
    IsWindowVisible,
    IsIconic,
    GetWindowRect,
    GetWindowLongW,
    ShowWindow,
    SetForegroundWindow,
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

/**
 * 「注入被系统丢弃」的错误（纯函数，便于单测）。
 *
 * 为什么需要它：SendInput 在 UIPI（目标窗口完整性级别更高）、锁屏、UAC 安全桌面下
 * **不报错**，只是返回 0。过去调用点全部忽略返回值，于是「点了但系统没接」被当成成功
 * 回给模型（`ok:true` + 一张没变化的截图），模型只能凭信念继续点 —— 这是静默失败。
 *
 * @param {string} what 哪一步注入（「鼠标移动」「组合键 ctrl+c」…）
 * @param {number} expected 期望投递的事件数
 * @param {number} delivered SendInput 实际接收的事件数
 */
function droppedInputError(what, expected, delivered) {
  const e = new Error(
    `输入没有被系统接收：${what} —— 期望投递 ${expected} 个事件，实际 ${delivered}。` +
      '常见原因：目标窗口以管理员权限运行（UIPI 拦截）、屏幕已锁定、或正处于 UAC 安全桌面；' +
      '这些情况下系统会静默丢弃事件，动作没有生效。'
  );
  e.code = 'INPUT_DROPPED';
  e.retryable = false;
  e.suggestedFix =
    '不要原样重复这个动作（重复投递会变成重复点击/重复输入）；先 action=screenshot 确认画面。' +
    '若目标窗口确实需要管理员权限，请用户以普通权限重开该窗口，或让用户手动完成这一步。';
  return e;
}

/**
 * **注入的唯一投递口**：SendInput 的返回值必须等于期望事件数，否则抛 INPUT_DROPPED。
 *
 * SendInput 是「全有或全无」的一次调用（被拦时返回 0，不会只投递一部分），所以
 * `delivered !== list.length` 就等价于「这一步完全没生效」，可以直接判定失败。
 */
function sendInputs(inputs, what) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) return 0;
  const b = getBindings();
  const delivered = Number(b.SendInput(list.length, list, b.sizeofInput)) || 0;
  if (delivered !== list.length) throw droppedInputError(what, list.length, delivered);
  return delivered;
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

function mouseEvent(dwFlags, mouseData, what) {
  const inputs = [
    {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: mouseData || 0, dwFlags, time: 0, dwExtraInfo: 0 } }
    }
  ];
  return sendInputs(inputs, what || '鼠标事件');
}

/** 绝对移动到全局物理坐标（virtual desk 0-65535 归一化，不受指针加速影响）。 */
function moveMouseToPhysical(x, y) {
  const m = getVirtualScreenMetrics();
  const nx = clampNorm(x - m.x, m.width);
  const ny = clampNorm(y - m.y, m.height);
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
  return sendInputs(inputs, `鼠标移动到 (${Math.round(x)}, ${Math.round(y)})`);
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
  return mouseEvent(flags[0], 0, `鼠标按下（${button || 'left'}）`);
}

function mouseButtonUp(button) {
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  return mouseEvent(flags[1], 0, `鼠标抬起（${button || 'left'}）`);
}

/**
 * 拖拽：down → 分步绝对移动（每步都定位，避免依赖 SendInput 相对移动被指针加速扭曲）→ up。
 *
 * 移动中途失败（注入被拦 / 异常）也必须把按键抬起来：否则鼠标键会卡在按下态，
 * 用户得自己点一下才能恢复。抬键本身再失败就吞掉 —— 已经在错误路径上，别掩盖原错误。
 *
 * @param {{x:number,y:number}} fromPhys 全局物理坐标
 * @param {{x:number,y:number}} toPhys
 */
async function dragMouse(fromPhys, toPhys, button, opts = {}) {
  const steps = Math.max(2, Math.floor(opts.steps || 12));
  const stepDelayMs = Math.max(1, opts.stepDelayMs || 15);
  mouseButtonDown(button);
  try {
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
  } finally {
    try {
      mouseButtonUp(button);
    } catch {
      /* 抬键被拦：原错误更重要 */
    }
  }
  return true;
}

/**
 * 在当前光标位置按一下。
 *
 * down 与 up 分开投递且各自校验：SendInput 被拦时返回 0（整次调用没生效），所以
 * down 抛错时「没有按下」是事实，不该再补 up；down 成功 up 被拦时按键可能停在按下态，
 * 此时如实抛错比静默吞掉更有用（模型会去截图核对，而不是以为「点成功了」）。
 */
function clickMouseButton(button) {
  mouseButtonDown(button);
  mouseButtonUp(button);
  return true;
}

/** 滚轮：direction=up|down，notches 格数（1 格 = WHEEL_DELTA）。 */
function scrollWheel(direction, notches) {
  const dir = direction === 'up' ? -1 : 1;
  return mouseEvent(
    MOUSEEVENTF_WHEEL,
    dir * WHEEL_DELTA * Math.max(1, Math.floor(notches)),
    `滚轮（${direction === 'up' ? 'up' : 'down'}）`
  );
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

/** 按下并释放一个组合键（一次 SendInput 批量投递，整批校验）。 */
function pressKeyCombo(parsed) {
  const inputs = [];
  const mods = parsed.modifiers || [];
  for (const name of mods) inputs.push(keyInput(MODIFIER_KEYS[name].vk, false, false));
  if (parsed.key && Number.isFinite(parsed.vk)) inputs.push(keyInput(parsed.vk, parsed.extended, false));
  if (parsed.key && Number.isFinite(parsed.vk)) inputs.push(keyInput(parsed.vk, parsed.extended, true));
  for (const name of mods.slice().reverse()) inputs.push(keyInput(MODIFIER_KEYS[name].vk, false, true));
  if (!inputs.length) return 0;
  const label = mods.concat(parsed.key ? [parsed.key] : []).join('+') || '按键';
  return sendInputs(inputs, `组合键 ${label}`);
}

/**
 * 在按住若干修饰键的情况下执行 `fn`（click / drag 用）。
 *
 * 为什么需要它：`pressKeyCombo` 是「按下即释放」的原子组合键，表达不了「按住 shift 再点」
 * —— 区间选择、ctrl 多选、ctrl 拖拽复制这些常见操作过去根本做不到。
 * 释放放在 finally：动作抛错也不能把修饰键卡在按下态（那会污染用户后续所有输入）。
 *
 * @template T
 * @param {string[]|undefined} modifiers
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
async function withModifiers(modifiers, fn) {
  const names = normalizeModifiers(modifiers);
  if (!names.length) return fn();
  const held = [];
  try {
    for (const name of names) {
      sendInputs([keyInput(MODIFIER_KEYS[name].vk, false, false)], `按下修饰键 ${name}`);
      held.push(name);
    }
    return await fn();
  } finally {
    for (const name of held.reverse()) {
      try {
        sendInputs([keyInput(MODIFIER_KEYS[name].vk, false, true)], `抬起修饰键 ${name}`);
      } catch {
        /* 抬键被拦：原错误更重要 */
      }
    }
  }
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
 *
 * `typed` 是**实际投递成功**的字符数（不是「打算输入多少」）：模型靠它核对
 * 「打进去了多少」，乐观计数会让它在被拦时以为文本已就位。
 * 中途被拦时抛 INPUT_DROPPED，并在消息里带上已输入字数 —— 模型据此决定是续打还是放弃，
 * 而不是整段重输（那会变成重复文本）。
 *
 * @returns {Promise<number>} 实际投递的字符数
 */
async function typeText(text) {
  const chars = Array.from(String(text));
  /** @type {Array<object>} */
  let buffer = [];
  /** 当前缓冲里已排队的字符数（按码点计，与返回的 typed 同口径）。 */
  let bufferChars = 0;
  let typed = 0;
  const flush = () => {
    if (!buffer.length) return;
    const pending = buffer;
    const pendingChars = bufferChars;
    buffer = [];
    bufferChars = 0;
    try {
      sendInputs(pending, '文本输入');
    } catch (e) {
      if (e && e.code === 'INPUT_DROPPED') {
        e.typedCount = typed;
        e.message += ` 已成功输入 ${typed} / ${chars.length} 个字符后中断。`;
        e.suggestedFix =
          `${e.suggestedFix}注意：已输入的前 ${typed} 个字符确实在里面，不要整段重输。`;
      }
      throw e;
    }
    typed += pendingChars;
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
    bufferChars += 1;
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

/** 读窗口标题（UTF-16，最多 256 字符；上限是 GetWindowTextW 的常见安全值）。 */
function windowTitleOf(b, hwnd) {
  const buf = new Uint16Array(256);
  const n = Number(b.GetWindowTextW(hwnd, buf, 256)) || 0;
  let title = '';
  for (let i = 0; i < n && buf[i]; i++) title += String.fromCharCode(buf[i]);
  return title.trim();
}

function foregroundWindowTitle() {
  const b = getBindings();
  const hwnd = Number(b.GetForegroundWindow()) || 0;
  if (!hwnd) return '';
  return windowTitleOf(b, hwnd);
}

/** 调用方给了不存在的句柄（窗口已关闭 / 句柄过期 / 模型编了一个）。 */
function invalidWindowError(handle, why) {
  const e = new Error(`窗口句柄无效：${JSON.stringify(handle)}${why ? `（${why}）` : ''}`);
  e.code = 'INVALID_WINDOW';
  e.retryable = false;
  e.suggestedFix = '先 action=list_windows 重新取当前窗口清单（窗口可能已关闭或句柄已过期），再用新句柄。';
  return e;
}

/** 前台切换被系统拒绝（Windows 前台锁）：如实失败，别让模型以为切过去了。 */
function activateFailedError(title) {
  const e = new Error(
    `切换前台失败：「${title}」没有成为前台窗口。` +
      'Windows 只允许前台进程、或刚收到用户输入的进程抢焦点；系统会静默拒绝并闪一下任务栏。'
  );
  e.code = 'ACTIVATE_FAILED';
  e.retryable = false;
  e.suggestedFix =
    '别反复重试同一个窗口：改成直接 action=click 点击目标窗口可见的位置（这会带来真实用户输入，之后就能切成功了），' +
    '或让用户自己点一下任务栏/Alt+Tab。';
  return e;
}

/**
 * 顶层窗口清单（z 序：最上层在前）。
 *
 * 为什么要它：模型过去只能看图猜「现在是什么窗口」，切窗口只能靠点击任务栏或盲按 Alt+Tab；
 * 有了清单就能按标题认窗口、按句柄激活（list_windows → activate_window），
 * 也省掉「为了看一眼标题截一张全屏图」的 token。
 *
 * 为什么用 GetWindow(GW_CHILD/GW_HWNDNEXT) 而不是 EnumWindows：后者要 koffi 回调，
 * 而回调是 koffi 里唯一的高风险面（GC 时机 + 重入）。GetWindow 链枚举的是同一批
 * 顶层窗口（桌面窗口的子窗口，顺序即 z 序），不需要回调。
 *
 * @param {{ max?: number }} [opts]
 * @returns {Array<{ handle: number, title: string,
 *   rect: { x: number, y: number, width: number, height: number } | null,
 *   minimized: boolean, active: boolean }>} 最小化窗口的 rect 为 null（见下）
 */
function listWindows(opts = {}) {
  const b = getBindings();
  const max = Math.max(1, Math.min(Math.floor(Number(opts.max) || 25), 60));
  const foreground = Number(b.GetForegroundWindow()) || 0;
  const out = [];
  let hwnd = Number(b.GetWindow(b.GetDesktopWindow(), GW_CHILD)) || 0;
  while (hwnd) {
    if (b.IsWindowVisible(hwnd)) {
      const exStyle = Number(b.GetWindowLongW(hwnd, GWL_EXSTYLE)) || 0;
      // 工具窗口（悬浮面板、输入法候选、托盘助手）不是用户心里的「窗口」，排除掉
      if (!(exStyle & WS_EX_TOOLWINDOW)) {
        const title = windowTitleOf(b, hwnd);
        if (title) {
          const rect = { left: 0, top: 0, right: 0, bottom: 0 };
          if (b.GetWindowRect(hwnd, rect)) {
            const width = Number(rect.right) - Number(rect.left);
            const height = Number(rect.bottom) - Number(rect.top);
            const minimized = Boolean(b.IsIconic(hwnd));
            // 最小化窗口的 GetWindowRect 是 (-32000,-32000) 哨兵值：报出去会让模型
            // 照着它去点屏外（钳制后就变成点屏幕角落）。位置不明就说「没有位置」。
            if (minimized || (width > 0 && height > 0)) {
              out.push({
                handle: hwnd,
                title: title.slice(0, 200),
                rect: minimized ? null : { x: Number(rect.left), y: Number(rect.top), width, height },
                minimized,
                active: hwnd === foreground
              });
              if (out.length >= max) break;
            }
          }
        }
      }
    }
    hwnd = Number(b.GetWindow(hwnd, GW_HWNDNEXT)) || 0;
  }
  return out;
}

/**
 * 把窗口切到前台（最小化的先恢复）。
 *
 * 判定**以 GetForegroundWindow 的实际结果为准**，不看 SetForegroundWindow 的返回值 ——
 * 「以为切过去了、其实还在原窗口」会让后续每一次点击都打在错的窗口上。
 *
 * 前台锁（Windows 的既定行为，非本仓可绕过的机制）：非前台进程通常抢不到焦点。
 * 因此失败后再投一次 Alt 按下/抬起重置前台锁并重试一次；仍失败就抛 ACTIVATE_FAILED
 * 并给出替代路径（点击窗口可见处会带来真实用户输入，之后即可切换）。
 *
 * @param {number|string} handle list_windows 返回的句柄
 * @returns {Promise<string>} 目标窗口标题
 */
async function activateWindow(handle) {
  const b = getBindings();
  const hwnd = Number(handle);
  if (!Number.isFinite(hwnd) || hwnd <= 0) throw invalidWindowError(handle);
  if (!b.IsWindow(hwnd)) throw invalidWindowError(handle, '窗口已不存在');
  const isForeground = () => (Number(b.GetForegroundWindow()) || 0) === hwnd;
  if (b.IsIconic(hwnd)) b.ShowWindow(hwnd, SW_RESTORE);
  if (isForeground()) return windowTitleOf(b, hwnd);
  b.SetForegroundWindow(hwnd);
  if (isForeground()) return windowTitleOf(b, hwnd);
  sendInputs([keyInput(VK_MENU, false, false), keyInput(VK_MENU, false, true)], '重置前台锁（Alt）');
  await sleep(60);
  b.SetForegroundWindow(hwnd);
  if (isForeground()) return windowTitleOf(b, hwnd);
  throw activateFailedError(windowTitleOf(b, hwnd) || `#${hwnd}`);
}

module.exports = {
  isSupported,
  unsupportedError,
  SUPPORTED_KEY_TOKENS,
  MODIFIER_NAMES,
  parseKeyCombo,
  normalizeModifiers,
  // 注入投递口与它的失败契约（错误构造函数导出给单测：不触碰 koffi/SendInput）
  sendInputs,
  droppedInputError,
  getVirtualScreenMetrics,
  moveMouseToPhysical,
  mouseButtonDown,
  mouseButtonUp,
  dragMouse,
  clickMouseButton,
  scrollWheel,
  pressKeyCombo,
  withModifiers,
  typeText,
  getPhysicalCursorPos,
  foregroundWindowTitle,
  listWindows,
  activateWindow,
  invalidWindowError,
  activateFailedError,
  sleep
};
