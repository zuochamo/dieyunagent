/* global window */
'use strict';

/**
 * 集成终端的显示层：把 PTY 输出归约成「`<pre>` 能如实显示」的纯文本。
 *
 * 这个面板不是终端模拟器（没有字符网格、没有行寻址），所以这里只做两件事：
 *
 * 1. **剥离控制序列**：OSC（`\e]0;` 标题、`\e]3008;` shell 集成标记）、CSI（`\e[01;32m`
 *    颜色、`\e[?2004h` 私有模式、`\e[H` 定位）、其它 ESC。以前这些会被逐字节贴到屏上，
 *    用户看到的就是 `]3008;start=…;machineid=…` 这种垃圾。
 * 2. **只保留纯文本模型能正确表达的光标动作**：CR / BS / EL（擦行）/ 光标左右 / 列定位。
 *    readline 的回退与重绘靠这几条，丢了它们就会出现「退格删不掉、提示符叠字」。
 *
 * 表达不了的（`\e[A\e[B`、`\e[H`、`\e[@` 等行寻址 / 插删）一律丢弃：纯文本模型没有行地址，
 * 硬猜只会把正文擦掉。真需要 TUI 的场景应当换终端模拟器，而不是在这里堆补丁。
 */

/** 显示层保留的最大行数：长跑输出（build / 日志跟随）不能把 DOM 撑爆 */
const TERMINAL_SCREEN_MAX_LINES = 4000;

/**
 * 列上限，同时也是「单次按列补齐」的上限：PTY 只有 120 列，`\e[999C`（走到行尾）
 * 这类惯用法不该让一次光标位移就分配 MB 级空格（`\e[5000000C` 原先是 5MB 单行）。
 * 正文本身不受它限制：真的写了很长的行，列会跟着可打印字符一起长。
 */
const TERMINAL_SCREEN_MAX_COLS = 4096;

/** 未终止的控制序列最多留这么多字符：对端不发终止符时不能无限攒 pending */
const TERMINAL_SCREEN_MAX_PENDING = 8192;

const TERMINAL_ESC = '\u001b';
const TERMINAL_BEL = '\u0007';

/**
 * @param {{ maxLines?: number }} [opts]
 */
