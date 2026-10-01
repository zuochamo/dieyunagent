'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-screen.js');

/** 渲染端脚本是浏览器全局脚本，按仓库既有做法用 new Function 取工厂（见 trace-checkpoint-delta.test.cjs） */
function loadTerminalScreen() {
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    `${source}\nreturn { createTerminalScreen, TERMINAL_SCREEN_MAX_LINES };`
  );
  return factory({});
}

const { createTerminalScreen, TERMINAL_SCREEN_MAX_LINES } = loadTerminalScreen();
const ESC = '\u001b';
const BEL = '\u0007';

describe('terminal-screen：把 PTY 输出归约成可显示的纯文本', () => {
  it('剥掉 OSC（标题 / shell 集成标记），原文照收', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}]0;dieyunx@ubuntudieyun: /srv${BEL}$ ls`);
    expect(screen.text()).toBe('$ ls');

    // 现场日志里那串：OSC 3008 … ST（\e\\）
    const session =
      `${ESC}]3008;start=6b50d090-0dcf-44c6-94a0-cf85a248b00e;machineid=7002;type=shell;cwd=/srv${ESC}\\`;
    screen.write(`${session}${ESC}]0;dieyunx@ubuntudieyun:${BEL}root@srv:/srv# `);
    expect(screen.text()).toBe('$ lsroot@srv:/srv# ');
  });

  it('剥掉 CSI（颜色 / 私有模式 / 定位），保留可见字符', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}[?2004h${ESC}[01;32mok${ESC}[00m ${ESC}[H${ESC}[Kdone`);
    expect(screen.text()).toBe('ok done');
  });

  it('半截转义序列跨数据块时不会被当成正文', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}]3008;start=6b50d090`);
    expect(screen.text()).toBe('');
    screen.write(`-0dcf;type=shell${ESC}\\prompt$ `);
    expect(screen.text()).toBe('prompt$ ');

    const csi = createTerminalScreen();
    csi.write(`${ESC}[01;3`);
    expect(csi.text()).toBe('');
    csi.write('2mhi');
    expect(csi.text()).toBe('hi');
  });

  it('CR 回到行首覆盖，readline 的重绘不再叠字', () => {
    const screen = createTerminalScreen();
    screen.write('abcdef\rXY');
    expect(screen.text()).toBe('XYcdef');
    screen.write('\rZ');
    expect(screen.text()).toBe('ZYcdef');
  });

  it('退格与擦行（EL/ED）按列对齐处理', () => {
    const screen = createTerminalScreen();
    screen.write('sudu\b\b\b\b');
    expect(screen.text()).toBe('sudu');
    screen.write(`${ESC}[K`);
    expect(screen.text()).toBe('');
    screen.write('ls -la');
    expect(screen.text()).toBe('ls -la');
  });

  it('CRLF 与 LF 都按换行提交', () => {
    const screen = createTerminalScreen();
    screen.write('a\r\nb\nc');
    expect(screen.text()).toBe('a\nb\nc');
  });

  it('清屏序列清空缓冲，其余 C0/DEL 丢弃', () => {
    const screen = createTerminalScreen();
    screen.write('junk\u0000\u0007\u007fx');
    expect(screen.text()).toBe('junkx');
    screen.write(`${ESC}[2J`);
    expect(screen.text()).toBe('');
  });

  it('cwd 变化靠 CR+EL 覆盖，重绘不会把两条提示符叠在一起', () => {
    const screen = createTerminalScreen();
    screen.write('/run/media/dieyun/server$ ');
    screen.write('\r/run/media/dieyun/server/dieyunindex$ ');
    expect(screen.text()).toBe('/run/media/dieyun/server/dieyunindex$ ');
  });

  it('列位移夹在上限内：一次 \\e[5000000C 不再分配 MB 级空格', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}[5000000Cx`);
    expect(screen.text().length).toBeLessThanOrEqual(4097);
    expect(screen.text().endsWith('x')).toBe(true);

    // 正文本身不受列上限限制：真写了很长的行，列跟着可打印字符一起长
    const long = createTerminalScreen();
    long.write('a'.repeat(6000));
    expect(long.text()).toHaveLength(6000);
    expect(long.cursorOffset()).toBe(6000);
  });

  it('绝对列定位同样夹在上限内', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}[50000Gx`);
    expect(screen.text().length).toBeLessThanOrEqual(4097);
  });

  it('未终止的控制序列不会无限攒；丢弃后仍能正常解析后续序列', () => {
    const screen = createTerminalScreen();
    screen.write(`${ESC}]0;${'A'.repeat(20000)}`);
    expect(screen.text()).toBe('');
    screen.write(`${ESC}[2Jok`);
    expect(screen.text()).toBe('ok');
  });

  it('tab 按字符下标记账，展开只发生在渲染层', () => {
    const screen = createTerminalScreen();
    screen.write('ab\tX');
    expect(screen.cursorOffset()).toBe(4);
    screen.write(`${ESC}[K`);
    expect(screen.text()).toBe('ab\tX');
  });

  it('行数超上限时从头裁剪，长跑输出不会撑爆 DOM', () => {
    const screen = createTerminalScreen({ maxLines: 3 });
    screen.write('1\n2\n3\n4\n5');
    expect(screen.text()).toBe('3\n4\n5');
    expect(TERMINAL_SCREEN_MAX_LINES).toBeGreaterThanOrEqual(1000);
  });

  it('光标位置跟着 CR / 覆盖 / 擦行走，供显示层画光标', () => {
    const screen = createTerminalScreen();
    expect(screen.cursorOffset()).toBe(0);

    screen.write('abc');
    expect(screen.cursorOffset()).toBe(3);

    screen.write('\rd');
    expect(screen.text()).toBe('dbc');
    expect(screen.cursorOffset()).toBe(1);
    expect(screen.text()[screen.cursorOffset()]).toBe('b');

    screen.write('\r\nls');
    expect(screen.text()).toBe('dbc\nls');
    expect(screen.cursorOffset()).toBe(screen.text().length);

    screen.write(`${ESC}[2K`);
    expect(screen.text()).toBe('dbc\n');
    expect(screen.cursorOffset()).toBe(4);
  });

  it('光标在行尾越界时夹到行尾', () => {
    const screen = createTerminalScreen();
    screen.write('abc');
    screen.write('\r');
    screen.write(`${ESC}[K`); // 擦光当前行，列仍在 0
    expect(screen.text()).toBe('');
    expect(screen.cursorOffset()).toBe(0);
  });

  it('clear() 复位缓冲与半截状态', () => {
    const screen = createTerminalScreen();
    screen.write('abc');
    screen.write(`${ESC}]0;half`);
    screen.clear();
    expect(screen.text()).toBe('');
    screen.write('x');
    expect(screen.text()).toBe('x');
  });
});