function createTerminalScreen(opts = {}) {
  const maxLines = Math.max(1, Number(opts.maxLines) || TERMINAL_SCREEN_MAX_LINES);
  /** 已显示的行；最后一行永远是光标所在行 */
  let lines = [''];
  /** 光标列：允许大于行尾（后续字符按空格补齐），这是 CR/EL 能对齐的前提 */
  let col = 0;
  /** 被数据块切开的半截转义序列，等下一块续上再处理 */
  let pending = '';

  function line() {
    return lines[lines.length - 1];
  }

  function setLine(text) {
    lines[lines.length - 1] = text;
  }

  function trimLines() {
    if (lines.length <= maxLines) return;
    lines.splice(0, lines.length - maxLines);
  }

  function clear() {
    lines = [''];
    col = 0;
    pending = '';
  }

  function putChar(ch) {
    const text = line();
    if (col >= text.length) {
      // 补齐上限：光标被远远推到右边时只补有限空格，不为一次转义分配大块内存
      const pad = Math.min(col - text.length, TERMINAL_SCREEN_MAX_COLS);
      setLine(text + ' '.repeat(pad) + ch);
    } else {
      setLine(text.slice(0, col) + ch + text.slice(col + 1));
    }
    col += 1;
  }

  function firstParam(params, fallback) {
    const m = /^\d+/.exec(params);
    return m ? Number(m[0]) : fallback;
  }

  /** CSI（`\e[` … 终止字节）：只认列内动作，其余丢弃 */
  function applyCsi(params, final) {
    switch (final) {
      case 'K': {
        // EL：0/缺省=光标到行尾，1=行首到光标，2=整行
        const n = firstParam(params, 0);
        if (n === 1) setLine(' '.repeat(col) + line().slice(col));
        else if (n === 2) setLine('');
        else setLine(line().slice(0, col));
        return;
      }
      case 'J': {
        // ED：0/缺省=光标到屏尾，1=屏首到光标，2=清屏（`clear` 的实现就是 \e[H\e[2J）
        const n = firstParam(params, 0);
        if (n === 2) clear();
        else if (n === 1) setLine(' '.repeat(col) + line().slice(col));
        else setLine(line().slice(0, col));
        return;
      }
      case 'C':
        // 单次右移夹在上限内（只前进、不后退）：避免 `\e[5000000C` 把一次位移变成大块空格
        col += Math.min(Math.max(1, firstParam(params, 1)), TERMINAL_SCREEN_MAX_COLS);
        return;
      case 'D':
        col = Math.max(0, col - Math.max(1, firstParam(params, 1)));
        return;
      case 'G':
        // 1-based 绝对列定位，参数同样夹在上限内（`\e[50000G` 不该把列推到五万）
        col = Math.max(Math.min(firstParam(params, 1) - 1, TERMINAL_SCREEN_MAX_COLS), 0);
        return;
      default:
        // m（颜色）、?2004h/l（括号粘贴）、H/f/A/B（行寻址）、s/u、@/P（插删）…
        return;
    }
  }

  /**
   * 从 src[at]（ESC）起解析一个控制序列。
   * @returns {number} 消耗的字符数；-1 表示这一块数据不够，等下一块
   */
  function consumeEscape(src, at) {
    const next = src[at + 1];
    if (next === undefined) return -1;
    if (next === '[') {
      let i = at + 2;
      while (i < src.length) {
        const code = src.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          applyCsi(src.slice(at + 2, i), src[i]);
          return i - at + 1;
        }
        if (code < 0x20 || code > 0x3f) return i - at; // 参数非法：只丢转义头，后面当正文收
        i += 1;
      }
      return -1;
    }
    if (next === ']') {
      let i = at + 2;
      while (i < src.length) {
        if (src[i] === TERMINAL_BEL) return i - at + 1; // OSC … BEL
        if (src[i] === TERMINAL_ESC) {
          if (src[i + 1] === undefined) return -1;
          if (src[i + 1] === '\\') return i - at + 2; // OSC … ST
        }
        i += 1;
      }
      return -1;
    }
    if (next === '(' || next === ')' || next === '*' || next === '+') {
      return src[at + 2] === undefined ? -1 : 3; // 字符集选择
    }
    return 2; // ESC + 单字符（= > 7 8 M D E …）
  }

  function write(text) {
    const src = pending + (text == null ? '' : String(text));
    pending = '';
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === TERMINAL_ESC) {
        const used = consumeEscape(src, i);
        if (used < 0) {
          // 对端还没给终止符：留一小段等下一块，超限就丢弃（否则 pending 可被无限撑大）
          const rest = src.slice(i);
          pending = rest.length > TERMINAL_SCREEN_MAX_PENDING ? '' : rest;
          return;
        }
        i += used;
        continue;
      }
      const code = src.charCodeAt(i);
      if (ch === '\n') {
        lines.push('');
        col = 0;
        trimLines();
      } else if (ch === '\r') {
        col = 0;
      } else if (ch === '\b') {
        col = Math.max(0, col - 1);
      } else if (ch === '\t') {
        // 模型里的 col 是「行内字符下标」而不是显示列：tab 只占 1 个下标（展开由 CSS 渲染层做）。
        // 若按显示列推进，EL/CR 的 slice 与光标定位都会错位（tab 展开后字符数 ≠ 显示宽度）。
        putChar('\t');
      } else if (code >= 0x20 && code !== 0x7f) {
        putChar(ch);
      }
      // 其余 C0 / DEL：丢弃
      i += 1;
    }
  }

  /** 光标在 text() 里的下标：本模型不支持行寻址，光标永远在最后一行第 col 列 */
  function cursorOffset() {
    const last = lines[lines.length - 1];
    let offset = 0;
    for (let i = 0; i < lines.length - 1; i++) offset += lines[i].length + 1;
    return offset + Math.min(col, last.length);
  }

  return {
    write,
    clear,
    text: () => lines.join('\n'),
    cursorOffset
  };
}

if (typeof window !== 'undefined') {
  window.createTerminalScreen = createTerminalScreen;
  window.TERMINAL_SCREEN_MAX_LINES = TERMINAL_SCREEN_MAX_LINES;
}
